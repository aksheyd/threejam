// Decoration only: sprites over the boxes game.ts moves, and the arcade's green band.
import type { ViewFrame, ViewSetup } from 'fourjs'
import type { BufferGeometry, Mesh } from 'three'
import type game from './game.ts'
import { BOOM, CANNON, INVADERS, UFO, boxes, type Box } from './sprites.ts'

type Three = ViewSetup['THREE']

const WHITE = '#ffffff'
const GREEN = '#33ff33'
// Like the arcade's screen overlay, sprites below this y show green.
const GREEN_BELOW = -0.6

// Geometries in a unit square, which each mesh's scale stretches to its entity's w and h.
let sprites: { cannon: BufferGeometry; ufo: BufferGeometry; boom: BufferGeometry; invaders: BufferGeometry[][]; bombs: BufferGeometry[] }

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

// The renderer always antialiases, so odd-width sprites would blur; this rounds a mesh's corner to a whole pixel.
function snap(mesh: Mesh, width: number, height: number): void {
  const round = (edge: number, span: number, pixels: number) => {
    const at = ((edge + span / 2) / span) * pixels
    return ((Math.ceil(at - 0.5 - 1e-6) - at) / pixels) * span
  }
  mesh.position.x += round(mesh.position.x - mesh.scale.x / 2, 4, width)
  mesh.position.y += round(mesh.position.y - mesh.scale.y / 2, 3, height)
}

export function init({ THREE }: ViewSetup<typeof game>): void {
  const sprite = (art: readonly string[]) => geometry(THREE, boxes(art))
  sprites = {
    cannon: sprite(CANNON),
    ufo: sprite(UFO),
    boom: sprite(BOOM),
    invaders: INVADERS.map((poses) => poses.map(sprite)),
    bombs: [0, 1, 2].map((slot) => geometry(THREE, bombParts(slot))),
  }
}

export function draw({ THREE, world, objects, renderer }: ViewFrame<typeof game>): void {
  const mesh = (name: string): Mesh => {
    const found = objects.get(name)
    if (!found) throw new Error(`no mesh for ${name}`)
    return found
  }
  const tint = (target: Mesh, y: number) => {
    if (target.material instanceof THREE.MeshBasicMaterial) target.material.color.set(y < GREEN_BELOW ? GREEN : WHITE)
  }

  const pose = world.fleet.steps % 2
  for (const [row, invaders] of world.invaders.entries()) {
    for (const inv of invaders) {
      const target = mesh(inv.name)
      target.geometry = sprites.invaders[row][pose]
      tint(target, inv.y)
    }
  }
  for (const { name } of [world.cannon, world.life1, world.life2]) mesh(name).geometry = sprites.cannon
  mesh(world.ufo.name).geometry = sprites.ufo
  const boom = mesh(world.boom.name)
  boom.geometry = sprites.boom
  tint(boom, world.boom.y)
  for (const bomb of [world.bomb1, world.bomb2, world.bomb3]) mesh(bomb.name).geometry = sprites.bombs[Math.floor(bomb.age / 4) % 3]

  const { width, height } = renderer.domElement
  for (const target of objects.values()) snap(target, width, height)
}
