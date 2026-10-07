// Decoration only: the arcade's green band over the sprites game.ts draws, with every mesh on whole pixels.
import type { ViewFrame } from 'threejam'
import type { Mesh } from 'three'
import type game from './game.ts'

const WHITE = '#ffffff'
const GREEN = '#33ff33'
// Like the arcade's screen overlay, sprites below this y show green.
const GREEN_BELOW = -0.6

// The renderer always antialiases, so odd-width sprites would blur; this rounds a mesh's corner to a whole pixel.
function snap(mesh: Mesh, width: number, height: number): void {
  const round = (edge: number, span: number, pixels: number) => {
    const at = ((edge + span / 2) / span) * pixels
    return ((Math.ceil(at - 0.5 - 1e-6) - at) / pixels) * span
  }
  mesh.position.x += round(mesh.position.x - mesh.scale.x / 2, 4, width)
  mesh.position.y += round(mesh.position.y - mesh.scale.y / 2, 3, height)
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

  for (const invaders of world.invaders) for (const inv of invaders) tint(mesh(inv.name), inv.y)
  tint(mesh(world.boom.name), world.boom.y)

  const { width, height } = renderer.domElement
  for (const target of objects.values()) snap(target, width, height)
}
