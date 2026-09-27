import { isColor } from './colors.ts'
import { createStore, drawableOf, stateOf, type Store } from './entities.ts'
import { GameError, RunError, UsageError, quote, show } from './errors.ts'
import { guarded } from './guard.ts'
import { KeyState, keyNamed, schedule } from './input.ts'
import { checkSeed, createRandom } from './random.ts'
import { driverFor, type Context, type Drawable, type Drive, type Driver, type Entities, type EntityState, type Game, type Key, type LogEntry, type ReadonlyDeep, type Snapshot, type World } from './types.ts'

export const DT = 1 / 60

export interface SessionOptions {
  readonly seed?: number
  readonly set?: readonly string[]
}

export class Session<E extends Entities = Entities> {
  readonly game: Game<E>
  readonly seed: number
  readonly logs: LogEntry[] = []
  #tick = 0
  #store: Store<E>
  #input = new KeyState()
  #ctx: Context
  #driverRandom: () => number

  constructor(game: Game<E>, options: SessionOptions = {}) {
    this.game = game
    this.seed = checkSeed(options.seed ?? 0)
    this.#store = createStore(game.entities)
    for (const assignment of options.set ?? []) applySet(this.#store, assignment)
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

  step(keys: Iterable<string>): void {
    const held = [...keys].map((key) => keyNamed(key))
    this.#tick += 1
    this.#input.advance(held)
    this.#run('update', this.#tick, () => this.game.update(this.#store.live, this.#ctx))
  }

  drive(driver: Driver<E>): Key[] {
    const tick = this.#tick + 1
    let keys: Key[] = []
    this.#run('driver', tick, () => {
      keys = [...driver({ world: this.#store.frozen, tick, random: this.#driverRandom })].map((key) => keyNamed(key))
    })
    return keys
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
  readonly drive?: Drive<E>
  readonly every?: number
  readonly clip?: boolean
}

export interface SimResult<E extends Entities> {
  readonly snapshots: Snapshot[]
  readonly logs: LogEntry[]
  readonly world: ReadonlyDeep<World<E>>
}

export function simulate<E extends Entities>(game: Game<E>, options: SimOptions<E>): SimResult<E> {
  const { ticks, every, drive } = options
  if (!Number.isInteger(ticks) || ticks < 0) throw new UsageError(`--ticks must be a whole number from 0 up, got ${ticks}`)
  if (every !== undefined && (!Number.isInteger(every) || every < 1)) throw new UsageError(`--every must be a whole number from 1 up, got ${every}`)
  const press = options.press ?? []
  const hold = options.hold ?? []
  if (drive !== undefined && press.length + hold.length > 0) throw new UsageError('use a driver or --press and --hold, not both')
  const keysAt = schedule({ press, hold, ticks, clip: options.clip ?? false })
  const session = new Session(game, options)
  const driver = drive === undefined ? undefined : driverFor(drive)
  const snapshots: Snapshot[] = []
  const take = () => snapshots.push({ tick: session.tick, entities: session.state() })
  session.start()
  if (every) take()
  for (let tick = 1; tick <= ticks; tick++) {
    session.step(driver === undefined ? keysAt(tick) : session.drive(driver))
    if (every && tick % every === 0 && tick < ticks) take()
  }
  if (!every || ticks > 0) take()
  return { snapshots, logs: session.logs, world: session.world }
}

export function pick(entities: readonly EntityState[], only: string | undefined): EntityState[] {
  if (!only) return [...entities]
  const patterns = only
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
  for (const pattern of patterns) {
    if (!entities.some((entity) => matches(pattern, entity.name))) throw new UsageError(`--only "${pattern}" matches no entity`)
  }
  return entities.filter((entity) => patterns.some((pattern) => matches(pattern, entity.name)))
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

// A pattern matches whole names, with * for any run of characters; a bare group name matches its members.
export function matches(pattern: string, name: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(name) || (!pattern.includes('[') && name.startsWith(`${pattern}[`))
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
