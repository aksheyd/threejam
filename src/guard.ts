import { GameError } from './errors.ts'
import { PORTABLE } from './math.ts'

const CLOCK = 'count ticks with ctx.tick, since game time only moves in ticks'
const SEEDED = 'use ctx.random(), which is seeded'
const COLLECTED = 'keep what the game needs on its entities, since garbage collection runs at different times'
const TIMERS = ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'] as const
const MATH = Object.entries(PORTABLE)

function refuse(name: string, instead: string): never {
  throw new GameError(`${name} would make runs differ; ${instead}`)
}

function blocked(name: string, instead: string): () => never {
  // A function, not an arrow, so new WeakRef() fails with this message too.
  return function () {
    return refuse(name, instead)
  }
}

// What game code finds instead of performance and crypto while the guard is up, as in sim's realm, which has neither: sim and a page agree on what's there.
const PERFORMANCE = Object.freeze({ now: blocked('performance.now()', CLOCK) })
const CRYPTO = Object.freeze({ getRandomValues: blocked('crypto.getRandomValues()', SEEDED), randomUUID: blocked('crypto.randomUUID()', SEEDED) })

// A realm with no clock, timers, or crypto, like the one sim runs a game in, keeps the stand-ins game code finds in their place, so the guard swaps plain properties there on every tick.
export function withStandIns(): void {
  const missing: Record<string, unknown> = { performance: PERFORMANCE, crypto: CRYPTO }
  for (const key of TIMERS) missing[key] = blocked(`${key}()`, CLOCK)
  for (const [key, value] of Object.entries(missing)) if (Reflect.get(globalThis, key) === undefined) Reflect.set(globalThis, key, value)
}

// A property the guard replaces, and what game code finds there while the guard is up.
interface Change {
  readonly owner: object
  readonly key: string
  readonly value: unknown
}

// plain is for a writable data property, which gets and sets swap several times faster than descriptors do; the guard swaps on every tick.
interface Swap extends Change {
  readonly plain: boolean
}

// load is while a game's or driver's modules load, and run while start, update, or a driver runs.
type Window = 'load' | 'run'

let running = 0
let plans: Readonly<Record<Window, readonly Swap[]>> | undefined

// Swaps the clock, unseeded randomness, timers, and garbage collection for errors, and Math's functions for portable ones, while fn runs; it keeps runs repeatable, not code contained.
export function guarded<T>(fn: () => T): T {
  const lower = raise('run')
  running += 1
  try {
    const result = fn()
    if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
      throw new GameError('start and update must not be async, since game time only moves in ticks')
    }
    return result
  } finally {
    running -= 1
    lower()
  }
}

// Loads a game's or driver's modules with the guard up, so what their top level keeps from Math, Date, or Intl stays guarded. Math's functions kept there turn portable only once the game runs, so top-level code computes what it does in a test that imports the game.
export function loading<T>(load: () => T): T {
  const lower = raise('load')
  try {
    return load()
  } finally {
    lower()
  }
}

function raise(window: Window): () => void {
  plans ??= plan()
  const swaps = plans[window]
  const values = new Array<unknown>(swaps.length)
  const descriptors = new Array<PropertyDescriptor | undefined>(swaps.length)
  for (let i = 0; i < swaps.length; i++) {
    const { owner, key, value, plain } = swaps[i]
    if (plain) {
      values[i] = Reflect.get(owner, key)
      Reflect.set(owner, key, value)
    } else {
      descriptors[i] = Object.getOwnPropertyDescriptor(owner, key)
      Object.defineProperty(owner, key, { value, writable: true, configurable: true })
    }
  }
  return () => {
    for (let i = swaps.length - 1; i >= 0; i--) {
      const { owner, key, plain } = swaps[i]
      const before = descriptors[i]
      if (plain) Reflect.set(owner, key, values[i])
      else if (before === undefined) Reflect.deleteProperty(owner, key)
      else Object.defineProperty(owner, key, before)
    }
  }
}

// Made once, from the platform's own objects, so every window puts the same stand-ins in place.
function plan(): Record<Window, Swap[]> {
  const swap = (change: Change): Swap => ({ ...change, plain: Object.getOwnPropertyDescriptor(change.owner, change.key)?.writable === true })
  const shared = [{ owner: Math, key: 'random', value: blocked('Math.random()', SEEDED) }, ...globals()].map(swap)
  return {
    run: [...MATH.map(([key, portable]) => swap({ owner: Math, key, value: portable })), ...shared],
    load: [...MATH.map(([key, portable]) => swap({ owner: Math, key, value: deferred(Reflect.get(Math, key), portable) })), ...shared],
  }
}

function deferred(native: unknown, portable: Function): Function {
  if (typeof native !== 'function') return portable
  return (...args: unknown[]) => Reflect.apply(running > 0 ? portable : native, undefined, args)
}

function globals(): Change[] {
  const swaps: Change[] = [
    { owner: globalThis, key: 'performance', value: PERFORMANCE },
    { owner: globalThis, key: 'crypto', value: CRYPTO },
    ...TIMERS.map((key) => ({ owner: globalThis, key, value: blocked(`${key}()`, CLOCK) })),
    ...['WeakRef', 'FinalizationRegistry'].map((key) => ({ owner: globalThis, key, value: blocked(`new ${key}()`, COLLECTED) })),
  ]
  if (typeof Date === 'function') swaps.push({ owner: globalThis, key: 'Date', value: guardedDate(Date) })
  const intl: unknown = Reflect.get(globalThis, 'Intl')
  if (isObject(intl)) swaps.push({ owner: globalThis, key: 'Intl', value: guardedIntl(intl) })
  const temporal: unknown = Reflect.get(globalThis, 'Temporal')
  if (isObject(temporal)) swaps.push({ owner: globalThis, key: 'Temporal', value: guardedTemporal(temporal) })
  return swaps
}

// Date in game code has no clock.
function guardedDate(native: DateConstructor): DateConstructor {
  const now = blocked('Date.now()', CLOCK)
  const date: DateConstructor = new Proxy(native, {
    apply: blocked('Date()', CLOCK),
    construct(target, args, newTarget) {
      if (args.length === 0) refuse('new Date()', CLOCK)
      return Reflect.construct(target, args, newTarget === date ? target : newTarget)
    },
    get(target, key) {
      return key === 'now' ? now : Reflect.get(target, key)
    },
  })
  return date
}

// Intl in game code has no clock either.
function guardedIntl(intl: object): object {
  const native: unknown = Reflect.get(intl, 'DateTimeFormat')
  if (typeof native !== 'function') return intl
  const format: Function = new Proxy(native, {
    construct: (target, given, newTarget) => clocked(Reflect.construct(target, given, newTarget === format ? target : newTarget)),
    apply: (target, self, given) => clocked(Reflect.apply(target, self, given)),
  })
  return Object.create(intl, { DateTimeFormat: { value: format, writable: true, configurable: true } })
}

// A DateTimeFormat reads the clock when it formats no date, so the ones game code makes refuse to.
function clocked<T>(made: T): T {
  if (!isObject(made)) return made
  for (const key of ['format', 'formatToParts']) {
    const method: unknown = Reflect.get(made, key)
    if (typeof method !== 'function') continue
    const value = (date?: unknown) => (date === undefined ? refuse(`Intl.DateTimeFormat ${key}() with no date`, CLOCK) : Reflect.apply(method, made, [date]))
    Object.defineProperty(made, key, { value, writable: true, configurable: true })
  }
  return made
}

function guardedTemporal(temporal: object): object {
  const now: unknown = Reflect.get(temporal, 'Now')
  if (!isObject(now)) return temporal
  const stopped: PropertyDescriptorMap = {}
  for (const key of Object.getOwnPropertyNames(now)) {
    if (typeof Reflect.get(now, key) === 'function') stopped[key] = { value: blocked(`Temporal.Now.${key}()`, CLOCK), writable: true, configurable: true }
  }
  return Object.create(temporal, { Now: { value: Object.create(now, stopped), writable: true, configurable: true } })
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
