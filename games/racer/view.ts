// The race in 3D. A camera behind the car looks up a lit road where every car, coin, and line stands where game.ts puts it, with the game's x across the road and its y along it. The picture is drawn into a texture that covers the flat shapes, under the heads-up display, and nothing here changes play, so sim never sees it.
import type { ViewFrame, ViewSetup } from 'threejam'
import type { BufferGeometry, DirectionalLight, Group, Material, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, Texture, Vector2, WebGLRenderTarget } from 'three'
import type game from './game.ts'
import { KINDS, LANES, LENGTHS, RACER, ROAD_EDGE, TRAFFIC_WIDTH } from './road.ts'

type Three = ViewSetup['THREE']
type Racer = ViewFrame<typeof game>['world']
type Kind = (typeof KINDS)[number]
type Triple = readonly [number, number, number]

const SKY = '#4a98e0'
const HORIZON = '#d2e7f3'
const GLASS = '#1b2430'
const TYRE = '#1e1e22'
const LAMP = '#fff2c2'
const TAIL = '#ff2b2b'
const TRAILER = '#e4e4e8'
// The road's texture has this many pixels a world unit, and repeats every DASHES units down the road.
const PX = 128
const DASHES = 1.25
const GRASS_STRIPES = 2.5
// Each side of the road has TREES trees, TREE_GAP apart, from just behind the camera into the fog.
const TREES = 24
const TREE_GAP = 1.5
const TREES_BEHIND = 2.5

interface Model {
  readonly root: Group
  readonly kinds: Record<Kind, Group>
  readonly paint: MeshStandardMaterial
}

interface Stage {
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly sun: DirectionalLight
  readonly target: WebGLRenderTarget
  readonly size: Vector2
  readonly backdrop: Group
  readonly road: Texture
  readonly grass: Texture
  readonly car: { readonly root: Group; readonly paint: MeshStandardMaterial }
  readonly traffic: readonly Model[]
  readonly coins: readonly Mesh[]
  readonly start: Group
  readonly finish: Group
  readonly trees: readonly { readonly tree: Group; readonly along: number }[]
}

let stage: Stage | undefined

// Where a point of the game's flat world is in 3D: its x across the road, its y away from the camera, and up from the road.
function place(object: Object3D, x: number, y: number, up = 0): void {
  object.position.set(x, up, -y)
}

function canvas(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const context = element.getContext('2d')
  if (!context) throw new Error('this browser has no 2D canvas to paint textures on')
  paint(context)
  return element
}

function texture(THREE: Three, image: HTMLCanvasElement, anisotropy: number, repeat: [number, number] = [1, 1], sharp = false): Texture {
  const made = new THREE.CanvasTexture(image)
  if (sharp) made.magFilter = THREE.NearestFilter
  made.colorSpace = THREE.SRGBColorSpace
  made.anisotropy = anisotropy
  made.wrapS = THREE.RepeatWrapping
  made.wrapT = THREE.RepeatWrapping
  made.repeat.set(...repeat)
  return made
}

// Asphalt with red and white kerbs, white edge lines, and dashed lines between the lanes, one stretch of dashes from top to bottom.
function roadImage(): HTMLCanvasElement {
  const half = ROAD_EDGE + 0.1
  return canvas(2 * half * PX, DASHES * PX, (context) => {
    const across = (x: number) => Math.round((x + half) * PX)
    const fill = (color: string, from: number, to: number, top = 0, bottom = DASHES) => {
      context.fillStyle = color
      context.fillRect(across(from), Math.round(top * PX), across(to) - across(from), Math.round((bottom - top) * PX))
    }
    fill('#47484f', -half, half)
    for (const [from, to] of [[-half, -ROAD_EDGE], [ROAD_EDGE, half]]) {
      fill('#d63b34', from, to, 0, DASHES / 2)
      fill('#f0f0f0', from, to, DASHES / 2, DASHES)
    }
    for (const edge of [-ROAD_EDGE + 0.035, ROAD_EDGE - 0.035]) fill('#f0f0f0', edge - 0.015, edge + 0.015)
    for (const [left, right] of [LANES.slice(0, 2), LANES.slice(1)]) {
      const middle = (left + right) / 2
      fill('#f0f0f0', middle - 0.018, middle + 0.018, 0, 0.5)
    }
  })
}

function checkers(columns: number): HTMLCanvasElement {
  return canvas(columns, 2, (context) => {
    for (let x = 0; x < columns; x++) {
      for (let y = 0; y < 2; y++) {
        context.fillStyle = (x + y) % 2 === 0 ? '#111114' : '#f4f4f4'
        context.fillRect(x, y, 1, 1)
      }
    }
  })
}

function mesh(THREE: Three, geometry: BufferGeometry, material: Material, at: Triple, size?: Triple): Mesh {
  const made = new THREE.Mesh(geometry, material)
  made.position.set(...at)
  if (size) made.scale.set(...size)
  made.castShadow = true
  made.receiveShadow = true
  return made
}

// A unit box whose top is narrower than its bottom, as a car's windows slope in.
function cabin(THREE: Three, topWidth: number, topLength: number): BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) <= 0) continue
    position.setX(i, position.getX(i) * topWidth)
    position.setZ(i, position.getZ(i) * topLength)
  }
  geometry.computeVertexNormals()
  return geometry
}

// What every car, van, and truck is made of.
interface Kit {
  readonly box: BufferGeometry
  readonly cabin: BufferGeometry
  readonly wheel: BufferGeometry
  readonly glass: Material
  readonly tyre: Material
  readonly lamp: Material
  readonly tail: Material
  readonly stripe: Material
  readonly trailer: Material
}

function kit(THREE: Three): Kit {
  return {
    box: new THREE.BoxGeometry(1, 1, 1),
    cabin: cabin(THREE, 0.8, 0.55),
    wheel: new THREE.CylinderGeometry(0.05, 0.05, 0.05, 14).rotateZ(Math.PI / 2),
    glass: new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.25, metalness: 0.2 }),
    tyre: new THREE.MeshStandardMaterial({ color: TYRE, roughness: 0.9 }),
    lamp: new THREE.MeshStandardMaterial({ color: LAMP, emissive: LAMP, emissiveIntensity: 0.6 }),
    tail: new THREE.MeshStandardMaterial({ color: TAIL, emissive: TAIL, emissiveIntensity: 0.8 }),
    stripe: new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.4 }),
    trailer: new THREE.MeshStandardMaterial({ color: TRAILER, roughness: 0.6 }),
  }
}

// The racer, cars, vans, and trucks face up the road, toward -z, and stand on it, filling the box the game gives them, in world units.
function vehicle(THREE: Three, parts: Kit, kind: Kind | 'racer', paint: Material): Group {
  const [width, length] = kind === 'racer' ? [RACER.w, RACER.h] : [TRAFFIC_WIDTH, LENGTHS[kind]]
  const side = width / 2
  const group = new THREE.Group()
  const add = (material: Material, size: Triple, at: Triple, geometry = parts.box) => group.add(mesh(THREE, geometry, material, at, size))
  const wheels = (...zs: number[]) => {
    for (const z of zs) for (const x of [0.025 - side, side - 0.025]) group.add(mesh(THREE, parts.wheel, parts.tyre, [x, 0.05, z]))
  }
  const lights = (height: number) => {
    for (const x of [0.045 - side, side - 0.045]) {
      add(parts.lamp, [0.055, 0.022, 0.012], [x, height, -length / 2 - 0.005])
      add(parts.tail, [0.06, 0.022, 0.012], [x, height, length / 2 + 0.005])
    }
  }
  switch (kind) {
    case 'racer':
    case 'car': {
      const racer = kind === 'racer'
      wheels(-length / 2 + 0.1, length / 2 - 0.1)
      add(paint, [width, 0.075, length], [0, 0.085, 0])
      add(parts.glass, [width - 0.05, racer ? 0.075 : 0.09, length * (racer ? 0.46 : 0.52)], [0, racer ? 0.16 : 0.167, 0.03], parts.cabin)
      add(paint, [width - 0.11, 0.012, length * (racer ? 0.22 : 0.26)], [0, racer ? 0.203 : 0.218, 0.03])
      lights(0.095)
      if (racer) {
        add(parts.stripe, [0.05, 0.004, length + 0.004], [0, 0.124, 0])
        add(paint, [width - 0.01, 0.014, 0.06], [0, 0.17, length / 2 - 0.04])
        for (const x of [0.05 - side, side - 0.05]) add(parts.tyre, [0.016, 0.04, 0.02], [x, 0.14, length / 2 - 0.04])
      }
      break
    }
    case 'van':
      wheels(-length / 2 + 0.11, length / 2 - 0.11)
      add(paint, [width, 0.1, length], [0, 0.1, 0])
      add(paint, [width - 0.01, 0.11, length * 0.8], [0, 0.2, length * 0.09])
      add(parts.glass, [width - 0.008, 0.05, length * 0.56], [0, 0.22, length * 0.05])
      add(parts.glass, [width - 0.04, 0.07, 0.01], [0, 0.205, -length * 0.31 - 0.001])
      lights(0.11)
      break
    case 'truck': {
      const trailer = length - 0.26
      wheels(-length / 2 + 0.09, length / 2 - 0.22, length / 2 - 0.1)
      add(paint, [width, 0.19, 0.24], [0, 0.145, -length / 2 + 0.12])
      add(parts.glass, [width - 0.04, 0.07, 0.01], [0, 0.19, -length / 2 - 0.001])
      add(parts.trailer, [width, 0.27, trailer], [0, 0.215, length / 2 - trailer / 2])
      add(paint, [width + 0.004, 0.035, trailer - 0.04], [0, 0.13, length / 2 - trailer / 2])
      lights(0.1)
      break
    }
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
  return group
}

// Flat ground that takes shadows but casts none.
function ground(THREE: Three, width: number, length: number, material: Material, height: number): Mesh {
  const made = new THREE.Mesh(new THREE.PlaneGeometry(width, length).rotateX(-Math.PI / 2), material)
  made.position.set(0, height, -length / 2 + 10)
  made.receiveShadow = true
  return made
}

// A start or finish gantry: a checkered banner on two posts, high enough to stay above the camera's view as the car passes under it, and a checkered strip across the road.
function arch(THREE: Three, anisotropy: number): Group {
  const group = new THREE.Group()
  const post = new THREE.MeshStandardMaterial({ color: '#d9d9de', roughness: 0.5 })
  const flag = new THREE.MeshStandardMaterial({ map: texture(THREE, checkers(28), anisotropy, [1, 1], true), roughness: 0.7 })
  for (const x of [-1.12, 1.12]) group.add(mesh(THREE, new THREE.BoxGeometry(0.06, 1.3, 0.06), post, [x, 0.65, 0]))
  group.add(mesh(THREE, new THREE.BoxGeometry(2.3, 0.18, 0.03), flag, [0, 1.3, 0]))
  const strip = new THREE.MeshStandardMaterial({ map: texture(THREE, checkers(24), anisotropy, [1, 1], true), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })
  const line = new THREE.Mesh(new THREE.PlaneGeometry(2 * ROAD_EDGE, 0.15).rotateX(-Math.PI / 2), strip)
  line.receiveShadow = true
  group.add(line)
  return group
}

// What every tree is made of.
interface Forest {
  readonly trunk: BufferGeometry
  readonly pine: BufferGeometry
  readonly round: BufferGeometry
  readonly bark: Material
  readonly needles: Material
  readonly leaves: Material
}

// A pine, or every third tree a round one, sized by its index so each looks its own.
function tree(THREE: Three, index: number, forest: Forest): Group {
  const group = new THREE.Group()
  group.add(mesh(THREE, forest.trunk, forest.bark, [0, 0.09, 0]))
  if (index % 3 === 0) group.add(mesh(THREE, forest.round, forest.leaves, [0, 0.32, 0]))
  else group.add(mesh(THREE, forest.pine, forest.needles, [0, 0.38, 0]))
  group.scale.setScalar(0.85 + 0.5 * ((index * 0.618) % 1))
  return group
}

// The sky, hills, and clouds, which keep their place around the camera, as far things do.
function backdrop(THREE: Three): Group {
  const group = new THREE.Group()
  const sky = new THREE.SphereGeometry(100, 32, 16)
  const [low, high] = [new THREE.Color(HORIZON), new THREE.Color(SKY)]
  const shades: number[] = []
  const points = sky.getAttribute('position')
  for (let i = 0; i < points.count; i++) {
    const shade = low.clone().lerp(high, Math.min(1, Math.max(0, points.getY(i) / 100) * 2.2))
    shades.push(shade.r, shade.g, shade.b)
  }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3))
  group.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })))
  const hills = new THREE.MeshLambertMaterial({ color: '#86abc6', flatShading: true, fog: false })
  for (let i = 0; i < 15; i++) {
    const turn = -Math.PI / 2 + (i - 7) * 0.16
    const height = 5 + 5 * ((i * 0.618) % 1)
    const hill = new THREE.Mesh(new THREE.ConeGeometry(10 + 4 * ((i * 0.382) % 1), height, 5), hills)
    hill.position.set(Math.cos(turn) * 80, height / 2 - 1.5, Math.sin(turn) * 80)
    hill.rotation.y = i
    group.add(hill)
  }
  const clouds = new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#a9b9c9', flatShading: true, fog: false })
  for (const [x, y, z, w] of [[-30, 16, -70, 9], [8, 22, -78, 12], [36, 13, -66, 8], [-62, 20, -40, 10], [64, 18, -44, 11]]) {
    const cloud = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), clouds)
    cloud.position.set(x, y, z)
    cloud.scale.set(w, w * 0.22, w * 0.45)
    group.add(cloud)
  }
  return group
}

export function init({ THREE, scene, world, objects, renderer }: ViewSetup<typeof game>): void {
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  renderer.shadowMap.enabled = true
  const view = new THREE.Scene()
  view.background = new THREE.Color(HORIZON)
  view.fog = new THREE.Fog(HORIZON, 8, 27)
  const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 200)

  view.add(new THREE.HemisphereLight('#dceeff', '#557a3c', 1.6))
  const sun = new THREE.DirectionalLight('#fff0d4', 2.8)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 6, bottom: -6, near: 0.5, far: 24 })
  sun.shadow.camera.updateProjectionMatrix()
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.01
  view.add(sun, sun.target)

  const far = backdrop(THREE)
  view.add(far)
  const grass = texture(THREE, canvas(1, 2, (context) => {
    context.fillStyle = '#5ba53d'
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = '#51983a'
    context.fillRect(0, 1, 1, 1)
  }), anisotropy, [1, 100 / GRASS_STRIPES], true)
  const road = texture(THREE, roadImage(), anisotropy, [1, 100 / DASHES])
  road.wrapS = THREE.ClampToEdgeWrapping
  view.add(ground(THREE, 200, 100, new THREE.MeshLambertMaterial({ map: grass }), -0.01), ground(THREE, 2 * ROAD_EDGE + 0.2, 100, new THREE.MeshStandardMaterial({ map: road, roughness: 0.85 }), 0))

  const forest = {
    trunk: new THREE.CylinderGeometry(0.025, 0.035, 0.18, 6),
    pine: new THREE.ConeGeometry(0.17, 0.46, 7),
    round: new THREE.IcosahedronGeometry(0.19, 0),
    bark: new THREE.MeshLambertMaterial({ color: '#6e4b2e' }),
    needles: new THREE.MeshLambertMaterial({ color: '#2e7a3a', flatShading: true }),
    leaves: new THREE.MeshLambertMaterial({ color: '#4a9440', flatShading: true }),
  }
  const trees = Array.from({ length: 2 * TREES }, (_, index) => {
    const planted = tree(THREE, index, forest)
    view.add(planted)
    return { tree: planted, along: (index % TREES) * TREE_GAP + ((index * 0.37) % 1) * 0.6 }
  })

  const parts = kit(THREE)
  const car = { paint: new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.15 }), root: new THREE.Group() }
  car.root.add(vehicle(THREE, parts, 'racer', car.paint))
  // The car turns about its up axis first, so its lean is its own.
  car.root.rotation.order = 'YXZ'
  view.add(car.root)
  const traffic = world.traffic.map(() => {
    const paint = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 })
    const root = new THREE.Group()
    const kinds = { car: vehicle(THREE, parts, 'car', paint), van: vehicle(THREE, parts, 'van', paint), truck: vehicle(THREE, parts, 'truck', paint) }
    root.add(kinds.car, kinds.van, kinds.truck)
    view.add(root)
    return { root, kinds, paint }
  })
  const coin = new THREE.CylinderGeometry(0.065, 0.065, 0.024, 20).rotateZ(Math.PI / 2)
  const gold = new THREE.MeshStandardMaterial({ color: '#ffd24a', emissive: '#c88a00', emissiveIntensity: 0.55, metalness: 0.1, roughness: 0.35 })
  const coins = world.coins.map(() => {
    const made = mesh(THREE, coin, gold, [0, 0, 0])
    view.add(made)
    return made
  })
  const start = arch(THREE, anisotropy)
  const finish = arch(THREE, anisotropy)
  view.add(start, finish)

  // Drawn with the heads-up display's text over it and the flat shapes under it, as a multisampled picture the screen's size.
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, colorSpace: THREE.SRGBColorSpace, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
  const hud = objects.get(world.hud.name)
  if (!hud) throw new Error('the heads-up display has no mesh to draw the road under')
  const picture = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), new THREE.MeshBasicMaterial({ map: target.texture, depthTest: false, depthWrite: false }))
  picture.renderOrder = hud.renderOrder - 0.5
  scene.add(picture)

  stage = { scene: view, camera, sun, target, size: new THREE.Vector2(), backdrop: far, road, grass, car, traffic, coins, start, finish, trees }
}

export function draw({ world, tick, renderer }: ViewFrame<typeof game>): void {
  if (!stage) throw new Error('draw ran before init')
  const { car, race } = world
  const { camera, sun, target } = stage

  // The road, the grass, and the trees move toward the camera as the race's distance grows.
  stage.road.offset.y = (race.distance / DASHES) % 1
  stage.grass.offset.y = (race.distance / GRASS_STRIPES) % 1
  const span = TREES * TREE_GAP
  for (const [index, { tree, along }] of stage.trees.entries()) {
    const side = index < TREES ? -1 : 1
    const ahead = ((((along - race.distance) % span) + span) % span) - TREES_BEHIND
    place(tree, side * (ROAD_EDGE + 0.45 + 0.7 * ((index * 0.29) % 1)), car.y + ahead)
  }

  // Each model is built at the sizes road.ts gives and stretched to the box the world has, so what's drawn is what collides.
  place(stage.car.root, car.x, car.y)
  stage.car.root.scale.set(car.w / RACER.w, 1, car.h / RACER.h)
  stage.car.paint.color.set(car.color)
  // Steering turns the car's nose a little toward the turn and leans its body out of it, over the spin a crash gives.
  stage.car.root.rotation.set(0, car.angle - car.steer * 0.1, car.steer * 0.04)
  for (const [index, other] of world.traffic.entries()) {
    const { root, kinds, paint } = stage.traffic[index]
    root.visible = other.visible
    if (!other.visible) continue
    place(root, other.x, other.y)
    root.scale.set(other.w / TRAFFIC_WIDTH, 1, other.h / LENGTHS[other.kind])
    root.rotation.y = other.angle
    for (const kind of KINDS) kinds[kind].visible = kind === other.kind
    paint.color.set(other.color)
  }
  for (const [index, coin] of world.coins.entries()) {
    const shown = stage.coins[index]
    shown.visible = coin.visible
    place(shown, coin.x, coin.y, 0.1 + 0.015 * Math.sin(tick / 9 + index))
    shown.rotation.y = tick / 12 + index
  }
  place(stage.start, 0, world.start_line.y)
  place(stage.finish, 0, world.finish_line.y)

  // The camera rides behind the car and a little to its side of the road, and widens its view as the car speeds up.
  camera.fov = 52 + 10 * (car.speed / car.top_speed)
  camera.updateProjectionMatrix()
  place(camera, car.x * 0.6, car.y - 1.3, 0.62)
  camera.lookAt(car.x * 0.8, 0.12, -(car.y + 2.4))
  stage.backdrop.position.set(camera.position.x, 0, camera.position.z)
  place(sun.target, 0, car.y + 2.5)
  place(sun, -1.8, car.y + 4.6, 4.5)

  const size = renderer.getDrawingBufferSize(stage.size)
  if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y)
  renderer.setRenderTarget(target)
  renderer.render(stage.scene, camera)
  renderer.setRenderTarget(null)
}
