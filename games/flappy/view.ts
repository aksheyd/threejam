// Decoration only: the skyline, the pipes' fill, the ground's stripes, and the bird's details never affect play, so sim never sees them.
import type { ViewFrame, ViewSetup } from 'threejam'
import type { BufferGeometry, Mesh } from 'three'
import type game from './game.ts'

type Flappy = ViewFrame<typeof game>['world']
type Point = Pick<Flappy['bird'], 'x' | 'y'>
type Rect = [x: number, y: number, w: number, h: number]
type Part = { dx: number; dy: number; w: number; h: number; color: string }
type PipePart = keyof Flappy['pipes'][number]['parts']

const OUTLINE = '#543847'
const PIPE = '#73bf2e'
const PIPE_HI = '#9ce659'
const PIPE_LO = '#558e22'
const WHITE = '#ffffff'
const CLOUD = '#e9fcd9'
const BUILDING_COLORS = ['#c7eadb', '#b7e2d0']
const WINDOW = '#a7d8c6'
const BUSH_EDGE = '#4dc65d'
const BUSH = '#5ee270'

const CLOUDS: Rect[] = [
  [0, -0.8, 4.2, 0.3],
  [-2.1, -0.6355, 0.4986, 0.1291],
  [-2.1513, -0.5975, 0.2742, 0.2051],
  [-1.6196, -0.6383, 0.5049, 0.1235],
  [-1.6751, -0.6031, 0.2777, 0.1938],
  [-1.1546, -0.6373, 0.4605, 0.1254],
  [-1.1153, -0.6038, 0.2533, 0.1924],
  [-0.736, -0.6212, 0.4835, 0.1576],
  [-0.7267, -0.5772, 0.2659, 0.2456],
  [-0.2765, -0.6386, 0.5964, 0.1228],
  [-0.3017, -0.5964, 0.328, 0.2071],
  [0.1451, -0.6307, 0.4677, 0.1385],
  [0.1068, -0.5894, 0.2572, 0.2212],
  [0.6324, -0.6288, 0.5458, 0.1423],
  [0.5799, -0.5929, 0.3002, 0.2143],
  [1.0413, -0.6196, 0.4809, 0.1608],
  [1.019, -0.586, 0.2645, 0.2279],
  [1.5292, -0.631, 0.518, 0.138],
  [1.553, -0.5901, 0.2849, 0.2198],
  [1.9658, -0.6242, 0.5362, 0.1515],
  [1.9933, -0.5817, 0.2949, 0.2365],
]

const BUILDINGS: Rect[] = [
  [-1.9414, -0.847, 0.3172, 0.306],
  [-1.6635, -0.7767, 0.2385, 0.4466],
  [-1.4436, -0.8062, 0.2013, 0.3876],
  [-1.2502, -0.7865, 0.1855, 0.427],
  [-1.014, -0.797, 0.287, 0.4061],
  [-0.7191, -0.8255, 0.3026, 0.349],
  [-0.4292, -0.7946, 0.2773, 0.4108],
  [-0.1599, -0.8098, 0.2612, 0.3804],
  [0.1195, -0.7561, 0.2976, 0.4878],
  [0.3914, -0.7869, 0.2464, 0.4261],
  [0.6089, -0.7828, 0.1885, 0.4343],
  [0.8384, -0.7508, 0.2706, 0.4985],
  [1.1213, -0.8287, 0.2951, 0.3426],
  [1.3858, -0.7864, 0.234, 0.4271],
  [1.5944, -0.8092, 0.1832, 0.3816],
  [1.7877, -0.8471, 0.2035, 0.3058],
  [1.9836, -0.7755, 0.1883, 0.449],
  [2.1768, -0.8328, 0.1981, 0.3345],
]

const BUSHES: Rect[] = [
  [-2.1, -0.8982, 0.3586, 0.1236],
  [-1.849, -0.9088, 0.3121, 0.1025],
  [-1.6305, -0.8979, 0.3824, 0.1242],
  [-1.3628, -0.8984, 0.4229, 0.1232],
  [-1.0668, -0.9096, 0.3418, 0.1008],
  [-0.8275, -0.8979, 0.3538, 0.1242],
  [-0.5799, -0.9162, 0.4437, 0.0875],
  [-0.2693, -0.9142, 0.3264, 0.0916],
  [-0.0408, -0.9079, 0.335, 0.1042],
  [0.1937, -0.9134, 0.3884, 0.0931],
  [0.4656, -0.9095, 0.3006, 0.1009],
  [0.676, -0.9058, 0.3554, 0.1083],
  [0.9248, -0.9027, 0.443, 0.1145],
  [1.2348, -0.9046, 0.3773, 0.1109],
  [1.499, -0.9187, 0.4014, 0.0827],
  [1.78, -0.9005, 0.4349, 0.119],
  [2.0844, -0.9001, 0.4312, 0.1199],
]

// The fill and shading over each part of a pipe pair.
const PIPE_BODY: Part[] = [
  { dx: 0, dy: 0, w: 0.32, h: 3.2, color: PIPE },
  { dx: -0.105, dy: 0, w: 0.05, h: 3.2, color: PIPE_HI },
  { dx: 0.13, dy: 0, w: 0.06, h: 3.2, color: PIPE_LO },
]
const PIPE_CAP: Part[] = [
  { dx: 0, dy: 0, w: 0.36, h: 0.12, color: PIPE },
  { dx: -0.12, dy: 0, w: 0.05, h: 0.12, color: PIPE_HI },
  { dx: 0.15, dy: 0, w: 0.06, h: 0.12, color: PIPE_LO },
]
const PIPE_FILL: ReadonlyArray<readonly [PipePart, Part[]]> = [
  ['top', PIPE_BODY],
  ['top_cap', PIPE_CAP],
  ['bottom', PIPE_BODY],
  ['bottom_cap', PIPE_CAP],
]

const GROUND_LINE: Rect = [0, -1.0575, 4.2, 0.015]
const GRASS: Rect = [0, -1.095, 4.2, 0.06]
const GRASS_EDGE: Rect = [0, -1.13, 4.2, 0.01]
const DIRT_EDGE: Rect = [0, -1.1425, 4.2, 0.015]
// The stripes on the grass repeat every STRIPE_GAP, and each wraps to the right end once it scrolls past STRIPE_LEFT.
const STRIPE: Rect = [0, -1.095, 0.1, 0.06]
const STRIPE_COUNT = 27
const STRIPE_GAP = 0.16
const STRIPE_LEFT = -2.16
const STRIPE_PERIOD = STRIPE_COUNT * STRIPE_GAP

const BODY: Part[] = [
  { dx: 0, dy: 0, w: 0.216, h: 0.156, color: '#fad129' },
  { dx: 0.006, dy: -0.048, w: 0.156, h: 0.048, color: '#fdee9e' },
]
const WING: Part[] = [
  { dx: -0.066, dy: -0.006, w: 0.108, h: 0.078, color: OUTLINE },
  { dx: -0.066, dy: -0.006, w: 0.084, h: 0.054, color: '#fdf7e0' },
]
// The wing moves to the next of these every 5 ticks, and holds still once the run is over.
const WING_FRAMES = [0.018, 0, -0.018, 0]
const FACE: Part[] = [
  { dx: 0.054, dy: 0.036, w: 0.078, h: 0.078, color: WHITE },
  { dx: 0.0744, dy: 0.0324, w: 0.0264, h: 0.042, color: '#1f1414' },
]
const BEAK: Part[] = [
  { dx: 0.0024, dy: 0.0156, w: 0.108, h: 0.0288, color: '#fa5921' },
  { dx: -0.0024, dy: -0.0156, w: 0.096, h: 0.0264, color: '#e64d1f' },
]

// Meshes that init makes and draw moves each frame; at reads draw's world, since engine.reset() replaces the one init saw.
const followers: { mesh: Mesh; part: Part; at: (world: Flappy) => Point }[] = []
const stripes: Mesh[] = []

function windows([x, y, w, h]: Rect): Rect[] {
  const top = y + h / 2 - 0.05
  return [
    [x, top, 0.6 * w, 0.025],
    [x, top - 0.07, 0.6 * w, 0.025],
  ]
}

function wing({ bird }: Flappy): Point {
  return { x: bird.x, y: bird.y + (bird.state === 'over' ? 0 : WING_FRAMES[Math.floor(bird.age / 5) % 4]) }
}

// Where a part is on screen: its x and y are from its entity's.
function placed(at: Point, part: Point): Point {
  return { x: at.x + part.x, y: at.y + part.y }
}

export function init({ THREE, scene, world, objects }: ViewSetup<typeof game>): void {
  const square = new THREE.PlaneGeometry(1, 1)
  const triangle = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], 3))
  const add = (color: string, order: number, [x, y, w, h]: Rect, geometry: BufferGeometry = square): Mesh => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }))
    mesh.position.set(x, y, 0)
    mesh.scale.set(w, h, 1)
    mesh.renderOrder = order
    scene.add(mesh)
    return mesh
  }
  // Each call returns an order above the named entity and the orders returned before, and still under the next entity.
  const above = (name: string) => {
    const base = objects.get(name)?.renderOrder
    if (base === undefined) throw new Error(`${name} has no mesh to draw over`)
    let count = 0
    return () => {
      count += 1
      return base + count / 100
    }
  }
  const follow = (parts: Part[], at: (world: Flappy) => Point, order: () => number) => {
    for (const part of parts) followers.push({ mesh: add(part.color, order(), [0, 0, part.w, part.h]), part, at })
  }

  // Counting up from a negative order keeps the skyline under every entity, in the order it's added.
  let order = -1000
  for (const cloud of CLOUDS) add(CLOUD, order++, cloud)
  BUILDINGS.forEach((building, i) => {
    add(BUILDING_COLORS[i % 2], order++, building)
    for (const pane of windows(building)) add(WINDOW, order++, pane)
  })
  for (const [x, y, w, h] of BUSHES) add(BUSH_EDGE, order++, [x, y + 0.0075, w + 0.03, h + 0.015])
  for (const bush of BUSHES) add(BUSH, order++, bush)
  add(BUSH, order++, [0, -0.99, 4.2, 0.12])

  for (const [i, pipe] of world.pipes.entries()) {
    for (const [part, fill] of PIPE_FILL) follow(fill, (w) => placed(w.pipes[i], w.pipes[i].parts[part]), above(pipe.parts[part].name))
  }
  const overGround = above('ground')
  add(OUTLINE, overGround(), GROUND_LINE)
  add(PIPE_HI, overGround(), GRASS)
  for (let i = 0; i < STRIPE_COUNT; i++) stripes.push(add(PIPE, overGround(), STRIPE, triangle))
  add('#558022', overGround(), GRASS_EDGE)
  add('#d7a84c', overGround(), DIRT_EDGE)
  const overBird = above('bird')
  follow(BODY, (w) => w.bird, overBird)
  follow(WING, wing, overBird)
  follow(FACE, (w) => w.bird, overBird)
  follow(BEAK, (w) => placed(w.bird, w.bird.parts.beak), above(world.bird.parts.beak.name))
}

export function draw({ world }: ViewFrame<typeof game>): void {
  for (const { mesh, part, at } of followers) {
    const { x, y } = at(world)
    mesh.position.set(x + part.dx, y + part.dy, 0)
  }
  for (const [i, stripe] of stripes.entries()) {
    stripe.position.x = STRIPE_LEFT + ((((STRIPE_GAP * i - world.ground.scroll) % STRIPE_PERIOD) + STRIPE_PERIOD) % STRIPE_PERIOD)
  }
}
