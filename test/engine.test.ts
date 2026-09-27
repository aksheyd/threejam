import assert from 'node:assert/strict'
import { test } from 'node:test'
import pong from '../games/pong/game.ts'
import { RunError, UsageError } from '../src/errors.ts'
import { Session, defineGame, pick, simulate, type Game } from '../src/index.ts'

const ball = { x: 0, y: 0, w: 0.1, h: 0.1, vx: 1, label: 'b' }

function failure(game: Game, ticks = 1): string {
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

test('assignments are checked where they happen', () => {
  const cases: Array<[string, (w: Record<string, Record<string, unknown>>) => void, RegExp]> = [
    ['undeclared field', (w) => (w.ball.vxx = 1), /has no field "vxx"; declare it in entities/],
    ['size', (w) => (w.ball.w = -1), /w must be greater than 0, got -1/],
    ['NaN', (w) => (w.ball.x = Number.NaN), /x must be a finite number, got NaN/],
    ['type change', (w) => (w.ball.label = 3), /label started as a string/],
    ['color', (w) => (w.ball.color = 'blurple'), /color must be a CSS color/],
    ['text on a shape', (w) => (w.ball.text = 'hi'), /is a shape, so it can't have text/],
    ['visuals on data', (w) => (w.score.color = 'red'), /has no shape or text, so it can't have color/],
    ['missing entity', (w) => void w.bal, /no entity named "bal"/],
  ]
  for (const [name, change, message] of cases) {
    const game = { entities: { ball: { ...ball }, score: { value: 0 } }, update: change } as unknown as Game
    assert.match(failure(game), message, name)
  }
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
  const later = defineGame({ entities: { ball }, update: (async () => {}) as unknown as Game['update'] })
  assert.match(failure(later), /must not be async/)
})

test('a held key is pressed on its first tick and released on the tick after it ends', () => {
  const seen: string[] = []
  const game = defineGame({
    entities: { ball },
    update(_, ctx) {
      if (ctx.input.pressed('space')) seen.push(`pressed ${ctx.tick}`)
      if (ctx.input.released('Space')) seen.push(`released ${ctx.tick}`)
    },
  })
  simulate(game, { ticks: 10, hold: ['Space@3-5'], press: ['Space@8'] })
  assert.deepEqual(seen, ['pressed 3', 'released 6', 'pressed 8', 'released 9'])
})

test('key schedules and overrides reject mistakes as usage errors', () => {
  const game = defineGame({ entities: { ball }, update() {} })
  for (const [options, message] of [
    [{ press: ['Space@20'] }, /tick 20 is after --ticks 10/],
    [{ hold: ['Up@9-3'] }, /span 9-3 ends before it starts/],
    [{ press: ['Spcae@2'] }, /unknown key "Spcae"/],
    [{ set: ['bal.x=1'] }, /no entity named "bal"/],
    [{ set: ['ball.w=0'] }, /w must be greater than 0/],
  ] as const) {
    assert.throws(() => simulate(game, { ticks: 10, ...options }), (error: Error) => error instanceof UsageError && message.test(error.message))
  }
})

test('--set changes the starting state before start runs', () => {
  let startX = Number.NaN
  const game = defineGame({ entities: { ball }, start: (w) => void (startX = w.ball.x), update() {} })
  new Session(game, { set: ['ball.x=1.5', 'ball.label=hello'] }).start()
  assert.equal(startX, 1.5)
  const [state] = simulate(game, { ticks: 0, set: ['ball.label=hello'] }).snapshots[0].entities
  assert.equal(state.label, 'hello')
})

test('state lists declared fields and engine fields that changed, and --only matches names', () => {
  const game = defineGame({
    entities: { ball, title: { text: 'HI' }, score: { value: 0 } },
    update(w) {
      w.ball.visible = false
    },
  })
  const { entities } = simulate(game, { ticks: 1 }).snapshots[0]
  assert.deepEqual(entities[0], { name: 'ball', ...ball, visible: false })
  assert.deepEqual(entities[1], { name: 'title', text: 'HI' })
  assert.deepEqual(
    pick(entities, 'b*,score').map((e) => e.name),
    ['ball', 'score'],
  )
  assert.throws(() => pick(entities, 'bal'), /--only "bal" matches no entity/)
})
