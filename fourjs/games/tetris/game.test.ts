import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, simulate, type EntityState, type SimOptions } from '../../src/index.ts'
import tetris from './game.ts'

function run(options: SimOptions): (tick: number, name?: string) => EntityState {
  const { snapshots } = simulate(tetris, { every: 1, ...options })
  return (tick, name = 'game') => pick(snapshots[tick].entities, name)[0]
}

test('Left and Right move at once, repeat after 10 ticks and then every 3, and a wall stops both moves and turns', () => {
  const waiting = run({ ticks: 30, hold: ['Left', 'Down'], press: ['Up@5'] })
  assert.deepEqual(waiting(30), waiting(0))

  const at = run({ ticks: 26, set: ['game.bag=["I"]'], press: ['Space@1', 'Up@2,26'], hold: ['Right@3-24'] })
  const columns = Array.from({ length: 23 }, (_, i) => at(i + 2).left)
  assert.deepEqual(columns, [6, ...Array(10).fill(7), 8, 8, 8, 9, 9, 9, ...Array(6).fill(10)])
  assert.equal(at(2).turn, 1)
  assert.equal(at(26).turn, 1)
})

test('a piece falls a row every 30 ticks, or every 2 with Down, and locking it clears full rows for 100 to 800 points', () => {
  const single = run({ ticks: 67, set: ['game.board=["LLLL..JJJJ","T........."]', 'game.bag=["O"]'], press: ['Space@1'], hold: ['Down@32-'] })
  assert.deepEqual([30, 31, 32, 33, 34, 35, 65, 66].map((tick) => single(tick).bottom), [19, 18, 18, 17, 17, 16, 1, 1])
  const { score, lines, board, spawned } = single(67)
  assert.deepEqual({ score, lines, board, spawned }, { score: 100, lines: 1, board: ['T...OO....'], spawned: 2 })

  const rows = '["IIIIIIIII.","JJJJJJJJJ.","LLLLLLLLL.","OOOOOOOOO.","T........."]'
  const four = run({ ticks: 53, set: [`game.board=${rows}`, 'game.bag=["I"]'], press: ['Space@1', 'Up@2'], hold: ['Right@3-20', 'Down@21-'] })
  assert.equal(four(52).lines, 0)
  assert.deepEqual([four(53).score, four(53).board, four(53, 'score').text], [800, ['T.........'], '000800'])
})

test('a piece with no room ends the game, and Space starts a new one only after restart_delay ticks', () => {
  const set = [`game.board=${JSON.stringify(Array(18).fill('IIIIIIIII.'))}`, 'game.bag=["O"]']
  const early = run({ ticks: 63, set, press: ['Space@1,30,63'], hold: ['Down@2-3'] })
  assert.deepEqual([2, 3, 30, 63].map((tick) => early(tick).state), ['playing', 'over', 'over', 'over'])
  assert.deepEqual([early(3, 'border').color, early(3, 'cell_1_1').color], ['#d92626', '#737373'])
  assert.deepEqual([early(62, 'banner_prompt').text, early(63, 'banner_prompt').text], ['', 'PRESS SPACE'])

  const late = run({ ticks: 64, set, press: ['Space@1,30,64'], hold: ['Down@2-3'] })
  const { state, board, score, spawned } = late(64)
  assert.deepEqual({ state, board, score, spawned }, { state: 'playing', board: [], score: 0, spawned: 1 })
  assert.deepEqual([late(64, 'border').color, late(64, 'banner_title').visible], ['#8c94ad', false])
})
