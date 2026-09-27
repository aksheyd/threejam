import * as THREE from 'three'
import type { Drawable, Game, Value } from '../types.ts'

export interface ViewSetup {
  THREE: typeof THREE
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
  renderer: THREE.WebGLRenderer
  objects: ReadonlyMap<string, THREE.Mesh>
}

export interface ViewFrame extends ViewSetup {
  entities: Readonly<Record<string, Record<string, Value>>>
  tick: number
}

export interface ViewModule {
  init?(setup: ViewSetup): void
  draw?(frame: ViewFrame): void
}

const FONT_PX = 96
const FONT = `600 ${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

const GEOMETRY = {
  square: new THREE.PlaneGeometry(1, 1),
  circle: new THREE.CircleGeometry(0.5, 48),
  triangle: new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], 3),
  ),
}

interface Label {
  text: string
  texture: THREE.CanvasTexture
  aspect: number
}

export class View {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, -10, 10)
  readonly objects = new Map<string, THREE.Mesh>()
  readonly #labels = new Map<string, Label>()
  readonly #custom: ViewModule

  constructor(canvas: HTMLCanvasElement, game: Game, custom: ViewModule) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    this.scene.background = new THREE.Color(game.background ?? '#08080d')
    this.#custom = custom
    custom.init?.(this.#setup())
  }

  resize(width: number, height: number, ratio = devicePixelRatio): void {
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(width, height)
  }

  draw(drawables: Drawable[], entities: Record<string, Record<string, Value>>, tick: number): void {
    drawables.forEach((drawable, order) => {
      const mesh = this.objects.get(drawable.name) ?? this.#create(drawable.name, order)
      if (drawable.kind === 'text') this.#text(mesh, drawable)
      else this.#shape(mesh, drawable)
    })
    this.#custom.draw?.({ ...this.#setup(), entities, tick })
    this.renderer.render(this.scene, this.camera)
  }

  #setup(): ViewSetup {
    return { THREE, scene: this.scene, camera: this.camera, renderer: this.renderer, objects: this.objects }
  }

  #create(name: string, order: number): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false })
    const mesh = new THREE.Mesh(GEOMETRY.square, material)
    mesh.name = name
    mesh.renderOrder = order
    this.scene.add(mesh)
    this.objects.set(name, mesh)
    return mesh
  }

  #shape(mesh: THREE.Mesh, { fields: f }: Drawable): void {
    mesh.geometry = GEOMETRY[f.shape]
    mesh.position.set(f.x, f.y, 0)
    mesh.scale.set(f.w, f.h, 1)
    mesh.visible = f.visible
    const material = mesh.material as THREE.MeshBasicMaterial
    material.color.set(f.color)
    material.opacity = f.opacity
  }

  #text(mesh: THREE.Mesh, { name, fields: f }: Drawable): void {
    const label = this.#label(name, f.text)
    const height = f.size * 1.25
    const width = height * label.aspect
    const shift = f.align === 'left' ? width / 2 : f.align === 'right' ? -width / 2 : 0
    mesh.position.set(f.x + shift, f.y, 0)
    mesh.scale.set(width, height, 1)
    mesh.visible = f.visible && f.text !== ''
    const material = mesh.material as THREE.MeshBasicMaterial
    if (material.map !== label.texture) {
      material.map = label.texture
      material.needsUpdate = true
    }
    material.color.set(f.color)
    material.opacity = f.opacity
  }

  #label(name: string, text: string): Label {
    const cached = this.#labels.get(name)
    if (cached?.text === text) return cached
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('this browser has no 2D canvas for text')
    context.font = FONT
    canvas.width = Math.max(1, Math.ceil(context.measureText(text).width + FONT_PX * 0.2))
    canvas.height = Math.ceil(FONT_PX * 1.25)
    context.font = FONT
    context.fillStyle = '#ffffff'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, canvas.width / 2, canvas.height / 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    cached?.texture.dispose()
    const label = { text, texture, aspect: canvas.width / canvas.height }
    this.#labels.set(name, label)
    return label
  }
}
