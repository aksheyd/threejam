import { CENTER } from '../input.ts'
import type { Change } from '../playtest.ts'
import { KEYS, type Key, type Point } from '../types.ts'

// How long a page waits between sends, which is about the most of a session run can miss when it stops some other way than Esc.
const EVERY_MS = 250
// The most changes one send holds, each under 400 bytes, well inside the 1 MB that run reads of one.
const MOST_CHANGES = 1000

// What a run page started with --record keeps of a person's play and sends run as it goes: each session from its first tick, as the keys held and the pointer on each tick where either changes.
export class Recorder {
  readonly #token: string
  readonly #build: number
  // The session being recorded, if the page records the one it plays.
  #session: string | undefined
  #seed = 0
  #changes: Change[] = []
  #ticks = 0
  #keys: readonly Key[] = []
  #pointer: Point = CENTER
  // How much of the session run has: its first changes, and every tick through one.
  #sent = { changes: 0, ticks: 0 }
  #sending: Promise<boolean> | undefined
  #paced = Number.NEGATIVE_INFINITY

  constructor({ token, build }: { token: string; build: number }) {
    this.#token = token
    this.#build = build
  }

  // A session starts with every key up and the pointer in the middle, as a Session does.
  start(seed: number): void {
    this.#session = Math.random().toString(36).slice(2)
    this.#seed = seed
    this.#changes = []
    this.#ticks = 0
    this.#keys = []
    this.#pointer = CENTER
    this.#sent = { changes: 0, ticks: 0 }
  }

  // A session that something other than a person plays, which run leaves out.
  stop(): void {
    this.#session = undefined
  }

  // The input of the session's next tick, recorded before the tick runs, so that a tick that fails is in the playtest too.
  add(tick: number, held: Iterable<Key>, pointer: Point): void {
    if (this.#session === undefined) return
    const down = new Set(held)
    const keys = KEYS.filter((key) => down.has(key))
    const moved = !Object.is(pointer.x, this.#pointer.x) || !Object.is(pointer.y, this.#pointer.y)
    if (moved || keys.length !== this.#keys.length || keys.some((key, i) => key !== this.#keys[i])) this.#changes.push(moved ? [tick, keys, pointer] : [tick, keys])
    this.#keys = keys
    this.#pointer = pointer
    this.#ticks = tick
  }

  // Sends run what it lacks, one send at a time and at most once every EVERY_MS.
  pace(now: number): void {
    if (this.#sending !== undefined || now - this.#paced < EVERY_MS) return
    this.#paced = now
    void this.#send()
  }

  // Sends run all of the session, once any send under way is done.
  async flush(): Promise<void> {
    await this.#sending
    for (let refused = 0; this.#pending() && refused < 2; ) if (!(await this.#send())) refused += 1
  }

  #pending(): boolean {
    return this.#session !== undefined && (this.#sent.changes < this.#changes.length || this.#sent.ticks < this.#ticks)
  }

  // Whether run took the next part of the session.
  #send(): Promise<boolean> {
    const sending = this.#post().finally(() => (this.#sending = undefined))
    this.#sending = sending
    return sending
  }

  async #post(): Promise<boolean> {
    const session = this.#session
    if (session === undefined || !this.#pending()) return true
    const from = this.#sent.changes
    const changes = this.#changes.slice(from, from + MOST_CHANGES)
    const rest = this.#changes[from + changes.length]
    // A part that leaves changes for the next one runs through the tick before them.
    const ticks = rest === undefined ? this.#ticks : rest[0] - 1
    const query = new URLSearchParams({ token: this.#token, build: String(this.#build), session, seed: String(this.#seed), from: String(from), ticks: String(ticks) })
    let response: Response
    try {
      response = await fetch(`/record?${query}`, { method: 'POST', body: JSON.stringify(changes) })
    } catch {
      // run has stopped.
      return false
    }
    if (session !== this.#session) return false
    if (response.ok) this.#sent = { changes: from + changes.length, ticks }
    // run has another session, or less of this one, so the next send starts from the first change.
    else if (response.status === 409) this.#sent = { changes: 0, ticks: 0 }
    else {
      this.#session = undefined
      console.error(`run refused this page's playtest with status ${response.status}, so the page stopped recording it`)
    }
    return response.ok
  }
}
