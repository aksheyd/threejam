import { imageProblem, type Images } from './assets.ts'
import { isColor } from './colors.ts'
import { GameError, show } from './errors.ts'
import { undrawable } from './font.ts'
import { cos, sin } from './math.ts'
import {
  CHOICE,
  GROUP,
  LIST,
  MAYBE,
  isChoice,
  isGroup,
  isList,
  isMaybe,
  type Align,
  type Choice,
  type Common,
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

// What a value may hold. Fields declared with oneOf, listOf, or maybe have one; plain fields hold any data.
type Schema =
  | { readonly kind: 'any' }
  | { readonly kind: 'number' }
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }
  | { readonly kind: 'tuple'; readonly items: readonly Schema[] }
  | { readonly kind: 'record'; readonly fields: ReadonlyMap<string, Schema> }
  | { readonly kind: 'list'; readonly item: Schema }
  | { readonly kind: 'maybe'; readonly value: Schema }

type Container = Extract<Schema, { readonly kind: 'any' | 'tuple' | 'record' | 'list' }>

const ANY: Container = { kind: 'any' }

const ENGINE_FIELDS: ReadonlySet<string> = new Set<EngineField>(['x', 'y', 'angle', 'visible', 'w', 'h', 'shape', 'color', 'opacity', 'image', 'text', 'size', 'align'])
const FIELDS_OF: Readonly<Record<Kind, ReadonlySet<EngineField>>> = {
  shape: new Set(['x', 'y', 'angle', 'visible', 'w', 'h', 'shape', 'color', 'opacity', 'image']),
  text: new Set(['x', 'y', 'angle', 'visible', 'text', 'size', 'align', 'color', 'opacity']),
  data: new Set(['x', 'y', 'angle', 'visible']),
}
const KIND_NOTE: Readonly<Record<Kind, string>> = { shape: 'is a shape', text: 'is text', data: 'has no shape or text' }
// What state shows for every entity drawn or holding parts, whatever it declares.
const PLACED = ['x', 'y', 'visible'] as const
const SHAPE_FIELDS = ['w', 'h', 'shape', 'color', 'opacity', 'image']
const DEFAULTS: Readonly<EngineFields> = {
  x: 0,
  y: 0,
  angle: 0,
  visible: true,
  w: 1,
  h: 1,
  shape: 'square',
  color: '#ffffff',
  opacity: 1,
  image: '',
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
  readonly schemas: ReadonlyMap<string, Schema>
  // The files in the game's folder, when the game came from one, and the game's sprites, which image may name.
  readonly images: Images
  readonly gate: Gate
}

// Open only while start, update, or --set runs, so code that runs between ticks, like a promise's callback, can't change the game.
interface Gate {
  open: boolean
}

export interface Stored extends Base {
  // A part's entity, which it draws relative to.
  readonly owner: Base | undefined
  readonly parts: readonly Stored[] | undefined
  readonly live: Entity
  readonly frozen: Entity
  // The values spawn puts back, which settle records once --set has applied and before start runs.
  readonly starting: { readonly engine: EngineFields; readonly custom: Fields }
}

// Each entity's proxies lead back to it, so spawn can reset the member it's handed.
const STORED = new WeakMap<object, Stored>()

interface Parts {
  readonly all: readonly Stored[]
  readonly live: object
  readonly frozen: object
}

type Layout =
  | { readonly kind: 'one'; readonly entity: Stored }
  | { readonly kind: 'list'; readonly entities: readonly Stored[] }
  | { readonly kind: 'grid'; readonly rows: readonly (readonly Stored[])[] }

export interface Store<E extends Entities> {
  readonly all: readonly Stored[]
  readonly live: World<E>
  readonly frozen: ReadonlyDeep<World<E>>
  // Runs change with the live world taking writes, which it refuses at any other time.
  edit<T>(change: () => T): T
}

export function createStore<E extends Entities>(entities: E, images: Images): Store<E> {
  const all: Stored[] = []
  const gate: Gate = { open: false }
  const add = (name: string, init: unknown): Stored => {
    const entity = createEntity(name, all.length, init, { owner: undefined, images, gate })
    all.push(entity, ...(entity.parts ?? []))
    return entity
  }
  const layouts = new Map<string, Layout>()
  for (const [key, value] of Object.entries(entities)) {
    if (!isGroup(value)) layouts.set(key, { kind: 'one', entity: add(key, value) })
    else if (value[GROUP] === 'list') layouts.set(key, { kind: 'list', entities: value.members.map((init, i) => add(`${key}[${i}]`, init)) })
    else layouts.set(key, { kind: 'grid', rows: value.rows.map((row, r) => row.map((init, c) => add(`${key}[${r}][${c}]`, init))) })
  }
  const edit = <T>(change: () => T): T => {
    const was = gate.open
    gate.open = true
    try {
      return change()
    } finally {
      gate.open = was
    }
  }
  // Both worlds are built from these entities, so they have exactly the shape World<E> describes.
  return { all, live: worldOf(layouts, (e) => e.live) as World<E>, frozen: worldOf(layouts, (e) => e.frozen) as ReadonlyDeep<World<E>>, edit }
}

export function stateOf(entity: Stored): EntityState {
  const state: { name: string; [field: string]: Value } = { name: entity.name }
  if (entity.kind !== 'data' || entity.parts !== undefined) for (const field of PLACED) state[field] = entity.engine[field]
  for (const field of entity.declared) if (!(field in state)) state[field] = read(entity, field)
  for (const field of FIELDS_OF[entity.kind]) {
    if (!(field in state) && entity.engine[field] !== DEFAULTS[field]) state[field] = entity.engine[field]
  }
  return state
}

export function settle(all: readonly Stored[]): void {
  for (const entity of all) {
    Object.assign(entity.starting.engine, entity.engine)
    for (const [field, value] of Object.entries(entity.custom)) entity.starting.custom[field] = copy(value)
  }
}

// A part sits at its offset turned by its entity's angle, using the portable sin and cos so every page places it where sim does.
export function drawableOf(entity: Stored): Drawable | undefined {
  const { name, order } = entity
  const { color, opacity, w, h, shape, image, text, size, align } = entity.engine
  const at = entity.owner?.engine
  let { x, y, angle } = entity.engine
  let visible = entity.engine.visible
  if (at !== undefined) {
    if (at.angle === 0) {
      x += at.x
      y += at.y
    } else {
      const c = cos(at.angle)
      const s = sin(at.angle)
      const dx = x
      x = at.x + c * dx - s * y
      y = at.y + s * dx + c * y
      angle += at.angle
    }
    visible &&= at.visible
  }
  switch (entity.kind) {
    case 'shape':
      return { kind: 'shape', name, order, x, y, angle, visible, color, opacity, w, h, shape, image }
    case 'text':
      return { kind: 'text', name, order, x, y, angle, visible, color, opacity, text, size, align }
    case 'data':
      return undefined
    default: {
      const _exhaustive: never = entity.kind
      return _exhaustive
    }
  }
}

// Resets the first hidden member of a group to its starting values, parts too, then applies fields and shows it.
export function spawn<T extends Common>(group: readonly T[], fields: Spawn<T> = {}): T | undefined {
  if (!Array.isArray(group)) throw new GameError(`spawn takes a group of entities, like world.bullets, got ${show(group)}`)
  if (!isPlain(fields)) throw new GameError(`spawn takes the fields to set as an object, like { x: 0, y: 1 }, got ${show(fields)}`)
  for (const member of group) {
    const stored = STORED.get(member)
    if (stored === undefined) throw new GameError(`spawn takes a group of entities, like world.bullets, but it holds ${show(member)}`)
    if (stored.engine.visible) continue
    if (stored.live !== member || !stored.gate.open) throw new GameError(`entity "${stored.name}" is read-only here; only start and update change the game`)
    for (const entity of [stored, ...(stored.parts ?? [])]) {
      Object.assign(entity.engine, entity.starting.engine)
      for (const [field, value] of Object.entries(entity.starting.custom)) entity.custom[field] = copy(value)
    }
    for (const [field, value] of Object.entries(fields)) Reflect.set(member, field, value)
    member.visible = true
    return member
  }
  return undefined
}

// The fields spawn can set on a member: any of its own but its name and parts.
export type Spawn<T> = { -readonly [F in keyof T as F extends 'name' | 'parts' ? never : F]?: T[F] }

function createEntity(name: string, order: number, init: unknown, { owner, images, gate }: { owner: Base | undefined; images: Images; gate: Gate }): Stored {
  const where = `entity "${name}"`
  if (!isPlain(init)) throw new GameError(`${where} must be an object of fields, got ${show(init)}`)
  if ('name' in init) throw new GameError(`${where}: name is set by the engine, so it can't be declared`)
  const kind: Kind = 'text' in init ? 'text' : SHAPE_FIELDS.some((field) => field in init) ? 'shape' : 'data'
  if (owner !== undefined && kind === 'data') {
    throw new GameError(`${where} has no shape or text; give a part w, h, shape, color, opacity, or image to be a shape, or text to be text`)
  }
  const fields = Object.entries(init).filter(([field]) => field !== 'parts')
  const custom: Fields = {}
  const initial: Fields = {}
  const schemas = new Map<string, Schema>()
  const base: Base = { name, kind, order, engine: { ...DEFAULTS }, custom, declared: fields.map(([field]) => field), initial, schemas, images, gate }
  for (const [field, raw] of fields) {
    if (raw === undefined) throw new GameError(`${where}: ${field} is undefined; give it a starting value`)
    const schema = declaredSchema(where, field, raw)
    if (schema !== undefined) schemas.set(field, schema)
    assign(base, field, isChoice(raw) ? chosen(where, field, raw) : isList(raw) ? raw.items : isMaybe(raw) ? null : raw)
    if (!isEngineField(field)) initial[field] = custom[field]
  }
  if (owner !== undefined && 'parts' in init) throw new GameError(`${where}: parts can't have parts`)
  const parts = 'parts' in init ? createParts(base, init.parts) : undefined
  const live = entityProxy(base, true, parts?.live)
  const frozen = entityProxy(base, false, parts?.frozen)
  const stored: Stored = { ...base, owner, parts: parts?.all, live, frozen, starting: { engine: { ...base.engine }, custom: {} } }
  STORED.set(live, stored)
  STORED.set(frozen, stored)
  return stored
}

function createParts(entity: Base, init: unknown): Parts {
  const part = (suffix: string, index: number, fields: unknown) =>
    createEntity(`${entity.name}.parts${suffix}`, entity.order + 1 + index, fields, { owner: entity, images: entity.images, gate: entity.gate })
  if (Array.isArray(init)) {
    const all = init.map((fields: unknown, i) => part(`[${i}]`, i, fields))
    return { all, live: Object.freeze(all.map((p) => p.live)), frozen: Object.freeze(all.map((p) => p.frozen)) }
  }
  if (!isPlain(init)) throw new GameError(`entity "${entity.name}": parts must be an object of named parts or an array of parts, got ${show(init)}`)
  const named = Object.entries(init).map(([key, fields], i) => [key, part(`.${key}`, i, fields)] as const)
  const members = (pick: (p: Stored) => Entity) =>
    namedMembers(
      new Map(named.map(([key, p]) => [key, pick(p)])),
      (key) => `entity "${entity.name}" has no part "${key}"`,
      (key) => `part "${entity.name}.parts.${key}"`,
    )
  return { all: named.map(([, p]) => p), live: members((p) => p.live), frozen: members((p) => p.frozen) }
}

function chosen(where: string, field: string, choice: Choice<string>): string {
  const options = choice[CHOICE]
  if (!options.includes(choice.initial)) throw new GameError(`${where}: ${field} starts as ${show(choice.initial)}, which isn't one of ${listed(options)}`)
  return choice.initial
}

function declaredSchema(where: string, field: string, raw: unknown): Schema | undefined {
  if (isChoice(raw)) return { kind: 'choice', options: raw[CHOICE] }
  if (isList(raw)) return { kind: 'list', item: exampleSchema(where, field, '', raw[LIST]) }
  if (isMaybe(raw)) return { kind: 'maybe', value: exampleSchema(where, field, '', raw[MAYBE]) }
  return undefined
}

// An example is written like a starting value; each value in it stands for any value of its kind.
function exampleSchema(where: string, field: string, path: string, example: unknown): Schema {
  const problem = (text: string) => new GameError(`${where}: ${field}: example${path} ${text}`)
  if (typeof example === 'number') {
    if (!Number.isFinite(example)) throw problem(`must be a finite number, got ${show(example)}`)
    return { kind: 'number' }
  }
  if (typeof example === 'string') return { kind: 'string' }
  if (typeof example === 'boolean') return { kind: 'boolean' }
  if (isChoice(example)) return { kind: 'choice', options: example[CHOICE] }
  if (isList(example)) return { kind: 'list', item: exampleSchema(where, field, `${path}[*]`, example[LIST]) }
  if (isMaybe(example)) return { kind: 'maybe', value: exampleSchema(where, field, path, example[MAYBE]) }
  if (Array.isArray(example)) return { kind: 'tuple', items: example.map((item: unknown, i) => exampleSchema(where, field, `${path}[${i}]`, item)) }
  if (isPlain(example)) {
    return { kind: 'record', fields: new Map(Object.entries(example).map(([key, item]) => [key, exampleSchema(where, field, `${path}.${key}`, item)])) }
  }
  if (example === null) throw problem("can't be null; use maybe(example) for a value that can be null")
  throw problem(`must be a number, string, boolean, array, plain object, oneOf, listOf, or maybe, got ${show(example)}`)
}

function assign(entity: Base, field: string, value: unknown): void {
  const schema = entity.schemas.get(field)
  if (isEngineField(field)) setEngine(entity, field, schema === undefined ? value : conform(`entity "${entity.name}"`, field, schema, value))
  else entity.custom[field] = schema === undefined ? customValue(entity, field, value) : conform(`entity "${entity.name}"`, field, schema, value)
}

function setEngine(entity: Base, field: EngineField, value: unknown): void {
  const where = `entity "${entity.name}"`
  if (!FIELDS_OF[entity.kind].has(field)) throw new GameError(`${where} ${KIND_NOTE[entity.kind]}, so it can't have ${field}`)
  const fields = entity.engine
  switch (field) {
    case 'x':
    case 'y':
    case 'angle':
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
    case 'image': {
      if (typeof value !== 'string') throw new GameError(`${where}: image must be the name of an image file, like "rock.png", or of a sprite, like "rock", or "" for none, got ${show(value)}`)
      const problem = value === '' ? undefined : imageProblem(value, entity.images)
      if (problem !== undefined) throw new GameError(`${where}: ${problem}`)
      fields.image = value
      return
    }
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

function entityProxy(entity: Base, live: boolean, parts: object | undefined): Entity {
  const where = `entity "${entity.name}"`
  const readOnly = () => new GameError(`${where} is read-only here; only start and update change the game`)
  const views = new WeakMap<object, object>()
  // Values are copied on assignment, so each object lives in one place and keeps the schema it was checked with.
  const view = (target: object, path: string, schema: Container): object => {
    const proxy = new Proxy(target, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop)
        if (typeof prop !== 'string' || value === null || typeof value !== 'object') return value
        return views.get(value) ?? view(value, path + step(t, prop), container(within(schema, prop)))
      },
      set(t, prop, value) {
        if (!live || !entity.gate.open) throw readOnly()
        if (typeof prop === 'symbol') throw new GameError(`${where}: ${path} can't hold symbol keys`)
        return Reflect.set(t, prop, change(where, path, schema, t, prop, value))
      },
      deleteProperty(t, prop) {
        if (!live || !entity.gate.open) throw readOnly()
        if (schema.kind === 'tuple' || schema.kind === 'record') {
          throw new GameError(`${where}: can't delete ${path}${step(t, String(prop))}, since ${path} holds ${describe(schema)}`)
        }
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
    field === 'name' ||
    (field === 'parts' && parts !== undefined) ||
    (isEngineField(field) ? FIELDS_OF[entity.kind].has(field) : Object.hasOwn(entity.custom, field))
  const get = (field: string): unknown => {
    if (field === 'name') return entity.name
    if (isEngineField(field)) {
      if (!FIELDS_OF[entity.kind].has(field)) throw new GameError(`${where} ${KIND_NOTE[entity.kind]}, so it has no ${field}`)
      return entity.engine[field]
    }
    if (!Object.hasOwn(entity.custom, field)) {
      if (field === 'parts' && parts !== undefined) return parts
      if (PROBED.has(field)) return undefined
      throw new GameError(`${where} has no field "${field}"`)
    }
    const value = entity.custom[field]
    if (value === null || typeof value !== 'object') return value
    return views.get(value) ?? view(value, field, container(entity.schemas.get(field) ?? ANY))
  }
  const handler: ProxyHandler<object> = {
    get: (_, prop) => (typeof prop === 'symbol' ? undefined : get(prop)),
    set(_, prop, value) {
      if (!live || !entity.gate.open) throw readOnly()
      if (typeof prop === 'symbol' || prop === 'name') throw new GameError(`${where}: ${String(prop)} is set by the engine`)
      if (prop === 'parts' && parts !== undefined) throw new GameError(`${where}: parts can't be replaced; change the fields of each part instead`)
      if (!isEngineField(prop) && !Object.hasOwn(entity.custom, prop)) {
        throw new GameError(`${where} has no field "${prop}"; declare it in entities`)
      }
      assign(entity, prop, value)
      return true
    },
    has: (_, prop) => typeof prop === 'string' && has(prop),
    ownKeys: () => ['name', ...FIELDS_OF[entity.kind], ...Object.keys(entity.custom), ...(parts === undefined ? [] : ['parts'])],
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === 'symbol' || !has(prop)) return undefined
      return { value: get(prop), writable: live && prop !== 'name' && prop !== 'parts', enumerable: true, configurable: true }
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
  return namedMembers(
    members,
    (key) => `no entity named "${key}"`,
    (key) => `entity "${key}"`,
  )
}

// A fixed set of named entities, like the world or an entity's named parts: reading a missing name or replacing one fails.
function namedMembers(members: ReadonlyMap<string, unknown>, missing: (key: string) => string, member: (key: string) => string): object {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (members.has(prop)) return members.get(prop)
        if (PROBED.has(prop)) return undefined
        throw new GameError(missing(prop))
      },
      set(_, prop) {
        throw new GameError(`can't replace ${member(String(prop))}; change its fields instead`)
      },
      deleteProperty(_, prop) {
        throw new GameError(`can't delete ${member(String(prop))}; hide it with visible = false`)
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

// Checks a whole value and returns a clean copy; shown is what a mismatch says the value must be.
function conform(where: string, path: string, schema: Schema, value: unknown, shown: Schema = schema): Value {
  switch (schema.kind) {
    case 'any':
      return data(where, path, value)
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value
      break
    case 'string':
      if (typeof value === 'string') return value
      break
    case 'boolean':
      if (typeof value === 'boolean') return value
      break
    case 'choice':
      if (typeof value === 'string' && schema.options.includes(value)) return value
      break
    case 'tuple':
      if (Array.isArray(value) && value.length === schema.items.length) {
        return schema.items.map((item, i) => conform(where, `${path}[${i}]`, item, value[i]))
      }
      break
    case 'record': {
      const keys = isPlain(value) ? Object.keys(value) : []
      if (isPlain(value) && keys.length === schema.fields.size && keys.every((key) => schema.fields.has(key))) {
        return Object.fromEntries([...schema.fields].map(([key, field]) => [key, conform(where, `${path}.${key}`, field, value[key])]))
      }
      break
    }
    case 'list':
      if (Array.isArray(value)) return value.map((item: unknown, i) => conform(where, `${path}[${i}]`, schema.item, item))
      break
    case 'maybe':
      return value === null ? null : conform(where, path, schema.value, value, shown)
    default: {
      const _exhaustive: never = schema
      return _exhaustive
    }
  }
  throw new GameError(`${where}: ${path} must be ${expected(shown)}, got ${show(value)}`)
}

// Checks one assignment inside a value, like list.push(item) or pair[0] = 1, and returns what to store.
function change(where: string, path: string, schema: Container, target: object, prop: string, value: unknown): unknown {
  const size = Array.isArray(target) ? target.length : 0
  switch (schema.kind) {
    case 'any':
      return Array.isArray(target) && prop === 'length' ? value : data(where, path + step(target, prop), value)
    case 'list':
      if (prop === 'length') {
        if (typeof value === 'number' && value <= size) return value
        throw new GameError(`${where}: ${path} grows only by adding items, like ${path}.push(item)`)
      }
      if (!isIndex(prop)) throw new GameError(`${where}: ${path} holds ${describe(schema)}, so it can't have "${prop}"`)
      if (Number(prop) > size) throw new GameError(`${where}: ${path}[${prop}] would leave a gap, since ${path} has ${size} items`)
      return conform(where, `${path}[${prop}]`, schema.item, value)
    case 'tuple': {
      if (prop === 'length' && value === size) return value
      const item = isIndex(prop) ? schema.items[Number(prop)] : undefined
      if (item === undefined) throw new GameError(`${where}: ${path} holds ${describe(schema)}, so it keeps ${schema.items.length} items`)
      return conform(where, `${path}[${prop}]`, item, value)
    }
    case 'record': {
      const field = schema.fields.get(prop)
      if (field === undefined) throw new GameError(`${where}: ${path} has no key "${prop}"; it holds ${describe(schema)}`)
      return conform(where, `${path}.${prop}`, field, value)
    }
    default: {
      const _exhaustive: never = schema
      return _exhaustive
    }
  }
}

function within(schema: Container, prop: string): Schema {
  switch (schema.kind) {
    case 'any':
      return ANY
    case 'list':
      return schema.item
    case 'tuple':
      return schema.items[Number(prop)] ?? ANY
    case 'record':
      return schema.fields.get(prop) ?? ANY
    default: {
      const _exhaustive: never = schema
      return _exhaustive
    }
  }
}

// The schema of a value that is an object, which a maybe holds once it isn't null.
function container(schema: Schema): Container {
  switch (schema.kind) {
    case 'maybe':
      return container(schema.value)
    case 'any':
    case 'tuple':
    case 'record':
    case 'list':
      return schema
    case 'number':
    case 'string':
    case 'boolean':
    case 'choice':
      return ANY
    default: {
      const _exhaustive: never = schema
      return _exhaustive
    }
  }
}

function expected(schema: Schema): string {
  switch (schema.kind) {
    case 'any':
      return 'a number, string, boolean, null, array, or plain object'
    case 'number':
      return 'a finite number'
    case 'string':
      return 'a string'
    case 'boolean':
      return 'true or false'
    case 'choice':
      return `one of ${listed(schema.options)}`
    case 'maybe':
      return `${expected(schema.value)} or null`
    case 'tuple':
    case 'record':
    case 'list':
      return describe(schema)
    default: {
      const _exhaustive: never = schema
      return _exhaustive
    }
  }
}

// Describes a schema the way TypeScript writes the type, like { x: number; y: number }[].
function describe(schema: Schema): string {
  switch (schema.kind) {
    case 'any':
      return 'Value'
    case 'number':
    case 'string':
    case 'boolean':
      return schema.kind
    case 'choice':
      return schema.options.map((option) => JSON.stringify(option)).join(' | ')
    case 'tuple':
      return `[${schema.items.map(describe).join(', ')}]`
    case 'record':
      return schema.fields.size === 0 ? '{}' : `{ ${[...schema.fields].map(([key, field]) => `${key}: ${describe(field)}`).join('; ')} }`
    case 'list': {
      const union = schema.item.kind === 'maybe' || (schema.item.kind === 'choice' && schema.item.options.length > 1)
      return union ? `(${describe(schema.item)})[]` : `${describe(schema.item)}[]`
    }
    case 'maybe':
      return `${describe(schema.value)} | null`
    default: {
      const _exhaustive: never = schema
      return _exhaustive
    }
  }
}

function isIndex(prop: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(prop)
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
