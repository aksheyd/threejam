import { isColor } from './colors.ts'
import { GameError, show } from './errors.ts'
import type { Drawable, Entity, EntityState, Value } from './types.ts'

type Kind = 'shape' | 'text' | 'data'
type Fields = Record<string, Value>

const COMMON: Fields = { x: 0, y: 0, visible: true }
const SHAPE_DEFAULTS: Fields = { w: 1, h: 1, shape: 'square', color: '#ffffff', opacity: 1 }
const TEXT_DEFAULTS: Fields = { color: '#ffffff', opacity: 1, size: 0.14, align: 'center' }
const SHAPE_ONLY = new Set(['w', 'h', 'shape'])
const TEXT_ONLY = new Set(['text', 'size', 'align'])
const VISUAL = new Set([...SHAPE_ONLY, ...TEXT_ONLY, 'color', 'opacity'])
const ENGINE = new Set([...Object.keys(COMMON), ...VISUAL])
const SHAPES = ['square', 'circle', 'triangle']
const ALIGNS = ['left', 'center', 'right']
// Names that inspection, JSON, and promises probe; reading them must not throw.
const PROBED = new Set(['toJSON', 'then', 'constructor', 'valueOf', 'toString', 'inspect', 'nodeType', 'asymmetricMatch'])

export interface Stored {
  readonly name: string
  readonly kind: Kind
  readonly values: Fields
  readonly initial: Fields
  readonly declared: readonly string[]
  readonly defaults: Fields
  readonly proxy: Entity
}

export type Store = Map<string, Stored>

export function createStore(entities: unknown): Store {
  if (!isPlain(entities)) throw new GameError('entities must be an object that maps names to fields')
  const store: Store = new Map()
  for (const [name, init] of Object.entries(entities)) {
    if (!isPlain(init)) throw new GameError(`entity "${name}" must be an object of fields, got ${show(init)}`)
    const kind: Kind = 'text' in init ? 'text' : ['w', 'h', 'shape', 'color', 'opacity'].some((f) => f in init) ? 'shape' : 'data'
    const defaults = { ...COMMON, ...(kind === 'shape' ? SHAPE_DEFAULTS : kind === 'text' ? TEXT_DEFAULTS : {}) }
    const values: Fields = { ...defaults }
    const initial: Fields = {}
    for (const [field, value] of Object.entries(init)) {
      if (value === undefined) throw new GameError(`entity "${name}": ${field} is undefined; give it a starting value`)
      initial[field] = values[field] = checked(name, kind, field, value, undefined)
    }
    const stored = { name, kind, values, initial, declared: Object.keys(init), defaults } as Omit<Stored, 'proxy'>
    store.set(name, { ...stored, proxy: entityProxy(stored) })
  }
  return store
}

function entityProxy(s: Omit<Stored, 'proxy'>): Entity {
  return new Proxy(s.values, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (Object.hasOwn(target, prop)) return target[prop]
      if (PROBED.has(prop)) return undefined
      throw new GameError(`entity "${s.name}" has no field "${prop}"`)
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol') throw new GameError(`entity "${s.name}" can't hold symbol keys`)
      if (!Object.hasOwn(target, prop) && !ENGINE.has(prop)) {
        throw new GameError(`entity "${s.name}" has no field "${prop}"; declare it in entities`)
      }
      target[prop] = checked(s.name, s.kind, prop, value, s.initial[prop])
      return true
    },
    deleteProperty(_, prop) {
      throw new GameError(`can't delete ${String(prop)} from entity "${s.name}"; set it to another value`)
    },
    defineProperty(_, prop) {
      throw new GameError(`can't define ${String(prop)} on entity "${s.name}"; assign it instead`)
    },
  }) as unknown as Entity
}

export function worldProxy(store: Store): Record<string, Entity> {
  return new Proxy({} as Record<string, Entity>, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      const stored = store.get(prop)
      if (stored) return stored.proxy
      if (PROBED.has(prop)) return undefined
      throw new GameError(`no entity named "${prop}"`)
    },
    set(_, prop) {
      throw new GameError(`can't replace entity "${String(prop)}"; change its fields instead`)
    },
    deleteProperty(_, prop) {
      throw new GameError(`can't delete entity "${String(prop)}"; hide it with visible = false`)
    },
    has(_, prop) {
      return typeof prop === 'string' && store.has(prop)
    },
    ownKeys() {
      return [...store.keys()]
    },
    getOwnPropertyDescriptor(_, prop) {
      const stored = typeof prop === 'string' ? store.get(prop) : undefined
      return stored && { value: stored.proxy, writable: false, enumerable: true, configurable: true }
    },
  })
}

export function stateOf(s: Stored): EntityState {
  const state: EntityState = { name: s.name }
  for (const field of s.declared) state[field] = copy(s.values[field])
  for (const [field, value] of Object.entries(s.defaults)) {
    if (!s.declared.includes(field) && s.values[field] !== value) state[field] = s.values[field]
  }
  return state
}

export function drawableOf(s: Stored): Drawable | undefined {
  if (s.kind === 'data') return undefined
  return { name: s.name, kind: s.kind, fields: copy(s.values) as Drawable['fields'] }
}

function checked(entity: string, kind: Kind, field: string, value: unknown, initial: Value | undefined): Value {
  const where = `entity "${entity}"`
  if (field === 'x' || field === 'y') return finite(where, field, value)
  if (field === 'visible') {
    if (typeof value !== 'boolean') throw new GameError(`${where}: visible must be true or false, got ${show(value)}`)
    return value
  }
  if (VISUAL.has(field)) {
    if (kind === 'data') throw new GameError(`${where} has no shape or text, so it can't have ${field}`)
    if (kind === 'text' && SHAPE_ONLY.has(field)) throw new GameError(`${where} is text, so it can't have ${field}`)
    if (kind === 'shape' && TEXT_ONLY.has(field)) throw new GameError(`${where} is a shape, so it can't have ${field}; text needs its own entity`)
    switch (field) {
      case 'w':
      case 'h':
      case 'size': {
        const n = finite(where, field, value)
        if (n <= 0) throw new GameError(`${where}: ${field} must be greater than 0, got ${show(value)}`)
        return n
      }
      case 'opacity': {
        const n = finite(where, field, value)
        if (n < 0 || n > 1) throw new GameError(`${where}: opacity must be from 0 to 1, got ${show(value)}`)
        return n
      }
      case 'shape':
        return oneOf(where, field, value, SHAPES)
      case 'align':
        return oneOf(where, field, value, ALIGNS)
      case 'color':
        if (typeof value !== 'string' || !isColor(value)) {
          throw new GameError(`${where}: color must be a CSS color like "#ff8800" or "orange", got ${show(value)}`)
        }
        return value
      case 'text':
        if (typeof value !== 'string') throw new GameError(`${where}: text must be a string, got ${show(value)}; use String() or a template string`)
        return value
    }
  }
  const plain = data(where, field, value)
  if (initial !== undefined && initial !== null && typeof initial !== 'object' && typeof plain !== typeof initial) {
    throw new GameError(`${where}: ${field} started as a ${typeof initial}, so it can't become ${show(value)}`)
  }
  return plain
}

function finite(where: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new GameError(`${where}: ${field} must be a finite number, got ${show(value)}`)
  return value
}

function oneOf(where: string, field: string, value: unknown, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new GameError(`${where}: ${field} must be ${allowed.map((a) => `"${a}"`).join(', ')}, got ${show(value)}`)
  }
  return value
}

function data(where: string, field: string, value: unknown): Value {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return finite(where, field, value)
  if (Array.isArray(value)) return value.map((item, i) => data(where, `${field}[${i}]`, item))
  if (isPlain(value)) {
    const out: Fields = {}
    for (const [key, item] of Object.entries(value)) out[key] = data(where, `${field}.${key}`, item)
    return out
  }
  throw new GameError(`${where}: ${field} must be a number, string, boolean, null, array, or plain object, got ${show(value)}`)
}

function copy<T extends Value>(value: T): T {
  return value !== null && typeof value === 'object' ? (structuredClone(value) as T) : value
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
