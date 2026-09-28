#!/usr/bin/env node
import { basename } from 'node:path'
import { Cli, z } from 'incur'
import { pick, simulate, untilCondition } from './engine.ts'
import { UsageError } from './errors.ts'
import { exportGame } from './export.ts'
import { describe, gameFiles, loadDriver, loadGame, typecheck } from './load.ts'
import { createGame } from './new.ts'
import { VERSION, mcpCommand } from './package.ts'
import { play } from './serve.ts'
import { parseTicks, shoot } from './shot.ts'
import type { EntityState, Value } from './types.ts'

process.stdout.on('error', (error) => {
  if ('code' in error && error.code === 'EPIPE') process.exit(0)
  throw error
})

const args = z.object({ dir: z.string().describe('Game folder with a game.ts') })

const inputs = {
  press: z.array(z.string()).optional().describe('Press a key or mouse button on some ticks, like Space@60, Space@60,120, or Mouse@30; repeatable'),
  hold: z
    .array(z.string())
    .optional()
    .describe('Hold a key or mouse button on spans of ticks, like Up@30-90,120- or Mouse@10-40, or every tick with just Up; repeatable'),
  pointer: z
    .array(z.string())
    .optional()
    .describe('Move the pointer to X,Y in world units on a tick, like 0.5,-0.2@30, where it stays until the next move; X,Y alone starts it there; repeatable'),
  driver: z
    .string()
    .optional()
    .describe(
      'A file whose default export picks the input before each tick: ({ world, tick, keys, pointer, random }) => keys or { keys, pointer }, ' +
        'where keys and pointer are the tick before',
    ),
  set: z
    .array(z.string())
    .optional()
    .describe('Change a starting value before start runs, like paddle.w=1, bricks[*].points=5, or pipes[*].parts.top.h=2; repeatable'),
  seed: z.number().int().optional().describe('Random seed; the same files, flags, and seed give the same run (default 0)'),
}

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }

function failure(error: unknown) {
  return { code: error instanceof UsageError ? 'USAGE' : 'GAME_ERROR', message: describe(error) }
}

function rounded(value: Value): Value {
  if (typeof value === 'number') {
    const round = Math.round(value * 1e4) / 1e4
    return Object.is(round, -0) ? 0 : round
  }
  if (Array.isArray(value)) return value.map(rounded)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]))
  return value
}

interface Inputs {
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly pointer?: readonly string[]
  readonly driver?: string
  readonly set?: readonly string[]
  readonly seed?: number
}

// incur joins repeated flags with commas, which --set, --hold, and --pointer values contain, so the command is spelled out.
function shotCommand({ dir, ticks, inputs }: { dir: string; ticks: number; inputs: Inputs }): string {
  const flag = (name: string, values: readonly string[] | undefined) => (values ?? []).map((value) => ` --${name} ${shellWord(value)}`).join('')
  const driver = inputs.driver === undefined ? '' : ` --driver ${shellWord(inputs.driver)}`
  const seed = inputs.seed === undefined ? '' : ` --seed ${inputs.seed}`
  const keys = `${flag('press', inputs.press)}${flag('hold', inputs.hold)}${flag('pointer', inputs.pointer)}`
  return `shot ${shellWord(dir)} --at ${ticks}${keys}${driver}${flag('set', inputs.set)}${seed}`
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

function shown(entities: readonly EntityState[], fields: string | undefined): EntityState[] {
  const wanted = fields
    ?.split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  for (const field of wanted ?? []) {
    if (!entities.some((entity) => field in entity)) throw new UsageError(`--fields "${field}" isn't a field of any printed entity`)
  }
  return entities.map((entity) => {
    const kept = Object.entries(entity).filter(([field]) => field !== 'name' && (wanted === undefined || wanted.includes(field)))
    return { name: entity.name, ...Object.fromEntries(kept.map(([field, value]) => [field, rounded(value)])) }
  })
}

const cli = Cli.create('fourjs', {
  description: 'FourJS: make games from TypeScript files, test them without a window, and play them in a browser',
  version: VERSION,
  mcp: {
    command: mcpCommand(),
    tools: { discovery: 'direct' },
    instructions:
      'A FourJS game is a folder with a game.ts that exports defineGame({ entities, start, update }), plus any images and sounds it uses; new starts one. ' +
      'After each edit run check; prove behavior with sim, which runs exact ticks (60 a second) with scripted keys, mouse, and pointer or a driver, ' +
      'lists the sounds played, and can stop at the first tick a condition holds; look at frames with shot. The same files, flags, and seed always give the same result. ' +
      'export writes one HTML file that people can play offline.',
  },
})
  .command('new', {
    description:
      'Start a game: write a small playable game.ts and its test into a new or empty folder, plus a package.json and tsconfig.json when no project above it depends on FourJS',
    args: z.object({ dir: z.string().describe('Folder to create; it must be new or empty') }),
    examples: [
      { args: { dir: 'games/catch' }, description: 'Add a game to a project that depends on FourJS' },
      { args: { dir: 'my-game' }, description: 'Start a project of its own; run npm install in it next' },
    ],
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    run(c) {
      try {
        const { files, standalone } = createGame(c.args.dir)
        // A project of its own runs its commands from inside, once npm install has added FourJS there.
        const at = standalone ? '.' : shellWord(c.args.dir)
        const commands = [
          { command: `check ${at}`, description: 'Check its types, entities, start, and first tick' },
          { command: `sim ${at} --ticks 120 --press Space@1 --hold Right@2-40`, description: 'Start it and hold Right, which catches the first ball' },
          { command: `run ${at}`, description: 'Play it' },
        ]
        const description = standalone ? `Run npm install in ${shellWord(c.args.dir)} first, then these from there:` : undefined
        return c.ok({ dir: c.args.dir, files, test: standalone ? 'npm test' : `node --test ${at}` }, { cta: { description, commands } })
      } catch (error) {
        return c.error(failure(error))
      }
    },
  })
  .command('check', {
    description: 'Check a game: TypeScript types of game.ts and view.ts, entities and the images they name, start, and the first tick',
    args,
    examples: [{ args: { dir: 'games/pong' }, description: 'Check Pong after an edit' }],
    mcp: { annotations: readOnly },
    async run(c) {
      try {
        const files = gameFiles(c.args.dir)
        const errors = [...typecheck({ file: files.game, dom: false }), ...(files.view ? typecheck({ file: files.view, dom: true }) : [])]
        if (errors.length > 0) return c.error({ code: 'TYPE_ERROR', message: errors.join('; ') })
        const { snapshots } = simulate(await loadGame(c.args.dir), { ticks: 1, assets: files.assets })
        return { ok: true, entities: snapshots[0].entities.length }
      } catch (error) {
        return c.error(failure(error))
      }
    },
  })
  .command('sim', {
    description: 'Run a game without a window for some ticks (60 a second), or until a condition holds, and print its entities and the sounds it played',
    args,
    options: z.object({
      ticks: z.number().int().describe('How many ticks to run, 60 to a second; with --until, the most to run'),
      ...inputs,
      until: z
        .string()
        .optional()
        .describe(
          'Stop after the first tick where NAME.FIELD=VALUE holds, like match.state=over, or a number compares with != < <= > >=, ' +
            'like ball.x>1.9; a pattern stops when any entity it matches does',
        ),
      only: z
        .string()
        .optional()
        .describe('Print only these entities, like ball,bricks: * matches anything but a dot, a group name matches its members, and an entity brings its parts'),
      fields: z.string().optional().describe('Print only these fields, like x,y,vx; name is always printed'),
      every: z.number().int().optional().describe('Also print the entities after tick 0 and every N ticks'),
    }),
    examples: [
      {
        args: { dir: 'games/pong' },
        options: { ticks: 120, press: ['Space@1'], hold: ['W@1-60'], only: 'ball,left_paddle', fields: 'x,y' },
        description: 'Start a match, hold W for a second, and print where the ball and left paddle are',
      },
      { args: { dir: 'games/pong' }, options: { ticks: 600, every: 60, only: 'ball' }, description: 'Follow the ball once a second' },
      {
        args: { dir: 'games/pong' },
        options: { ticks: 3600, press: ['Space@1'], until: 'match.left=1', only: 'match' },
        description: 'Start a match and stop on the tick the left player first scores, within a minute',
      },
      {
        args: { dir: 'games/asteroids' },
        options: { ticks: 60, press: ['Space@1'], hold: ['Mouse@2-60'], pointer: ['-1,1@2'], only: 'ship,bullets', fields: 'angle,visible' },
        description: 'Start, then hold the mouse with the pointer up and to the left, so the ship turns toward it and fires',
      },
    ],
    mcp: { annotations: readOnly },
    async run(c) {
      try {
        const { ticks, press, hold, pointer, driver, set, seed, every, only, fields, until } = c.options
        const files = gameFiles(c.args.dir)
        const game = await loadGame(c.args.dir)
        const drive = driver === undefined ? undefined : await loadDriver(driver)
        const stop = until === undefined ? undefined : untilCondition(until)
        const run = simulate(game, { ticks, press, hold, pointer, drive, set, seed, every, until: stop, assets: files.assets })
        const printed = run.snapshots.map((snapshot) => ({ tick: snapshot.tick, entities: shown(pick(snapshot.entities, only), fields) }))
        const data = every ? { snapshots: printed } : printed[0]
        const result = until === undefined ? data : { tick: run.tick, reached: run.reached, ...data }
        const again = shotCommand({ dir: c.args.dir, ticks: run.tick, inputs: { press, hold, pointer, driver, set, seed } })
        const log = run.logs.length > 0 ? { log: run.logs } : {}
        const sounds = run.sounds.length > 0 ? { sounds: run.sounds } : {}
        return c.ok({ ...result, ...log, ...sounds }, { cta: { commands: [{ command: again, description: 'See this tick as a PNG' }] } })
      } catch (error) {
        return c.error(failure(error))
      }
    },
  })
  .command('shot', {
    description: 'Save PNGs of a game at exact ticks, drawn by the same Three.js view players see',
    args,
    options: z.object({
      at: z.string().optional().describe('Ticks to capture, like 1,120,600 (default 1)'),
      ...inputs,
      out: z.string().default('frame.png').describe('PNG path; with several ticks, frame.png becomes frame-001.png, frame-120.png, and so on'),
    }),
    alias: { out: 'o' },
    examples: [{ args: { dir: 'games/pong' }, options: { at: '1,120,600', press: ['Space@1'] }, description: 'Three frames of one match' }],
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async run(c) {
      try {
        const at = parseTicks(c.options.at ?? '1')
        const { press, hold, pointer, driver, set, seed, out } = c.options
        const drive = driver === undefined ? undefined : await loadDriver(driver)
        const { assets } = gameFiles(c.args.dir)
        simulate(await loadGame(c.args.dir), { ticks: Math.max(...at), press, hold, pointer, drive, set, seed, clip: true, assets })
        return { files: await shoot({ dir: c.args.dir, at, out, press, hold, pointer, driver, set, seed }) }
      } catch (error) {
        return c.error(failure(error))
      }
    },
  })
  .command('run', {
    description: 'Play a game in a browser window; Esc quits and saving a file reloads it. For people, not agents',
    args,
    options: z.object({
      seed: z.number().int().optional().describe('Random seed; without one, run picks one and prints it, and reloads replay it'),
      serveOnly: z.boolean().optional().describe('Serve the page and print its address without opening a window'),
    }),
    mcp: false,
    async *run(c) {
      try {
        gameFiles(c.args.dir)
      } catch (error) {
        return c.error(failure(error))
      }
      yield* play({ dir: c.args.dir, seed: c.options.seed, window: !c.options.serveOnly })
    },
  })
  .command('export', {
    description:
      'Write a game as one HTML file that plays offline when opened from disk, with the engine, Three.js, the game, its view.ts, and its images and sounds inside',
    args,
    options: z.object({
      out: z.string().optional().describe("HTML path (default: the game folder's name, like pong.html)"),
      seed: z.number().int().optional().describe('Random seed; without one, the page picks a new one each time it loads'),
    }),
    alias: { out: 'o' },
    examples: [{ args: { dir: 'games/pong' }, options: { out: 'pong.html' }, description: 'Pong as one file to share' }],
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async run(c) {
      try {
        const { folder, assets } = gameFiles(c.args.dir)
        simulate(await loadGame(c.args.dir), { ticks: 1, seed: c.options.seed, assets })
        return await exportGame({ dir: c.args.dir, out: c.options.out ?? `${basename(folder)}.html`, seed: c.options.seed })
      } catch (error) {
        return c.error(failure(error))
      }
    },
  })

cli.serve()

export default cli
