import { GameError, UsageError, quote, show } from './errors.ts'
import { KEYS, type Input, type Key, type Point } from './types.ts'

const BY_LOWER: ReadonlyMap<string, Key> = new Map(KEYS.map((key) => [key.toLowerCase(), key]))
const KEY_LIST = 'A-Z, 0-9, Space, Enter, Tab, Backspace, Shift, Ctrl, Alt, Up, Down, Left, Right, Mouse, and MouseRight'
const SCREEN = 'x from -2 to 2 and y from -1.5 to 1.5'

export const CENTER: Point = Object.freeze({ x: 0, y: 0 })

export function keyNamed(name: unknown): Key {
  const key = typeof name === 'string' ? BY_LOWER.get(name.toLowerCase()) : undefined
  if (key === undefined) throw new GameError(`unknown key ${JSON.stringify(name)}; keys are ${KEY_LIST}`)
  return key
}

export function pointAt(value: unknown): Point {
  const x = typeof value === 'object' && value !== null && 'x' in value ? value.x : undefined
  const y = typeof value === 'object' && value !== null && 'y' in value ? value.y : undefined
  if (typeof x !== 'number' || typeof y !== 'number' || !onScreen(x, y)) {
    throw new GameError(`the pointer must be { x, y } on the screen, with ${SCREEN}, got ${show(value)}`)
  }
  return Object.freeze({ x, y })
}

// What drivers and Session.step hand the engine: a list of keys, or { keys, pointer }.
export function controlsOf(value: unknown): { readonly keys: Key[]; readonly pointer: Point | undefined } {
  if (typeof value === 'string') throw new GameError(`the keys must be a list, like ["Space"], not the string ${show(value)}`)
  if (isIterable(value)) return { keys: Array.from(value, keyNamed), pointer: undefined }
  if (typeof value !== 'object' || value === null) throw new GameError(`expected the keys, like ["Space"], or { keys, pointer }, got ${show(value)}`)
  const keys = 'keys' in value ? value.keys : undefined
  const pointer = 'pointer' in value ? value.pointer : undefined
  if (typeof keys === 'string' || (keys !== undefined && !isIterable(keys))) throw new GameError(`keys must be a list, like ["Space"], got ${show(keys)}`)
  return { keys: keys === undefined ? [] : Array.from(keys, keyNamed), pointer: pointer === undefined ? undefined : pointAt(pointer) }
}

export class InputState implements Input {
  #now: ReadonlySet<Key> = new Set()
  #before: ReadonlySet<Key> = new Set()
  #pointer = CENTER
  readonly #asked = new Set<Key>()

  get pointer(): Point {
    return this.#pointer
  }

  // Every key game code has asked about.
  get asked(): ReadonlySet<Key> {
    return this.#asked
  }

  advance(held: Iterable<Key>, pointer: Point | undefined): void {
    this.#before = this.#now
    this.#now = new Set(held)
    if (pointer !== undefined) this.#pointer = pointer
  }

  held(key: Key): boolean {
    return this.#now.has(this.#ask(key))
  }

  pressed(key: Key): boolean {
    const k = this.#ask(key)
    return this.#now.has(k) && !this.#before.has(k)
  }

  released(key: Key): boolean {
    const k = this.#ask(key)
    return !this.#now.has(k) && this.#before.has(k)
  }

  #ask(name: Key): Key {
    const key = keyNamed(name)
    this.#asked.add(key)
    return key
  }
}

const CODES: Readonly<Record<string, Key>> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

export function keyFromCode(code: string): Key | undefined {
  const letterOrDigit = /^(?:Key([A-Z])|(?:Digit|Numpad)([0-9]))$/.exec(code)
  if (letterOrDigit) return BY_LOWER.get((letterOrDigit[1] ?? letterOrDigit[2]).toLowerCase())
  return CODES[code]
}

interface Span {
  readonly key: Key
  readonly first: number
  readonly last: number
}

export interface ScheduleOptions {
  readonly press: readonly string[]
  readonly hold: readonly string[]
  readonly ticks: number
  readonly clip: boolean
}

// With clip, keys after the last tick are dropped instead of rejected, so one schedule serves shorter runs.
export function schedule({ press, hold, ticks, clip }: ScheduleOptions): (tick: number) => ReadonlySet<Key> {
  const limit = clip ? Number.MAX_SAFE_INTEGER : ticks
  const spans: Span[] = []
  for (const value of press) {
    const { key, at } = split('--press', value)
    if (at === undefined) throw new UsageError(`--press ${quote(value)} needs ticks, like Space@60`)
    for (const part of at.split(',')) {
      const tick = tickIn('--press', value, part, limit)
      spans.push({ key, first: tick, last: tick })
    }
  }
  for (const value of hold) {
    const { key, at } = split('--hold', value)
    if (at === undefined) {
      spans.push({ key, first: 1, last: ticks })
      continue
    }
    for (const part of at.split(',')) {
      const match = /^(\d+)(-(\d*))?$/.exec(part.trim())
      if (!match) throw new UsageError(`--hold ${quote(value)}: "${part}" should be a tick like 30, a span like 30-90, or an open span like 30-`)
      const first = tickIn('--hold', value, match[1], limit)
      const last = match[2] === undefined ? first : match[3] === '' ? ticks : Number(match[3])
      if (last < first) throw new UsageError(`--hold ${quote(value)}: span ${part} ends before it starts`)
      spans.push({ key, first, last: Math.min(last, Math.max(ticks, first)) })
    }
  }
  return lookup(spans)
}

function lookup(spans: readonly Span[]): (tick: number) => ReadonlySet<Key> {
  const edges = spans
    .flatMap(({ key, first, last }) => [
      { tick: first, key, change: 1 },
      { tick: last + 1, key, change: -1 },
    ])
    .sort((a, b) => a.tick - b.tick)
  const counts = new Map<Key, number>()
  const segments: Array<{ readonly from: number; readonly keys: ReadonlySet<Key> }> = []
  for (let i = 0; i < edges.length; ) {
    const tick = edges[i].tick
    for (; i < edges.length && edges[i].tick === tick; i++) counts.set(edges[i].key, (counts.get(edges[i].key) ?? 0) + edges[i].change)
    segments.push({ from: tick, keys: new Set([...counts].flatMap(([key, count]) => (count > 0 ? [key] : []))) })
  }
  const none: ReadonlySet<Key> = new Set()
  return (tick) => {
    let low = 0
    let high = segments.length - 1
    let found: ReadonlySet<Key> = none
    while (low <= high) {
      const middle = (low + high) >> 1
      if (segments[middle].from <= tick) {
        found = segments[middle].keys
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found
  }
}

function split(flag: string, value: string): { key: Key; at: string | undefined } {
  const at = value.indexOf('@')
  const name = at === -1 ? value : value.slice(0, at)
  try {
    return { key: keyNamed(name.trim()), at: at === -1 ? undefined : value.slice(at + 1) }
  } catch (error) {
    throw new UsageError(`${flag} ${quote(value)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Digits only, since Number() would also read 0x5, 1e1, and an empty string as ticks.
function tickIn(flag: string, value: string, text: string, ticks: number): number {
  const tick = /^\d+$/.test(text.trim()) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(tick) || tick < 1) throw new UsageError(`${flag} ${quote(value)}: "${text}" should be a tick from 1 up`)
  if (tick > ticks) throw new UsageError(`${flag} ${quote(value)}: tick ${tick} is after --ticks ${ticks}`)
  return tick
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`
const POINTER = new RegExp(String.raw`^(${NUMBER})\s*,\s*(${NUMBER})(?:@(.*))?$`, 'i')

export interface PointerOptions {
  readonly pointer: readonly string[]
  readonly ticks: number
  readonly clip: boolean
}

// Each --pointer moves the pointer on one tick, and it stays there until the next move.
export function pointerMoves({ pointer, ticks, clip }: PointerOptions): (tick: number) => Point | undefined {
  const limit = clip ? Number.MAX_SAFE_INTEGER : ticks
  const moves = new Map<number, Point>()
  for (const value of pointer) {
    const match = POINTER.exec(value.trim())
    if (!match) throw new UsageError(`--pointer ${quote(value)} should look like X,Y@T in world units, like 0.5,-0.2@30, or X,Y to start there`)
    const [x, y] = [Number(match[1]), Number(match[2])]
    if (!onScreen(x, y)) throw new UsageError(`--pointer ${quote(value)}: the pointer stays on the screen, with ${SCREEN}`)
    const tick = match[3] === undefined ? 1 : tickIn('--pointer', value, match[3], limit)
    if (moves.has(tick)) throw new UsageError(`--pointer ${quote(value)}: another --pointer already moves it on tick ${tick}`)
    moves.set(tick, Object.freeze({ x, y }))
  }
  return (tick) => moves.get(tick)
}

function onScreen(x: number, y: number): boolean {
  return x >= -2 && x <= 2 && y >= -1.5 && y <= 1.5
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value
}
