import { GameError } from './errors.ts'
import { PORTABLE } from './math.ts'

const CLOCK = 'count ticks with ctx.tick, since game time only moves in ticks'
const TIMERS = ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'] as const
const MATH = Object.entries(PORTABLE)

function blocked(name: string, instead: string): () => never {
  return () => {
    throw new GameError(`${name} would make runs differ; ${instead}`)
  }
}

// A realm with no timers or clock, like the one sim runs a game in, gets ones that fail the way guarded() makes them fail, so a game hears why.
export function withoutClocks(): void {
  for (const name of TIMERS) if (Reflect.get(globalThis, name) === undefined) Reflect.set(globalThis, name, blocked(`${name}()`, CLOCK))
  if (Reflect.get(globalThis, 'performance') === undefined) Reflect.set(globalThis, 'performance', { now: blocked('performance.now()', CLOCK) })
}

// Swaps the clock, Math.random, and the timers for errors and Math's functions for portable ones while fn runs; it keeps runs repeatable, not code contained.
export function guarded<T>(fn: () => T): T {
  const clock: unknown = Reflect.get(globalThis, 'performance')
  const saved = { random: Math.random, Date: globalThis.Date, now: isObject(clock) ? Reflect.get(clock, 'now') : undefined }
  const timers = TIMERS.filter((name) => typeof Reflect.get(globalThis, name) === 'function').map((name) => ({
    name,
    original: Reflect.get(globalThis, name),
  }))
  const natives = MATH.map(([name]) => ({ name, native: Reflect.get(Math, name) }))
  for (const [name, portable] of MATH) Reflect.set(Math, name, portable)
  Math.random = blocked('Math.random()', 'use ctx.random(), which is seeded')
  globalThis.Date = new Proxy(saved.Date, {
    apply: blocked('Date()', CLOCK),
    construct(target, args) {
      if (args.length === 0) blocked('new Date()', CLOCK)()
      return Reflect.construct(target, args)
    },
    get(target, prop) {
      return prop === 'now' ? blocked('Date.now()', CLOCK) : Reflect.get(target, prop)
    },
  })
  if (isObject(clock)) Reflect.set(clock, 'now', blocked('performance.now()', CLOCK))
  for (const { name } of timers) Reflect.set(globalThis, name, blocked(`${name}()`, CLOCK))
  try {
    const result = fn()
    if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
      throw new GameError('start and update must not be async, since game time only moves in ticks')
    }
    return result
  } finally {
    for (const { name, native } of natives) Reflect.set(Math, name, native)
    Math.random = saved.random
    globalThis.Date = saved.Date
    if (isObject(clock)) Reflect.set(clock, 'now', saved.now)
    for (const { name, original } of timers) Reflect.set(globalThis, name, original)
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
