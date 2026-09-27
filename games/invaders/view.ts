// Decoration only: sprites over the boxes game.ts moves, the arcade's green band, and a 5x7 pixel font.
import type { ViewFrame, ViewSetup } from 'fourjs'
import type { BufferGeometry, Mesh, MeshBasicMaterial, Scene } from 'three'
import { textArt } from './font.ts'
import type { Invader, Invaders } from './game.ts'
import { BOOM, CANNON, INVADERS, UFO, boxes, type Box } from './sprites.ts'

type Three = ViewSetup['THREE']
type Text = { x: number; y: number; visible: boolean; text: string; size: number; align: string; color: string; opacity: number }

const WHITE = '#ffffff'
const GREEN = '#33ff33'
// Like the arcade's screen overlay, sprites below this y show green.
const GREEN_BELOW = -0.6

// Geometries in a unit square, which each mesh's scale stretches to its entity's w and h.
let sprites: { cannon: BufferGeometry; ufo: BufferGeometry; boom: BufferGeometry; invaders: BufferGeometry[][]; bombs: BufferGeometry[] }
// Pixel-font meshes that replace the default text meshes, rebuilt only when their text changes.
const labels = new Map<string, { mesh: Mesh; text: string }>()

function geometry(THREE: Three, parts: Box[]): BufferGeometry {
  const points = parts.flatMap(({ x, y, w, h }) => {
    const [l, r, b, t] = [x - w / 2, x + w / 2, y - h / 2, y + h / 2]
    return [l, b, 0, r, b, 0, r, t, 0, l, b, 0, r, t, 0, l, t, 0]
  })
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
}

// A stem, and a crossbar that slides down it by a third of the bomb's height every 4 ticks.
function bombParts(slot: number): Box[] {
  return [
    { x: 0, y: 0, w: 1 / 3, h: 1 },
    { x: 0, y: 3 / 7 - slot / 3, w: 1, h: 1 / 7 },
  ]
}

function tint(mesh: Mesh, y: number): void {
  ;(mesh.material as MeshBasicMaterial).color.set(y < GREEN_BELOW ? GREEN : WHITE)
}

// The renderer always antialiases, so odd-width sprites would blur; this rounds a mesh's corner to a whole pixel.
function snap(mesh: Mesh, width: number, height: number): void {
  const round = (edge: number, span: number, pixels: number) => {
    const at = ((edge + span / 2) / span) * pixels
    return ((Math.ceil(at - 0.5 - 1e-6) - at) / pixels) * span
  }
  mesh.position.x += round(mesh.position.x - mesh.scale.x / 2, 4, width)
  mesh.position.y += round(mesh.position.y - mesh.scale.y / 2, 3, height)
}

function label(THREE: Three, scene: Scene, name: string, base: Mesh, t: Text): void {
  base.visible = false
  let entry = labels.get(name)
  if (!entry) {
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false })
    entry = { mesh: new THREE.Mesh(new THREE.BufferGeometry(), material), text: '' }
    entry.mesh.renderOrder = base.renderOrder
    scene.add(entry.mesh)
    labels.set(name, entry)
  }
  const { mesh } = entry
  mesh.visible = t.visible && t.text !== ''
  if (!mesh.visible) return
  if (entry.text !== t.text) {
    mesh.geometry.dispose()
    mesh.geometry = geometry(THREE, boxes(textArt(t.text)))
    entry.text = t.text
  }
  const width = ((6 * t.text.length - 1) * t.size) / 7
  const shift = t.align === 'left' ? width / 2 : t.align === 'right' ? -width / 2 : 0
  mesh.position.set(t.x + shift, t.y, 0)
  mesh.scale.set(width, t.size, 1)
  const material = mesh.material as MeshBasicMaterial
  material.color.set(t.color)
  material.opacity = t.opacity
}

export function init({ THREE }: ViewSetup): void {
  const sprite = (art: readonly string[]) => geometry(THREE, boxes(art))
  sprites = {
    cannon: sprite(CANNON),
    ufo: sprite(UFO),
    boom: sprite(BOOM),
    invaders: INVADERS.map((poses) => poses.map(sprite)),
    bombs: [0, 1, 2].map((slot) => geometry(THREE, bombParts(slot))),
  }
}

export function draw({ THREE, scene, renderer, entities, objects }: ViewFrame): void {
  const world = entities as unknown as Invaders
  const pose = world.fleet.steps % 2
  for (const [name, mesh] of objects) {
    const fields = entities[name]
    if (typeof fields.text === 'string') {
      label(THREE, scene, name, mesh, fields as unknown as Text)
    } else if (name.startsWith('inv_')) {
      const inv = fields as unknown as Invader
      mesh.geometry = sprites.invaders[inv.row - 1][pose]
      tint(mesh, inv.y)
    }
  }
  const find = (name: string) => objects.get(name) as Mesh
  for (const name of ['cannon', 'life1', 'life2']) find(name).geometry = sprites.cannon
  find('ufo').geometry = sprites.ufo
  find('boom').geometry = sprites.boom
  tint(find('boom'), world.boom.y)
  for (const name of ['bomb1', 'bomb2', 'bomb3'] as const) find(name).geometry = sprites.bombs[Math.floor(world[name].age / 4) % 3]

  const { width, height } = renderer.domElement
  for (const mesh of objects.values()) snap(mesh, width, height)
  for (const { mesh } of labels.values()) snap(mesh, width, height)
}
