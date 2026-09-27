import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, simulate, type Game } from '../../src/index.ts'
import breakout from './game.ts'

function withOnly(brick: string): Game {
  const entities = Object.fromEntries(Object.entries(breakout.entities).filter(([name]) => !name.startsWith('brick_') || name === brick))
  return { ...breakout, entities }
}

test('the first serve knocks out a lone brick for its row points, which wins the game', () => {
  for (const [brick, tick, points] of [
    ['brick_1_1', 106, 7],
    ['brick_3_1', 97, 5],
    ['brick_5_1', 89, 3],
    ['brick_7_1', 82, 1],
  ] as const) {
    const { logs } = simulate(withOnly(brick), { ticks: tick, press: ['Space@1'] })
    assert.deepEqual(logs, [
      '[tick 0] score 0, lives 3, 1 bricks to clear',
      `[tick ${tick}] score ${points}`,
      `[tick ${tick}] YOU WIN! every brick cleared, final score ${points}`,
    ])
  }
})

test('each miss costs a life until the game is over, and Space starts a new game only after the restart delay', () => {
  const over = 733
  const ready = over + breakout.entities.ball.restart_delay
  const serves = 'Space@1,300,600'
  const early = simulate(breakout, { ticks: ready, press: [serves, `Space@${ready}`], hold: [`Left@${over + 1}-`] })
  assert.deepEqual(early.logs.slice(1), [
    '[tick 77] score 1',
    '[tick 167] lives 2',
    '[tick 369] score 2',
    '[tick 451] lives 1',
    '[tick 661] score 3',
    '[tick 733] lives 0',
    '[tick 733] GAME OVER, final score 3',
  ])
  const [prompt, paddle, game] = pick(early.snapshots[0].entities, 'prompt,paddle,game')
  assert.deepEqual([prompt.text, paddle.x, game.state], ['PRESS SPACE TO PLAY AGAIN', 0, 'over'])

  const { snapshots, logs } = simulate(breakout, { ticks: ready + 1, press: [serves, `Space@${ready + 1}`] })
  assert.deepEqual(logs.slice(-2), [`[tick ${ready + 1}] score 0`, `[tick ${ready + 1}] lives 3`])
  const [again] = pick(snapshots[0].entities, 'game')
  assert.deepEqual([again.state, again.bricks_left], ['ready', 112])
  assert.ok(pick(snapshots[0].entities, 'brick_*').every((brick) => brick.visible !== false))
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
