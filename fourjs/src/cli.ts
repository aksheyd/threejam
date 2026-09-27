#!/usr/bin/env node
import { dirname } from 'node:path'
import { Cli, z } from 'incur'
import { pick, simulate } from './engine.ts'
import { UsageError } from './errors.ts'
import { describe, gameFile, loadGame, typecheck } from './load.ts'
import { play } from './serve.ts'
import { parseTicks, shoot } from './shot.ts'
import type { EntityState } from './types.ts'

const args = z.object({ dir: z.string().describe('Game folder with a game.ts') })

const inputs = {
  press: z.array(z.string()).optional().describe('Press a key on some ticks, like Space@60 or Space@60,120; repeatable'),
  hold: z.array(z.string()).optional().describe('Hold a key on spans of ticks, like Up@30-90,120-, or every tick with just Up; repeatable'),
  set: z.array(z.string()).optional().describe('Change a starting value for this run, like ball.vx=2; repeatable'),
  seed: z.number().int().optional().describe('Random seed; the same files, flags, and seed give the same run (default 0)'),
}

function failure(error: unknown, dir?: string) {
  return { code: error instanceof UsageError ? 'USAGE' : 'GAME_ERROR', message: describe(error, dir) }
}

function rounded(entity: EntityState): EntityState {
  const round = (value: unknown): unknown =>
    typeof value === 'number'
      ? Math.round(value * 1e4) / 1e4 || 0
      : Array.isArray(value)
        ? value.map(round)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]))
          : value
  return round(entity) as EntityState
}

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }

const cli = Cli.create('four', {
  description: 'FourJS: make games from TypeScript files, test them without a window, and play them in a browser',
  version: '0.0.1',
  mcp: {
    tools: { discovery: 'direct' },
    instructions:
      'A FourJS game is a folder with a game.ts that exports defineGame({ entities, start, update }). ' +
      'After each edit run check; prove behavior with sim, which runs exact ticks (60 a second) with scripted keys; ' +
      'look at frames with shot. The same files, flags, and seed always give the same result.',
  },
})
  .command('check', {
    description: 'Check a game: TypeScript types, entities, start, and the first tick',
    args,
    examples: [{ args: { dir: 'games/pong' }, description: 'Check Pong after an edit' }],
    mcp: { annotations: readOnly },
    async run(c) {
      let dir: string | undefined
      try {
        const file = gameFile(c.args.dir)
        dir = dirname(file)
        const types = typecheck(file)
        if (types.length > 0) return c.error({ code: 'TYPE_ERROR', message: types.join('\n') })
        const { snapshots } = simulate(await loadGame(c.args.dir), { ticks: 1 })
        return { ok: true, entities: snapshots[0].entities.length }
      } catch (error) {
        return c.error(failure(error, dir))
      }
    },
  })
  .command('sim', {
    description: 'Run a game without a window for some ticks (60 a second) and print its entities',
    args,
    options: z.object({
      ticks: z.number().int().describe('How many ticks to run; 60 is one second'),
      ...inputs,
      only: z.string().optional().describe('Print only these entities, like ball,paddle_* where * matches anything'),
      every: z.number().int().optional().describe('Also print the entities after tick 0 and every N ticks'),
    }),
    examples: [
      {
        args: { dir: 'games/pong' },
        options: { ticks: 120, press: ['Space@1'], hold: ['W@1-60'], only: 'ball,left_paddle' },
        description: 'Start a match, hold W for a second, and print the ball and left paddle',
      },
      { args: { dir: 'games/pong' }, options: { ticks: 600, every: 60, only: 'ball' }, description: 'Follow the ball once a second' },
    ],
    mcp: { annotations: readOnly },
    async run(c) {
      let dir: string | undefined
      try {
        dir = dirname(gameFile(c.args.dir))
        const { ticks, press, hold, set, seed, every, only } = c.options
        const { snapshots, logs } = simulate(await loadGame(c.args.dir), { ticks, press, hold, set, seed, every })
        const shown = snapshots.map((s) => ({ tick: s.tick, entities: pick(s.entities, only).map(rounded) }))
        const data = every ? { snapshots: shown } : shown[0]
        return c.ok(logs.length > 0 ? { ...data, log: logs } : data, {
          cta: {
            commands: [
              { command: 'shot', args: { dir: c.args.dir }, options: { at: String(ticks) }, description: 'See this tick as a PNG' },
            ],
          },
        })
      } catch (error) {
        return c.error(failure(error, dir))
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
    examples: [
      { args: { dir: 'games/pong' }, options: { at: '1,120,600', press: ['Space@1'] }, description: 'Three frames of one match' },
    ],
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async run(c) {
      let dir: string | undefined
      try {
        dir = dirname(gameFile(c.args.dir))
        const at = parseTicks(c.options.at ?? '1')
        const { press, hold, set, seed, out } = c.options
        simulate(await loadGame(c.args.dir), { ticks: Math.max(...at), press, hold, set, seed })
        return { files: await shoot(c.args.dir, { at, out, press, hold, set, seed }) }
      } catch (error) {
        return c.error(failure(error, dir))
      }
    },
  })
  .command('run', {
    description: 'Play a game in a browser window; Esc quits and saving a file reloads it. For people, not agents',
    args,
    options: z.object({
      seed: z.number().int().optional().describe('Random seed; without one, each load picks a new seed'),
      serveOnly: z.boolean().optional().describe('Serve the page and print its address without opening a window'),
    }),
    mcp: false,
    async *run(c) {
      try {
        gameFile(c.args.dir)
      } catch (error) {
        return c.error(failure(error))
      }
      yield* play(c.args.dir, { seed: c.options.seed, window: !c.options.serveOnly })
    },
  })

cli.serve()

export default cli
