// Flappy: Space starts a run and each press flaps. Fly through the gaps; hitting a pipe, the ceiling, or the ground ends the run.
import { defineGame, grid, group, oneOf, type Context, type Entities, type World } from 'fourjs'

const OUTLINE = '#543847'
const WHITE = '#ffffff'

const LEFT = -2
const BOB_PERIOD = 0.8

// The boxes of a pipe pair, offset from its gap: the top pipe and its cap, then the bottom pipe and its cap.
const WALLS = [
  { part: 'top_line', dy: 2.16, w: 0.36, h: 3.2 },
  { part: 'top_cap_line', dy: 0.48, w: 0.4, h: 0.16 },
  { part: 'bot_line', dy: -2.16, w: 0.36, h: 3.2 },
  { part: 'bot_cap_line', dy: -0.48, w: 0.4, h: 0.16 },
]

const entities = {
  ceiling: { x: 0, y: 2, w: 4.4, h: 1, visible: false },
  // Each pipe pair is its gap, and walls[i] are the boxes around pipes[i] in the order of WALLS.
  pipes: group(3, (i) => ({
    x: 2.25 + 1.6 * i, y: 0, w: 0.4, h: 0.8, visible: false,
    gap_min: -0.35, gap_max: 0.75, wrap: 4.8, home_x: 0, scored: false,
  })),
  walls: grid(3, WALLS.length, ({ col }) => ({ w: WALLS[col].w, h: WALLS[col].h, color: OUTLINE })),
  // scroll is how far the ground has moved, for the stripes view.ts draws.
  ground: { x: 0, y: -1.275, w: 4.2, h: 0.45, color: '#ded895', scroll: 0 },
  // The bird's box is its outline. restart_delay is in ticks.
  bird: {
    x: -0.9, y: 0.1, w: 0.24, h: 0.18, color: OUTLINE,
    gravity: 8, flap_speed: 2.3, max_fall: 3.5, forward_speed: 1, bob: 0.03, restart_delay: 30,
    state: oneOf(['ready', 'play', 'over']), vy: 0, score: 0, age: 0, landed: false, over_ticks: 0, can_restart: false, home_y: 0,
  },
  // The beak sticks out of the bird's box, so pipes test both; dx and dy place it from the bird.
  beak: { w: 0.126, h: 0.084, color: OUTLINE, dx: 0.102, dy: -0.036 },
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
type Wall = Flappy['walls'][number][number]
type Box = Pick<Wall, 'x' | 'y' | 'w' | 'h'>

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

function placeWalls(pipe: Pipe, walls: readonly Wall[]): void {
  for (const [col, wall] of walls.entries()) {
    wall.x = pipe.x
    wall.y = pipe.y + WALLS[col].dy
  }
}

function placeBeak({ bird, beak }: Flappy): void {
  beak.x = bird.x + beak.dx
  beak.y = bird.y + beak.dy
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
  placeBeak(world)
}

function movePipes(world: Flappy, ctx: Context): void {
  const { bird } = world
  for (const [i, pipe] of world.pipes.entries()) {
    if (bird.state === 'play') {
      pipe.x -= bird.forward_speed * ctx.dt
      if (pipe.x < LEFT - pipe.w / 2) {
        pipe.x += pipe.wrap
        newGap(pipe, ctx)
        pipe.scored = false
      }
    }
    placeWalls(pipe, world.walls[i])
  }
}

function scrollGround({ bird, ground }: Flappy, ctx: Context): void {
  if (bird.state !== 'over') ground.scroll += bird.forward_speed * ctx.dt
}

function referee(world: Flappy, ctx: Context): void {
  const { bird, beak } = world
  for (const [i, walls] of world.walls.entries()) {
    const hit = walls.findIndex((wall) => overlaps(bird, wall) || overlaps(beak, wall))
    if (hit >= 0) {
      crash(world, `pipe${i + 1}_${WALLS[hit].part}`, ctx)
      return
    }
  }
  for (const [i, pipe] of world.pipes.entries()) {
    if (!pipe.scored && pipe.x + pipe.w / 2 < bird.x - bird.w / 2) {
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
    for (const [i, pipe] of world.pipes.entries()) {
      pipe.home_x = pipe.x
      goHome(pipe, bird, ctx)
      placeWalls(pipe, world.walls[i])
    }
    placeBeak(world)
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
