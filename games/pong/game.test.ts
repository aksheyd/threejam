import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, simulate } from 'threejam'
import pong from './game.ts'

const round = (value: unknown) => Math.round(Number(value) * 1e4) / 1e4

function close(actual: unknown, expected: number): void {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} should be ${expected}`)
}

test('nothing moves until Space starts a match, and then the serve waits serve_pause ticks before it flies right', () => {
  const idle = simulate(pong, { ticks: 60, hold: ['W', 'Up'] }).world
  assert.deepEqual([idle.match.state, idle.prompt.visible, idle.ball.x, idle.left_paddle.y, idle.right_paddle.y], ['ready', true, 0, 0, 0])

  const waiting = simulate(pong, { ticks: 45, press: ['Space@1'] }).world
  assert.deepEqual([waiting.match.state, waiting.prompt.visible, waiting.left_keys.visible, waiting.ball.x, waiting.ball.y], ['play', false, false, 0, 0])
  const { ball } = simulate(pong, { ticks: 46, press: ['Space@1'] }).world
  close(ball.x, ball.vx / 60)
  close(Math.hypot(ball.vx, ball.vy), ball.serve_speed)
  assert.ok(ball.vx > 0 && Math.abs(Math.atan2(ball.vy, ball.vx)) <= Math.PI / 6, 'the serve goes right, at most 30 degrees from level')
})

test('W and S move the left paddle and Up and Down the right, 2.2 a second, until a wall stops them', () => {
  const paddles = (ticks: number, ...hold: string[]) => {
    const { left_paddle, right_paddle } = simulate(pong, { ticks, press: ['Space@1'], hold }).world
    return [round(left_paddle.y), round(right_paddle.y)]
  }
  assert.deepEqual(paddles(31, 'W@1-30', 'Down@1-30'), [1.1, -1.1])
  assert.deepEqual(paddles(61, 'S@1-60', 'Up@1-60'), [-1.275, 1.275])
  assert.deepEqual(paddles(31, 'W@1-30', 'S@1-30'), [0, 0])
})

test('a ball past a paddle scores for the other side and is served again from the middle, Space changes nothing mid-match, seven points win, and Space then plays again from 0-0', () => {
  const served = simulate(pong, { ticks: 177, press: ['Space@1,150'], every: 1 })
  const ball = (tick: number) => pick(served.snapshots[tick].entities, 'ball')[0]
  assert.deepEqual(served.logs, [{ tick: 131, text: 'left scores, 1-0' }])
  assert.deepEqual([served.world.match.left, served.world.left_score.text], [1, '1'])
  assert.deepEqual([ball(131).x, ball(131).y, ball(131).speed, ball(176).x], [0, 0, 1.6, 0])
  assert.ok(Number(ball(177).x) > 0, 'the next serve goes to the player who missed')

  const won = simulate(pong, { ticks: 3600, press: ['Space@1'], until: ({ world }) => world.match.state === 'over' })
  assert.deepEqual(
    won.logs.map(({ tick, text }) => `[tick ${tick}] ${text}`),
    [131, 263, 387, 519, 643, 769, 893].map((tick, i) => `[tick ${tick}] left scores, ${i + 1}-0`).concat('[tick 893] left wins 7-0'),
  )
  const { winner, prompt, left_score, right_score } = won.world
  assert.deepEqual([winner.text, prompt.text, left_score.text, right_score.text, winner.visible], ['LEFT PLAYER WINS', 'PRESS SPACE TO PLAY AGAIN', '7', '0', true])

  const again = simulate(pong, { ticks: 894, press: ['Space@1,894'] }).world
  assert.deepEqual([again.match.state, again.match.left, again.left_score.text, again.winner.visible, again.prompt.visible], ['play', 0, '0', false, false])
})

test('with paddles as tall as the screen, every return is 5% faster up to max_speed and aimed by where the ball meets the paddle, and the walls turn it back', () => {
  const { snapshots, logs } = simulate(pong, { ticks: 1800, press: ['Space@1'], set: ['left_paddle.h=3', 'right_paddle.h=3'], every: 1 })
  const balls = snapshots.map((snapshot) => pick(snapshot.entities, 'ball')[0])
  const turned = (field: 'vx' | 'vy') => balls.filter((ball, tick) => tick > 0 && Math.sign(Number(ball[field])) !== Math.sign(Number(balls[tick - 1][field])))
  const returns = turned('vx')
  assert.equal(returns.length, 17)
  let speed = 1.6
  for (const ball of returns) {
    speed = Math.min(speed * 1.05, 3.5)
    close(ball.speed, speed)
    // The paddle stays at y 0, so the ball's offset from its middle, over half their heights together, is the share of 50 degrees the return turns.
    close(Math.atan2(Number(ball.vy), Math.abs(Number(ball.vx))), (Number(ball.y) / ((3 + 0.08) / 2)) * ((50 * Math.PI) / 180))
  }
  assert.equal(speed, 3.5)
  const bounces = turned('vy').filter((ball) => !returns.includes(ball))
  assert.ok(bounces.length > 0 && bounces.every((ball) => Math.abs(Number(ball.y)) === 1.46), JSON.stringify(bounces.map((ball) => ball.y)))
  assert.deepEqual(logs, [])
})
