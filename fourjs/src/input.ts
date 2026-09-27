import { GameError, UsageError } from './errors.ts'
import type { Input } from './types.ts'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const DIGITS = '0123456789'.split('')
const NAMED = ['Space', 'Enter', 'Tab', 'Backspace', 'Shift', 'Ctrl', 'Alt', 'Up', 'Down', 'Left', 'Right']

export const KEYS: readonly string[] = [...LETTERS, ...DIGITS, ...NAMED]
export type Key = string

const BY_LOWER = new Map(KEYS.map((key) => [key.toLowerCase(), key]))
const KEY_LIST = 'A-Z, 0-9, Space, Enter, Tab, Backspace, Shift, Ctrl, Alt, Up, Down, Left, and Right'

export function keyNamed(name: unknown): Key {
  const key = typeof name === 'string' ? BY_LOWER.get(name.toLowerCase()) : undefined
  if (key === undefined) throw new GameError(`unknown key ${JSON.stringify(name)}; keys are ${KEY_LIST}`)
  return key
}

export class KeyState implements Input {
  #now = new Set<Key>()
  #before = new Set<Key>()

  advance(held: Iterable<Key>): void {
    this.#before = this.#now
    this.#now = new Set(held)
  }

  held(key: string): boolean {
    return this.#now.has(keyNamed(key))
  }

  pressed(key: string): boolean {
    const k = keyNamed(key)
    return this.#now.has(k) && !this.#before.has(k)
  }

  released(key: string): boolean {
    const k = keyNamed(key)
    return !this.#now.has(k) && this.#before.has(k)
  }
}

const CODES: Record<string, Key> = {
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
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return code.slice(-1)
  return CODES[code]
}

type Spans = Array<[number, number]>

export function schedule(press: readonly string[], hold: readonly string[], ticks: number): (tick: number) => Set<Key> {
  const spans = new Map<Key, Spans>()
  const add = (key: Key, span: [number, number]) => spans.set(key, [...(spans.get(key) ?? []), span])
  for (const value of press) {
    const [key, at] = split('--press', value)
    if (at === undefined) throw new UsageError(`--press ${JSON.stringify(value)} needs ticks, like Space@60`)
    for (const part of at.split(',')) add(key, [tickIn('--press', value, part, ticks), tickIn('--press', value, part, ticks)])
  }
  for (const value of hold) {
    const [key, at] = split('--hold', value)
    if (at === undefined) {
      add(key, [1, ticks])
      continue
    }
    for (const part of at.split(',')) {
      const match = /^(\d+)(-(\d*))?$/.exec(part.trim())
      if (!match) throw new UsageError(`--hold ${JSON.stringify(value)}: "${part}" should be a tick like 30, a span like 30-90, or an open span like 30-`)
      const first = tickIn('--hold', value, match[1], ticks)
      const last = match[2] === undefined ? first : match[3] === '' ? ticks : Number(match[3])
      if (last < first) throw new UsageError(`--hold ${JSON.stringify(value)}: span ${part} ends before it starts`)
      add(key, [first, Math.min(last, ticks)])
    }
  }
  return (tick) => {
    const held = new Set<Key>()
    for (const [key, list] of spans) if (list.some(([a, b]) => tick >= a && tick <= b)) held.add(key)
    return held
  }
}

function split(flag: string, value: string): [Key, string | undefined] {
  const at = value.indexOf('@')
  const name = at === -1 ? value : value.slice(0, at)
  try {
    return [keyNamed(name.trim()), at === -1 ? undefined : value.slice(at + 1)]
  } catch (error) {
    throw new UsageError(`${flag} ${JSON.stringify(value)}: ${(error as Error).message}`)
  }
}

function tickIn(flag: string, value: string, text: string, ticks: number): number {
  const tick = Number(text.trim())
  if (!Number.isInteger(tick) || tick < 1) throw new UsageError(`${flag} ${JSON.stringify(value)}: "${text}" should be a tick from 1 up`)
  if (tick > ticks) throw new UsageError(`${flag} ${JSON.stringify(value)}: tick ${tick} is after --ticks ${ticks}`)
  return tick
}
