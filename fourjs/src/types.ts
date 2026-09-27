export type Value = number | string | boolean | null | Value[] | { [key: string]: Value }

export type Shape = 'square' | 'circle' | 'triangle'
export type Align = 'left' | 'center' | 'right'

export type Common = {
  x: number
  y: number
  visible: boolean
}

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

export type EntityInit = Partial<Common> & Partial<Visuals> & { [field: string]: Value | undefined }

export type Entities = Record<string, EntityInit>

export type Entity<I extends EntityInit = EntityInit> = Common &
  (string extends keyof I ? { [field: string]: Value } : { -readonly [F in keyof I]-?: Exclude<I[F], undefined> })

export type World<E extends Entities> = { readonly [K in keyof E]: Entity<E[K]> }

export interface Input {
  held(key: string): boolean
  pressed(key: string): boolean
  released(key: string): boolean
}

export interface Context {
  readonly tick: number
  readonly dt: number
  readonly input: Input
  random(): number
  print(...values: unknown[]): void
  all(prefix: string): Entity[]
}

export interface Game<E extends Entities = Entities> {
  title?: string
  background?: string
  entities: E
  start?(world: World<E>, ctx: Context): void
  update(world: World<E>, ctx: Context): void
}

export type EntityState = { name: string } & { [field: string]: Value }

export interface Snapshot {
  tick: number
  entities: EntityState[]
}

export interface Drawable {
  name: string
  kind: 'shape' | 'text'
  fields: Common & Visuals & { [field: string]: Value }
}

export function defineGame<E extends Entities>(game: Game<E>): Game<E> {
  return game
}
