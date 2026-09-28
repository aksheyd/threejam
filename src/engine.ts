import { soundEntry } from './assets.ts'
import { isColor } from './colors.ts'
import { createStore, drawableOf, settle, stateOf, type Store } from './entities.ts'
import { GameError, RunError, UsageError, quote, show } from './errors.ts'
import { guarded } from './guard.ts'
import { InputState, controlsOf, pointerMoves, schedule } from './input.ts'
import { checkSeed, createRandom } from './random.ts'
import {
  driverFor,
  type Context,
  type Controls,
  type Drawable,
  type Drive,
  type Driver,
  type Entities,
  type EntityState,
  type Game,
  type Key,
  type LogEntry,
  type ReadonlyDeep,
  type Snapshot,
  type SoundEntry,
  type World,
} from './types.ts'

export const DT = 1 / 60

export interface SessionOptions {
  readonly seed?: number
  readonly set?: readonly string[]
  // The image and sound files in the game's folder, which the loader and the page pass; without them, any name of the right type passes.
  readonly assets?: readonly string[]
}

export class Session<E extends Entities = Entities> {
  readonly game: Game<E>
  readonly seed: number
  readonly logs: LogEntry[] = []
  readonly sounds: SoundEntry[] = []
  #tick = 0
  #store: Store<E>
  #input = new InputState()
  #held: readonly Key[] = Object.freeze([])
  #ctx: Context
  #driverRandom: () => number

  constructor(game: Game<E>, options: SessionOptions = {}) {
    this.game = game
    this.seed = checkSeed(options.seed ?? 0)
    const files = options.assets === undefined ? undefined : Object.freeze([...options.assets])
    this.#store = createStore(game.entities, files)
    for (const assignment of options.set ?? []) applySet(this.#store, assignment)
    settle(this.#store.all)
    this.#driverRandom = createRandom({ seed: this.seed, stream: 1 })
    const session = this
    this.#ctx = {
      get tick() {
        return session.#tick
      },
      dt: DT,
      input: this.#input,
      random: createRandom({ seed: this.seed }),
      print: (...values: unknown[]) => {
        this.logs.push({ tick: this.#tick, text: values.map((value) => (typeof value === 'string' ? value : show(value))).join(' ') })
      },
      play: (sound: unknown, options?: unknown) => {
        this.sounds.push(soundEntry({ tick: this.#tick, sound, options, files }))
      },
    }
  }

  get tick(): number {
    return this.#tick
  }

  get world(): ReadonlyDeep<World<E>> {
    return this.#store.frozen
  }

  start(): void {
    this.#run('start', this.#tick, () => this.game.start?.(this.#store.live, this.#ctx))
  }

  // A pointer stays where the last step that moved it left it.
  step(controls: Iterable<Key> | Controls): void {
    const { keys, pointer } = controlsOf(controls)
    this.#tick += 1
    this.#input.advance(keys, pointer)
    this.#held = Object.freeze([...new Set(keys)])
    this.#run('update', this.#tick, () => this.game.update(this.#store.live, this.#ctx))
  }

  drive(driver: Driver<E>): Controls {
    const tick = this.#tick + 1
    let controls: Controls = {}
    this.#run('driver', tick, () => {
      const frame = { world: this.#store.frozen, tick, keys: this.#held, pointer: this.#input.pointer, random: this.#driverRandom }
      controls = controlsOf(driver(frame))
    })
    return controls
  }

  state(): EntityState[] {
    return this.#store.all.map(stateOf)
  }

  drawables(): Drawable[] {
    return this.#store.all.flatMap((entity) => drawableOf(entity) ?? [])
  }

  #run(phase: 'start' | 'update' | 'driver', tick: number, fn: () => void): void {
    try {
      guarded(fn)
    } catch (cause) {
      throw new RunError({ phase, tick, cause })
    }
  }
}

export interface SimOptions<E extends Entities = Entities> extends SessionOptions {
  readonly ticks: number
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly pointer?: readonly string[]
  readonly drive?: Drive<E>
  // Stops the run after the first tick this returns true, so ticks becomes the most it runs.
  readonly until?: (frame: { readonly world: ReadonlyDeep<World<E>>; readonly tick: number }) => boolean
  readonly every?: number
  readonly clip?: boolean
}

export interface SimResult<E extends Entities> {
  readonly snapshots: Snapshot[]
  readonly logs: LogEntry[]
  readonly sounds: SoundEntry[]
  readonly world: ReadonlyDeep<World<E>>
  // The last tick that ran, and whether until returned true after it.
  readonly tick: number
  readonly reached: boolean
}

export function simulate<E extends Entities>(game: Game<E>, options: SimOptions<E>): SimResult<E> {
  const { ticks, every, drive, until } = options
  if (!Number.isInteger(ticks) || ticks < 0) throw new UsageError(`--ticks must be a whole number from 0 up, got ${ticks}`)
  if (every !== undefined && (!Number.isInteger(every) || every < 1)) throw new UsageError(`--every must be a whole number from 1 up, got ${every}`)
  const press = options.press ?? []
  const hold = options.hold ?? []
  const pointer = options.pointer ?? []
  if (drive !== undefined && press.length + hold.length + pointer.length > 0) throw new UsageError('use a driver or --press, --hold, and --pointer, not both')
  const clip = options.clip ?? false
  const keysAt = schedule({ press, hold, ticks, clip })
  const pointerAt = pointerMoves({ pointer, ticks, clip })
  const session = new Session(game, options)
  const driver = drive === undefined ? undefined : driverFor(drive)
  const snapshots: Snapshot[] = []
  const take = () => snapshots.push({ tick: session.tick, entities: session.state() })
  session.start()
  if (every) take()
  let reached = false
  for (let tick = 1; tick <= ticks && !reached; tick++) {
    session.step(driver === undefined ? { keys: keysAt(tick), pointer: pointerAt(tick) } : session.drive(driver))
    reached = until?.({ world: session.world, tick }) ?? false
    if (every && tick % every === 0 && tick < ticks && !reached) take()
  }
  if (!every || session.tick > 0) take()
  return { snapshots, logs: session.logs, sounds: session.sounds, world: session.world, tick: session.tick, reached }
}

export function pick(entities: readonly EntityState[], only: string | undefined): EntityState[] {
  if (!only) return [...entities]
  const patterns = only
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
  for (const pattern of patterns) {
    if (!entities.some((entity) => picks(pattern, entity.name))) throw new UsageError(`--only "${pattern}" matches no entity`)
  }
  return entities.filter((entity) => patterns.some((pattern) => picks(pattern, entity.name)))
}

// Printing an entity prints its parts too, so a pattern that picks an entity also picks its parts.
function picks(pattern: string, name: string): boolean {
  const owner = name.indexOf('.parts')
  return matches(pattern, name) || (owner > 0 && matches(pattern, name.slice(0, owner)))
}

export function parseGame(value: unknown): Game {
  if (isGame(value)) return value
  throw new GameError(gameProblem(value) ?? 'the game file must export default defineGame({ entities, update })')
}

function isGame(value: unknown): value is Game {
  return gameProblem(value) === undefined
}

function gameProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'the game file must export default defineGame({ entities, update })'
  if (!isRecord(value.entities)) return 'entities must be an object that maps names to fields'
  if (typeof value.update !== 'function') return 'the game needs an update(world, ctx) function'
  if (value.start !== undefined && typeof value.start !== 'function') return 'start must be a function'
  if (value.title !== undefined && typeof value.title !== 'string') return `title must be a string, got ${show(value.title)}`
  if (value.background !== undefined && !(typeof value.background === 'string' && isColor(value.background))) {
    return `background must be a CSS color like "#08080d", got ${show(value.background)}`
  }
  return undefined
}

// A pattern matches whole names, with * for any run of characters but a dot, so it stops short of parts; a bare group name matches its members.
export function matches(pattern: string, name: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]*')
  return new RegExp(`^${source}$`).test(name) || (!pattern.includes('[') && !name.includes('.') && name.startsWith(`${pattern}[`))
}

function applySet<E extends Entities>(store: Store<E>, assignment: string): void {
  const match = /^(.+?)\.([A-Za-z_$][\w$]*)=(.*)$/s.exec(assignment)
  if (!match) throw new UsageError(`--set ${quote(assignment)} should look like NAME.FIELD=VALUE`)
  const [, pattern, field, raw] = match
  const targets = store.all.filter((entity) => matches(pattern, entity.name))
  if (targets.length === 0) throw new UsageError(`--set ${quote(assignment)}: no entity matches "${pattern}"`)
  const value = parseValue(raw)
  for (const entity of targets) {
    try {
      Reflect.set(entity.live, field, value)
    } catch (error) {
      throw new UsageError(`--set ${quote(assignment)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const COMPARISONS = ['!=', '<=', '>=', '=', '<', '>'] as const
type Comparison = (typeof COMPARISONS)[number]

// sim --until: the run stops once any entity or part that NAME matches meets the condition.
export function untilCondition(text: string): (frame: { readonly world: ReadonlyDeep<World<Entities>> }) => boolean {
  const match = /^(.+?)\.([A-Za-z_$][\w$]*)\s*(!=|<=|>=|=|<|>)\s*(.*)$/s.exec(text)
  const comparison = COMPARISONS.find((candidate) => candidate === match?.[3])
  if (!match || comparison === undefined) {
    throw new UsageError(`--until ${quote(text)} should look like NAME.FIELD=VALUE, or compare a number with !=, <, <=, >, or >=`)
  }
  const [, pattern, field, , raw] = match
  const holds = test(text, comparison, parseValue(raw))
  let seen: object | undefined
  let targets: readonly Named[] = []
  return ({ world }) => {
    if (world !== seen) {
      seen = world
      targets = entitiesIn(world).filter(({ name }) => matches(pattern, name))
      if (targets.length === 0) throw new UsageError(`--until ${quote(text)}: no entity matches "${pattern}"`)
      const lacking = targets.find(({ entity }) => !(field in entity))
      if (lacking !== undefined) throw new UsageError(`--until ${quote(text)}: entity "${lacking.name}" has no field "${field}"`)
    }
    return targets.some(({ entity }) => holds(Reflect.get(entity, field)))
  }
}

interface Named {
  readonly name: string
  readonly entity: object
}

function test(text: string, comparison: Comparison, wanted: unknown): (actual: unknown) => boolean {
  if (comparison === '=') return (actual) => same(actual, wanted)
  if (comparison === '!=') return (actual) => !same(actual, wanted)
  if (typeof wanted !== 'number') throw new UsageError(`--until ${quote(text)}: ${comparison} compares numbers, and ${show(wanted)} isn't one`)
  switch (comparison) {
    case '<':
      return (actual) => typeof actual === 'number' && actual < wanted
    case '<=':
      return (actual) => typeof actual === 'number' && actual <= wanted
    case '>':
      return (actual) => typeof actual === 'number' && actual > wanted
    case '>=':
      return (actual) => typeof actual === 'number' && actual >= wanted
    default: {
      const _exhaustive: never = comparison
      return _exhaustive
    }
  }
}

// Every entity and part in a world, in the order state() lists them.
function entitiesIn(world: object): Named[] {
  const found: Named[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) {
      found.push({ name: String(Reflect.get(value, 'name')), entity: value })
      if ('parts' in value && typeof value.parts === 'object' && value.parts !== null) Object.values(value.parts).forEach(visit)
    }
  }
  Object.values(world).forEach(visit)
  return found
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  }
  return a === b
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
