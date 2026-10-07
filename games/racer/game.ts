// Racer. Space starts the race; Left and Right steer through the traffic to the finish line before the clock runs out. A crash spins the car out and slows it to the traffic's speed, and each coin adds a second.
import { defineGame, group, oneOf, spawn, type Context, type Entities, type World } from 'threejam'
import { KINDS, LANES, LENGTHS, RACER, ROAD_EDGE, TRAFFIC_WIDTH } from './road.ts'

const WHITE = '#f2f2f2'
const GREY = '#c8c8d2'
const PAINT = ['#2f6fdb', '#f2c230', '#f2f2f2', '#3aa856', '#8a4fd8', '#ef7d22']

const entities = {
  road: { w: 1.8, h: 3, color: '#4a4a55' },
  // The lines where the race starts and ends, which move down the screen as the car drives.
  start_line: { y: -0.87, w: 1.8, h: 0.06, color: WHITE },
  finish_line: { y: 319.13, w: 1.8, h: 0.06, color: WHITE },
  // A coin floats along the road at the traffic's speed, so it keeps to the gap its row left.
  coins: group(6, () => ({ w: 0.13, h: 0.13, shape: 'circle', color: '#ffd23f', visible: false })),
  // speed is along the road in world units a second, like the car's; a crashed car brakes to a stop as it slides off the road, drift saying which way.
  traffic: group(18, () => ({ w: TRAFFIC_WIDTH, h: LENGTHS.car, color: PAINT[0], visible: false, kind: oneOf(KINDS), speed: 0, crashed: false, drift: 0 })),
  // A world unit is 10 metres. turn_rate is how fast steer reaches a held direction, in a second, and spin and spin_ticks count ticks.
  car: { y: -1.1, ...RACER, color: '#e23b3b', speed: 0, top_speed: 6, accel: 1.8, steer: 0, steer_speed: 2.4, turn_rate: 12, spin: 0, spin_ticks: 60 },
  // clock, timer, and the other _ticks count ticks; distance, finish, and the rows' spacing are world units along the road; lane is the one the last row kept free.
  race: {
    state: oneOf(['ready', 'play', 'won', 'lost']), clock: 3600, start_clock: 3600, distance: 0, finish: 320, coins: 0, crashes: 0,
    timer: 0, restart_ticks: 60, coin_ticks: 60, traffic_speed: 2.5, spawn_y: 12, behind: -3, next_row: 2, first_row: 2, gap_min: 1.7, gap_max: 2.7,
    pair_gap: 0.7, pairs: 0.6, lane: 1, coin_chance: 0.25, brake: 2.5, slide_speed: 2.4, slide_turn: 3, verge: 1.3,
  },
  // The heads-up display comes last, so it draws over everything above.
  hud: { y: 1.37, w: 4, h: 0.26, color: '#000000', opacity: 0.35 },
  panel: { y: 0.4, w: 3.1, h: 0.82, color: '#000000', opacity: 0.4 },
  time: { x: -1.9, y: 1.37, text: 'TIME 60', size: 0.1, align: 'left', color: WHITE },
  distance_left: { y: 1.37, text: '3.2 KM TO GO', size: 0.1, color: WHITE },
  speedometer: { x: 1.9, y: 1.37, text: '0 KM/H', size: 0.1, align: 'right', color: WHITE },
  message: { y: 0.62, text: 'RACER', size: 0.32, color: WHITE },
  detail: { y: 0.3, text: 'PRESS SPACE TO START', size: 0.1, color: WHITE },
  prompt: { y: 0.12, text: 'LEFT AND RIGHT STEER; EACH COIN ADDS A SECOND', size: 0.065, color: GREY },
} satisfies Entities

type Racer = World<typeof entities>
type Car = Racer['car']
type Other = Racer['traffic'][number]
type Box = { x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
}

function toward(value: number, target: number, most: number): number {
  return Math.abs(target - value) <= most ? target : value + Math.sign(target - value) * most
}

// The road left to drive in kilometres, at 10 metres a world unit.
function km({ race }: Racer): string {
  return (Math.max(0, race.finish - race.distance) / 100).toFixed(1)
}

function newRace(world: Racer, ctx: Context): void {
  const { car, race } = world
  for (const each of [...world.traffic, ...world.coins]) each.visible = false
  car.x = 0
  car.speed = 0
  car.steer = 0
  car.spin = 0
  car.angle = 0
  race.state = 'play'
  race.clock = race.start_clock
  race.distance = 0
  race.next_row = race.first_row
  race.lane = 1
  race.coins = 0
  race.crashes = 0
  ctx.print(`the race starts with ${race.clock / 60} seconds on the clock`)
}

function end(world: Racer, ctx: Context, state: 'won' | 'lost'): void {
  const { race } = world
  race.state = state
  race.timer = race.restart_ticks
  if (state === 'won') {
    ctx.play('score')
    ctx.print(`FINISH with ${(race.clock / 60).toFixed(1)} seconds to spare, ${race.crashes} crashes, and ${race.coins} coins`)
  } else {
    ctx.play('lose')
    ctx.print(`TIME UP with ${km(world)} km to go`)
  }
}

// A held direction turns the wheel toward it at turn_rate, so the car eases into a turn and out of it, and the road's edges stop it.
function steer(car: Car, ctx: Context): void {
  const held = car.spin > 0 ? 0 : (ctx.input.held('Right') ? 1 : 0) - (ctx.input.held('Left') ? 1 : 0)
  car.steer = toward(car.steer, held, car.turn_rate * ctx.dt)
  const edge = ROAD_EDGE - car.w / 2
  car.x = Math.max(-edge, Math.min(edge, car.x + car.steer * car.steer_speed * ctx.dt))
}

// The car speeds up to top_speed while it races, and once the race is over eases down to the traffic's speed, so nothing behind it ever catches up; a spin holds the speed the crash left.
function accelerate(world: Racer, ctx: Context): void {
  const { car, race } = world
  if (car.spin > 0) {
    car.spin -= 1
    // One whole turn, back to straight ahead as the spin ends.
    car.angle = (2 * Math.PI * car.spin) / car.spin_ticks
    return
  }
  car.speed = toward(car.speed, race.state === 'play' ? car.top_speed : race.traffic_speed, car.accel * ctx.dt)
}

// A row of one car, or later in the race often two. It keeps free the lane the row before kept free, or one beside it, so the car can always get through; sometimes a coin waits in a free lane.
function addRow(world: Racer, ctx: Context): number {
  const { race } = world
  race.lane = Math.max(0, Math.min(2, race.lane + Math.floor(ctx.random() * 3) - 1))
  const others = [0, 1, 2].filter((lane) => lane !== race.lane)
  if (ctx.random() < 0.5) others.reverse()
  const count = ctx.random() < race.pairs * Math.min(1, race.distance / race.finish) ? 2 : 1
  for (const lane of others.slice(0, count)) {
    const roll = ctx.random()
    const kind = roll < 0.15 ? 'truck' : roll < 0.4 ? 'van' : 'car'
    const h = LENGTHS[kind]
    spawn(world.traffic, { kind, h, x: LANES[lane], y: race.spawn_y + h / 2, speed: race.traffic_speed, color: PAINT[Math.floor(ctx.random() * PAINT.length)] })
  }
  const free = [race.lane, ...others.slice(count)]
  if (ctx.random() < race.coin_chance) spawn(world.coins, { x: LANES[free[Math.floor(ctx.random() * free.length)]], y: race.spawn_y })
  return count
}

// The start line is where the car's front was when the race began, and the finish line is finish further along the road.
function lineAt(world: Racer, along: number): number {
  const { car, race } = world
  return car.y + car.h / 2 + along - race.distance
}

// Rows come as the car gains on the traffic, a gap apart, with more room after a row of two; none starts past the finish line.
function addTraffic(world: Racer, ctx: Context): void {
  const { car, race } = world
  race.next_row -= Math.max(0, car.speed - race.traffic_speed) * ctx.dt
  if (race.next_row > 0) return
  const count = race.spawn_y > lineAt(world, race.finish) ? 0 : addRow(world, ctx)
  race.next_row += race.gap_min + (race.gap_max - race.gap_min) * ctx.random() + (count === 2 ? race.pair_gap : 0)
}

// A crashed car slides until it's off the road, turning as it goes.
function sliding(world: Racer, other: Other): boolean {
  return other.crashed && Math.abs(other.x) < world.race.verge
}

// A car hit by something at x slides away from it, or to its own side of the road when hit from right behind.
function knock(other: Other, x: number): void {
  const away = Math.abs(other.x - x) > 0.1 ? other.x - x : other.x
  other.crashed = true
  other.drift = away < 0 ? -1 : 1
}

function moveTraffic(world: Racer, ctx: Context): void {
  const { car, race } = world
  for (const other of world.traffic) {
    if (!other.visible) continue
    if (other.crashed) other.speed = Math.max(0, other.speed - race.brake * ctx.dt)
    if (sliding(world, other)) {
      other.x += other.drift * race.slide_speed * ctx.dt
      other.angle += other.drift * race.slide_turn * ctx.dt
      // A wreck pushes any car it slides into ahead of it, crashing it too, and knocks coins out of the way.
      for (const struck of world.traffic) {
        if (struck === other || !struck.visible || !overlaps(struck, other)) continue
        if (!struck.crashed) knock(struck, other.x)
        struck.x = other.x + (other.drift * (other.w + struck.w)) / 2
      }
      for (const coin of world.coins) if (coin.visible && overlaps(coin, other)) coin.visible = false
    }
    other.y += (other.speed - car.speed) * ctx.dt
    if (other.y + other.h / 2 < race.behind) other.visible = false
  }
  for (const coin of world.coins) {
    if (!coin.visible) continue
    coin.y += (race.traffic_speed - car.speed) * ctx.dt
    if (coin.y < race.behind) coin.visible = false
  }
}

// The car spins out and slows to the traffic's speed, and the car it hit slides off the road.
function crash(world: Racer, ctx: Context, other: Other): void {
  const { car, race } = world
  car.spin = car.spin_ticks
  car.speed = Math.min(car.speed, race.traffic_speed)
  if (!other.crashed) knock(other, car.x)
  race.crashes += 1
  ctx.play('hit')
  ctx.print(`crashed into ${other.name} with ${km(world)} km to go`)
}

// A car in the way, or a wreck still sliding across the road, crashes the car unless it's already spinning.
function collide(world: Racer, ctx: Context): void {
  const { car, race } = world
  if (car.spin === 0) {
    const hit = world.traffic.find((other) => other.visible && (!other.crashed || sliding(world, other)) && overlaps(car, other))
    if (hit !== undefined) crash(world, ctx, hit)
  }
  if (race.state !== 'play') return
  for (const coin of world.coins) {
    if (!coin.visible || !overlaps(car, coin)) continue
    coin.visible = false
    race.clock += race.coin_ticks
    race.coins += 1
    ctx.play('coin')
  }
}

function countDown(world: Racer, ctx: Context): void {
  const { race } = world
  race.clock -= 1
  if (race.clock <= 0) end(world, ctx, 'lost')
  else if (race.clock <= 300 && race.clock % 60 === 0) ctx.play('blip')
}

function placeLines(world: Racer): void {
  world.start_line.y = lineAt(world, 0)
  world.finish_line.y = lineAt(world, world.race.finish)
}

function show(world: Racer): void {
  const { car, race } = world
  const ready = race.state === 'ready'
  world.time.text = `TIME ${Math.ceil(race.clock / 60)}`
  world.distance_left.text = `${km(world)} KM TO GO`
  world.speedometer.text = `${Math.round(car.speed * 36)} KM/H`
  const again = race.timer === 0 ? 'PRESS SPACE TO RACE AGAIN' : ''
  switch (race.state) {
    case 'ready':
      world.message.text = 'RACER'
      world.detail.text = 'PRESS SPACE TO START'
      world.prompt.text = 'LEFT AND RIGHT STEER; EACH COIN ADDS A SECOND'
      break
    case 'play':
      world.message.text = ''
      world.detail.text = ''
      world.prompt.text = ''
      break
    case 'won':
      world.message.text = 'FINISH'
      world.detail.text = `${(race.clock / 60).toFixed(1)} SECONDS TO SPARE`
      world.prompt.text = again
      break
    case 'lost':
      world.message.text = 'TIME UP'
      world.detail.text = `${km(world)} KM TO GO`
      world.prompt.text = again
      break
    default: {
      const _exhaustive: never = race.state
      return _exhaustive
    }
  }
  world.prompt.color = ready ? GREY : WHITE
  world.panel.visible = race.state !== 'play'
}

export default defineGame({
  title: 'Racer',
  background: '#3f8f3f',
  entities,
  update(world, ctx) {
    const { race } = world
    switch (race.state) {
      case 'ready':
        if (ctx.input.pressed('Space')) newRace(world, ctx)
        break
      case 'play':
        countDown(world, ctx)
        break
      case 'won':
      case 'lost':
        if (race.timer > 0) race.timer -= 1
        else if (ctx.input.pressed('Space')) newRace(world, ctx)
        break
      default: {
        const _exhaustive: never = race.state
        return _exhaustive
      }
    }
    if (race.state !== 'ready') {
      accelerate(world, ctx)
      steer(world.car, ctx)
      race.distance += world.car.speed * ctx.dt
      if (race.state === 'play' && race.distance >= race.finish) end(world, ctx, 'won')
      moveTraffic(world, ctx)
      if (race.state === 'play') addTraffic(world, ctx)
      collide(world, ctx)
      placeLines(world)
    }
    show(world)
  },
})
