import assert from 'node:assert/strict'
import { test } from 'node:test'
import { grid, pick, simulate } from 'threejam'
import breakout from './game.ts'

function alone(row: number, col: number): typeof breakout {
  const brick = breakout.entities.bricks.rows[row][col]
  return { ...breakout, entities: { ...breakout.entities, bricks: grid(1, 1, () => brick) } }
}

test('the first serve knocks out a lone brick for its row points, which wins the game', () => {
  for (const { row, tick, points } of [
    { row: 0, tick: 106, points: 7 },
    { row: 2, tick: 97, points: 5 },
    { row: 4, tick: 89, points: 3 },
    { row: 6, tick: 82, points: 1 },
  ]) {
    const { logs } = simulate(alone(row, 0), { ticks: tick, press: ['Space@1'] })
    assert.deepEqual(logs, [
      { tick: 0, text: 'score 0, lives 3, 1 bricks to clear' },
      { tick, text: `score ${points}` },
      { tick, text: `YOU WIN! every brick cleared, final score ${points}` },
    ])
  }
})

test('each miss costs a life until the game is over, and Space starts a new game only after the restart delay', () => {
  const over = 733
  const ready = over + breakout.entities.ball.restart_delay
  const serves = 'Space@1,300,600'
  const early = simulate(breakout, { ticks: ready, press: [serves, `Space@${ready}`], hold: [`Left@${over + 1}-`] })
  assert.deepEqual(early.logs.slice(1), [
    { tick: 77, text: 'score 1' },
    { tick: 167, text: 'lives 2' },
    { tick: 369, text: 'score 2' },
    { tick: 451, text: 'lives 1' },
    { tick: 661, text: 'score 3' },
    { tick: 733, text: 'lives 0' },
    { tick: 733, text: 'GAME OVER, final score 3' },
  ])
  const [prompt, paddle, game] = pick(early.snapshots[0].entities, 'prompt,paddle,game')
  assert.deepEqual([prompt.text, paddle.x, game.state], ['PRESS SPACE TO PLAY AGAIN', 0, 'over'])

  const { snapshots, logs } = simulate(breakout, { ticks: ready + 1, press: [serves, `Space@${ready + 1}`] })
  assert.deepEqual(logs.slice(-2), [
    { tick: ready + 1, text: 'score 0' },
    { tick: ready + 1, text: 'lives 3' },
  ])
  const [again] = pick(snapshots[0].entities, 'game')
  assert.deepEqual([again.state, again.bricks_left], ['ready', 112])
  assert.ok(pick(snapshots[0].entities, 'bricks').every((brick) => brick.visible !== false))
})

test('Left or A and Right or D move the paddle between the walls, and the ball rests on it until the serve', () => {
  const at = (ticks: number, ...hold: string[]) => pick(simulate(breakout, { ticks, hold }).snapshots[0].entities, 'paddle,ball')
  const xs = (ticks: number, ...hold: string[]) => at(ticks, ...hold).map((e) => Math.round(Number(e.x) * 1e4) / 1e4)
  assert.deepEqual(xs(30, 'Left'), [-1.3, -1.3])
  assert.deepEqual(xs(30, 'D'), [1.3, 1.3])
  assert.deepEqual(xs(60, 'A'), [-1.76, -1.76])
  assert.deepEqual(xs(60, 'Right'), [1.76, 1.76])
  assert.deepEqual(xs(30, 'A', 'D'), [0, 0])
  assert.equal(at(60, 'Left')[1].y, -1.24)
})
