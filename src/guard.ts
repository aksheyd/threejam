import { GameError } from './errors.ts'

type Timers = Pick<typeof globalThis, 'setTimeout' | 'setInterval' | 'queueMicrotask'>

function blocked(name: string, instead: string): () => never {
  return () => {
    throw new GameError(`${name} would make runs differ; ${instead}`)
  }
}

const CLOCK = 'count ticks with ctx.tick, since game time only moves in ticks'

export function guarded<T>(fn: () => T): T {
  const g = globalThis as typeof globalThis & Timers
  const frames = typeof g.requestAnimationFrame === 'function'
  const saved = {
    random: Math.random,
    Date: g.Date,
    now: performance.now,
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    queueMicrotask: g.queueMicrotask,
    requestAnimationFrame: g.requestAnimationFrame,
  }
  Math.random = blocked('Math.random()', 'use ctx.random(), which is seeded')
  g.Date = new Proxy(saved.Date, {
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
  g.setTimeout = blocked('setTimeout()', CLOCK) as unknown as typeof setTimeout
  g.setInterval = blocked('setInterval()', CLOCK) as unknown as typeof setInterval
  g.queueMicrotask = blocked('queueMicrotask()', CLOCK)
  if (frames) g.requestAnimationFrame = blocked('requestAnimationFrame()', CLOCK)
  try {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      throw new GameError('start and update must not be async, since game time only moves in ticks')
    }
    return result
  } finally {
    Math.random = saved.random
    g.Date = saved.Date
    performance.now = saved.now
    g.setTimeout = saved.setTimeout
    g.setInterval = saved.setInterval
    g.queueMicrotask = saved.queueMicrotask
    if (frames) g.requestAnimationFrame = saved.requestAnimationFrame
  }
}
