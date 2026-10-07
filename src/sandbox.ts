// The side of the sandbox that runs inside the realm each game gets: it fixes the realm's globals, then loads the game and its driver with the guard up and runs one simulation.
import { parseGame, simulate, untilCondition } from './engine.ts'
import { RunError, UsageError, type Phase } from './errors.ts'
import { loading, withStandIns } from './guard.ts'
import { defineDriver, driverFor, isDrive, type Drive, type Game, type LogEntry, type Snapshot, type SoundEntry } from './types.ts'

// The property of the realm's global object the child process finds the sandbox at.
export const SANDBOX = 'threejam'

export interface Request {
  readonly ticks: number
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly pointer?: readonly string[]
  readonly set?: readonly string[]
  readonly seed?: number
  readonly every?: number
  readonly until?: string
  readonly only?: string
  readonly clip?: boolean
  readonly assets: readonly string[]
  // The driver as the command line named it, for messages; its code is in the bundle.
  readonly driver?: string
}

export type Reply =
  | {
      readonly ok: true
      readonly snapshots: readonly Snapshot[]
      readonly logs: readonly LogEntry[]
      readonly sounds: readonly SoundEntry[]
      readonly tick: number
      readonly reached: boolean
    }
  | { readonly ok: false; readonly failure: Failure }

// lost means the reply couldn't be made, as when a game breaks the built-in objects it needs; timeout comes from the child process.
export type Failure =
  | { readonly kind: 'usage'; readonly message: string }
  | { readonly kind: 'run'; readonly phase: Phase; readonly tick: number; readonly thrown: Thrown }
  | { readonly kind: 'thrown'; readonly thrown: Thrown }
  | { readonly kind: 'timeout'; readonly at: Place }
  | { readonly kind: 'lost' }

export type Thrown = { readonly kind: 'error'; readonly name: string; readonly message: string; readonly stack: string } | { readonly kind: 'value'; readonly text: string }

// Where the game was, so a run that runs out of time can say: loading its modules, in start, in the driver before a tick, in update at a tick, or after the last tick.
export type Stage = 'load' | Phase | 'end'

export interface Place {
  readonly stage: Stage
  readonly tick: number
}

export interface Modules {
  readonly game: () => unknown
  readonly driver: (() => unknown) | undefined
}

let stage: Stage = 'load'
let updates = 0

// The bundle calls this before any of the game's modules load, which happens on the first run.
export function sandbox(modules: Modules): void {
  prepareRealm()
  Reflect.set(globalThis, SANDBOX, Object.freeze({ run: (request: string) => reply(modules, request), where }))
}

// The realm has the language's built-ins and nothing else; this is where its globals get fixed before a game can capture them.
function prepareRealm(): void {
  withStandIns()
}

// Concatenated from a fixed word and a count, so reading it after a timeout runs none of the game's code.
function where(): string {
  return `{"stage":"${stage}","tick":${stage === 'driver' ? updates + 1 : updates}}`
}

function reply(modules: Modules, request: string): string {
  let answer: Reply
  try {
    answer = { ok: true, ...simulated(modules, JSON.parse(request)) }
  } catch (error) {
    answer = { ok: false, failure: failureOf(error) }
  }
  try {
    return JSON.stringify(answer)
  } catch {
    return JSON.stringify({ ok: false, failure: { kind: 'lost' } })
  }
}

function simulated(modules: Modules, request: Request): Omit<Extract<Reply, { ok: true }>, 'ok'> {
  const game = tracked(parseGame(defaultExport(loading(modules.game))))
  const drive = modules.driver === undefined ? undefined : trackedDriver(driverIn(loading(modules.driver), request.driver))
  const until = request.until === undefined ? undefined : untilCondition(request.until)
  const { ticks, press, hold, pointer, set, seed, every, clip, assets, only } = request
  const run = simulate(game, { ticks, press, hold, pointer, set, seed, every, clip, assets, drive, until, only })
  stage = 'end'
  const { snapshots } = run
  return { snapshots, logs: run.logs, sounds: run.sounds, tick: run.tick, reached: run.reached }
}

function defaultExport(module: unknown): unknown {
  return typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined
}

function driverIn(module: unknown, name: string | undefined): Drive {
  const drive = defaultExport(module)
  if (isDrive(drive)) return drive
  throw new UsageError(`--driver ${name} must export default a function ({ world, tick, keys, pointer, random }) => keys or { keys, pointer }, or defineDriver(...)`)
}

function tracked(game: Game): Game {
  const { start, update } = game
  return {
    ...game,
    start:
      start === undefined
        ? undefined
        : (world, ctx) => {
            stage = 'start'
            start.call(game, world, ctx)
          },
    update(world, ctx) {
      stage = 'update'
      updates += 1
      update.call(game, world, ctx)
    },
  }
}

function trackedDriver(drive: Drive): Drive {
  return defineDriver(() => {
    stage = 'driver'
    const driver = driverFor(drive)
    return (frame) => {
      stage = 'driver'
      return driver(frame)
    }
  })
}

function failureOf(error: unknown): Failure {
  if (error instanceof UsageError) return { kind: 'usage', message: error.message }
  if (error instanceof RunError) return { kind: 'run', phase: error.phase, tick: error.tick, thrown: thrownOf(error.cause) }
  return { kind: 'thrown', thrown: thrownOf(error) }
}

function thrownOf(value: unknown): Thrown {
  try {
    if (value instanceof Error) return { kind: 'error', name: String(value.name), message: String(value.message), stack: String(value.stack ?? '') }
    return { kind: 'value', text: String(value) }
  } catch {
    return { kind: 'value', text: 'a value that has no text' }
  }
}
