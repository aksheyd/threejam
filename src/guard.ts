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
// The platform's own, kept before game code can reach it, to tell an empty locale list from a named one.
const INTL_AT_LOAD: unknown = Reflect.get(globalThis, 'Intl')
const CANONICAL: unknown = isObject(INTL_AT_LOAD) ? Reflect.get(INTL_AT_LOAD, 'getCanonicalLocales') : undefined

function refuse(name: string, instead: string): never {
  throw new GameError(`${name} would make runs differ; ${instead}`)
}

function blocked(name: string, instead: string): () => never {
  // A function, not an arrow, so new WeakRef() fails with this message too.
  return function () {
    return refuse(name, instead)
  }
}

// What game code finds instead of performance, crypto, and structuredClone while the guard is up, as in sim's realm, which lacks them: sim and a page agree on what's there.
const PERFORMANCE = Object.freeze({ now: blocked('performance.now()', CLOCK) })
const CRYPTO = Object.freeze({ getRandomValues: blocked('crypto.getRandomValues()', SEEDED), randomUUID: blocked('crypto.randomUUID()', SEEDED) })

// The globals sim's realm has beyond the language: the stand-ins, which a page's own give way to while the guard is up.
export const STAND_INS = ['performance', 'crypto', 'structuredClone', ...TIMERS] as const

// A realm with no clock, timers, crypto, or structuredClone, like the one sim runs a game in, keeps the stand-ins game code finds in their place; the engine copies with structuredClone even while the guard is down.
export function withStandIns(): void {
  const missing: Record<string, unknown> = { performance: PERFORMANCE, crypto: CRYPTO, structuredClone: clonePlain }
  for (const key of TIMERS) missing[key] = blocked(`${key}()`, CLOCK)
  for (const [key, value] of Object.entries(missing)) if (Reflect.get(globalThis, key) === undefined) Reflect.set(globalThis, key, value)
}

// The engine copies only plain data, which game code may copy too; anything else would copy differently than a browser's structuredClone does.
export function clonePlain(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const prototype: unknown = Object.getPrototypeOf(value)
  const array = Array.isArray(value)
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new GameError('structuredClone copies only numbers, strings, booleans, null, arrays, and plain objects in game code')
  }
  const copy: object = array ? new Array<unknown>(value.length) : {}
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: clonePlain(Reflect.get(value, key)), writable: true, enumerable: true, configurable: true })
  }
  return copy
}

// A property the guard replaces while it's up: with a value, or with a getter for an accessor like Intl.DateTimeFormat.prototype.format.
type Change = { readonly owner: object; readonly key: string; readonly value: unknown } | { readonly owner: object; readonly key: string; readonly get: () => unknown }

// set swaps a writable data property's value, several times faster than define, which replaces the property, as an accessor or a missing one needs; set keeps the property's attributes to put it back whole after game code changes it.
type Swap =
  | { readonly how: 'set'; readonly owner: object; readonly key: string; readonly value: unknown; readonly enumerable: boolean; readonly configurable: boolean }
  | { readonly how: 'define'; readonly owner: object; readonly key: string; readonly descriptor: PropertyDescriptor }

// load is while a game's or driver's modules load, and run while start, update, or a driver runs.
type Window = 'load' | 'run'

let running = 0
let raised = 0
let plans: Readonly<Record<Window, readonly Swap[]>> | undefined
// What game code put in place of a swapped property, or null where it deleted one. sim keeps the guard up for a whole run and a page lowers it between batches of ticks, so each raise puts these back, and game code sees one run whatever the batches.
const theirs = new Map<Swap, PropertyDescriptor | null>()

// Each run starts with the guard's own stand-ins, whatever game code put in their place in the run before.
export function newRun(): void {
  theirs.clear()
}

// Swaps the clock, unseeded randomness, timers, garbage collection, the locale, and the time zone for errors or fixed values, and Math's functions for portable ones, while fn runs. It changes the platform's own objects, not only the globals that name them, so no prototype or constructor game code can walk to leads back to the originals; it keeps runs repeatable, not code contained.
export function guarded<T>(fn: () => T): T {
  return up('run', () => {
    running += 1
    try {
      const result = fn()
      if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
        throw new GameError('start and update must not be async, since game time only moves in ticks')
      }
      return result
    } finally {
      running -= 1
    }
  })
}

// Loads a game's or driver's modules with the guard up, so what their top level keeps from Math, Date, or Intl stays guarded. Math's functions kept there turn portable only once the game runs, so top-level code computes what it does in a test that imports the game.
export function loading<T>(load: () => T): T {
  return up('load', load)
}

// Keeps the guard up through a whole run of ticks, so each tick's guarded() finds it raised and swaps nothing, since one raise costs more than a tick; between ticks only the engine runs, and nothing it does depends on what the guard swaps.
export function throughout<T>(ticks: () => T): T {
  return up('run', ticks)
}

function up<T>(window: Window, fn: () => T): T {
  const lower = raised === 0 ? raise(window) : undefined
  raised += 1
  try {
    return fn()
  } finally {
    raised -= 1
    lower?.()
  }
}

function raise(window: Window): () => void {
  plans ??= plan()
  const swaps = plans[window]
  const values = new Array<unknown>(swaps.length)
  const descriptors = new Array<PropertyDescriptor | undefined>(swaps.length)
  // What went in whole, game code's own or a define swap's; a set swap that finds nothing of game code's sets the plan's value.
  const placed = new Array<PropertyDescriptor | null | undefined>(swaps.length)
  for (let i = 0; i < swaps.length; i++) {
    const swap = swaps[i]
    const kept = theirs.get(swap)
    if (swap.how === 'set') {
      values[i] = Reflect.get(swap.owner, swap.key)
      if (kept === undefined) Reflect.set(swap.owner, swap.key, swap.value)
      else place(swap.owner, swap.key, (placed[i] = kept))
    } else {
      descriptors[i] = Object.getOwnPropertyDescriptor(swap.owner, swap.key)
      place(swap.owner, swap.key, (placed[i] = kept === undefined ? swap.descriptor : kept))
    }
  }
  return () => {
    for (let i = swaps.length - 1; i >= 0; i--) {
      const swap = swaps[i]
      const put = placed[i]
      // A descriptor, not a read, so no getter game code put there runs.
      const now = Object.getOwnPropertyDescriptor(swap.owner, swap.key)
      if (swap.how === 'set') {
        const untouched = put === undefined ? now?.writable === true && now.value === swap.value : alike(now, put)
        if (!untouched) theirs.set(swap, now ?? null)
        if (untouched && put === undefined) Reflect.set(swap.owner, swap.key, values[i])
        else Object.defineProperty(swap.owner, swap.key, { value: values[i], writable: true, enumerable: swap.enumerable, configurable: swap.configurable })
      } else {
        if (put !== undefined && !alike(now, put)) theirs.set(swap, now ?? null)
        place(swap.owner, swap.key, descriptors[i] ?? null)
      }
    }
  }
}

function place(owner: object, key: string, descriptor: PropertyDescriptor | null): void {
  if (descriptor === null) Reflect.deleteProperty(owner, key)
  else Object.defineProperty(owner, key, descriptor)
}

function alike(now: PropertyDescriptor | undefined, put: PropertyDescriptor | null): boolean {
  if (now === undefined || put === null) return now === undefined && put === null
  return now.value === put.value && now.writable === put.writable && now.get === put.get && now.set === put.set
}

// Made once, from the platform's own objects, so every window puts the same stand-ins in place.
function plan(): Record<Window, Swap[]> {
  const shared: Change[] = [{ owner: Math, key: 'random', value: blocked('Math.random()', SEEDED) }, ...host(), ...dates(), ...intl(), ...temporal(), ...localeMethods()]
  const math = (pick: (key: string, portable: Function) => unknown) => MATH.map(([key, portable]): Change => ({ owner: Math, key, value: pick(key, portable) }))
  return {
    run: [...math((_, portable) => portable), ...shared].map(swap),
    load: [...math((key, portable) => deferred(Reflect.get(Math, key), portable)), ...shared].map(swap),
  }
}

function swap(change: Change): Swap {
  const { owner, key } = change
  if ('get' in change) return { how: 'define', owner, key, descriptor: { get: change.get, configurable: true } }
  const native = Object.getOwnPropertyDescriptor(owner, key)
  if (native?.writable === true) return { how: 'set', owner, key, value: change.value, enumerable: native.enumerable === true, configurable: native.configurable === true }
  return { how: 'define', owner, key, descriptor: { value: change.value, writable: true, configurable: true } }
}

function deferred(native: unknown, portable: Function): Function {
  if (typeof native !== 'function') return portable
  return (...args: unknown[]) => Reflect.apply(running > 0 ? portable : native, undefined, args)
}

function host(): Change[] {
  return [
    { owner: globalThis, key: 'performance', value: PERFORMANCE },
    { owner: globalThis, key: 'crypto', value: CRYPTO },
    { owner: globalThis, key: 'structuredClone', value: clonePlain },
    ...TIMERS.map((key) => ({ owner: globalThis, key, value: blocked(`${key}()`, CLOCK) })),
    ...['WeakRef', 'FinalizationRegistry'].map((key) => ({ owner: globalThis, key, value: blocked(`new ${key}()`, COLLECTED) })),
  ]
}

// Date at its own objects: the constructor that both the global and Date.prototype.constructor name has no clock, and the static and prototype methods, which every date and every subclass reaches, read no clock or time zone.
function dates(): Change[] {
  const native = Date
  const prototype: object = native.prototype
  const date: DateConstructor = new Proxy(native, {
    apply: blocked('Date()', CLOCK),
    construct(target, args, newTarget) {
      if (args.length === 0) refuse('new Date()', CLOCK)
      if (args.length > 1) refuse('new Date(year, month, ...)', `${ZONE}, so use new Date(Date.UTC(year, month, ...))`)
      checkDate(args[0], 'new Date')
      return Reflect.construct(target, args, newTarget)
    },
  })
  const parse = native.parse
  const changes: Change[] = [
    { owner: globalThis, key: 'Date', value: date },
    { owner: prototype, key: 'constructor', value: date },
    { owner: native, key: 'now', value: blocked('Date.now()', CLOCK) },
    { owner: native, key: 'parse', value: (text: unknown) => (checkDate(text, 'Date.parse'), Reflect.apply(parse, native, [text])) },
  ]
  for (const [key, instead] of LOCAL_TIME) {
    if (typeof Reflect.get(prototype, key) === 'function') changes.push({ owner: prototype, key, value: blocked(`date.${key}()`, `${ZONE}, so use ${instead}`) })
  }
  for (const key of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const method: unknown = Reflect.get(prototype, key)
    if (typeof method === 'function') changes.push({ owner: prototype, key, value: inLocale(method, true) })
  }
  return changes
}

function checkDate(value: unknown, call: string): void {
  if (typeof value === 'string' && !ISO_DATE.test(value)) {
    refuse(`${call}(${quote(value)})`, 'write dates as ISO 8601 with a Z or an offset, like "2024-01-31T12:00:00Z", since other strings depend on the time zone or the browser')
  }
}

// Intl at its own object: each constructor, which both the namespace and the constructor's prototype name, defaults to en-US, and every DateTimeFormat's format and formatToParts read no clock.
function intl(): Change[] {
  if (!isObject(INTL_AT_LOAD)) return []
  const changes: Change[] = []
  for (const name of INTL) {
    const native: unknown = Reflect.get(INTL_AT_LOAD, name)
    if (typeof native !== 'function') continue
    const pinned = inLocaleFormat(native, name === 'DateTimeFormat')
    const prototype: unknown = Reflect.get(native, 'prototype')
    changes.push({ owner: INTL_AT_LOAD, key: name, value: pinned })
    if (isObject(prototype)) changes.push({ owner: prototype, key: 'constructor', value: pinned })
    if (name === 'DateTimeFormat' && isObject(prototype)) changes.push(...clockless(prototype))
  }
  return changes
}

function inLocaleFormat(native: Function, dates: boolean): Function {
  const args = (given: unknown[]) => [localeList(given[0]), dates ? zoned(given[1]) : given[1], ...given.slice(2)]
  const format: Function = new Proxy(native, {
    construct: (target, given, newTarget) => Reflect.construct(target, args(given), newTarget === format ? target : newTarget),
    apply: (target, self, given) => Reflect.apply(target, self, args(given)),
  })
  return format
}

// A DateTimeFormat reads the clock when it formats no date.
function clockless(prototype: object): Change[] {
  const changes: Change[] = []
  const getter = Object.getOwnPropertyDescriptor(prototype, 'format')?.get
  if (getter !== undefined) {
    const formats = new WeakMap<object, Function>()
    const get = function (this: unknown): unknown {
      const bound: unknown = Reflect.apply(getter, this, [])
      if (typeof bound !== 'function' || !isObject(this)) return bound
      const known = formats.get(this)
      if (known !== undefined) return known
      const format = (date?: unknown) => (date === undefined ? refuse('Intl.DateTimeFormat format() with no date', CLOCK) : Reflect.apply(bound, undefined, [date]))
      formats.set(this, format)
      return format
    }
    changes.push({ owner: prototype, key: 'format', get })
  }
  const parts: unknown = Reflect.get(prototype, 'formatToParts')
  if (typeof parts === 'function') {
    const value = function (this: unknown, date?: unknown): unknown {
      return date === undefined ? refuse('Intl.DateTimeFormat formatToParts() with no date', CLOCK) : Reflect.apply(parts, this, [date])
    }
    changes.push({ owner: prototype, key: 'formatToParts', value })
  }
  return changes
}

// Temporal at its own object: Temporal.Now's methods read no clock.
function temporal(): Change[] {
  const temporal: unknown = Reflect.get(globalThis, 'Temporal')
  const now: unknown = isObject(temporal) ? Reflect.get(temporal, 'Now') : undefined
  if (!isObject(now)) return []
  return Object.getOwnPropertyNames(now)
    .filter((key) => typeof Reflect.get(now, key) === 'function')
    .map((key) => ({ owner: now, key, value: blocked(`Temporal.Now.${key}()`, CLOCK) }))
}

// The locale methods of primitives, which game code can't reach through a guarded global, and Temporal's.
function localeMethods(): Change[] {
  const changes: Change[] = []
  const pin = (owner: unknown, key: string, make: (native: Function) => Function) => {
    const native: unknown = isObject(owner) ? Reflect.get(owner, key) : undefined
    if (isObject(owner) && typeof native === 'function') changes.push({ owner, key, value: make(native) })
  }
  pin(Number.prototype, 'toLocaleString', (native) => inLocale(native, false))
  pin(BigInt.prototype, 'toLocaleString', (native) => inLocale(native, false))
  pin(String.prototype, 'localeCompare', compared)
  pin(String.prototype, 'toLocaleLowerCase', (native) => inLocale(native, false))
  pin(String.prototype, 'toLocaleUpperCase', (native) => inLocale(native, false))
  const temporal: unknown = Reflect.get(globalThis, 'Temporal')
  if (!isObject(temporal)) return changes
  for (const name of Object.getOwnPropertyNames(temporal)) {
    const type: unknown = Reflect.get(temporal, name)
    // An Instant is formatted in a time zone, while a ZonedDateTime has its own and the plain types have none.
    if (typeof type === 'function') pin(Reflect.get(type, 'prototype'), 'toLocaleString', (native) => inLocale(native, name === 'Instant'))
  }
  return changes
}

function inLocale(native: Function, zone: boolean): Function {
  return function (this: unknown, locales?: unknown, options?: unknown): unknown {
    return Reflect.apply(native, this, [localeList(locales), zone ? zoned(options) : options])
  }
}

function compared(native: Function): Function {
  return function (this: unknown, that: unknown, locales?: unknown, options?: unknown): unknown {
    return Reflect.apply(native, this, [that, localeList(locales), options])
  }
}

// The locales the game names, or en-US when it names none: Intl reads both undefined and an empty list as the machine's own.
function localeList(given: unknown): unknown {
  if (typeof CANONICAL !== 'function') return given === undefined ? LOCALE : given
  const list: unknown = Reflect.apply(CANONICAL, INTL_AT_LOAD, [given])
  return Array.isArray(list) && list.length > 0 ? list : LOCALE
}

function zoned(options: unknown): unknown {
  if (options === undefined) return { timeZone: UTC }
  if (!isObject(options) || Reflect.get(options, 'timeZone') !== undefined) return options
  return Object.create(options, { timeZone: { value: UTC, enumerable: true } })
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
