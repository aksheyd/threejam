// Asteroids. Left / Right or A / D turn, Up or W thrusts, and Space fires; or hold the mouse to aim at the pointer and fire, and the right button to thrust. Space or a click starts and plays again.
import { defineGame, group, oneOf, spawn, type Context, type Entities, type Point, type World } from '@aksheyd/fourjs'

const WHITE = '#f2f2f2'
const GREY = '#8c8c99'
const HALF_W = 2
const HALF_H = 1.5
const ROCK_IMAGES = ['rock1.svg', 'rock2.svg', 'rock3.svg']
const ROCK_SIZES = ['big', 'medium', 'small'] as const
// A rock is hit this far from its middle, as a share of its width, which keeps its jagged corners fair.
const ROCK_REACH = 0.42

type Size = (typeof ROCK_SIZES)[number]

// Speeds are in world units a second, and a rock that breaks becomes two of the size it splits into.
const SIZES: Record<Size, { w: number; points: number; slowest: number; fastest: number; splits: Size | undefined; pitch: number }> = {
  big: { w: 0.5, points: 20, slowest: 0.25, fastest: 0.5, splits: 'medium', pitch: 0.6 },
  medium: { w: 0.28, points: 50, slowest: 0.45, fastest: 0.8, splits: 'small', pitch: 1 },
  small: { w: 0.15, points: 100, slowest: 0.7, fastest: 1.1, splits: undefined, pitch: 1.6 },
}

const entities = {
  rocks: group(32, () => ({
    w: 0.5, h: 0.5, image: 'rock1.svg', visible: false, kind: oneOf(ROCK_SIZES), vx: 0, vy: 0, spin: 0,
  })),
  bullets: group(4, () => ({ w: 0.035, h: 0.035, shape: 'circle', color: WHITE, visible: false, vx: 0, vy: 0, age: 0 })),
  // The ship points up at angle 0; turn_speed is in radians a second, and bullet_ticks, fire_ticks, and safe_ticks count ticks.
  ship: {
    x: 0, y: 0, angle: 0, visible: false, vx: 0, vy: 0, radius: 0.07, turn_speed: 4, thrust: 2.6, drag: 0.5, max_speed: 2.2,
    bullet_speed: 3.2, bullet_ticks: 45, fire_ticks: 9, gun: 0, safe: 0, safe_ticks: 120,
    parts: {
      flame: { y: -0.14, w: 0.07, h: 0.1, shape: 'triangle', angle: Math.PI, color: '#ff9933', visible: false },
      hull: { w: 0.15, h: 0.2, shape: 'triangle', color: WHITE },
      notch: { y: -0.075, w: 0.09, h: 0.05, shape: 'triangle', color: '#000000' },
    },
  },
  score: { x: -1.9, y: 1.38, text: '0', align: 'left', color: WHITE },
  lives: { x: 1.9, y: 1.38, text: 'LIVES 3', align: 'right', color: WHITE },
  message: { x: 0, y: 0.45, text: 'ASTEROIDS', size: 0.35, color: WHITE },
  prompt: { x: 0, y: -0.1, text: 'PRESS SPACE OR CLICK TO START', size: 0.1, color: WHITE },
  keys_help: { x: 0, y: -0.95, text: 'ARROWS TURN AND THRUST, SPACE FIRES', size: 0.07, color: GREY },
  mouse_help: { x: 0, y: -1.1, text: 'OR HOLD THE MOUSE TO AIM AND FIRE; RIGHT BUTTON THRUSTS', size: 0.07, color: GREY },
  // first_wave is the big rocks in the first wave, and each wave after has one more, up to most_rocks; the times count ticks.
  game: {
    state: oneOf(['ready', 'play', 'dead', 'over']), score: 0, lives: 3, start_lives: 3, wave: 0, first_wave: 4, most_rocks: 8,
    timer: 0, respawn_ticks: 90, restart_ticks: 60,
  },
} satisfies Entities

type Asteroids = World<typeof entities>
type Rock = Asteroids['rocks'][number]
type Ship = Asteroids['ship']

function livesPhrase(n: number): string {
  return n === 1 ? '1 life' : `${n} lives`
}

function between(ctx: Context, low: number, high: number): number {
  return low + (high - low) * ctx.random()
}

// Keeps an angle from -pi to pi, so turning never winds it up.
function around(angle: number): number {
  return angle > Math.PI ? angle - 2 * Math.PI : angle <= -Math.PI ? angle + 2 * Math.PI : angle
}

// The way the ship's nose points: up at angle 0, and to the left at a quarter turn.
function heading(angle: number): [x: number, y: number] {
  return [-Math.sin(angle), Math.cos(angle)]
}

// Once all of it is past one edge, it comes back at the other.
function wrap(e: { x: number; y: number }, margin: number): void {
  if (e.x > HALF_W + margin) e.x -= 2 * (HALF_W + margin)
  else if (e.x < -HALF_W - margin) e.x += 2 * (HALF_W + margin)
  if (e.y > HALF_H + margin) e.y -= 2 * (HALF_H + margin)
  else if (e.y < -HALF_H - margin) e.y += 2 * (HALF_H + margin)
}

function touches(rock: Rock, at: Point, radius: number): boolean {
  const reach = rock.w * ROCK_REACH + radius
  const [dx, dy] = [rock.x - at.x, rock.y - at.y]
  return dx * dx + dy * dy < reach * reach
}

function launch(world: Asteroids, ctx: Context, kind: Size, { x, y }: Point): void {
  const { w, slowest, fastest } = SIZES[kind]
  const direction = between(ctx, -Math.PI, Math.PI)
  const speed = between(ctx, slowest, fastest)
  spawn(world.rocks, {
    kind, x, y, w, h: w,
    vx: speed * Math.cos(direction), vy: speed * Math.sin(direction),
    angle: between(ctx, -Math.PI, Math.PI), spin: between(ctx, -1.5, 1.5),
    image: ROCK_IMAGES[Math.floor(ctx.random() * ROCK_IMAGES.length)],
  })
}

// Big rocks drift in from random places on the screen's edge, away from the ship.
function addRocks(world: Asteroids, ctx: Context, count: number): void {
  const { ship } = world
  for (let i = 0; i < count; i++) {
    const along = between(ctx, -1, 1)
    const side = ctx.random() < 0.5 ? -1 : 1
    let at = ctx.random() < 0.5 ? { x: along * HALF_W, y: side * HALF_H } : { x: side * HALF_W, y: along * HALF_H }
    if (ship.visible && Math.abs(at.x - ship.x) < 1 && Math.abs(at.y - ship.y) < 1) at = { x: -at.x, y: -at.y }
    launch(world, ctx, 'big', at)
  }
}

function nextWave(world: Asteroids, ctx: Context): void {
  const { game } = world
  game.wave += 1
  const count = Math.min(game.first_wave + game.wave - 1, game.most_rocks)
  addRocks(world, ctx, count)
  ctx.print(`wave ${game.wave} brings ${count} big rocks`)
}

function respawn(world: Asteroids): void {
  const { ship, game } = world
  ship.x = 0
  ship.y = 0
  ship.vx = 0
  ship.vy = 0
  ship.angle = 0
  ship.gun = 0
  ship.safe = ship.safe_ticks
  ship.visible = true
  game.state = 'play'
}

function newGame(world: Asteroids, ctx: Context): void {
  const { game } = world
  for (const each of [...world.rocks, ...world.bullets]) each.visible = false
  game.score = 0
  game.lives = game.start_lives
  game.wave = 0
  respawn(world)
  nextWave(world, ctx)
  ctx.print(`a new game with ${livesPhrase(game.lives)}`)
}

function starts(ctx: Context): boolean {
  return ctx.input.pressed('Space') || ctx.input.pressed('Mouse')
}

function turnToward(ship: Ship, target: Point, ctx: Context): void {
  const wanted = Math.atan2(ship.x - target.x, target.y - ship.y)
  const off = around(wanted - ship.angle)
  const most = ship.turn_speed * ctx.dt
  ship.angle = Math.abs(off) <= most ? wanted : around(ship.angle + Math.sign(off) * most)
}

function fire(world: Asteroids, ctx: Context): void {
  const { ship } = world
  const [hx, hy] = heading(ship.angle)
  const nose = ship.parts.hull.h / 2
  const vx = ship.vx + hx * ship.bullet_speed
  const vy = ship.vy + hy * ship.bullet_speed
  // With every bullet in flight, the gun waits for one to land or fly out.
  if (spawn(world.bullets, { x: ship.x + hx * nose, y: ship.y + hy * nose, vx, vy }) === undefined) return
  ship.gun = ship.fire_ticks
  ctx.play('shoot', { volume: 0.5 })
}

function fly(world: Asteroids, ctx: Context): void {
  const { ship } = world
  const { input } = ctx
  const aiming = input.held('Mouse')
  if (aiming) {
    turnToward(ship, input.pointer, ctx)
  } else {
    const turn = (input.held('Left') || input.held('A') ? 1 : 0) - (input.held('Right') || input.held('D') ? 1 : 0)
    ship.angle = around(ship.angle + turn * ship.turn_speed * ctx.dt)
  }
  const thrusting = input.held('Up') || input.held('W') || input.held('MouseRight')
  if (thrusting) {
    const [hx, hy] = heading(ship.angle)
    ship.vx += hx * ship.thrust * ctx.dt
    ship.vy += hy * ship.thrust * ctx.dt
  }
  const slowed = 1 - ship.drag * ctx.dt
  ship.vx *= slowed
  ship.vy *= slowed
  const speed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy)
  if (speed > ship.max_speed) {
    ship.vx *= ship.max_speed / speed
    ship.vy *= ship.max_speed / speed
  }
  ship.x += ship.vx * ctx.dt
  ship.y += ship.vy * ctx.dt
  wrap(ship, ship.parts.hull.h / 2)
  ship.parts.flame.visible = thrusting
  // A new ship blinks every 6 ticks while it can't be hit.
  if (ship.safe > 0) ship.safe -= 1
  ship.visible = ship.safe === 0 || Math.floor(ship.safe / 6) % 2 === 1
  if (ship.gun > 0) ship.gun -= 1
  if (ship.gun === 0 && (input.held('Space') || aiming)) fire(world, ctx)
}

function moveRocks(world: Asteroids, ctx: Context): void {
  for (const rock of world.rocks) {
    if (!rock.visible) continue
    rock.x += rock.vx * ctx.dt
    rock.y += rock.vy * ctx.dt
    rock.angle = around(rock.angle + rock.spin * ctx.dt)
    wrap(rock, rock.w / 2)
  }
}

function moveBullets(world: Asteroids, ctx: Context): void {
  for (const bullet of world.bullets) {
    if (!bullet.visible) continue
    bullet.age += 1
    if (bullet.age >= world.ship.bullet_ticks) {
      bullet.visible = false
      continue
    }
    bullet.x += bullet.vx * ctx.dt
    bullet.y += bullet.vy * ctx.dt
    wrap(bullet, 0)
  }
}

function breakRock(world: Asteroids, ctx: Context, rock: Rock): void {
  const { points, splits, pitch } = SIZES[rock.kind]
  const at = { x: rock.x, y: rock.y }
  rock.visible = false
  world.game.score += points
  ctx.play('explode', { pitch })
  if (splits === undefined) return
  launch(world, ctx, splits, at)
  launch(world, ctx, splits, at)
}

function shootRocks(world: Asteroids, ctx: Context): void {
  for (const bullet of world.bullets) {
    if (!bullet.visible) continue
    const rock = world.rocks.find((each) => each.visible && touches(each, bullet, 0))
    if (rock === undefined) continue
    bullet.visible = false
    breakRock(world, ctx, rock)
  }
}

function crash(world: Asteroids, ctx: Context): void {
  const { ship, game } = world
  if (ship.safe > 0) return
  const rock = world.rocks.find((each) => each.visible && touches(each, ship, ship.radius))
  if (rock === undefined) return
  game.lives -= 1
  ctx.print(`the ship hit ${rock.name}, ${livesPhrase(game.lives)} left`)
  breakRock(world, ctx, rock)
  ship.visible = false
  ship.parts.flame.visible = false
  ctx.play('lose')
  if (game.lives > 0) {
    game.state = 'dead'
    game.timer = game.respawn_ticks
    return
  }
  game.state = 'over'
  game.timer = game.restart_ticks
  ctx.print(`GAME OVER with ${game.score} points`)
}

function show(world: Asteroids): void {
  const { game } = world
  const ready = game.state === 'ready'
  world.score.text = String(game.score)
  world.lives.text = `LIVES ${game.lives}`
  world.message.text = ready ? 'ASTEROIDS' : game.state === 'over' ? 'GAME OVER' : ''
  world.prompt.text = ready ? 'PRESS SPACE OR CLICK TO START' : game.state === 'over' && game.timer === 0 ? 'PRESS SPACE OR CLICK TO PLAY AGAIN' : ''
  world.keys_help.visible = ready
  world.mouse_help.visible = ready
}

export default defineGame({
  title: 'Asteroids',
  background: '#000000',
  entities,
  // The title screen's rocks drift until a game starts with a wave of its own.
  start(world, ctx) {
    addRocks(world, ctx, world.game.first_wave)
  },
  update(world, ctx) {
    const { game } = world
    moveRocks(world, ctx)
    moveBullets(world, ctx)
    switch (game.state) {
      case 'ready':
        if (starts(ctx)) newGame(world, ctx)
        break
      case 'play':
        fly(world, ctx)
        break
      case 'dead':
        game.timer -= 1
        if (game.timer <= 0) respawn(world)
        break
      case 'over':
        if (game.timer > 0) game.timer -= 1
        else if (starts(ctx)) newGame(world, ctx)
        break
      default: {
        const _exhaustive: never = game.state
        return _exhaustive
      }
    }
    if (game.state === 'play' || game.state === 'dead') {
      shootRocks(world, ctx)
      if (game.state === 'play') crash(world, ctx)
      if (world.rocks.every((rock) => !rock.visible)) nextWave(world, ctx)
    }
    show(world)
  },
})
