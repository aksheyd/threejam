// Flappy: Space starts a run and each press flaps. Fly through the gaps; hitting a pipe or the ground ends the run.
import { defineGame, type Context, type Entities, type World } from 'fourjs'

const OUTLINE = '#543847'
const PIPE = '#73bf2e'
const PIPE_HI = '#9ce659'
const PIPE_LO = '#558e22'
const WHITE = '#ffffff'

const LEFT = -2
const BOB_PERIOD = 0.8
const WING_FRAMES = [0.018, 0, -0.018, 0]
const STRIPE_COUNT = 27
const STRIPE_WRAP_AT = -2.16
const STRIPE_PERIOD = 4.32

type State = 'ready' | 'play' | 'over'
type Part = { dx: number; dy: number; w: number; h: number; color: string; flaps?: boolean }
type Rect = { x: number; y: number; w: number; h: number; color: string }

// A pipe pair's parts, as offsets from its gap.
const PIPE_PARTS = {
  top_line: { dx: 0, dy: 2.16, w: 0.36, h: 3.2, color: OUTLINE },
  top: { dx: 0, dy: 2.16, w: 0.32, h: 3.2, color: PIPE },
  top_hi: { dx: -0.105, dy: 2.16, w: 0.05, h: 3.2, color: PIPE_HI },
  top_lo: { dx: 0.13, dy: 2.16, w: 0.06, h: 3.2, color: PIPE_LO },
  top_cap_line: { dx: 0, dy: 0.48, w: 0.4, h: 0.16, color: OUTLINE },
  top_cap: { dx: 0, dy: 0.48, w: 0.36, h: 0.12, color: PIPE },
  top_cap_hi: { dx: -0.12, dy: 0.48, w: 0.05, h: 0.12, color: PIPE_HI },
  top_cap_lo: { dx: 0.15, dy: 0.48, w: 0.06, h: 0.12, color: PIPE_LO },
  bot_line: { dx: 0, dy: -2.16, w: 0.36, h: 3.2, color: OUTLINE },
  bot: { dx: 0, dy: -2.16, w: 0.32, h: 3.2, color: PIPE },
  bot_hi: { dx: -0.105, dy: -2.16, w: 0.05, h: 3.2, color: PIPE_HI },
  bot_lo: { dx: 0.13, dy: -2.16, w: 0.06, h: 3.2, color: PIPE_LO },
  bot_cap_line: { dx: 0, dy: -0.48, w: 0.4, h: 0.16, color: OUTLINE },
  bot_cap: { dx: 0, dy: -0.48, w: 0.36, h: 0.12, color: PIPE },
  bot_cap_hi: { dx: -0.12, dy: -0.48, w: 0.05, h: 0.12, color: PIPE_HI },
  bot_cap_lo: { dx: 0.15, dy: -0.48, w: 0.06, h: 0.12, color: PIPE_LO },
} satisfies Record<string, Part>
const PIPE_PART_NAMES = Object.keys(PIPE_PARTS) as Array<keyof typeof PIPE_PARTS>
const PIPE_SOLIDS = ['top_line', 'top_cap_line', 'bot_line', 'bot_cap_line'] as const
const PIPES = ['pipe1', 'pipe2', 'pipe3'] as const

// The bird's parts, drawn over its outline, as offsets from it.
const BIRD_PARTS = {
  body: { dx: 0, dy: 0, w: 0.216, h: 0.156, color: '#fad129' },
  belly: { dx: 0.006, dy: -0.048, w: 0.156, h: 0.048, color: '#fdee9e' },
  wing_line: { dx: -0.066, dy: -0.006, w: 0.108, h: 0.078, color: OUTLINE, flaps: true },
  wing: { dx: -0.066, dy: -0.006, w: 0.084, h: 0.054, color: '#fdf7e0', flaps: true },
  eye: { dx: 0.054, dy: 0.036, w: 0.078, h: 0.078, color: WHITE },
  pupil: { dx: 0.0744, dy: 0.0324, w: 0.0264, h: 0.042, color: '#1f1414' },
  beak_line: { dx: 0.102, dy: -0.036, w: 0.126, h: 0.084, color: OUTLINE },
  beak_top: { dx: 0.1044, dy: -0.0204, w: 0.108, h: 0.0288, color: '#fa5921' },
  beak_bot: { dx: 0.0996, dy: -0.0516, w: 0.096, h: 0.0264, color: '#e64d1f' },
} satisfies Record<string, Part>
const BIRD_PART_NAMES = Object.keys(BIRD_PARTS) as Array<keyof typeof BIRD_PARTS>

function parts<P extends string, T extends Record<string, Part>>(prefix: P, table: T, x: number, y: number) {
  const rects: Record<string, Rect> = {}
  for (const [name, part] of Object.entries(table)) {
    rects[prefix + name] = { x: x + part.dx, y: y + part.dy, w: part.w, h: part.h, color: part.color }
  }
  return rects as Record<`${P}${keyof T & string}`, Rect>
}

function gap(x: number) {
  return { x, y: 0, w: 0.4, h: 0.8, visible: false, gap_min: -0.35, gap_max: 0.75, wrap: 4.8, home_x: 0, scored: false }
}

function stripes() {
  const triangles: Record<string, Rect & { shape: 'triangle' }> = {}
  for (let i = 0; i < STRIPE_COUNT; i++) {
    triangles[`stripe_${i + 1}`] = { x: STRIPE_WRAP_AT + 0.16 * i, y: -1.095, w: 0.1, h: 0.06, shape: 'triangle', color: PIPE }
  }
  return triangles as Record<`stripe_${number}`, Rect & { shape: 'triangle' }>
}

const entities = {
  ceiling: { x: 0, y: 2, w: 4.4, h: 1, visible: false },
  pipe1: gap(2.25),
  ...parts('pipe1_', PIPE_PARTS, 2.25, 0),
  pipe2: gap(3.85),
  ...parts('pipe2_', PIPE_PARTS, 3.85, 0),
  pipe3: gap(5.45),
  ...parts('pipe3_', PIPE_PARTS, 5.45, 0),
  ground: { x: 0, y: -1.275, w: 4.2, h: 0.45, color: '#ded895' },
  ground_line: { x: 0, y: -1.0575, w: 4.2, h: 0.015, color: OUTLINE },
  grass: { x: 0, y: -1.095, w: 4.2, h: 0.06, color: PIPE_HI },
  ...stripes(),
  grass_edge: { x: 0, y: -1.13, w: 4.2, h: 0.01, color: '#558022' },
  dirt_edge: { x: 0, y: -1.1425, w: 4.2, h: 0.015, color: '#d7a84c' },
  // The bird's box is its outline. restart_delay is in ticks.
  bird: {
    x: -0.9, y: 0.1, w: 0.24, h: 0.18, color: OUTLINE,
    gravity: 8, flap_speed: 2.3, max_fall: 3.5, forward_speed: 1, bob: 0.03, restart_delay: 30,
    state: 'ready' as State, vy: 0, score: 0, age: 0, landed: false as boolean, over_ticks: 0, can_restart: false as boolean, home_y: 0,
  },
  ...parts('bird_', BIRD_PARTS, -0.9, 0.1),
  // Capitals come out about 0.72 of size tall with their middle 0.1 of size above y, so these sizes and offsets compensate.
  score_shadow: { x: 0.02, y: 1.14, text: '0', size: 0.39, color: OUTLINE },
  score: { x: 0, y: 1.16, text: '0', size: 0.39, color: WHITE },
  title_shadow: { x: 0.015, y: 0.605, text: 'GET READY', size: 0.29, color: OUTLINE },
  title: { x: 0, y: 0.62, text: 'GET READY', size: 0.29, color: WHITE },
  prompt_shadow: { x: 0.01, y: 0.32, text: 'PRESS SPACE', size: 0.195, color: OUTLINE },
  prompt: { x: 0, y: 0.33, text: 'PRESS SPACE', size: 0.195, color: WHITE },
  // ticks is how long the flash fades after a crash, and peak its opacity on the crash tick.
  flash: { w: 4, h: 3, color: WHITE, opacity: 0, ticks: 20, peak: 0.85, left: 0 },
} satisfies Entities

type Flappy = World<typeof entities>
type Bird = Flappy['bird']
type Pipe = Flappy['pipe1']
type PipeName = (typeof PIPES)[number]
type Box = { x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
}

function restY({ bird, ground }: Flappy): number {
  return ground.y + (ground.h + bird.h) / 2
}

function fly(bird: Bird, flap: boolean, ctx: Context): void {
  bird.vy -= bird.gravity * ctx.dt
  if (flap) bird.vy = bird.flap_speed
  bird.vy = Math.max(bird.vy, -bird.max_fall)
  bird.y += bird.vy * ctx.dt
}

function crash(world: Flappy, what: string, ctx: Context): void {
  const { bird, flash } = world
  bird.state = 'over'
  bird.vy = Math.min(bird.vy, 0)
  flash.left = flash.ticks
  ctx.print(`hit ${what} at score ${bird.score}`)
}

function land(world: Flappy): void {
  const { bird } = world
  bird.y = restY(world)
  bird.vy = 0
  bird.landed = true
}

function newGap(pipe: Pipe, ctx: Context): void {
  pipe.y = pipe.gap_min + (pipe.gap_max - pipe.gap_min) * ctx.random()
}

function goHome(pipe: Pipe, bird: Bird, ctx: Context): void {
  pipe.x = pipe.home_x
  newGap(pipe, ctx)
  // A pair that starts behind the bird can't be passed.
  pipe.scored = pipe.x < bird.x
}

function restart(world: Flappy, ctx: Context): void {
  const { bird } = world
  bird.state = 'ready'
  bird.y = bird.home_y
  bird.vy = 0
  bird.score = 0
  bird.landed = false
  bird.over_ticks = 0
  bird.can_restart = false
  for (const name of PIPES) goHome(world[name], bird, ctx)
}

function placeBird(world: Flappy): void {
  const { bird } = world
  const wing = bird.state === 'over' ? 0 : WING_FRAMES[Math.floor(bird.age / 5) % 4]
  for (const name of BIRD_PART_NAMES) {
    const part: Part = BIRD_PARTS[name]
    const shape = world[`bird_${name}`]
    shape.x = bird.x + part.dx
    shape.y = bird.y + part.dy + (part.flaps ? wing : 0)
  }
}

function moveBird(world: Flappy, ctx: Context): void {
  const { bird, ground, ceiling } = world
  const pressed = ctx.input.pressed('Space')
  bird.age += 1
  if (bird.state === 'ready') {
    bird.y = bird.home_y + bird.bob * Math.sin((bird.age * ctx.dt * 2 * Math.PI) / BOB_PERIOD)
    if (pressed) bird.state = 'play'
  }
  if (bird.state === 'play') {
    fly(bird, pressed, ctx)
    if (overlaps(bird, ground)) {
      land(world)
      crash(world, 'the ground', ctx)
    } else if (overlaps(bird, ceiling)) {
      bird.y = ceiling.y - (ceiling.h + bird.h) / 2
      crash(world, 'the ceiling', ctx)
    }
  } else if (bird.state === 'over') {
    if (bird.can_restart && pressed) {
      restart(world, ctx)
    } else if (!bird.landed) {
      fly(bird, false, ctx)
      if (bird.y <= restY(world)) land(world)
    } else {
      bird.over_ticks += 1
      bird.can_restart = bird.over_ticks >= bird.restart_delay
    }
  }
  placeBird(world)
}

function placePipe(world: Flappy, name: PipeName): void {
  const pipe = world[name]
  for (const part of PIPE_PART_NAMES) {
    const shape = world[`${name}_${part}`]
    shape.x = pipe.x + PIPE_PARTS[part].dx
    shape.y = pipe.y + PIPE_PARTS[part].dy
  }
}

function movePipes(world: Flappy, ctx: Context): void {
  const { bird } = world
  for (const name of PIPES) {
    const pipe = world[name]
    if (bird.state === 'play') {
      pipe.x -= bird.forward_speed * ctx.dt
      if (pipe.x < LEFT - pipe.w / 2) {
        pipe.x += pipe.wrap
        newGap(pipe, ctx)
        pipe.scored = false
      }
    }
    placePipe(world, name)
  }
}

function scrollGround(world: Flappy, ctx: Context): void {
  const { bird } = world
  if (bird.state === 'over') return
  for (const stripe of ctx.all('stripe_')) {
    stripe.x -= bird.forward_speed * ctx.dt
    if (stripe.x < STRIPE_WRAP_AT) stripe.x += STRIPE_PERIOD
  }
}

function solidHit(world: Flappy, name: PipeName): string | undefined {
  // The beak sticks out of the bird's box, so pipes test both.
  const boxes = [world.bird, world.bird_beak_line]
  const solid = PIPE_SOLIDS.find((solid) => boxes.some((box) => overlaps(box, world[`${name}_${solid}`])))
  return solid && `${name}_${solid}`
}

function referee(world: Flappy, ctx: Context): void {
  const { bird } = world
  for (const name of PIPES) {
    const hit = solidHit(world, name)
    if (hit) {
      crash(world, hit, ctx)
      return
    }
  }
  for (const name of PIPES) {
    const pipe = world[name]
    if (!pipe.scored && pipe.x + pipe.w / 2 < bird.x - bird.w / 2) {
      pipe.scored = true
      bird.score += 1
      ctx.print(`passed ${name}, score ${bird.score}`)
    }
  }
}

function fade(flash: Flappy['flash']): void {
  flash.opacity = (flash.peak * flash.left) / flash.ticks
  flash.left = Math.max(0, flash.left - 1)
}

function show(world: Flappy, line: 'score' | 'title' | 'prompt', text: string): void {
  world[line].text = text
  world[`${line}_shadow`].text = text
}

function showHud(world: Flappy): void {
  const { bird } = world
  show(world, 'score', String(bird.score))
  show(world, 'title', bird.state === 'ready' ? 'GET READY' : bird.landed ? 'GAME OVER' : '')
  show(world, 'prompt', bird.state === 'ready' || bird.can_restart ? 'PRESS SPACE' : '')
}

export default defineGame({
  title: 'Flappy',
  background: '#4ec0ca',
  entities,
  start(world, ctx) {
    const { bird } = world
    bird.home_y = bird.y
    for (const name of PIPES) {
      const pipe = world[name]
      pipe.home_x = pipe.x
      goHome(pipe, bird, ctx)
      placePipe(world, name)
    }
  },
  update(world, ctx) {
    moveBird(world, ctx)
    movePipes(world, ctx)
    scrollGround(world, ctx)
    if (world.bird.state === 'play') referee(world, ctx)
    fade(world.flash)
    showHud(world)
  },
})
