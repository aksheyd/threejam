import { GameError, quote } from './errors.ts'
import { PORTABLE } from './math.ts'

const CLOCK = 'count ticks with ctx.tick, since game time only moves in ticks'
const SEEDED = 'use ctx.random(), which is seeded'
const COLLECTED = 'keep what the game needs on its entities, since garbage collection runs at different times'
const ZONE = "it reads the machine's time zone"
// Game code formats and compares text as en-US does, and dates in UTC, unless it names a locale or a time zone itself.
const LOCALE = 'en-US'
const UTC = 'UTC'
const TIMERS = ['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'] as const
const MATH = Object.entries(PORTABLE)
const INTL = ['Collator', 'DateTimeFormat', 'DisplayNames', 'DurationFormat', 'ListFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat', 'Segmenter'] as const
const PARTS = ['Date', 'Day', 'FullYear', 'Hours', 'Milliseconds', 'Minutes', 'Month', 'Seconds'] as const
// The Date methods that read or write the local time, each with what to use instead.
const LOCAL_TIME: ReadonlyArray<readonly [string, string]> = [
  ...PARTS.map((part) => [`get${part}`, `getUTC${part}()`] as const),
  ...PARTS.filter((part) => part !== 'Day').map((part) => [`set${part}`, `setUTC${part}()`] as const),
  ['getYear', 'getUTCFullYear()'],
  ['setYear', 'setUTCFullYear()'],
  ['getTimezoneOffset', "0, UTC's offset"],
  ...['toString', 'toDateString', 'toTimeString'].map((name) => [name, 'toISOString() or toUTCString()'] as const),
]
// The date strings every engine reads alike: ISO 8601, with a Z or an offset when there's a time.
const ISO_DATE = /^(?:[+-]\d{6}|\d{4})(?:-\d{2}(?:-\d{2})?)?(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/

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

// Swaps the clock, unseeded randomness, timers, garbage collection, the locale, and the time zone for errors or fixed values, and Math's functions for portable ones, while fn runs; it keeps runs repeatable, not code contained.
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
  const shared = [{ owner: Math, key: 'random', value: blocked('Math.random()', SEEDED) }, ...globals(), ...localeMethods()].map(swap)
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

// The locale methods of primitives, which game code can't reach through a guarded global, and Temporal's.
function localeMethods(): Change[] {
  const swaps: Change[] = []
  const pin = (owner: unknown, key: string, make: (native: Function) => Function) => {
    const native: unknown = isObject(owner) ? Reflect.get(owner, key) : undefined
    if (isObject(owner) && typeof native === 'function') swaps.push({ owner, key, value: make(native) })
  }
  pin(Number.prototype, 'toLocaleString', (native) => inLocale(native, false))
  pin(BigInt.prototype, 'toLocaleString', (native) => inLocale(native, false))
  pin(String.prototype, 'localeCompare', compared)
  pin(String.prototype, 'toLocaleLowerCase', (native) => inLocale(native, false))
  pin(String.prototype, 'toLocaleUpperCase', (native) => inLocale(native, false))
  const temporal: unknown = Reflect.get(globalThis, 'Temporal')
  if (!isObject(temporal)) return swaps
  for (const name of Object.getOwnPropertyNames(temporal)) {
    const type: unknown = Reflect.get(temporal, name)
    // An Instant is formatted in a time zone, while a ZonedDateTime has its own and the plain types have none.
    if (typeof type === 'function') pin(Reflect.get(type, 'prototype'), 'toLocaleString', (native) => inLocale(native, name === 'Instant'))
  }
  return swaps
}

// Date in game code: no clock, and no time zone. Dates it makes have their own prototype, so their local-time methods fail without the guard touching Date.prototype on every tick.
function guardedDate(native: DateConstructor): DateConstructor {
  const methods: PropertyDescriptorMap = {}
  for (const [key, instead] of LOCAL_TIME) {
    if (typeof Reflect.get(native.prototype, key) === 'function') methods[key] = { value: blocked(`date.${key}()`, `${ZONE}, so use ${instead}`), writable: true, configurable: true }
  }
  for (const key of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const method: unknown = Reflect.get(native.prototype, key)
    if (typeof method === 'function') methods[key] = { value: inLocale(method, true), writable: true, configurable: true }
  }
  const prototype: object = Object.create(native.prototype, methods)
  function Made() {}
  Made.prototype = prototype
  const now = blocked('Date.now()', CLOCK)
  const parse = (text: unknown) => {
    checkDate(text, 'Date.parse')
    return Reflect.apply(native.parse, native, [text])
  }
  const date: DateConstructor = new Proxy(native, {
    apply: blocked('Date()', CLOCK),
    construct(target, args, newTarget) {
      if (args.length === 0) refuse('new Date()', CLOCK)
      if (args.length > 1) refuse('new Date(year, month, ...)', `${ZONE}, so use new Date(Date.UTC(year, month, ...))`)
      checkDate(args[0], 'new Date')
      return Reflect.construct(target, args, newTarget === date ? Made : newTarget)
    },
    get(target, key) {
      return key === 'now' ? now : key === 'parse' ? parse : Reflect.get(target, key)
    },
  })
  Object.defineProperty(prototype, 'constructor', { value: date, writable: true, configurable: true })
  return date
}

function checkDate(value: unknown, call: string): void {
  if (typeof value === 'string' && !ISO_DATE.test(value)) {
    refuse(`${call}(${quote(value)})`, 'write dates as ISO 8601 with a Z or an offset, like "2024-01-31T12:00:00Z", since other strings depend on the time zone or the browser')
  }
}

function guardedIntl(intl: object): object {
  const pinned: PropertyDescriptorMap = {}
  for (const name of INTL) {
    const native: unknown = Reflect.get(intl, name)
    if (typeof native === 'function') pinned[name] = { value: inLocaleFormat(native, name === 'DateTimeFormat'), writable: true, configurable: true }
  }
  return Object.create(intl, pinned)
}

function inLocaleFormat(native: Function, dates: boolean): Function {
  const args = (given: unknown[]) => [given[0] === undefined ? LOCALE : given[0], dates ? zoned(given[1]) : given[1], ...given.slice(2)]
  const made = <T>(value: T): T => (dates ? clocked(value) : value)
  const format: Function = new Proxy(native, {
    construct: (target, given, newTarget) => made(Reflect.construct(target, args(given), newTarget === format ? target : newTarget)),
    apply: (target, self, given) => made(Reflect.apply(target, self, args(given))),
  })
  return format
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

function inLocale(native: Function, zone: boolean): Function {
  return function (this: unknown, locales?: unknown, options?: unknown): unknown {
    return Reflect.apply(native, this, [locales === undefined ? LOCALE : locales, zone ? zoned(options) : options])
  }
}

function compared(native: Function): Function {
  return function (this: unknown, that: unknown, locales?: unknown, options?: unknown): unknown {
    return Reflect.apply(native, this, [that, locales === undefined ? LOCALE : locales, options])
  }
}

function zoned(options: unknown): unknown {
  if (options === undefined) return { timeZone: UTC }
  if (!isObject(options) || Reflect.get(options, 'timeZone') !== undefined) return options
  return Object.create(options, { timeZone: { value: UTC, enumerable: true } })
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
