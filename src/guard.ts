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

export function guarded<T>(fn: () => T): T {
  const saved = { random: Math.random, Date: globalThis.Date, now: performance.now }
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
  performance.now = blocked('performance.now()', CLOCK)
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
    performance.now = saved.now
    for (const { name, original } of timers) Reflect.set(globalThis, name, original)
  }
}
