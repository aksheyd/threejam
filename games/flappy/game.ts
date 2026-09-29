// Flappy: Space starts a run and each press flaps. Fly through the gaps; hitting a pipe, the ceiling, or the ground ends the run.
import { defineGame, group, oneOf, type Context, type Entities, type World } from 'threejam'

const OUTLINE = '#543847'
const WHITE = '#ffffff'

const LEFT = -2
const BOB_PERIOD = 0.8

const entities = {
  ceiling: { x: 0, y: 2, w: 4.4, h: 1, visible: false },
  // Each pipe pair sits at the middle of its gap, and its parts are the outlines of the pipes and caps above and below.
  pipes: group(3, (i) => ({
    x: 2.25 + 1.6 * i, y: 0,
    gap_min: -0.35, gap_max: 0.75, wrap: 4.8, home_x: 0, scored: false,
    parts: {
      top: { y: 2.16, w: 0.36, h: 3.2, color: OUTLINE },
      top_cap: { y: 0.48, w: 0.4, h: 0.16, color: OUTLINE },
      bottom: { y: -2.16, w: 0.36, h: 3.2, color: OUTLINE },
      bottom_cap: { y: -0.48, w: 0.4, h: 0.16, color: OUTLINE },
    },
  })),
  // scroll is how far the ground has moved, for the stripes view.ts draws.
  ground: { x: 0, y: -1.275, w: 4.2, h: 0.45, color: '#ded895', scroll: 0 },
  // The bird's box is its outline, and the beak sticks out of it, so pipes test both. restart_delay is in ticks.
  bird: {
    x: -0.9, y: 0.1, w: 0.24, h: 0.18, color: OUTLINE,
    gravity: 8, flap_speed: 2.3, max_fall: 3.5, forward_speed: 1, bob: 0.03, restart_delay: 30,
    state: oneOf(['ready', 'play', 'over']), vy: 0, score: 0, age: 0, landed: false, over_ticks: 0, can_restart: false, home_y: 0,
    parts: { beak: { x: 0.102, y: -0.036, w: 0.126, h: 0.084, color: OUTLINE } },
  },
  score_shadow: { x: 0.02, y: 1.18, text: '0', size: 0.28, color: OUTLINE },
  score: { x: 0, y: 1.2, text: '0', size: 0.28, color: WHITE },
  title_shadow: { x: 0.015, y: 0.635, text: 'GET READY', size: 0.21, color: OUTLINE },
  title: { x: 0, y: 0.65, text: 'GET READY', size: 0.21, color: WHITE },
  prompt_shadow: { x: 0.01, y: 0.34, text: 'PRESS SPACE', size: 0.14, color: OUTLINE },
  prompt: { x: 0, y: 0.35, text: 'PRESS SPACE', size: 0.14, color: WHITE },
  // ticks is how long the flash fades after a crash, and peak its opacity on the crash tick.
  flash: { w: 4, h: 3, color: WHITE, opacity: 0, ticks: 20, peak: 0.85, left: 0 },
} satisfies Entities

type Flappy = World<typeof entities>
type Bird = Flappy['bird']
type Pipe = Flappy['pipes'][number]
type Box = { x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
}

// Where a part is on screen: its x and y are from its entity's.
function placed(at: Pick<Box, 'x' | 'y'>, part: Box): Box {
  return { x: at.x + part.x, y: at.y + part.y, w: part.w, h: part.h }
}

// A pair is as wide as its caps.
function width(pipe: Pipe): number {
  return pipe.parts.top_cap.w
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
  for (const pipe of world.pipes) goHome(pipe, bird, ctx)
}

function moveBird(world: Flappy, ctx: Context): void {
  const { bird, ground, ceiling } = world
  const pressed = ctx.input.pressed('Space')
  bird.age += 1
  // Not a case below: the press that starts a run is also its first flap.
  if (bird.state === 'ready') {
    bird.y = bird.home_y + bird.bob * Math.sin((bird.age * ctx.dt * 2 * Math.PI) / BOB_PERIOD)
    if (pressed) bird.state = 'play'
  }
  switch (bird.state) {
    case 'ready':
      break
    case 'play':
      fly(bird, pressed, ctx)
      if (overlaps(bird, ground)) {
        land(world)
        crash(world, 'the ground', ctx)
      } else if (overlaps(bird, ceiling)) {
        bird.y = ceiling.y - (ceiling.h + bird.h) / 2
        crash(world, 'the ceiling', ctx)
      }
      break
    case 'over':
      if (bird.can_restart && pressed) {
        restart(world, ctx)
      } else if (!bird.landed) {
        fly(bird, false, ctx)
        if (bird.y <= restY(world)) land(world)
      } else {
        bird.over_ticks += 1
        bird.can_restart = bird.over_ticks >= bird.restart_delay
      }
      break
    default: {
      const _exhaustive: never = bird.state
      return _exhaustive
    }
  }
}

function movePipes(world: Flappy, ctx: Context): void {
  const { bird } = world
  if (bird.state !== 'play') return
  for (const pipe of world.pipes) {
    pipe.x -= bird.forward_speed * ctx.dt
    if (pipe.x < LEFT - width(pipe) / 2) {
      pipe.x += pipe.wrap
      newGap(pipe, ctx)
      pipe.scored = false
    }
  }
}

function scrollGround({ bird, ground }: Flappy, ctx: Context): void {
  if (bird.state !== 'over') ground.scroll += bird.forward_speed * ctx.dt
}

function referee(world: Flappy, ctx: Context): void {
  const { bird } = world
  const beak = placed(bird, bird.parts.beak)
  for (const pipe of world.pipes) {
    for (const part of Object.values(pipe.parts)) {
      const wall = placed(pipe, part)
      if (overlaps(bird, wall) || overlaps(beak, wall)) {
        crash(world, part.name, ctx)
        return
      }
    }
  }
  for (const [i, pipe] of world.pipes.entries()) {
    if (!pipe.scored && pipe.x + width(pipe) / 2 < bird.x - bird.w / 2) {
      pipe.scored = true
      bird.score += 1
      ctx.print(`passed pipe${i + 1}, score ${bird.score}`)
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
    for (const pipe of world.pipes) {
      pipe.home_x = pipe.x
      goHome(pipe, bird, ctx)
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
