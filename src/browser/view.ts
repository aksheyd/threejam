import * as THREE from 'three'
import { FONT_ADVANCE, FONT_ROWS, glyph } from '../font.ts'
import type { Drawable, Entities, EntitiesOf, Game, ReadonlyDeep, World } from '../types.ts'

export type EntityMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>

export interface ViewSetup<G extends Game = Game> {
  readonly THREE: typeof THREE
  readonly scene: THREE.Scene
  readonly camera: THREE.OrthographicCamera
  readonly renderer: THREE.WebGLRenderer
  readonly objects: ReadonlyMap<string, EntityMesh>
  readonly world: ReadonlyDeep<World<EntitiesOf<G>>>
}

export interface ViewFrame<G extends Game = Game> extends ViewSetup<G> {
  readonly tick: number
}

export interface ViewModule {
  init?(setup: ViewSetup): void
  draw?(frame: ViewFrame): void
}

export interface Scene {
  readonly drawables: readonly Drawable[]
  readonly world: ReadonlyDeep<World<Entities>>
  readonly tick: number
}

// Each geometry spans a unit square, and its texture coordinates span the image, so an image fills a shape's w by h box, cut to its shape.
const GEOMETRY = {
  square: new THREE.PlaneGeometry(1, 1),
  circle: new THREE.CircleGeometry(0.5, 48),
  triangle: new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], 3))
    .setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2)),
}

interface Label {
  readonly text: string
  readonly texture: THREE.CanvasTexture
  readonly columns: number
}

export class View {
  readonly #renderer: THREE.WebGLRenderer
  readonly #scene = new THREE.Scene()
  readonly #camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, -10, 10)
  readonly #objects = new Map<string, EntityMesh>()
  readonly #labels = new Map<string, Label>()
  readonly #images: ReadonlyMap<string, THREE.Texture>
  readonly #custom: ViewModule
  #started = false

  constructor({ canvas, game, custom, images }: { canvas: HTMLCanvasElement; game: Game; custom: ViewModule; images: ReadonlyMap<string, THREE.Texture> }) {
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    this.#scene.background = new THREE.Color(game.background ?? '#08080d')
    this.#images = images
    this.#custom = custom
  }

  resize(width: number, height: number, ratio = devicePixelRatio): void {
    this.#renderer.setPixelRatio(ratio)
    this.#renderer.setSize(width, height)
  }

  draw({ drawables, world, tick }: Scene): void {
    for (const drawable of drawables) this.#place(this.#objects.get(drawable.name) ?? this.#create(drawable), drawable)
    const setup: ViewSetup = { THREE, scene: this.#scene, camera: this.#camera, renderer: this.#renderer, objects: this.#objects, world }
    if (!this.#started) {
      this.#started = true
      custom('init', () => this.#custom.init?.(setup))
    }
    custom(`draw at tick ${tick}`, () => this.#custom.draw?.({ ...setup, tick }))
    this.#renderer.render(this.#scene, this.#camera)
  }

  #create(drawable: Drawable): EntityMesh {
    // Custom blending fades without joining Three's transparent pass, so faded meshes keep their declared order.
    const material = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, blending: THREE.CustomBlending })
    const mesh = new THREE.Mesh(GEOMETRY.square, material)
    mesh.name = drawable.name
    mesh.renderOrder = drawable.order
    this.#scene.add(mesh)
    this.#objects.set(drawable.name, mesh)
    return mesh
  }

  #place(mesh: EntityMesh, drawable: Drawable): void {
    const material = mesh.material
    material.opacity = drawable.opacity
    material.color.set(drawable.color)
    mesh.rotation.z = drawable.angle
    switch (drawable.kind) {
      case 'shape':
        mesh.geometry = GEOMETRY[drawable.shape]
        mesh.position.set(drawable.x, drawable.y, 0)
        mesh.scale.set(drawable.w, drawable.h, 1)
        mesh.visible = drawable.visible
        this.#texture(material, drawable.image === '' ? null : this.#image(drawable.image), 0)
        return
      case 'text': {
        const label = this.#label(drawable.name, drawable.text)
        mesh.visible = drawable.visible && label !== undefined
        if (label === undefined) return
        const height = drawable.size
        const width = (label.columns * height) / FONT_ROWS
        // From x to the middle of the letters, which align sets.
        const shift = drawable.align === 'left' ? width / 2 : drawable.align === 'right' ? -width / 2 : 0
        mesh.geometry = GEOMETRY.square
        mesh.scale.set(width, height, 1)
        if (drawable.angle === 0) {
          // Snapping the corner to a whole screen pixel keeps the font's pixels sharp.
          const pixel = 4 / this.#renderer.domElement.width
          const snap = (value: number) => Math.round(value / pixel) * pixel
          mesh.position.set(snap(drawable.x + shift - width / 2) + width / 2, snap(drawable.y - height / 2) + height / 2, 0)
        } else {
          // Turned text can't line up with screen pixels, so it turns about its x and y unsnapped.
          mesh.position.set(drawable.x + Math.cos(drawable.angle) * shift, drawable.y + Math.sin(drawable.angle) * shift, 0)
        }
        this.#texture(material, label.texture, 0.5)
        return
      }
      default: {
        const _exhaustive: never = drawable
        void _exhaustive
      }
    }
  }

  #image(name: string): THREE.Texture {
    const texture = this.#images.get(name)
    if (texture === undefined) throw new Error(`the page has no image ${name}; save a file of that name next to game.ts`)
    return texture
  }

  #texture(material: THREE.MeshBasicMaterial, texture: THREE.Texture | null, alphaTest: number): void {
    if (material.map === texture && material.alphaTest === alphaTest) return
    material.map = texture
    material.alphaTest = alphaTest
    material.needsUpdate = true
  }

  #label(name: string, text: string): Label | undefined {
    if (text === '') return undefined
    const cached = this.#labels.get(name)
    if (cached?.text === text) return cached
    const columns = text.length * FONT_ADVANCE - 1
    const canvas = document.createElement('canvas')
    canvas.width = columns
    canvas.height = FONT_ROWS
    const context = canvas.getContext('2d')
    if (!context) throw new Error('this browser has no 2D canvas for text')
    context.fillStyle = '#ffffff'
    for (const [index, char] of [...text].entries()) {
      for (const [row, pixels] of (glyph(char) ?? []).entries()) {
        for (const [column, pixel] of [...pixels].entries()) if (pixel === '#') context.fillRect(index * FONT_ADVANCE + column, row, 1, 1)
      }
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    texture.colorSpace = THREE.SRGBColorSpace
    cached?.texture.dispose()
    const label = { text, texture, columns }
    this.#labels.set(name, label)
    return label
  }
}

export function parseView(value: unknown): ViewModule {
  if (typeof value !== 'object' || value === null) return {}
  const init = 'init' in value ? value.init : undefined
  const draw = 'draw' in value ? value.draw : undefined
  if (init !== undefined && typeof init !== 'function') throw new Error('view.ts: init must be a function')
  if (draw !== undefined && typeof draw !== 'function') throw new Error('view.ts: draw must be a function')
  return {
    init: init === undefined ? undefined : (setup) => void Reflect.apply(init, undefined, [setup]),
    draw: draw === undefined ? undefined : (frame) => void Reflect.apply(draw, undefined, [frame]),
  }
}

function custom(what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    throw new Error(`view.ts: ${error instanceof Error ? error.message : String(error)} (in ${what})`, { cause: error })
  }
}
