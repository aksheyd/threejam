import { isColor } from './colors.ts'
import { GameError, show } from './errors.ts'
import { undrawable } from './font.ts'
import {
  CHOICE,
  GROUP,
  isChoice,
  isGroup,
  type Align,
  type Choice,
  type Drawable,
  type EngineFields,
  type Entities,
  type Entity,
  type EntityState,
  type ReadonlyDeep,
  type Shape,
  type Value,
  type World,
} from './types.ts'

type Kind = 'shape' | 'text' | 'data'
type Fields = Record<string, Value>
type EngineField = keyof EngineFields

const ENGINE_FIELDS: ReadonlySet<string> = new Set<EngineField>(['x', 'y', 'visible', 'w', 'h', 'shape', 'color', 'opacity', 'text', 'size', 'align'])
const FIELDS_OF: Readonly<Record<Kind, ReadonlySet<EngineField>>> = {
  shape: new Set(['x', 'y', 'visible', 'w', 'h', 'shape', 'color', 'opacity']),
  text: new Set(['x', 'y', 'visible', 'text', 'size', 'align', 'color', 'opacity']),
  data: new Set(['x', 'y', 'visible']),
}
const KIND_NOTE: Readonly<Record<Kind, string>> = { shape: 'is a shape', text: 'is text', data: 'has no shape or text' }
const SHAPE_FIELDS = ['w', 'h', 'shape', 'color', 'opacity']
const DEFAULTS: Readonly<EngineFields> = {
  x: 0,
  y: 0,
  visible: true,
  w: 1,
  h: 1,
  shape: 'square',
  color: '#ffffff',
  opacity: 1,
  text: '',
  size: 0.14,
  align: 'center',
}
// Names that inspection, JSON, and promises probe; reading them must not throw.
const PROBED: ReadonlySet<string> = new Set(['toJSON', 'then', 'constructor', 'valueOf', 'toString', 'inspect', 'nodeType', 'asymmetricMatch'])

interface Base {
  readonly name: string
  readonly kind: Kind
  readonly order: number
  readonly engine: EngineFields
  readonly custom: Fields
  readonly declared: readonly string[]
  readonly initial: Readonly<Fields>
  readonly choices: ReadonlyMap<string, readonly string[]>
}

export interface Stored extends Base {
  readonly live: Entity
  readonly frozen: Entity
}

type Layout =
  | { readonly kind: 'one'; readonly entity: Stored }
  | { readonly kind: 'list'; readonly entities: readonly Stored[] }
  | { readonly kind: 'grid'; readonly rows: readonly (readonly Stored[])[] }

export interface Store<E extends Entities> {
  readonly all: readonly Stored[]
  readonly live: World<E>
  readonly frozen: ReadonlyDeep<World<E>>
}

export function createStore<E extends Entities>(entities: E): Store<E> {
  const all: Stored[] = []
  const add = (name: string, init: unknown): Stored => {
    const entity = createEntity(name, all.length, init)
    all.push(entity)
    return entity
  }
  const layouts = new Map<string, Layout>()
  for (const [key, value] of Object.entries(entities)) {
    if (!isGroup(value)) layouts.set(key, { kind: 'one', entity: add(key, value) })
    else if (value[GROUP] === 'list') layouts.set(key, { kind: 'list', entities: value.members.map((init, i) => add(`${key}[${i}]`, init)) })
    else layouts.set(key, { kind: 'grid', rows: value.rows.map((row, r) => row.map((init, c) => add(`${key}[${r}][${c}]`, init))) })
  }
  // Both worlds are built from these entities, so they have exactly the shape World<E> describes.
  return { all, live: worldOf(layouts, (e) => e.live) as World<E>, frozen: worldOf(layouts, (e) => e.frozen) as ReadonlyDeep<World<E>> }
}

export function stateOf(entity: Stored): EntityState {
  const fields: Record<string, Value> = {}
  const shown = entity.kind === 'data' ? entity.declared : ['x', 'y', 'visible', ...entity.declared]
  for (const field of shown) if (!(field in fields)) fields[field] = read(entity, field)
  for (const field of FIELDS_OF[entity.kind]) {
    if (!(field in fields) && entity.engine[field] !== DEFAULTS[field]) fields[field] = entity.engine[field]
  }
  return { name: entity.name, ...fields }
}

export function drawableOf(entity: Stored): Drawable | undefined {
  const { x, y, visible, color, opacity, w, h, shape, text, size, align } = entity.engine
  const placed = { name: entity.name, order: entity.order, x, y, visible, color, opacity }
  switch (entity.kind) {
    case 'shape':
      return { ...placed, kind: 'shape', w, h, shape }
    case 'text':
      return { ...placed, kind: 'text', text, size, align }
    case 'data':
      return undefined
    default: {
      const _exhaustive: never = entity.kind
      return _exhaustive
    }
  }
}

function createEntity(name: string, order: number, init: unknown): Stored {
  if (!isPlain(init)) throw new GameError(`entity "${name}" must be an object of fields, got ${show(init)}`)
  if ('name' in init) throw new GameError(`entity "${name}": name is set by the engine, so it can't be declared`)
  const kind: Kind = 'text' in init ? 'text' : SHAPE_FIELDS.some((field) => field in init) ? 'shape' : 'data'
  const custom: Fields = {}
  const initial: Fields = {}
  const choices = new Map<string, readonly string[]>()
  const base: Base = { name, kind, order, engine: { ...DEFAULTS }, custom, declared: Object.keys(init), initial, choices }
  for (const [field, raw] of Object.entries(init)) {
    if (raw === undefined) throw new GameError(`entity "${name}": ${field} is undefined; give it a starting value`)
    assign(base, field, isChoice(raw) ? chosen(base, field, raw, choices) : raw)
    if (!isEngineField(field)) initial[field] = custom[field]
  }
  return { ...base, live: entityProxy(base, true), frozen: entityProxy(base, false) }
}

function chosen(entity: Base, field: string, choice: Choice<string>, choices: Map<string, readonly string[]>): string {
  const options = choice[CHOICE]
  if (!options.includes(choice.initial)) {
    throw new GameError(`entity "${entity.name}": ${field} starts as ${show(choice.initial)}, which isn't one of ${listed(options)}`)
  }
  choices.set(field, options)
  return choice.initial
}

function assign(entity: Base, field: string, value: unknown): void {
  const options = entity.choices.get(field)
  if (options !== undefined && !(typeof value === 'string' && options.includes(value))) {
    throw new GameError(`entity "${entity.name}": ${field} must be one of ${listed(options)}, got ${show(value)}`)
  }
  if (isEngineField(field)) setEngine(entity, field, value)
  else entity.custom[field] = customValue(entity, field, value)
}

function setEngine(entity: Base, field: EngineField, value: unknown): void {
  const where = `entity "${entity.name}"`
  if (!FIELDS_OF[entity.kind].has(field)) throw new GameError(`${where} ${KIND_NOTE[entity.kind]}, so it can't have ${field}`)
  const fields = entity.engine
  switch (field) {
    case 'x':
    case 'y':
      fields[field] = finite(where, field, value)
      return
    case 'w':
    case 'h':
    case 'size':
      fields[field] = positive(where, field, value)
      return
    case 'opacity': {
      const opacity = finite(where, field, value)
      if (opacity < 0 || opacity > 1) throw new GameError(`${where}: opacity must be from 0 to 1, got ${show(value)}`)
      fields.opacity = opacity
      return
    }
    case 'visible':
      if (typeof value !== 'boolean') throw new GameError(`${where}: visible must be true or false, got ${show(value)}`)
      fields.visible = value
      return
    case 'shape':
      if (!isShape(value)) throw new GameError(`${where}: shape must be "square", "circle", or "triangle", got ${show(value)}`)
      fields.shape = value
      return
    case 'align':
      if (!isAlign(value)) throw new GameError(`${where}: align must be "left", "center", or "right", got ${show(value)}`)
      fields.align = value
      return
    case 'color':
      if (typeof value !== 'string' || !isColor(value)) {
        throw new GameError(`${where}: color must be a CSS color like "#ff8800" or "orange", got ${show(value)}`)
      }
      fields.color = value
      return
    case 'text': {
      if (typeof value !== 'string') throw new GameError(`${where}: text must be a string, got ${show(value)}; use String() or a template string`)
      const missing = undrawable(value)
      if (missing !== undefined) {
        throw new GameError(`${where}: text can't draw ${JSON.stringify(missing)}; the font has A-Z, 0-9, space, and . , : ; ! ? - + / ( ) % ' "`)
      }
      fields.text = value
      return
    }
    default: {
      const _exhaustive: never = field
      return _exhaustive
    }
  }
}

function customValue(entity: Base, field: string, value: unknown): Value {
  const clean = data(`entity "${entity.name}"`, field, value)
  const start = entity.initial[field]
  if (start === undefined || start === null || kindOfValue(start) === kindOfValue(clean)) return clean
  throw new GameError(`entity "${entity.name}": ${field} started as ${kindOfValue(start)}, so it can't become ${show(value)}`)
}

function entityProxy(entity: Base, live: boolean): Entity {
  const where = `entity "${entity.name}"`
  const readOnly = () => new GameError(`${where} is read-only here; only start and update change the game`)
  const views = new WeakMap<object, object>()
  const view = (target: object, path: string): object => {
    const known = views.get(target)
    if (known !== undefined) return known
    const proxy = new Proxy(target, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop)
        return typeof prop === 'string' && value !== null && typeof value === 'object' ? view(value, path + step(t, prop)) : value
      },
      set(t, prop, value) {
        if (!live) throw readOnly()
        if (typeof prop === 'symbol') throw new GameError(`${where}: ${path} can't hold symbol keys`)
        if (Array.isArray(t) && prop === 'length') return Reflect.set(t, prop, value)
        return Reflect.set(t, prop, data(where, path + step(t, prop), value))
      },
      deleteProperty(t, prop) {
        if (!live) throw readOnly()
        return Reflect.deleteProperty(t, prop)
      },
      defineProperty(_, prop) {
        throw new GameError(`${where}: assign ${path}${String(prop)} instead of defining it`)
      },
    })
    views.set(target, proxy)
    return proxy
  }
  const has = (field: string) =>
    field === 'name' || (isEngineField(field) ? FIELDS_OF[entity.kind].has(field) : Object.hasOwn(entity.custom, field))
  const get = (field: string): unknown => {
    if (field === 'name') return entity.name
    if (isEngineField(field)) {
      if (!FIELDS_OF[entity.kind].has(field)) throw new GameError(`${where} ${KIND_NOTE[entity.kind]}, so it has no ${field}`)
      return entity.engine[field]
    }
    if (!Object.hasOwn(entity.custom, field)) {
      if (PROBED.has(field)) return undefined
      throw new GameError(`${where} has no field "${field}"`)
    }
    const value = entity.custom[field]
    return value !== null && typeof value === 'object' ? view(value, field) : value
  }
  const handler: ProxyHandler<object> = {
    get: (_, prop) => (typeof prop === 'symbol' ? undefined : get(prop)),
    set(_, prop, value) {
      if (!live) throw readOnly()
      if (typeof prop === 'symbol' || prop === 'name') throw new GameError(`${where}: ${String(prop)} is set by the engine`)
      if (!isEngineField(prop) && !Object.hasOwn(entity.custom, prop)) {
        throw new GameError(`${where} has no field "${prop}"; declare it in entities`)
      }
      assign(entity, prop, value)
      return true
    },
    has: (_, prop) => typeof prop === 'string' && has(prop),
    ownKeys: () => ['name', ...FIELDS_OF[entity.kind], ...Object.keys(entity.custom)],
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === 'symbol' || !has(prop)) return undefined
      return { value: get(prop), writable: live && prop !== 'name', enumerable: true, configurable: true }
    },
    deleteProperty(_, prop) {
      throw new GameError(`can't delete ${String(prop)} from ${where}; set it to another value`)
    },
    defineProperty(_, prop) {
      throw new GameError(`can't define ${String(prop)} on ${where}; assign it instead`)
    },
  }
  // The handler answers for exactly the fields this entity declares plus its engine fields and name.
  return new Proxy({}, handler) as Entity
}

function worldOf(layouts: ReadonlyMap<string, Layout>, pick: (entity: Stored) => Entity): object {
  const members = new Map<string, unknown>()
  for (const [key, layout] of layouts) members.set(key, arrange(layout, pick))
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (members.has(prop)) return members.get(prop)
        if (PROBED.has(prop)) return undefined
        throw new GameError(`no entity named "${prop}"`)
      },
      set(_, prop) {
        throw new GameError(`can't replace entity "${String(prop)}"; change its fields instead`)
      },
      deleteProperty(_, prop) {
        throw new GameError(`can't delete entity "${String(prop)}"; hide it with visible = false`)
      },
      has: (_, prop) => typeof prop === 'string' && members.has(prop),
      ownKeys: () => [...members.keys()],
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop === 'symbol' || !members.has(prop)) return undefined
        return { value: members.get(prop), writable: false, enumerable: true, configurable: true }
      },
    },
  )
}

function arrange(layout: Layout, pick: (entity: Stored) => Entity): unknown {
  switch (layout.kind) {
    case 'one':
      return pick(layout.entity)
    case 'list':
      return Object.freeze(layout.entities.map(pick))
    case 'grid':
      return Object.freeze(layout.rows.map((row) => Object.freeze(row.map(pick))))
    default: {
      const _exhaustive: never = layout
      return _exhaustive
    }
  }
}

function read(entity: Base, field: string): Value {
  return isEngineField(field) ? entity.engine[field] : copy(entity.custom[field])
}

function isEngineField(field: string): field is EngineField {
  return ENGINE_FIELDS.has(field)
}

function isShape(value: unknown): value is Shape {
  return value === 'square' || value === 'circle' || value === 'triangle'
}

function isAlign(value: unknown): value is Align {
  return value === 'left' || value === 'center' || value === 'right'
}

function finite(where: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new GameError(`${where}: ${field} must be a finite number, got ${show(value)}`)
  return value
}

function positive(where: string, field: string, value: unknown): number {
  const number = finite(where, field, value)
  if (number <= 0) throw new GameError(`${where}: ${field} must be greater than 0, got ${show(value)}`)
  return number
}

function data(where: string, path: string, value: unknown): Value {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return finite(where, path, value)
  if (Array.isArray(value)) return value.map((item, i) => data(where, `${path}[${i}]`, item))
  if (isPlain(value)) {
    const out: Fields = {}
    for (const [key, item] of Object.entries(value)) out[key] = data(where, `${path}.${key}`, item)
    return out
  }
  throw new GameError(`${where}: ${path} must be a number, string, boolean, null, array, or plain object, got ${show(value)}`)
}

function kindOfValue(value: Value): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

function step(target: object, prop: string): string {
  return Array.isArray(target) ? `[${prop}]` : `.${prop}`
}

function listed(options: readonly string[]): string {
  return options.map((option) => JSON.stringify(option)).join(', ')
}

function copy(value: Value): Value {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
