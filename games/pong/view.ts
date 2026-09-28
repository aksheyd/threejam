// Decoration only: the dashed net isn't part of the game, so sim never sees it.
import type { ViewSetup } from '@aksheyd/fourjs'

export function init({ THREE, scene }: ViewSetup): void {
  const dash = new THREE.PlaneGeometry(0.03, 0.12)
  const grey = new THREE.MeshBasicMaterial({ color: '#808080', depthTest: false })
  for (let i = 0; i < 12; i++) {
    const mesh = new THREE.Mesh(dash, grey)
    mesh.position.set(0, 1.375 - i * 0.25, 0)
    mesh.renderOrder = -1
    scene.add(mesh)
  }
}
