import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, simulate, type EntitiesOf, type Key, type SimOptions } from '../../src/index.ts'
import snake from './game.ts'

function end(options: SimOptions<EntitiesOf<typeof snake>>) {
  const { snapshots, logs } = simulate(snake, options)
  const [game, head] = pick(snapshots[0].entities, 'game,head')
  return { game, head, log: logs.at(-1) }
}

test('an arrow key starts the snake, which steps every 8 ticks and turns only a quarter at a time', () => {
  // Left@20 is the reverse, so it only starts the snake; Down@31 reverses the queued Up, so only Up and Left queue.
  const { snapshots } = simulate(snake, { ticks: 60, every: 1, press: ['Left@20', 'Up@30', 'Down@31', 'Left@32'] })
  const games = snapshots.map((s) => pick(s.entities, 'game')[0])
  assert.deepEqual([games[19].state, games[19].body], ['ready', [[6, 8], [5, 8], [4, 8]]])
  const stepped = games.flatMap((game, tick) => (tick > 0 && game.steps !== games[tick - 1].steps ? [tick] : []))
  assert.deepEqual(stepped, [28, 36, 44, 52, 60])
  assert.deepEqual(
    stepped.map((tick) => {
      const { body } = games[tick]
      return Array.isArray(body) ? body[0] : body
    }),
    [[7, 8], [7, 9], [6, 9], [5, 9], [4, 9]],
  )
})

test('a wall or the body ends the game, the head may take the cell the tail leaves, and Space plays again', () => {
  const wall = end({ ticks: 121, press: ['Right@1'] })
  assert.deepEqual(wall.log, { tick: 121, text: 'game over: hit the wall at (21,8). final score 0' })
  assert.equal(wall.head.color, '#f24d33')

  const again = end({ ticks: 130, press: ['Right@1', 'Space@130'] })
  assert.deepEqual([again.game.state, again.game.body, again.head.color], ['ready', [[6, 8], [5, 8], [4, 8]], '#73f266'])

  const uTurn = { ticks: 25, press: ['Up@1', 'Left@10', 'Down@18'] }
  const five = end({ ...uTurn, set: ['game.start_body=[[6,8],[5,8],[4,8],[3,8],[2,8]]'] })
  assert.deepEqual(five.log, { tick: 25, text: 'game over: ran into itself at (5,8). final score 0' })
  const four = end({ ...uTurn, set: ['game.start_body=[[6,8],[5,8],[4,8],[3,8]]'] })
  assert.deepEqual([four.game.state, four.game.body], ['playing', [[5, 8], [5, 9], [6, 9], [6, 8]]])
})

test('steering along a cycle through every cell never finds an apple under the snake, fills the board, and wins', () => {
  const [cols, rows] = [6, 4]
  // Up column 1, a serpentine over the other columns above row 1, and back along row 1.
  const next = ([x, y]: readonly number[]): number[] => {
    if (x === 1) return y < rows ? [1, y + 1] : [2, rows]
    if (y === 1) return [x - 1, 1]
    if (x % 2 === 0) return y > 2 ? [x, y - 1] : x < cols ? [x + 1, 2] : [x, 1]
    return y < rows ? [x, y + 1] : [x + 1, rows]
  }
  const keys: Record<string, Key> = { '1,0': 'Right', '-1,0': 'Left', '0,1': 'Up', '0,-1': 'Down' }
  let decided = -1
  let apple = ''
  let won = { tick: 0, state: '', score: 0, length: 0 }
  const { snapshots, logs } = simulate(snake, {
    ticks: 10_000,
    set: [`game.cols=${cols}`, `game.rows=${rows}`, 'game.start_body=[[3,2],[2,2]]'],
    drive: ({ world, tick }) => {
      const { game, food } = world
      if (won.tick === 0 && game.state === 'won') won = { tick, state: game.state, score: game.score, length: game.body.length }
      if (won.tick > 0) return tick === won.tick + 60 ? ['Space'] : []
      if (`${game.food_x},${game.food_y}` !== apple) {
        apple = `${game.food_x},${game.food_y}`
        for (const e of [world.head, ...world.segments]) {
          if (e.visible) assert.ok(Math.abs(e.x - food.x) > 0.01 || Math.abs(e.y - food.y) > 0.01, `the apple at (${apple}) is under ${e.name}`)
        }
      }
      if (game.steps === decided) return []
      decided = game.steps
      const [x, y] = game.body[0]
      const [nx, ny] = next([x, y])
      const turn = game.state === 'ready' || nx - x !== game.dir[0] || ny - y !== game.dir[1]
      return turn ? [keys[`${nx - x},${ny - y}`]] : []
    },
  })
  assert.deepEqual([won.state, won.score, won.length], ['won', cols * rows - 2, cols * rows])
  assert.equal(logs.filter(({ text }) => text.includes('ate food')).length, won.score)
  const [after, food] = pick(snapshots[0].entities, 'game,food')
  assert.deepEqual([after.state, after.score, after.body, food.visible], ['ready', 0, [[3, 2], [2, 2]], true])
})
