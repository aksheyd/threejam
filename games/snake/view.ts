// Decoration only: the grid lines and walls never move, so sim never sees them.
import type { ViewSetup } from 'threejam'
import type game from './game.ts'

type Box = { x: number; y: number; w: number; h: number }

export function init({ THREE, scene, world }: ViewSetup<typeof game>): void {
  const { cols, rows, cell } = world.game
  const [width, height] = [cols * cell, rows * cell]
  const square = new THREE.PlaneGeometry(1, 1)
  const layer = (color: string, renderOrder: number) => {
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false })
    return ({ x, y, w, h }: Box) => {
      const mesh = new THREE.Mesh(square, material)
      mesh.position.set(x, y, 0)
      mesh.scale.set(w, h, 1)
      mesh.renderOrder = renderOrder
      scene.add(mesh)
    }
  }
  const line = layer('#142414', -2)
  const wall = layer('#386638', -1)
  for (let i = 1; i < cols; i++) line({ x: i * cell - width / 2, y: 0, w: 0.01, h: height })
  for (let i = 1; i < rows; i++) line({ x: 0, y: i * cell - height / 2, w: width, h: 0.01 })
  // The walls sit just inside the board, so they stay on screen when the board fills it.
  for (const side of [-1, 1]) {
    wall({ x: side * (width / 2 - 0.01), y: 0, w: 0.02, h: height })
    wall({ x: 0, y: side * (height / 2 - 0.01), w: width, h: 0.02 })
  }
}
