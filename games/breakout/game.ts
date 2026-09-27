// Breakout for one player. Left / Right or A / D move the paddle and Space serves. Clear every brick to win; you have three lives.
import { defineGame, grid, oneOf, type Context, type Entities, type World } from 'fourjs'

const RED = { color: '#de3329', points: 7 }
const ORANGE = { color: '#f5851f', points: 5 }
const GREEN = { color: '#29b242', points: 3 }
const YELLOW = { color: '#eddb38', points: 1 }
const ROWS = [RED, RED, ORANGE, ORANGE, GREEN, GREEN, YELLOW, YELLOW]
const COLUMNS = 14
const GREY = '#8c8c8c'
const LIGHT = '#d9d9d9'
const SCREEN_BOTTOM = -1.5

const entities = {
  wall_left: { x: -1.98, y: 0, w: 0.04, h: 3, color: GREY },
  wall_right: { x: 1.98, y: 0, w: 0.04, h: 3, color: GREY },
  wall_top: { x: 0, y: 1.48, w: 4, h: 0.04, color: GREY },
  bricks: grid(ROWS.length, COLUMNS, ({ row, col }) => ({
    // Computed in hundredths so each position equals its decimal literal, like -1.54.
    x: (-182 + 28 * col) / 100,
    y: (108 - 9 * row) / 100,
    w: 0.26,
    h: 0.07,
    ...ROWS[row],
  })),
  score_text: { x: -1.335, y: 1.29, text: '0', size: 0.21, align: 'right', color: LIGHT },
  lives_icon: { x: 1.6, y: 1.29, w: 0.05, h: 0.05, color: '#ffffff' },
  lives_text: { x: 1.76, y: 1.29, text: '3', size: 0.21, color: LIGHT },
  message: { x: 0, y: -0.2, text: '', size: 0.28 },
  prompt: { x: 0, y: -0.6, text: 'PRESS SPACE', size: 0.14, color: LIGHT },
  paddle: { x: 0, y: -1.3, w: 0.4, h: 0.05, color: '#408cff', speed: 2.6 },
  // max_angle is in degrees from straight up, and restart_delay in ticks.
  ball: {
    x: 0, y: -1.24, w: 0.05, h: 0.05, color: '#ffffff',
    vx: 0, vy: 0, speed: 1.8, speed_step: 0.3, max_angle: 60, restart_delay: 60,
    hits: 0, hit_orange: false, hit_red: false, end_ticks: 0,
  },
  game: { state: oneOf(['ready', 'playing', 'over', 'won']), score: 0, lives: 3, lives_per_game: 3, bricks_left: 0, can_restart: false },
} satisfies Entities

type Breakout = World<typeof entities>
type Brick = Breakout['bricks'][number][number]
type Ball = Breakout['ball']
type State = Breakout['game']['state']
type Box = { x: number; y: number; w: number; h: number }

const MESSAGE: Record<State, string> = { ready: '', playing: '', over: 'GAME OVER', won: 'YOU WIN' }

function radians(degrees: number): number {
  return degrees * (Math.PI / 180)
}

function overlap(a: Box, b: Box): [number, number] | undefined {
  const px = (a.w + b.w) / 2 - Math.abs(a.x - b.x)
  const py = (a.h + b.h) / 2 - Math.abs(a.y - b.y)
  return px > 0 && py > 0 ? [px, py] : undefined
}

function currentSpeed(ball: Ball): number {
  const level = [ball.hits >= 4, ball.hits >= 12, ball.hit_orange, ball.hit_red].filter(Boolean).length
  return ball.speed + level * ball.speed_step
}

function restAbovePaddle(ball: Ball, paddle: Box): void {
  ball.x = paddle.x
  ball.y = paddle.y + (paddle.h + ball.h) / 2 + 0.01
}

function reset(world: Breakout): void {
  const { ball } = world
  restAbovePaddle(ball, world.paddle)
  ball.visible = true
  ball.vx = 0
  ball.vy = 0
  ball.hits = 0
  ball.hit_orange = false
  ball.hit_red = false
  world.game.state = 'ready'
}

function newGame(world: Breakout): void {
  const { game } = world
  const bricks = world.bricks.flat()
  for (const brick of bricks) brick.visible = true
  game.score = 0
  game.lives = game.lives_per_game
  game.bricks_left = bricks.length
  game.can_restart = false
  reset(world)
}

function launch(world: Breakout, ctx: Context): void {
  const { ball } = world
  let angle = radians(20 + ctx.random() * 25)
  if (ctx.random() < 0.5) angle = -angle
  const speed = currentSpeed(ball)
  ball.vx = speed * Math.sin(angle)
  ball.vy = speed * Math.cos(angle)
  world.game.state = 'playing'
}

function bounceWalls(world: Breakout): void {
  const { ball, wall_left, wall_right, wall_top } = world
  const left = wall_left.x + wall_left.w / 2
  const right = wall_right.x - wall_right.w / 2
  const top = wall_top.y - wall_top.h / 2
  const hw = ball.w / 2
  const hh = ball.h / 2
  if (ball.x - hw < left && ball.vx < 0) {
    ball.x = 2 * (left + hw) - ball.x
    ball.vx = -ball.vx
  } else if (ball.x + hw > right && ball.vx > 0) {
    ball.x = 2 * (right - hw) - ball.x
    ball.vx = -ball.vx
  }
  if (ball.y + hh > top && ball.vy > 0) {
    ball.y = 2 * (top - hh) - ball.y
    ball.vy = -ball.vy
  }
}

function bouncePaddle(ball: Ball, paddle: Box): void {
  if (ball.vy >= 0 || ball.y < paddle.y - paddle.h / 2 || !overlap(ball, paddle)) return
  const offset = Math.max(-1, Math.min(1, (ball.x - paddle.x) / ((paddle.w + ball.w) / 2)))
  const angle = offset * radians(ball.max_angle)
  const speed = currentSpeed(ball)
  ball.vx = speed * Math.sin(angle)
  ball.vy = speed * Math.cos(angle)
  ball.y = paddle.y + (paddle.h + ball.h) / 2
}

function bounceOffBrick(ball: Ball, brick: Box): boolean {
  const hit = overlap(ball, brick)
  if (!hit) return false
  const [px, py] = hit
  if (px < py) {
    if ((ball.x - brick.x) * ball.vx >= 0) return false
    ball.vx = -ball.vx
    return true
  }
  if ((ball.y - brick.y) * ball.vy >= 0) return false
  ball.vy = -ball.vy
  return true
}

function knockOut(world: Breakout, brick: Brick): void {
  const { ball, game } = world
  brick.visible = false
  game.score += brick.points
  game.bricks_left -= 1
  ball.hits += 1
  if (brick.color === RED.color) ball.hit_red = true
  else if (brick.color === ORANGE.color) ball.hit_orange = true
  const scale = currentSpeed(ball) / Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)
  ball.vx *= scale
  ball.vy *= scale
}

// One brick per tick, so a ball that meets the seam between two bricks bounces once.
function hitBrick(world: Breakout): void {
  for (const row of world.bricks) {
    for (const brick of row) {
      if (brick.visible && bounceOffBrick(world.ball, brick)) {
        knockOut(world, brick)
        return
      }
    }
  }
}

function finish(world: Breakout, state: 'over' | 'won'): void {
  const { ball } = world
  ball.visible = false
  ball.vx = 0
  ball.vy = 0
  ball.end_ticks = 0
  world.game.state = state
}

function loseBall(world: Breakout): void {
  const { game } = world
  game.lives -= 1
  if (game.lives > 0) reset(world)
  else finish(world, 'over')
}

function movePaddle(world: Breakout, ctx: Context): void {
  const { paddle, wall_left, wall_right, game } = world
  if (game.state === 'over' || game.state === 'won') return
  let dir = 0
  if (ctx.input.held('Left') || ctx.input.held('A')) dir -= 1
  if (ctx.input.held('Right') || ctx.input.held('D')) dir += 1
  const min = wall_left.x + wall_left.w / 2 + paddle.w / 2
  const max = wall_right.x - wall_right.w / 2 - paddle.w / 2
  paddle.x = Math.max(min, Math.min(max, paddle.x + dir * paddle.speed * ctx.dt))
}

function moveBall(world: Breakout, ctx: Context): void {
  const { ball, game } = world
  switch (game.state) {
    case 'ready':
      restAbovePaddle(ball, world.paddle)
      if (ctx.input.pressed('Space')) launch(world, ctx)
      return
    case 'playing':
      ball.x += ball.vx * ctx.dt
      ball.y += ball.vy * ctx.dt
      bounceWalls(world)
      bouncePaddle(ball, world.paddle)
      hitBrick(world)
      if (game.bricks_left === 0) finish(world, 'won')
      else if (ball.y + ball.h / 2 < SCREEN_BOTTOM) loseBall(world)
      return
    case 'over':
    case 'won':
      if (game.can_restart && ctx.input.pressed('Space')) {
        newGame(world)
      } else {
        ball.end_ticks += 1
        game.can_restart = ball.end_ticks >= ball.restart_delay
      }
      return
    default: {
      const _exhaustive: never = game.state
      return _exhaustive
    }
  }
}

// Runs before show, so each text still holds what the previous tick showed.
function logChanges(world: Breakout, ctx: Context): void {
  const { game } = world
  if (String(game.score) !== world.score_text.text) ctx.print(`score ${game.score}`)
  if (String(game.lives) !== world.lives_text.text) ctx.print(`lives ${game.lives}`)
  if (MESSAGE[game.state] === world.message.text) return
  if (game.state === 'won') ctx.print(`YOU WIN! every brick cleared, final score ${game.score}`)
  if (game.state === 'over') ctx.print(`GAME OVER, final score ${game.score}`)
}

function show(world: Breakout): void {
  const { game } = world
  world.score_text.text = String(game.score)
  world.lives_text.text = String(game.lives)
  world.message.text = MESSAGE[game.state]
  world.prompt.text = game.state === 'ready' ? 'PRESS SPACE' : game.can_restart ? 'PRESS SPACE TO PLAY AGAIN' : ''
}

export default defineGame({
  title: 'Breakout',
  background: '#000000',
  entities,
  start(world, ctx) {
    newGame(world)
    show(world)
    const { game } = world
    ctx.print(`score ${game.score}, lives ${game.lives}, ${game.bricks_left} bricks to clear`)
  },
  update(world, ctx) {
    movePaddle(world, ctx)
    moveBall(world, ctx)
    logChanges(world, ctx)
    show(world)
  },
})
