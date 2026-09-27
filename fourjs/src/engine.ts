import { createStore, drawableOf, stateOf, worldProxy, type Store } from './entities.ts'
import { GameError, RunError, UsageError, show } from './errors.ts'
import { guarded } from './guard.ts'
import { KeyState, schedule, type Key } from './input.ts'
import { checkSeed, createRandom } from './random.ts'
import type { Context, Drawable, Entity, EntityState, Game, Snapshot, Value } from './types.ts'

export const DT = 1 / 60

export interface SessionOptions {
  seed?: number
  set?: readonly string[]
}

export class Session {
  readonly game: Game
  readonly seed: number
  readonly logs: string[] = []
  #tick = 0
  #store: Store
  #world: Record<string, Entity>
  #input = new KeyState()
  #ctx: Context

  constructor(game: Game, options: SessionOptions = {}) {
    checkGame(game)
    this.game = game
    this.seed = checkSeed(options.seed ?? 0)
    this.#store = createStore(game.entities)
    for (const assignment of options.set ?? []) applySet(this.#store, assignment)
    this.#world = worldProxy(this.#store)
    const session = this
    const store = this.#store
    this.#ctx = {
      get tick() {
        return session.#tick
      },
      dt: DT,
      input: this.#input,
      random: createRandom(this.seed),
      print: (...values: unknown[]) => {
        this.logs.push(`[tick ${this.#tick}] ${values.map((v) => (typeof v === 'string' ? v : show(v))).join('\t')}`)
      },
      all: (prefix: string) => [...store.values()].filter((s) => s.name.startsWith(prefix)).map((s) => s.proxy),
    }
  }

  get tick(): number {
    return this.#tick
  }

  start(): void {
    this.#run('start', () => this.game.start?.(this.#world, this.#ctx))
  }

  step(held: Iterable<Key>): void {
    this.#tick += 1
    this.#input.advance(held)
    this.#run('update', () => this.game.update(this.#world, this.#ctx))
  }

  state(): EntityState[] {
    return [...this.#store.values()].map(stateOf)
  }

  drawables(): Drawable[] {
    return [...this.#store.values()].map(drawableOf).filter((d) => d !== undefined)
  }

  fields(): Record<string, Record<string, Value>> {
    return Object.fromEntries([...this.#store.values()].map((s) => [s.name, structuredClone(s.values)]))
  }

  #run(phase: 'start' | 'update', fn: () => void): void {
    try {
      guarded(fn)
    } catch (error) {
      throw new RunError(phase, this.#tick, error)
    }
  }
}

export interface SimOptions extends SessionOptions {
  ticks: number
  press?: readonly string[]
  hold?: readonly string[]
  every?: number
}

export function simulate(game: Game, options: SimOptions): { snapshots: Snapshot[]; logs: string[] } {
  const { ticks, every } = options
  if (!Number.isInteger(ticks) || ticks < 0) throw new UsageError(`--ticks must be a whole number from 0 up, got ${ticks}`)
  if (every !== undefined && (!Number.isInteger(every) || every < 1)) throw new UsageError(`--every must be a whole number from 1 up, got ${every}`)
  const keysAt = schedule(options.press ?? [], options.hold ?? [], ticks)
  const session = new Session(game, options)
  const snapshots: Snapshot[] = []
  const take = () => snapshots.push({ tick: session.tick, entities: session.state() })
  session.start()
  if (every) take()
  for (let tick = 1; tick <= ticks; tick++) {
    session.step(keysAt(tick))
    if (every && tick % every === 0 && tick < ticks) take()
  }
  if (!every || ticks > 0) take()
  return { snapshots, logs: session.logs }
}

export function pick(entities: EntityState[], only: string | undefined): EntityState[] {
  if (!only) return entities
  const patterns = only
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const filtered = entities.filter((e) => patterns.some((p) => matches(p, e.name)))
  for (const p of patterns) {
    if (!entities.some((e) => matches(p, e.name))) throw new UsageError(`--only "${p}" matches no entity`)
  }
  return filtered
}

function matches(pattern: string, name: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(name)
}

function checkGame(game: unknown): asserts game is Game {
  if (game === null || typeof game !== 'object') throw new GameError('the game file must export default defineGame({ entities, update })')
  const g = game as Partial<Game>
  if (typeof g.update !== 'function') throw new GameError('the game needs an update(world, ctx) function')
  if (g.start !== undefined && typeof g.start !== 'function') throw new GameError('start must be a function')
  if (g.background !== undefined && typeof g.background !== 'string') throw new GameError('background must be a CSS color string')
}

function applySet(store: Store, assignment: string): void {
  const match = /^([^.=]+)\.([^=]+)=(.*)$/s.exec(assignment)
  if (!match) throw new UsageError(`--set ${JSON.stringify(assignment)} should look like NAME.FIELD=VALUE`)
  const [, name, field, raw] = match
  const stored = store.get(name)
  if (!stored) throw new UsageError(`--set ${JSON.stringify(assignment)}: no entity named "${name}"`)
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    // A bare word like red is a string.
  }
  try {
    ;(stored.proxy as Record<string, unknown>)[field] = value
  } catch (error) {
    throw new UsageError(`--set ${JSON.stringify(assignment)}: ${(error as Error).message}`)
  }
}
