#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { Cli, z } from 'incur'
import { pick, simulate } from './engine.ts'
import { UsageError } from './errors.ts'
import { describe, gameFiles, loadDriver, loadGame, typecheck } from './load.ts'
import { play } from './serve.ts'
import { parseTicks, shoot } from './shot.ts'
import type { EntityState, Value } from './types.ts'

process.stdout.on('error', (error) => {
  if ('code' in error && error.code === 'EPIPE') process.exit(0)
  throw error
})

const args = z.object({ dir: z.string().describe('Game folder with a game.ts') })

const inputs = {
  press: z.array(z.string()).optional().describe('Press a key on some ticks, like Space@60 or Space@60,120; repeatable'),
  hold: z.array(z.string()).optional().describe('Hold a key on spans of ticks, like Up@30-90,120-, or every tick with just Up; repeatable'),
  driver: z.string().optional().describe('A file whose default export picks the keys before each tick: ({ world, tick, random }) => keys'),
  set: z.array(z.string()).optional().describe('Change a starting value before start runs, like paddle.w=1 or bricks[*].points=5; repeatable'),
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
  readonly driver?: string
  readonly set?: readonly string[]
  readonly seed?: number
}

// incur joins repeated flags with commas, which --set and --hold values contain, so the command is spelled out.
function shotCommand({ dir, ticks, inputs }: { dir: string; ticks: number; inputs: Inputs }): string {
  const flag = (name: string, values: readonly string[] | undefined) => (values ?? []).map((value) => ` --${name} ${shellWord(value)}`).join('')
  const driver = inputs.driver === undefined ? '' : ` --driver ${shellWord(inputs.driver)}`
  const seed = inputs.seed === undefined ? '' : ` --seed ${inputs.seed}`
  return `shot ${shellWord(dir)} --at ${ticks}${flag('press', inputs.press)}${flag('hold', inputs.hold)}${driver}${flag('set', inputs.set)}${seed}`
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

const cli = Cli.create('four', {
  description: 'FourJS: make games from TypeScript files, test them without a window, and play them in a browser',
  version: '0.0.1',
  mcp: {
    // The package name "four" belongs to someone else on npm, so agents start this file directly.
    command: `node ${fileURLToPath(import.meta.url)} --mcp`,
    tools: { discovery: 'direct' },
    instructions:
      'A FourJS game is a folder with a game.ts that exports defineGame({ entities, start, update }). ' +
      'After each edit run check; prove behavior with sim, which runs exact ticks (60 a second) with scripted keys or a driver; ' +
      'look at frames with shot. The same files, flags, and seed always give the same result.',
  },
})
  .command('check', {
    description: 'Check a game: TypeScript types of game.ts and view.ts, entities, start, and the first tick',
    args,
    examples: [{ args: { dir: 'games/pong' }, description: 'Check Pong after an edit' }],
    mcp: { annotations: readOnly },
    async run(c) {
      try {
        const files = gameFiles(c.args.dir)
        const errors = [...typecheck({ file: files.game, dom: false }), ...(files.view ? typecheck({ file: files.view, dom: true }) : [])]
        if (errors.length > 0) return c.error({ code: 'TYPE_ERROR', message: errors.join('; ') })
        const { snapshots } = simulate(await loadGame(c.args.dir), { ticks: 1 })
        return { ok: true, entities: snapshots[0].entities.length }
      } catch (error) {
        return c.error(failure(error))
      }
    },
  })
  .command('sim', {
    description: 'Run a game without a window for some ticks (60 a second) and print its entities',
    args,
    options: z.object({
      ticks: z.number().int().describe('How many ticks to run; 60 is one second'),
      ...inputs,
      only: z.string().optional().describe('Print only these entities, like ball,bricks where * matches anything and a group name matches its members'),
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
    ],
    mcp: { annotations: readOnly },
    async run(c) {
      try {
        const { ticks, press, hold, driver, set, seed, every, only, fields } = c.options
        const game = await loadGame(c.args.dir)
        const drive = driver === undefined ? undefined : await loadDriver(driver)
        const { snapshots, logs } = simulate(game, { ticks, press, hold, drive, set, seed, every })
        const printed = snapshots.map((snapshot) => ({ tick: snapshot.tick, entities: shown(pick(snapshot.entities, only), fields) }))
        const data = every ? { snapshots: printed } : printed[0]
        const again = shotCommand({ dir: c.args.dir, ticks, inputs: { press, hold, driver, set, seed } })
        return c.ok(logs.length > 0 ? { ...data, log: logs } : data, {
          cta: { commands: [{ command: again, description: 'See this tick as a PNG' }] },
        })
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
        const { press, hold, driver, set, seed, out } = c.options
        const drive = driver === undefined ? undefined : await loadDriver(driver)
        simulate(await loadGame(c.args.dir), { ticks: Math.max(...at), press, hold, drive, set, seed, clip: true })
        return { files: await shoot({ dir: c.args.dir, at, out, press, hold, driver, set, seed }) }
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

cli.serve()

export default cli
