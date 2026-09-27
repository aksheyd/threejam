import { GameError, UsageError, quote } from './errors.ts'
import { KEYS, type Input, type Key } from './types.ts'

const BY_LOWER: ReadonlyMap<string, Key> = new Map(KEYS.map((key) => [key.toLowerCase(), key]))
const KEY_LIST = 'A-Z, 0-9, Space, Enter, Tab, Backspace, Shift, Ctrl, Alt, Up, Down, Left, and Right'

export function keyNamed(name: unknown): Key {
  const key = typeof name === 'string' ? BY_LOWER.get(name.toLowerCase()) : undefined
  if (key === undefined) throw new GameError(`unknown key ${JSON.stringify(name)}; keys are ${KEY_LIST}`)
  return key
}

export class KeyState implements Input {
  #now: ReadonlySet<Key> = new Set()
  #before: ReadonlySet<Key> = new Set()

  advance(held: Iterable<Key>): void {
    this.#before = this.#now
    this.#now = new Set(held)
  }

  held(key: Key): boolean {
    return this.#now.has(keyNamed(key))
  }

  pressed(key: Key): boolean {
    const k = keyNamed(key)
    return this.#now.has(k) && !this.#before.has(k)
  }

  released(key: Key): boolean {
    const k = keyNamed(key)
    return !this.#now.has(k) && this.#before.has(k)
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

function tickIn(flag: string, value: string, text: string, ticks: number): number {
  const tick = Number(text.trim())
  if (!Number.isInteger(tick) || tick < 1) throw new UsageError(`${flag} ${quote(value)}: "${text}" should be a tick from 1 up`)
  if (tick > ticks) throw new UsageError(`${flag} ${quote(value)}: tick ${tick} is after --ticks ${ticks}`)
  return tick
}
