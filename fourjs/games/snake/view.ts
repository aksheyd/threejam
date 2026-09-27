// Decoration only: the grid lines and walls never move, so sim never sees them.
import type { ViewSetup } from 'fourjs'

export function init({ THREE, scene }: ViewSetup): void {
  const square = new THREE.PlaneGeometry(1, 1)
  const bar = (color: string, order: number, x: number, y: number, w: number, h: number) => {
    const mesh = new THREE.Mesh(square, new THREE.MeshBasicMaterial({ color, depthTest: false }))
    mesh.position.set(x, y, 0)
    mesh.scale.set(w, h, 1)
    mesh.renderOrder = order
    scene.add(mesh)
  }
  for (let i = 1; i < 20; i++) bar('#142414', -2, -2 + i * 0.2, 0, 0.01, 3)
  for (let i = 1; i < 15; i++) bar('#142414', -2, 0, -1.5 + i * 0.2, 4, 0.01)
  bar('#386638', -1, -1.99, 0, 0.02, 3)
  bar('#386638', -1, 1.99, 0, 0.02, 3)
  bar('#386638', -1, 0, -1.49, 4, 0.02)
  bar('#386638', -1, 0, 1.49, 4, 0.02)
}
