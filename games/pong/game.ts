// Pong for two players. Left paddle: W / S. Right paddle: Up / Down. Space starts a match; first to 7 wins.
import { KEYS, defineGame, oneOf, type Context, type Entities, type World } from 'fourjs'

const TOP = 1.5
const BOTTOM = -1.5
const LEFT = -2
const RIGHT = 2
const SERVE_ANGLE = Math.PI / 6
const HIT_ANGLE = (50 * Math.PI) / 180
const GREY = '#808080'
const WHITE = '#f2f2f2'

const entities = {
  left_score: { x: -0.5, y: 1.2, text: '0', size: 0.28, color: GREY },
  right_score: { x: 0.5, y: 1.2, text: '0', size: 0.28, color: GREY },
  winner: { x: 0, y: 0.5, text: '', color: WHITE },
  prompt: { x: 0, y: -0.5, text: 'PRESS SPACE TO START', color: WHITE },
  left_keys: { x: -1, y: -1, text: 'W / S', color: GREY },
  right_keys: { x: 1, y: -1, text: 'UP / DOWN', color: GREY },
  match: { state: oneOf(['ready', 'play', 'over']), left: 0, right: 0, win_score: 7 },
  left_paddle: { x: -1.85, y: 0, w: 0.08, h: 0.45, color: WHITE, up: oneOf(KEYS, 'W'), down: oneOf(KEYS, 'S'), speed: 2.2 },
  right_paddle: { x: 1.85, y: 0, w: 0.08, h: 0.45, color: WHITE, up: oneOf(KEYS, 'Up'), down: oneOf(KEYS, 'Down'), speed: 2.2 },
  // serve_pause is in ticks.
  ball: {
    x: 0, y: 0, w: 0.08, h: 0.08, color: '#ffffff',
    vx: 0, vy: 0, speed: 0, wait: 0, serve_speed: 1.6, max_speed: 3.5, speedup: 1.05, serve_pause: 45,
  },
} satisfies Entities

type Pong = World<typeof entities>
type Box = { x: number; y: number; w: number; h: number }
type Side = 'left' | 'right'

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
}

function serve(ball: Pong['ball'], dir: number, ctx: Context): void {
  ball.x = 0
  ball.y = 0
  ball.speed = ball.serve_speed
  const angle = (ctx.random() * 2 - 1) * SERVE_ANGLE
  ball.vx = dir * ball.speed * Math.cos(angle)
  ball.vy = ball.speed * Math.sin(angle)
  ball.wait = ball.serve_pause
}

function hit(ball: Pong['ball'], paddle: Box, dir: number): void {
  const offset = (ball.y - paddle.y) / ((paddle.h + ball.h) / 2)
  const angle = Math.max(-1, Math.min(1, offset)) * HIT_ANGLE
  ball.speed = Math.min(ball.speed * ball.speedup, ball.max_speed)
  ball.vx = dir * ball.speed * Math.cos(angle)
  ball.vy = ball.speed * Math.sin(angle)
  ball.x = paddle.x + (dir * (paddle.w + ball.w)) / 2
}

function showOverlay(world: Pong, shown: boolean): void {
  for (const text of [world.winner, world.prompt, world.left_keys, world.right_keys]) text.visible = shown
}

function point(world: Pong, side: Side, ctx: Context): void {
  const { match } = world
  match[side] += 1
  const digits = side === 'left' ? world.left_score : world.right_score
  digits.text = String(match[side])
  ctx.print(`${side} scores, ${match.left}-${match.right}`)
  if (match[side] < match.win_score) return
  match.state = 'over'
  world.winner.text = `${side.toUpperCase()} PLAYER WINS`
  world.prompt.text = 'PRESS SPACE TO PLAY AGAIN'
  showOverlay(world, true)
  ctx.print(`${side} wins ${match.left}-${match.right}`)
}

function movePaddle(paddle: Pong['left_paddle'], ctx: Context): void {
  let dir = 0
  if (ctx.input.held(paddle.up)) dir += 1
  if (ctx.input.held(paddle.down)) dir -= 1
  const half = paddle.h / 2
  paddle.y = Math.max(BOTTOM + half, Math.min(TOP - half, paddle.y + dir * paddle.speed * ctx.dt))
}

function moveBall(world: Pong, ctx: Context): void {
  const { ball, left_paddle: left, right_paddle: right } = world
  if (ball.wait > 0) {
    ball.wait -= 1
    return
  }
  ball.x += ball.vx * ctx.dt
  ball.y += ball.vy * ctx.dt

  const r = ball.h / 2
  if (ball.y + r > TOP) {
    ball.y = TOP - r
    ball.vy = -Math.abs(ball.vy)
  } else if (ball.y - r < BOTTOM) {
    ball.y = BOTTOM + r
    ball.vy = Math.abs(ball.vy)
  }

  // A ball already past a paddle's middle doesn't bounce, so it can score.
  if (ball.vx < 0 && ball.x > left.x && overlaps(ball, left)) hit(ball, left, 1)
  else if (ball.vx > 0 && ball.x < right.x && overlaps(ball, right)) hit(ball, right, -1)

  if (ball.x - ball.w / 2 > RIGHT) {
    point(world, 'left', ctx)
    serve(ball, 1, ctx)
  } else if (ball.x + ball.w / 2 < LEFT) {
    point(world, 'right', ctx)
    serve(ball, -1, ctx)
  }
}

export default defineGame({
  title: 'Pong',
  background: '#08080d',
  entities,
  start(world, ctx) {
    serve(world.ball, 1, ctx)
  },
  update(world, ctx) {
    const { match } = world
    if (match.state !== 'play' && ctx.input.pressed('Space')) {
      match.left = 0
      match.right = 0
      world.left_score.text = '0'
      world.right_score.text = '0'
      showOverlay(world, false)
      match.state = 'play'
    }
    if (match.state !== 'play') return
    movePaddle(world.left_paddle, ctx)
    movePaddle(world.right_paddle, ctx)
    moveBall(world, ctx)
  },
})
