import { GameError } from './errors.ts'

export type Value = number | string | boolean | null | Value[] | { [key: string]: Value }

export type Shape = 'square' | 'circle' | 'triangle'
export type Align = 'left' | 'center' | 'right'

export const KEYS = [
  ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
  ...['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'],
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  ...['Space', 'Enter', 'Tab', 'Backspace', 'Shift', 'Ctrl', 'Alt', 'Up', 'Down', 'Left', 'Right'],
  ...['Mouse', 'MouseRight'],
] as const

export type Key = (typeof KEYS)[number]

export const SOUNDS = ['blip', 'coin', 'explode', 'hit', 'jump', 'lose', 'score', 'shoot'] as const

// A built-in sound, or a sound file next to game.ts named with its extension.
export type Sound = (typeof SOUNDS)[number] | `${string}.${'wav' | 'mp3' | 'ogg' | 'WAV' | 'MP3' | 'OGG'}`

export type Common = { x: number; y: number; angle: number; visible: boolean }

export type Visuals = {
  w: number
  h: number
  shape: Shape
  color: string
  opacity: number
  image: string
  text: string
  size: number
  align: Align
}

export type EngineFields = Common & Visuals

// Symbol.for keeps these markers recognizable across separately bundled copies of this module.
export const CHOICE: unique symbol = Symbol.for('threejam.choice')
export const GROUP: unique symbol = Symbol.for('threejam.group')
export const LIST: unique symbol = Symbol.for('threejam.list')
export const MAYBE: unique symbol = Symbol.for('threejam.maybe')

export interface Choice<T extends string> {
  readonly [CHOICE]: readonly T[]
  readonly initial: T
}

export type Example =
  | number
  | string
  | boolean
  | readonly Example[]
  | { readonly [key: string]: Example }
  | Choice<string>
  | ListOf<Example>
  | Maybe<Example>

export interface ListOf<T extends Example> {
  readonly [LIST]: T
  readonly items: readonly unknown[]
}

export interface Maybe<T extends Example> {
  readonly [MAYBE]: T
}

export type FieldValue = Value | Choice<string> | ListOf<Example> | Maybe<Example>

export type PartInit = Partial<EngineFields> & { readonly parts?: never; readonly [field: string]: FieldValue | undefined }

export type PartsInit = { readonly [name: string]: PartInit } | readonly PartInit[]

export type EntityInit = Partial<EngineFields> & { readonly parts?: PartsInit; readonly [field: string]: FieldValue | PartsInit | undefined }

export interface Group<I extends EntityInit> {
  readonly [GROUP]: 'list'
  readonly members: readonly I[]
}

export interface Grid<I extends EntityInit> {
  readonly [GROUP]: 'grid'
  readonly rows: readonly (readonly I[])[]
}

export type Entities = Record<string, EntityInit | Group<EntityInit> | Grid<EntityInit>>

// Pixel art as text: each of rows is a row of pixels, top to bottom, where . shows what's behind and every other character is the color palette gives it.
export interface Sprite {
  readonly rows: readonly string[]
  readonly palette?: { readonly [char: string]: string }
}

// The sprites a game draws, by the names an entity's image gives them.
export type Sprites = { readonly [name: string]: Sprite }

// Inference instantiates this with all of Example before it knows T, which would otherwise recurse forever.
type Shaped<T> = [Example] extends [T] ? Value : ShapedEach<T>

type ShapedEach<T> = T extends Choice<infer C>
  ? C
  : T extends ListOf<infer I>
    ? Shaped<I>[]
    : T extends Maybe<infer I>
      ? Shaped<I> | null
      : T extends number
        ? number
        : T extends string
          ? string
          : T extends boolean
            ? boolean
            : { -readonly [K in keyof T]: Shaped<T[K]> }

type Widen<T> = T extends Choice<string> | ListOf<Example> | Maybe<Example>
  ? Shaped<T>
  : T extends boolean
    ? boolean
    : T extends null
      ? Value
      : T extends readonly never[]
        ? Value[]
        : T

// The fields I declares; in an array literal, TypeScript gives each object the others' keys as optional undefined.
type Given<I> = { [F in keyof I]-?: [Exclude<I[F], undefined>] extends [never] ? never : F }[keyof I]

type Declared<I extends EntityInit> = {
  [F in Exclude<Given<I>, 'parts'>]: F extends keyof EngineFields ? EngineFields[F] : Widen<Exclude<I[F], undefined>>
}

type ShapeField = 'w' | 'h' | 'shape' | 'color' | 'opacity' | 'image'

type KindFields<I extends EntityInit> = 'text' extends Given<I>
  ? Pick<Visuals, 'text' | 'size' | 'align' | 'color' | 'opacity'>
  : [Extract<Given<I>, ShapeField>] extends [never]
    ? unknown
    : Pick<Visuals, ShapeField>

type Part<I> = I extends EntityInit ? Entity<I> : never

type PartsOf<I extends EntityInit> = I extends { readonly parts: infer P }
  ? { readonly parts: P extends readonly (infer Each)[] ? readonly Part<Each>[] : { readonly [K in keyof P]: Part<P[K]> } }
  : unknown

// Not Value: parts aren't values, and relating typed lists to Value recurses past TypeScript's depth limit.
export type Entity<I extends EntityInit = EntityInit> = Common & { readonly name: string } & (string extends keyof I
    ? { [field: string]: unknown }
    : KindFields<I> & Declared<I> & PartsOf<I>)

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

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Input {
  held(key: Key): boolean
  pressed(key: Key): boolean
  released(key: Key): boolean
  // Where the mouse is in world units, the same for the whole tick.
  readonly pointer: Point
}

export interface Context {
  readonly tick: number
  readonly dt: number
  readonly input: Input
  random(): number
  print(...values: unknown[]): void
  play(sound: Sound, options?: { readonly volume?: number; readonly pitch?: number }): void
}

export interface Game<E extends Entities = Entities> {
  title?: string
  background?: string
  sprites?: Sprites
  entities: E
  start?(world: World<E>, ctx: Context): void
  update(world: World<E>, ctx: Context): void
}

export type EntitiesOf<G> = G extends Game<infer E> ? E : never

export interface DriverFrame<E extends Entities> {
  readonly world: ReadonlyDeep<World<E>>
  readonly tick: number
  readonly keys: readonly Key[]
  readonly pointer: Point
  random(): number
}

// The input for one tick: the keys held during it, and where the pointer moves, if it moves.
export interface Controls {
  readonly keys?: Iterable<Key>
  readonly pointer?: Point
}

export type Driver<E extends Entities = Entities> = (frame: DriverFrame<E>) => Iterable<Key> | Controls

export const DRIVER: unique symbol = Symbol.for('threejam.driver')

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

export interface SoundEntry {
  readonly tick: number
  readonly name: string
  readonly volume: number
  readonly pitch: number
}

export type EntityState = { readonly name: string } & { readonly [field: string]: Value }

export interface Snapshot {
  readonly tick: number
  readonly entities: readonly EntityState[]
}

// Where an entity or part is on the screen: a part's place and angle already include its entity's.
type Placed = {
  readonly name: string
  readonly order: number
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly visible: boolean
  readonly color: string
  readonly opacity: number
}

export type Drawable =
  | (Placed & { readonly kind: 'shape'; readonly w: number; readonly h: number; readonly shape: Shape; readonly image: string })
  | (Placed & { readonly kind: 'text'; readonly text: string; readonly size: number; readonly align: Align })

export function defineGame<E extends Entities>(game: Game<E>): Game<E> {
  return game
}

export function oneOf<const T extends readonly [string, ...string[]]>(options: T, initial: T[number] = options[0]): Choice<T[number]> {
  return { [CHOICE]: options, initial }
}

export function listOf<const T extends Example>(example: T, items: readonly NoInfer<Shaped<T>>[] = []): ListOf<T> {
  return { [LIST]: example, items }
}

export function maybe<const T extends Example>(example: T): Maybe<T> {
  return { [MAYBE]: example }
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

export function isList(value: unknown): value is ListOf<Example> {
  return typeof value === 'object' && value !== null && LIST in value
}

export function isMaybe(value: unknown): value is Maybe<Example> {
  return typeof value === 'object' && value !== null && MAYBE in value
}

function wholeCount(what: string, count: number): number {
  if (!Number.isInteger(count) || count < 0) throw new GameError(`${what} needs a whole number from 0 up, got ${count}`)
  return count
}
