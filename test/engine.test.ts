import assert from 'node:assert/strict'
import { test } from 'node:test'
import pong from '../games/pong/game.ts'
import { parseGame } from '../src/engine.ts'
import { RunError, UsageError } from '../src/errors.ts'
import { Session, defineDriver, defineGame, grid, group, oneOf, pick, simulate, type Entities, type Game, type World } from '../src/index.ts'

const ball = { x: 0, y: 0, w: 0.1, h: 0.1, vx: 1, label: 'b', list: [1, 2] }

function failure<E extends Entities>(game: Game<E>, ticks = 1): string {
  try {
    simulate(game, { ticks })
  } catch (error) {
    assert.ok(error instanceof RunError, `expected a RunError, got ${error}`)
    return error.message
  }
  assert.fail('the run should have failed')
}

test('the same seed repeats a run exactly and another seed serves differently', () => {
  const run = (seed: number) => simulate(pong, { ticks: 600, seed, press: ['Space@1'], hold: ['Up@100-300'] })
  assert.deepEqual(run(0), run(0))
  const [first, other] = [run(0), run(1)].map((r) => pick(r.snapshots[0].entities, 'ball')[0])
  assert.notEqual(first.vy, other.vy)
})

test('assignments are checked where they happen, including inside arrays', () => {
  const entities = { ball, score: { value: 0 }, title: { text: 'HI' }, match: { state: oneOf(['ready', 'play']) } }
  const cases: Array<[string, (w: World<typeof entities>) => void, RegExp]> = [
    ['undeclared field', (w) => Reflect.set(w.ball, 'vxx', 1), /has no field "vxx"; declare it in entities/],
    ['size', (w) => (w.ball.w = -1), /w must be greater than 0, got -1/],
    ['NaN', (w) => (w.ball.x = Number.NaN), /x must be a finite number, got NaN/],
    ['type change', (w) => Reflect.set(w.ball, 'label', 3), /label started as a string/],
    ['array type change', (w) => Reflect.set(w.ball, 'list', 'x'), /list started as an array/],
    ['NaN pushed into an array', (w) => w.ball.list.push(Number.NaN), /list\[2\] must be a finite number, got NaN/],
    ['color', (w) => (w.ball.color = 'blurple'), /color must be a CSS color/],
    ['text on a shape', (w) => Reflect.set(w.ball, 'text', 'hi'), /is a shape, so it can't have text/],
    ['visuals on data', (w) => Reflect.set(w.score, 'color', 'red'), /has no shape or text, so it can't have color/],
    ['a character the font lacks', (w) => (w.title.text = 'café'), /text can't draw "é"/],
    ['a value outside oneOf', (w) => Reflect.set(w.match, 'state', 'paused'), /state must be one of "ready", "play", got "paused"/],
    ['the engine-owned name', (w) => Reflect.set(w.ball, 'name', 'other'), /name is set by the engine/],
    ['missing entity', (w) => void Reflect.get(w, 'bal'), /no entity named "bal"/],
  ]
  for (const [name, change, message] of cases) assert.match(failure(defineGame({ entities, update: change })), message, name)
  const [state] = simulate(defineGame({ entities, update: (w) => void w.ball.list.push(3) }), { ticks: 2 }).snapshots[0].entities
  assert.deepEqual(state.list, [1, 2, 3, 3])
})

test('game code can read neither the clock nor unseeded randomness, and the guards lift after each tick', () => {
  for (const [name, read] of [
    ['Math.random()', () => Math.random()],
    ['Date.now()', () => Date.now()],
    ['new Date()', () => new Date()],
    ['performance.now()', () => performance.now()],
    ['setTimeout()', () => setTimeout(() => {}, 0)],
  ] as const) {
    const game = defineGame({ entities: { ball }, update: () => void read() })
    assert.match(failure(game), new RegExp(`${name.replace(/[().]/g, '\\$&')} would make runs differ`))
  }
  assert.equal(typeof Math.random(), 'number')
  assert.equal(typeof Date.now(), 'number')
  assert.match(failure(defineGame({ entities: { ball }, update: async () => {} })), /must not be async/)
})

test('a held key is pressed on its first tick and released on the tick after it ends', () => {
  const seen: string[] = []
  const game = defineGame({
    entities: { ball },
    update(_, ctx) {
      if (ctx.input.pressed('Space')) seen.push(`pressed ${ctx.tick}`)
      if (ctx.input.released('Space')) seen.push(`released ${ctx.tick}`)
    },
  })
  simulate(game, { ticks: 10, hold: ['space@3-5'], press: ['SPACE@8'] })
  assert.deepEqual(seen, ['pressed 3', 'released 6', 'pressed 8', 'released 9'])
})

test('key schedules and overrides reject mistakes as usage errors', () => {
  const game = defineGame({ entities: { ball }, update() {} })
  for (const [options, message] of [
    [{ press: ['Space@20'] }, /tick 20 is after --ticks 10/],
    [{ hold: ['Up@9-3'] }, /span 9-3 ends before it starts/],
    [{ press: ['Spcae@2'] }, /unknown key "Spcae"/],
    [{ set: ['bal.x=1'] }, /no entity matches "bal"/],
    [{ set: ['ball.w=0'] }, /w must be greater than 0/],
    [{ press: ['Space@2'], drive: () => [] }, /a driver or --press and --hold, not both/],
  ] as const) {
    assert.throws(() => simulate(game, { ticks: 10, ...options }), (error: Error) => error instanceof UsageError && message.test(error.message))
  }
})

test('--set changes the starting state before start runs, and patterns reach group members', () => {
  let startX = Number.NaN
  const game = defineGame({
    entities: { ball, bricks: group(3, (i) => ({ x: i, y: 1, w: 0.2, h: 0.1 })) },
    start: (w) => void (startX = w.ball.x),
    update() {},
  })
  new Session(game, { set: ['ball.x=1.5', 'ball.label=hello'] }).start()
  assert.equal(startX, 1.5)
  const { entities } = simulate(game, { ticks: 0, set: ['ball.label=hello', 'bricks[*].visible=false', 'bricks[1].visible=true'] }).snapshots[0]
  assert.equal(entities[0].label, 'hello')
  assert.deepEqual(
    entities.slice(1).map((e) => e.visible),
    [false, true, false],
  )
})

test('groups and grids become typed arrays of named members, drawn in declaration order', () => {
  const names: string[] = []
  const game = defineGame({
    entities: {
      bricks: group(2, (i) => ({ x: i, y: 0, w: 0.2, h: 0.1, hits: 0 })),
      cells: grid(2, 3, ({ row, col }) => ({ x: col, y: row, w: 0.1, h: 0.1, filled: false })),
      ball,
    },
    update(w) {
      w.bricks[1].hits += 1
      w.cells[1][2].filled = true
      names.push(w.bricks[1].name, w.cells[1][2].name)
      assert.equal(Reflect.set(w.bricks, 0, w.ball), false)
    },
  })
  const { entities } = simulate(game, { ticks: 1 }).snapshots[0]
  assert.deepEqual(names, ['bricks[1]', 'cells[1][2]'])
  assert.deepEqual(
    entities.map((e) => e.name),
    ['bricks[0]', 'bricks[1]', 'cells[0][0]', 'cells[0][1]', 'cells[0][2]', 'cells[1][0]', 'cells[1][1]', 'cells[1][2]', 'ball'],
  )
  assert.equal(pick(entities, 'bricks')[1].hits, 1)
  assert.equal(pick(entities, 'cells[1][2]')[0].filled, true)
})

test('a driver picks keys from a read-only world with its own random numbers', () => {
  const game = defineGame({
    entities: { paddle: { x: 0, y: 0, w: 0.1, h: 0.5, rolls: [0] } },
    update(w, ctx) {
      if (ctx.input.held('Up')) w.paddle.y += 1
      w.paddle.rolls = [...w.paddle.rolls, ctx.random()]
    },
  })
  const driven = simulate(game, { ticks: 30, drive: ({ world, random }) => (random() < 2 && world.paddle.y < 10 ? ['Up'] : []) })
  assert.deepEqual(driven, simulate(game, { ticks: 30, hold: ['Up@1-10'] }))
  assert.throws(
    () => simulate(game, { ticks: 1, drive: ({ world }) => (Reflect.set(world.paddle, 'y', 5) ? [] : []) }),
    (error: Error) => error instanceof RunError && error.phase === 'driver' && /read-only here/.test(error.message),
  )
  assert.throws(() => simulate(game, { ticks: 1, drive: () => JSON.parse('["Esc"]') }), /unknown key "Esc"/)
})

test('defineDriver gives each run fresh driver memory, and clip drops keys after the last tick', () => {
  const game = defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1 } }, update: (w, ctx) => void (ctx.input.pressed('Space') && (w.ball.x += 1)) })
  const once = defineDriver(() => {
    let pressed = false
    return () => (pressed ? [] : ((pressed = true), ['Space']))
  })
  const [first, second] = [simulate(game, { ticks: 5, drive: once }), simulate(game, { ticks: 5, drive: once })]
  assert.deepEqual([first.world.ball.x, second.world.ball.x], [1, 1])
  assert.equal(simulate(game, { ticks: 5, press: ['Space@2,300'], clip: true }).world.ball.x, 1)
  assert.throws(() => simulate(game, { ticks: 5, press: ['Space@300'] }), /tick 300 is after --ticks 5/)
})

test('ctx.print records the tick with each log entry', () => {
  const game = defineGame({ entities: { ball }, update: (w, ctx) => ctx.tick % 2 === 0 && ctx.print('tick', ctx.tick, { at: w.ball.x }) })
  assert.deepEqual(simulate(game, { ticks: 4 }).logs, [
    { tick: 2, text: 'tick 2 {"at":0}' },
    { tick: 4, text: 'tick 4 {"at":0}' },
  ])
})

test('state lists x, y, and visible for drawn entities plus declared fields, and --only matches names', () => {
  const game = defineGame({
    entities: { ball, title: { text: 'HI' }, score: { value: 0 } },
    update(w) {
      w.ball.visible = false
    },
  })
  const { entities } = simulate(game, { ticks: 1 }).snapshots[0]
  assert.deepEqual(entities[0], { name: 'ball', ...ball, visible: false })
  assert.deepEqual(entities[1], { name: 'title', x: 0, y: 0, visible: true, text: 'HI' })
  assert.deepEqual(entities[2], { name: 'score', value: 0 })
  assert.deepEqual(
    pick(entities, 'b*,score').map((e) => e.name),
    ['ball', 'score'],
  )
  assert.throws(() => pick(entities, 'bal'), /--only "bal" matches no entity/)
})

test('a game module is checked where it is loaded', () => {
  for (const [value, message] of [
    [undefined, /must export default defineGame/],
    [{ entities: {} }, /needs an update/],
    [{ entities: {}, update() {}, background: 'blurple' }, /background must be a CSS color/],
  ] as const) {
    assert.throws(() => parseGame(value), message)
  }
})
