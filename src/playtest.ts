// A playtest that run records with --record: the input of each tick a person plays on run's page, which the page sends run as it goes, and the driver file run saves it as, which sim, shot, and simulate replay exactly.
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { IoError, UsageError, quote, shellWord } from './errors.ts'
import { keyNamed, pointAt } from './input.ts'
import { named, reasonOf } from './load.ts'
import { makeFolder, replaceFile } from './output.ts'
import { createRandom } from './random.ts'
import { KEYS, type Key, type Point } from './types.ts'

// From its tick on, the keys held, and on that tick where the pointer moves, if it moves.
export type Change = readonly [tick: number, keys: readonly Key[], pointer?: Point]

// What every playtest run saves starts with, which marks a file that --record may replace.
const HEADER = '// A playtest that threejam run recorded'

export interface Session {
  // The build of the page that played it.
  readonly build: number
  readonly id: string
  readonly seed: number
  readonly changes: readonly Change[]
  // Every change through this tick is among the changes.
  readonly ticks: number
}

export type Taken = 'taken' | 'stale' | 'invalid'

interface Part extends Session {
  // How many of the session's changes come before this part's.
  readonly from: number
}

// The latest session a run page has sent, whole from its first tick. A page sends a session in parts as it plays, each from where the part before ended, and starts one over by sending it from its first change.
export class Recording {
  #latest: { readonly build: number; readonly id: string; readonly seed: number; readonly changes: Change[]; ticks: number } | undefined

  // A part from a page of an older build, or one that doesn't start where the latest session ends, is stale, which the page answers by sending its session again from the first change.
  take(query: URLSearchParams, body: string, build: number): Taken {
    const part = partOf(query, body)
    if (part === undefined) return 'invalid'
    if (part.build !== build) return 'stale'
    if (part.from === 0) {
      if (!inOrder(part, 0)) return 'invalid'
      this.#latest = { build: part.build, id: part.id, seed: part.seed, changes: [...part.changes], ticks: part.ticks }
      return 'taken'
    }
    const latest = this.#latest
    if (latest === undefined || latest.build !== part.build || latest.id !== part.id || latest.seed !== part.seed || latest.changes.length !== part.from) return 'stale'
    if (!inOrder(part, latest.ticks)) return 'invalid'
    latest.changes.push(...part.changes)
    latest.ticks = part.ticks
    return 'taken'
  }

  // The latest session, unless a save since its page loaded has started the playtest over.
  latest(build: number): Session | undefined {
    return this.#latest?.build === build ? this.#latest : undefined
  }
}

function partOf(query: URLSearchParams, body: string): Part | undefined {
  const [build, from, ticks] = ['build', 'from', 'ticks'].map((name) => whole(query.get(name), /^\d+$/))
  const seed = whole(query.get('seed'), /^-?\d+$/)
  const id = query.get('session')
  if (build === undefined || from === undefined || ticks === undefined || seed === undefined || id === null || !/^\w{1,64}$/.test(id)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const changes: Change[] = []
  for (const item of parsed) {
    const change = changeOf(item)
    if (change === undefined) return undefined
    changes.push(change)
  }
  return { build, id, seed, from, ticks, changes }
}

function whole(text: string | null, pattern: RegExp): number | undefined {
  const value = text !== null && pattern.test(text) ? Number(text) : Number.NaN
  return Number.isSafeInteger(value) ? value : undefined
}

// Every key a known one, kept in the order KEYS has them, and the pointer on the screen, so the file run writes holds nothing else of what the page sent.
function changeOf(value: unknown): Change | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return undefined
  const [tick, keys, pointer]: unknown[] = value
  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || !Array.isArray(keys)) return undefined
  try {
    const held = new Set(keys.map((key: unknown) => keyNamed(key)))
    const sorted = KEYS.filter((key) => held.has(key))
    return value.length === 2 ? [tick, sorted] : [tick, sorted, pointAt(pointer)]
  } catch {
    return undefined
  }
}

// Each change comes on a later tick than the one before it, the first after the ticks kept already, and the part runs at least through its last change.
function inOrder({ changes, ticks }: Part, after: number): boolean {
  let last = after
  for (const [tick] of changes) {
    if (tick <= last) return false
    last = tick
  }
  return ticks >= last
}

// What a playtest mustn't take the place of: anything but a playtest run saved, which must be a regular file and not a link to one. Checked when run starts and again right before it saves, since the path can change while the person plays.
function occupied(file: string): string | undefined {
  const found = lstatSync(file, { throwIfNoEntry: false })
  if (found === undefined) return undefined
  if (found.isSymbolicLink()) return 'is a link'
  if (found.isDirectory()) return 'is a folder'
  if (!found.isFile()) return "isn't a regular file"
  return headerOf(file) === HEADER ? undefined : "is a file run didn't record"
}

// Reads no more than the header. The flags keep a link or a FIFO that takes the file's place after lstat from being followed or waited on; Windows has neither.
function headerOf(file: string): string {
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!fstatSync(handle).isFile()) return ''
    const head = Buffer.alloc(HEADER.length)
    return head.toString('utf8', 0, readSync(handle, head, 0, head.length, 0))
  } finally {
    closeSync(handle)
  }
}

// Checked before run runs anything, so a playtest is never lost to a path run can't write, and never takes the place of a file run didn't record, like game.ts.
export function playtestFile(file: string): string {
  if (!/\.ts$/.test(file)) throw new UsageError(`--record ${quote(file)} should be a .ts file, like playtest.ts`)
  const why = occupied(file)
  if (why !== undefined) throw new UsageError(`--record ${named(file)} ${why}; name a new file, or a playtest to replace`)
  // The folder that holds the file, or else the nearest one above it, which the folders run makes go in. The save renames a new file into it, so run must be able to write there, and an earlier playtest stays as it is if it can't be written either.
  let folder = dirname(resolve(file))
  while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder)
  if (!statSync(folder).isDirectory()) throw new IoError(`couldn't make the folder for ${named(file)}: ${named(folder)} is a file`)
  for (const place of existsSync(file) ? [file, folder] : [folder]) {
    try {
      accessSync(place, constants.W_OK)
    } catch (error) {
      throw new IoError(`couldn't write ${named(file)}: ${reasonOf(error)}`)
    }
  }
  return file
}

// Saves the latest session as a driver file, and says what it saved, or why it saved nothing.
export function savePlaytest({ file, dir, session }: { file: string; dir: string; session: Session | undefined }): string {
  if (session === undefined || session.ticks === 0) return `Saved no playtest to ${file}, since no tick ran after run started or a file was last saved.`
  const why = occupied(file)
  if (why !== undefined) throw new IoError(`couldn't save the playtest to ${named(file)}, which ${why} now`)
  makeFolder(dirname(resolve(file)))
  replaceFile(file, playtestSource(session))
  const replay = `threejam sim ${shellWord(dir)} --driver ${shellWord(file)} --seed ${session.seed} --ticks ${session.ticks}`
  return `Saved the playtest, ${ticksOf(session.ticks)} with seed ${session.seed}, to ${file}; replay it with ${replay}`
}

function ticksOf(count: number): string {
  return `${count} ${count === 1 ? 'tick' : 'ticks'}`
}

// A driver that replays the session tick for tick, written from the checked keys and numbers alone. Each change is a call that gives it one type, which TypeScript would otherwise infer apart for each pointer, past what it can check. With another seed the game would play out otherwise, so the first number the driver gets tells it the seed is wrong.
export function playtestSource({ seed, ticks, changes }: Pick<Session, 'seed' | 'ticks' | 'changes'>): string {
  const first = number(createRandom({ seed, stream: 1 })())
  return [
    `${HEADER}: ${ticksOf(ticks)} with seed ${seed}. sim and shot replay it with --driver and --seed ${seed}, and simulate with drive and seed: ${seed}.`,
    "import type { Driver, Key, Point } from 'threejam'",
    '',
    'type Change = readonly [tick: number, keys: readonly Key[], pointer?: Point]',
    '',
    '// From the tick of each change on, its keys are held, and on that tick the pointer moves to its place, if it has one.',
    'const at = (...change: Change): Change => change',
    '',
    'const changes: readonly Change[] = [',
    ...changes.map(line),
    ']',
    '',
    'const byTick = new Map(changes.map((change) => [change[0], change]))',
    '',
    'const playtest: Driver = ({ tick, keys, random }) => {',
    `  // The first number a driver gets with seed ${seed}, so a replay with another seed, which would play out otherwise, fails at once.`,
    `  if (tick === 1 && random() !== ${first}) throw new Error('this playtest was recorded with seed ${seed}, so replay it with seed ${seed}')`,
    '  // After the last tick it recorded, nothing is held.',
    `  if (tick > ${ticks}) return []`,
    '  const change = byTick.get(tick)',
    '  if (change === undefined) return keys',
    '  const [, held, pointer] = change',
    '  return pointer === undefined ? held : { keys: held, pointer }',
    '}',
    '',
    'export default playtest',
    '',
  ].join('\n')
}

function line([tick, keys, pointer]: Change): string {
  const moves = pointer === undefined ? '' : `, { x: ${number(pointer.x)}, y: ${number(pointer.y)} }`
  return `  at(${tick}, [${keys.map((key) => `'${key}'`).join(', ')}]${moves}),`
}

// What JavaScript reads back as the same number, down to the sign of a zero.
function number(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value)
}
