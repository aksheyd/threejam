import { GameError } from './errors.ts'

export type Value = number | string | boolean | null | Value[] | { [key: string]: Value }

export type Shape = 'square' | 'circle' | 'triangle'
export type Align = 'left' | 'center' | 'right'

export const KEYS = [
  ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
  ...['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'],
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  ...['Space', 'Enter', 'Tab', 'Backspace', 'Shift', 'Ctrl', 'Alt', 'Up', 'Down', 'Left', 'Right'],
] as const

export type Key = (typeof KEYS)[number]

export type Common = { x: number; y: number; visible: boolean }

export type Visuals = {
  w: number
  h: number
  shape: Shape
  color: string
  opacity: number
  text: string
  size: number
  align: Align
}

export type EngineFields = Common & Visuals

// Symbol.for keeps these markers recognizable across separately bundled copies of this module.
export const CHOICE: unique symbol = Symbol.for('fourjs.choice')
export const GROUP: unique symbol = Symbol.for('fourjs.group')

export interface Choice<T extends string> {
  readonly [CHOICE]: readonly T[]
  readonly initial: T
}

export type FieldValue = Value | Choice<string>

export type EntityInit = Partial<EngineFields> & { readonly [field: string]: FieldValue | undefined }

export interface Group<I extends EntityInit> {
  readonly [GROUP]: 'list'
  readonly members: readonly I[]
}

export interface Grid<I extends EntityInit> {
  readonly [GROUP]: 'grid'
  readonly rows: readonly (readonly I[])[]
}

export type Entities = Record<string, EntityInit | Group<EntityInit> | Grid<EntityInit>>

type Widen<T> = T extends Choice<infer C>
  ? C
  : T extends boolean
    ? boolean
    : T extends null
      ? Value
      : T extends readonly never[]
        ? Value[]
        : T

type Declared<I extends EntityInit> = {
  -readonly [F in keyof I]-?: F extends keyof EngineFields ? EngineFields[F] : Widen<Exclude<I[F], undefined>>
}

type ShapeField = 'w' | 'h' | 'shape' | 'color' | 'opacity'

type KindFields<I extends EntityInit> = 'text' extends keyof I
  ? Pick<Visuals, 'text' | 'size' | 'align' | 'color' | 'opacity'>
  : [Extract<keyof I, ShapeField>] extends [never]
    ? unknown
    : Pick<Visuals, ShapeField>

export type Entity<I extends EntityInit = EntityInit> = Common & { readonly name: string } & (string extends keyof I
    ? { [field: string]: Value }
    : KindFields<I> & Declared<I>)

type Member<T> =
  T extends Group<infer I>
    ? readonly Entity<I>[]
    : T extends Grid<infer I>
      ? readonly (readonly Entity<I>[])[]
      : T extends EntityInit
        ? Entity<T>
        : never

export type World<E extends Entities> = { readonly [K in keyof E]: Member<E[K]> }

export type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T

export interface Input {
  held(key: Key): boolean
  pressed(key: Key): boolean
  released(key: Key): boolean
}

export interface Context {
  readonly tick: number
  readonly dt: number
  readonly input: Input
  random(): number
  print(...values: unknown[]): void
}

export interface Game<E extends Entities = Entities> {
  title?: string
  background?: string
  entities: E
  start?(world: World<E>, ctx: Context): void
  update(world: World<E>, ctx: Context): void
}

export type EntitiesOf<G> = G extends Game<infer E> ? E : never

export interface DriverFrame<E extends Entities> {
  readonly world: ReadonlyDeep<World<E>>
  readonly tick: number
  random(): number
}

export type Driver<E extends Entities = Entities> = (frame: DriverFrame<E>) => Iterable<Key>

export const DRIVER: unique symbol = Symbol.for('fourjs.driver')

export interface DriverFactory<E extends Entities = Entities> {
  readonly [DRIVER]: () => Driver<E>
}

export type Drive<E extends Entities = Entities> = Driver<E> | DriverFactory<E>

export function defineDriver<E extends Entities = Entities>(factory: () => Driver<E>): DriverFactory<E> {
  return { [DRIVER]: factory }
}

export function driverFor<E extends Entities>(drive: Drive<E>): Driver<E> {
  return typeof drive === 'function' ? drive : drive[DRIVER]()
}

export function isDrive(value: unknown): value is Drive {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && DRIVER in value && typeof value[DRIVER] === 'function')
}

export interface LogEntry {
  readonly tick: number
  readonly text: string
}

export type EntityState = { readonly name: string } & { readonly [field: string]: Value }

export interface Snapshot {
  readonly tick: number
  readonly entities: readonly EntityState[]
}

type Placed = {
  readonly name: string
  readonly order: number
  readonly x: number
  readonly y: number
  readonly visible: boolean
  readonly color: string
  readonly opacity: number
}

export type Drawable =
  | (Placed & { readonly kind: 'shape'; readonly w: number; readonly h: number; readonly shape: Shape })
  | (Placed & { readonly kind: 'text'; readonly text: string; readonly size: number; readonly align: Align })

export function defineGame<E extends Entities>(game: Game<E>): Game<E> {
  return game
}

export function oneOf<const T extends readonly [string, ...string[]]>(options: T, initial: T[number] = options[0]): Choice<T[number]> {
  return { [CHOICE]: options, initial }
}

export function group<I extends EntityInit>(count: number, make: (index: number) => I): Group<I> {
  return { [GROUP]: 'list', members: Array.from({ length: wholeCount('group', count) }, (_, index) => make(index)) }
}

export function grid<I extends EntityInit>(rows: number, cols: number, make: (cell: { row: number; col: number }) => I): Grid<I> {
  const width = wholeCount('grid columns', cols)
  return {
    [GROUP]: 'grid',
    rows: Array.from({ length: wholeCount('grid rows', rows) }, (_, row) => Array.from({ length: width }, (_, col) => make({ row, col }))),
  }
}

export function isChoice(value: unknown): value is Choice<string> {
  return typeof value === 'object' && value !== null && CHOICE in value
}

export function isGroup(value: unknown): value is Group<EntityInit> | Grid<EntityInit> {
  return typeof value === 'object' && value !== null && GROUP in value
}

function wholeCount(what: string, count: number): number {
  if (!Number.isInteger(count) || count < 0) throw new GameError(`${what} needs a whole number from 0 up, got ${count}`)
  return count
}
