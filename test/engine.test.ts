import assert from 'node:assert/strict'
import { test } from 'node:test'
import pong from '../games/pong/game.ts'
import { parseGame, untilCondition } from '../src/engine.ts'
import { RunError, UsageError } from '../src/errors.ts'
import {
  Session,
  defineDriver,
  defineGame,
  grid,
  group,
  listOf,
  maybe,
  oneOf,
  pick,
  simulate,
  spawn,
  type Context,
  type Entities,
  type Game,
  type World,
} from '../src/index.ts'
import { PORTABLE } from '../src/math.ts'

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
    ['an endless angle', (w) => (w.ball.angle = Number.POSITIVE_INFINITY), /angle must be a finite number, got Infinity/],
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

test('listOf and maybe type a field from an example and check every change to it, down to the items', () => {
  const entities = {
    game: {
      cells: listOf([0, 0]),
      moves: listOf({ key: oneOf(['Up', 'Down']), at: 0 }, [{ key: 'Up', at: 1 }]),
      target: maybe({ x: 0, y: 0 }),
      names: listOf(''),
    },
  }
  type Board = World<typeof entities>['game']
  const cases: Array<[string, (game: Board) => void, RegExp]> = [
    // @ts-expect-error a pair has two numbers
    ['a short item', (game) => game.cells.push([1]), /cells\[0\] must be \[number, number\], got \[1\]/],
    // @ts-expect-error a pair holds numbers
    ['an item of the wrong kind', (game) => game.cells.push([1, 'a']), /cells\[0\]\[1\] must be a finite number, got "a"/],
    // @ts-expect-error key is one of the example's choices
    ['a value outside oneOf in an item', (game) => (game.moves[0].key = 'Left'), /moves\[0\]\.key must be one of "Up", "Down", got "Left"/],
    // @ts-expect-error an item has the example's keys
    ['an item missing a key', (game) => game.moves.push({ key: 'Up' }), /moves\[1\] must be \{ key: "Up" \| "Down"; at: number \}, got \{"key":"Up"\}/],
    // @ts-expect-error a maybe holds null or the example's shape
    ['a value unlike the example', (game) => (game.target = { x: 1 }), /target must be \{ x: number; y: number \} or null, got \{"x":1\}/],
    ['a key the example lacks', (game) => void ((game.target = { x: 1, y: 2 }), Reflect.set(game.target, 'z', 3)), /target has no key "z"/],
    ['a gap in a list', (game) => (game.names.length = 2), /names grows only by adding items/],
  ]
  for (const [name, change, message] of cases) assert.match(failure(defineGame({ entities, update: (w) => change(w.game) })), message, name)
  // @ts-expect-error a list's example can't hold null
  assert.throws(() => new Session(defineGame({ entities: { a: { list: listOf({ hp: null }) } }, update() {} })), /list: example\.hp can't be null; use maybe/)

  const game = defineGame({
    entities,
    update({ game }) {
      game.cells.push([1, 2], [3, 4])
      game.cells.splice(0, 1)
      game.moves[0].at += 1
      game.target = { x: 1, y: 2 }
      game.target.y = 5
      const [x]: [number, number] = game.cells[0]
      const key: 'Up' | 'Down' = game.moves[0].key
      game.names.push(key, String(x))
    },
  })
  const session = new Session(game)
  // @ts-expect-error target is null until something sets it
  assert.throws(() => session.world.game.target.x, TypeError)
  const [state] = simulate(game, { ticks: 1 }).snapshots[0].entities
  assert.deepEqual(state, { name: 'game', cells: [[3, 4]], moves: [{ key: 'Up', at: 2 }], target: { x: 1, y: 5 }, names: ['Up', '3'] })
  assert.throws(() => simulate(game, { ticks: 0, set: ['game.cells=[[1]]'] }), /--set "game\.cells=\[\[1\]\]": .*cells\[0\] must be \[number, number\]/)
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

test('Mouse and MouseRight are keys, and the pointer moves on the ticks --pointer names, staying there until the next move', () => {
  const seen: string[] = []
  const game = defineGame({
    entities: { ball },
    start: (_, ctx) => void seen.push(`start ${ctx.input.pointer.x},${ctx.input.pointer.y}`),
    update(_, ctx) {
      const { x, y } = ctx.input.pointer
      seen.push(`${ctx.tick} ${x},${y}${ctx.input.pressed('Mouse') ? ' click' : ''}${ctx.input.held('MouseRight') ? ' right' : ''}`)
    },
  })
  simulate(game, { ticks: 5, press: ['mouse@2'], hold: ['MouseRight@4-'], pointer: ['0.5,-0.25@3', '-2,1.5@5'] })
  simulate(game, { ticks: 1, pointer: ['1, 1'] })
  assert.deepEqual(seen, ['start 0,0', '1 0,0', '2 0,0 click', '3 0.5,-0.25', '4 0.5,-0.25 right', '5 -2,1.5 right', 'start 0,0', '1 1,1'])
  // @ts-expect-error the pointer is read-only
  assert.match(failure(defineGame({ entities: { ball }, update: (_, ctx) => void (ctx.input.pointer.x = 1) })), /read only property 'x'/)
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
    [{ press: ['Space@2'], drive: () => [] }, /a driver or --press, --hold, and --pointer, not both/],
    [{ pointer: ['2.5,0@2'] }, /--pointer "2\.5,0@2": the pointer stays on the screen, with x from -2 to 2 and y from -1\.5 to 1\.5/],
    [{ pointer: ['0.5@2'] }, /--pointer "0\.5@2" should look like X,Y@T in world units, like 0\.5,-0\.2@30/],
    [{ pointer: ['0,0@20'] }, /--pointer "0,0@20": tick 20 is after --ticks 10/],
    [{ pointer: ['0,0@3', '1,1@3'] }, /another --pointer already moves it on tick 3/],
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

test('parts draw right after their entity, at its position, hidden with it, and are named by their path', () => {
  const game = defineGame({
    entities: {
      ship: { x: 1, y: 0, w: 0.25, h: 0.125, parts: { wing: { x: -0.25, w: 0.125, h: 0.0625, turns: 0 }, label: { y: 0.25, text: 'A', opacity: 0.5 } } },
      base: { x: 0, y: -1, parts: [{ w: 0.5, h: 0.5 }, { x: 0.5, w: 0.5, h: 0.5 }] },
      after: { w: 1, h: 1 },
    },
    update({ ship, base }, ctx) {
      ship.x += 0.5
      ship.parts.wing.turns += 1
      base.parts[1].y = 0.25
      ship.visible = ctx.tick === 1
    },
  })
  const session = new Session(game)
  session.start()
  session.step([])
  assert.deepEqual(session.state(), [
    { name: 'ship', x: 1.5, y: 0, visible: true, w: 0.25, h: 0.125 },
    { name: 'ship.parts.wing', x: -0.25, y: 0, visible: true, w: 0.125, h: 0.0625, turns: 1 },
    { name: 'ship.parts.label', x: 0, y: 0.25, visible: true, text: 'A', opacity: 0.5 },
    { name: 'base', x: 0, y: -1, visible: true },
    { name: 'base.parts[0]', x: 0, y: 0, visible: true, w: 0.5, h: 0.5 },
    { name: 'base.parts[1]', x: 0.5, y: 0.25, visible: true, w: 0.5, h: 0.5 },
    { name: 'after', x: 0, y: 0, visible: true, w: 1, h: 1 },
  ])
  const placed = () => session.drawables().map(({ name, order, x, y, visible, opacity }) => ({ name, order, x, y, visible, opacity }))
  assert.deepEqual(placed().slice(0, 5), [
    { name: 'ship', order: 0, x: 1.5, y: 0, visible: true, opacity: 1 },
    { name: 'ship.parts.wing', order: 1, x: 1.25, y: 0, visible: true, opacity: 1 },
    { name: 'ship.parts.label', order: 2, x: 1.5, y: 0.25, visible: true, opacity: 0.5 },
    { name: 'base.parts[0]', order: 4, x: 0, y: -1, visible: true, opacity: 1 },
    { name: 'base.parts[1]', order: 5, x: 0.5, y: -0.75, visible: true, opacity: 1 },
  ])
  session.step([])
  assert.deepEqual(
    placed().map((d) => d.visible),
    [false, false, false, true, true, true],
  )
  const turns: number = session.world.ship.parts.wing.turns
  assert.equal(turns, 2)
  // @ts-expect-error named parts are typed by their names
  assert.throws(() => session.world.ship.parts.tail, /entity "ship" has no part "tail"/)
})

test('parts are declared and changed with the checks entities have, and patterns reach them by name', () => {
  const declare = (entities: Entities) => () => new Session(defineGame({ entities, update() {} }))
  assert.throws(declare({ a: { parts: { b: { x: 1 } } } }), /entity "a\.parts\.b" has no shape or text/)
  // @ts-expect-error parts can't have parts
  assert.throws(declare({ a: { parts: { b: { w: 1, parts: {} } } } }), /entity "a\.parts\.b": parts can't have parts/)
  // @ts-expect-error parts is an object of named parts or an array of parts
  assert.throws(declare({ a: { parts: 3 } }), /entity "a": parts must be an object of named parts or an array of parts, got 3/)

  const entities = {
    ship: { x: 1, y: 0, w: 0.25, h: 0.125, parts: { wing: { x: -0.25, w: 0.125, h: 0.0625 }, label: { y: 0.25, text: 'A' } } },
    cells: group(2, (i) => ({ x: i, hits: 0, parts: [{ w: 0.5, h: 0.5 }] })),
  }
  const cases: Array<[string, (w: World<typeof entities>) => void, RegExp]> = [
    ['a bad size on a part', (w) => (w.ship.parts.wing.w = -1), /entity "ship\.parts\.wing": w must be greater than 0, got -1/],
    // @ts-expect-error parts is read-only
    ['replacing parts', (w) => (w.ship.parts = w.ship.parts), /entity "ship": parts can't be replaced/],
    // @ts-expect-error each part is read-only
    ['replacing a part', (w) => (w.ship.parts.wing = w.ship.parts.wing), /can't replace part "ship\.parts\.wing"/],
  ]
  for (const [name, change, message] of cases) assert.match(failure(defineGame({ entities, update: change })), message, name)

  const game = defineGame({ entities, update() {} })
  const { entities: state } = simulate(game, { ticks: 0, set: ['ship.x=0.5', 'ship.parts.*.y=0.5', 'cells[*].x=3', 'cells.hits=2'] }).snapshots[0]
  assert.deepEqual(
    state.map(({ name, x, y }) => [name, x, y]),
    [
      ['ship', 0.5, 0],
      ['ship.parts.wing', -0.25, 0.5],
      ['ship.parts.label', 0, 0.5],
      ['cells[0]', 3, 0],
      ['cells[0].parts[0]', 0, 0],
      ['cells[1]', 3, 0],
      ['cells[1].parts[0]', 0, 0],
    ],
  )
  assert.deepEqual(
    pick(state, 'ship.parts.label,cells').map((e) => e.name),
    ['ship.parts.label', 'cells[0]', 'cells[0].parts[0]', 'cells[1]', 'cells[1].parts[0]'],
  )
  assert.equal(pick(state, 'cells[1]')[0].hits, 2)
})

test('a part sits at its offset turned by its entity\'s angle, which adds to its own, with the portable sin and cos', () => {
  const game = defineGame({
    entities: {
      ship: { x: 1, y: 0.5, angle: 0.75, parts: { wing: { x: 0.25, y: -0.1, w: 0.1, h: 0.05, angle: 0.5 }, label: { x: -0.2, text: 'A' } } },
      rock: { w: 0.5, h: 0.5, angle: -1 },
    },
    update: ({ ship }) => void (ship.angle += 1),
  })
  const session = new Session(game)
  session.start()
  const placed = () => session.drawables().map(({ name, x, y, angle }) => ({ name, x, y, angle }))
  const turned = (angle: number, dx: number, dy: number) => ({
    x: 1 + PORTABLE.cos(angle) * dx - PORTABLE.sin(angle) * dy,
    y: 0.5 + PORTABLE.sin(angle) * dx + PORTABLE.cos(angle) * dy,
  })
  assert.deepEqual(placed(), [
    { name: 'ship.parts.wing', ...turned(0.75, 0.25, -0.1), angle: 1.25 },
    { name: 'ship.parts.label', ...turned(0.75, -0.2, 0), angle: 0.75 },
    { name: 'rock', x: 0, y: 0, angle: -1 },
  ])
  session.step([])
  assert.deepEqual(placed()[0], { name: 'ship.parts.wing', ...turned(1.75, 0.25, -0.1), angle: 2.25 })
  assert.deepEqual(session.state()[0], { name: 'ship', x: 1, y: 0.5, visible: true, angle: 1.75 })
})

test('an image names an image file in the game\'s folder, checked where it\'s declared or assigned, and "" draws none', () => {
  const assets = ['boom.wav', 'rock.svg', 'ship.png']
  const entities = { rock: { w: 0.5, h: 0.5, image: 'rock.svg' }, blank: { image: '' } }
  const session = new Session(defineGame({ entities, update: ({ rock }) => void (rock.image = 'ship.png') }), { assets })
  session.start()
  session.step([])
  assert.deepEqual(
    session.drawables().map((drawable) => (drawable.kind === 'shape' ? [drawable.name, drawable.w, drawable.image] : [])),
    [
      ['rock', 0.5, 'ship.png'],
      ['blank', 1, ''],
    ],
  )
  const assigning = (image: string) => () => simulate(defineGame({ entities, update: ({ rock }) => void (rock.image = image) }), { ticks: 1, assets })
  assert.throws(assigning('rok.svg'), /entity "rock": no image "rok\.svg" in the game's folder, which has rock\.svg, ship\.png$/)
  assert.throws(assigning('boom.wav'), /image "boom\.wav" isn't an image file; images are \.png, \.jpg, \.jpeg, \.webp, \.gif, or \.svg files/)
  const declaring = (image: string, files?: string[]) => () => new Session(defineGame({ entities: { rock: { image } }, update() {} }), { assets: files })
  assert.throws(declaring('rok.svg', assets), /entity "rock": no image "rok\.svg"/)
  assert.throws(declaring('rok.svg', []), /which has no image files/)
  // A test that imports a game has no folder to check against, so only the file type counts.
  assert.doesNotThrow(declaring('anything.gif'))
  assert.throws(declaring('rock'), /image "rock" isn't an image file/)
  assert.throws(() => simulate(defineGame({ entities, update() {} }), { ticks: 0, set: ['rock.image=gone.png'], assets }), UsageError)
})

test('spawn resets the first hidden member of a group to its starting values, parts too, then sets fields and shows it, or returns undefined', () => {
  const entities = {
    bullets: group(2, () => ({ w: 0.1, h: 0.1, visible: false, speed: 1, trail: listOf(0), parts: { glow: { w: 0.2, h: 0.2, opacity: 0.5 } } })),
  }
  type Bullet = World<typeof entities>['bullets'][number]
  const spawned: Array<string | undefined> = []
  const game = defineGame({
    entities,
    update({ bullets }, ctx) {
      if (ctx.tick === 1) {
        const first: Bullet | undefined = spawn(bullets, { x: 1, speed: 3 })
        first?.trail.push(1)
        if (first) first.parts.glow.opacity = 1
      }
      if (ctx.tick === 2) {
        bullets[0].visible = false
        spawned.push(spawn(bullets, { y: 2 })?.name, spawn(bullets)?.name, spawn(bullets)?.name)
      }
    },
  })
  const { snapshots } = simulate(game, { ticks: 2, set: ['bullets[*].speed=2'] })
  assert.deepEqual(spawned, ['bullets[0]', 'bullets[1]', undefined])
  const glow = { x: 0, y: 0, visible: true, w: 0.2, h: 0.2, opacity: 0.5 }
  assert.deepEqual(pick(snapshots[0].entities, 'bullets'), [
    { name: 'bullets[0]', x: 0, y: 2, visible: true, w: 0.1, h: 0.1, speed: 2, trail: [] },
    { name: 'bullets[0].parts.glow', ...glow },
    { name: 'bullets[1]', x: 0, y: 0, visible: true, w: 0.1, h: 0.1, speed: 2, trail: [] },
    { name: 'bullets[1].parts.glow', ...glow },
  ])
  // @ts-expect-error spawn sets the members' own fields, with their types
  assert.match(failure(defineGame({ entities, update: ({ bullets }) => void spawn(bullets, { speed: 'fast' }) })), /speed started as a number, so it can't become "fast"/)
  assert.throws(
    () => simulate(game, { ticks: 1, drive: ({ world }) => (spawn(world.bullets) ? [] : []) }),
    (error: Error) => error instanceof RunError && error.phase === 'driver' && /entity "bullets\[0\]" is read-only here/.test(error.message),
  )
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

test('a driver sees the keys held on the tick before, so a plain function can tap a key', () => {
  const game = defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1 } }, update: (w, ctx) => void (ctx.input.pressed('Space') && (w.ball.x += 1)) })
  const seen: string[] = []
  const { world } = simulate(game, {
    ticks: 6,
    drive: ({ keys, tick }) => {
      seen.push(`${tick}:${keys.join('+')}`)
      return keys.includes('Space') ? ['Up'] : ['Space', 'Space']
    },
  })
  assert.deepEqual(seen, ['1:', '2:Space', '3:Up', '4:Space', '5:Up', '6:Space'])
  assert.equal(world.ball.x, 3)
})

test('a driver moves the pointer by returning { keys, pointer }, sees where it was the tick before, and Session.step takes the same', () => {
  const game = defineGame({
    entities: { dot: { w: 0.1, h: 0.1 } },
    update({ dot }, ctx) {
      if (!ctx.input.held('Mouse')) return
      dot.x = ctx.input.pointer.x
      dot.y = ctx.input.pointer.y
    },
  })
  const seen: string[] = []
  const { world } = simulate(game, {
    ticks: 3,
    drive: ({ tick, pointer }) => {
      seen.push(`${tick}:${pointer.x},${pointer.y}`)
      return tick === 1 ? { pointer: { x: 1, y: -1 } } : { keys: ['Mouse'] }
    },
  })
  assert.deepEqual(seen, ['1:0,0', '2:1,-1', '3:1,-1'])
  assert.deepEqual([world.dot.x, world.dot.y], [1, -1])
  const session = new Session(game)
  session.start()
  session.step({ keys: ['Mouse'], pointer: { x: -0.5, y: 0.5 } })
  assert.deepEqual([session.world.dot.x, session.world.dot.y], [-0.5, 0.5])
  for (const [returned, message] of [
    [{ pointer: { x: 3, y: 0 } }, /the pointer must be \{ x, y \} on the screen, with x from -2 to 2 and y from -1\.5 to 1\.5, got \{"x":3,"y":0\}/],
    ['Space', /the keys must be a list, like \["Space"\], not the string "Space"/],
  ] as const) {
    assert.throws(
      () => simulate(game, { ticks: 1, drive: () => JSON.parse(JSON.stringify(returned)) }),
      (error: Error) => error instanceof RunError && error.phase === 'driver' && message.test(error.message),
    )
  }
})

test('until stops a run after the first tick it holds, and the result says whether it did', () => {
  const game = defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1 } }, update: (w) => void (w.ball.x += 1) })
  const early = simulate(game, { ticks: 100, every: 2, until: ({ world, tick }) => world.ball.x === 3 && tick === 3 })
  assert.deepEqual([early.tick, early.reached, early.world.ball.x], [3, true, 3])
  assert.deepEqual(
    early.snapshots.map((s) => s.tick),
    [0, 2, 3],
  )
  const late = simulate(game, { ticks: 5, until: ({ world }) => world.ball.x < 0 })
  assert.deepEqual([late.tick, late.reached, late.snapshots.map((s) => s.tick)], [5, false, [5]])
})

test('--until compares a field of any entity its pattern matches, and rejects conditions it can\'t check', () => {
  const game = defineGame({
    entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, label: 'a', pair: [0, 0] }, bricks: group(3, (i) => ({ x: i, hits: 0 })) },
    update(w, ctx) {
      w.ball.x += 1
      w.ball.pair = [ctx.tick, 0]
      if (ctx.tick === 4) w.bricks[2].hits = 1
      if (ctx.tick === 5) w.ball.label = 'b'
    },
  })
  const stop = (condition: string) => {
    const { tick, reached } = simulate(game, { ticks: 10, until: untilCondition(condition) })
    return reached ? tick : 'never'
  }
  assert.deepEqual(
    ['ball.x>=3', 'ball.x>2.5', 'ball.x<=1', 'ball.x<1', 'ball.label=b', 'ball.label!=a', 'ball.pair=[6,0]', 'bricks.hits=1', 'bricks[*].x=2'].map(stop),
    [3, 3, 1, 'never', 5, 5, 6, 4, 1],
  )
  for (const [condition, message] of [
    ['ball.x', /should look like NAME\.FIELD=VALUE/],
    ['ball.x<abc', /< compares numbers, and "abc" isn't one/],
    ['bal.x=1', /no entity matches "bal"/],
    ['bricks.label=a', /entity "bricks\[0\]" has no field "label"/],
  ] as const) {
    assert.throws(() => stop(condition), (error: Error) => error instanceof UsageError && message.test(error.message), condition)
  }
})

test('ctx.print records the tick with each log entry', () => {
  const game = defineGame({ entities: { ball }, update: (w, ctx) => ctx.tick % 2 === 0 && ctx.print('tick', ctx.tick, { at: w.ball.x }) })
  assert.deepEqual(simulate(game, { ticks: 4 }).logs, [
    { tick: 2, text: 'tick 2 {"at":0}' },
    { tick: 4, text: 'tick 4 {"at":0}' },
  ])
})

test('ctx.play records each sound with its tick, volume, and pitch, and an unknown sound or a bad option fails at the call', () => {
  const assets = ['laser.wav', 'rock.svg']
  const game = defineGame({
    entities: { ball },
    update(_, ctx) {
      if (ctx.tick === 1) ctx.play('coin')
      if (ctx.tick === 2) ctx.play('laser.wav', { volume: 0.25, pitch: 1.5 })
    },
  })
  assert.deepEqual(simulate(game, { ticks: 3, assets }).sounds, [
    { tick: 1, name: 'coin', volume: 1, pitch: 1 },
    { tick: 2, name: 'laser.wav', volume: 0.25, pitch: 1.5 },
  ])
  const playing = (...args: Parameters<Context['play']>) => failure(defineGame({ entities: { ball }, update: (_, ctx) => ctx.play(...args) }))
  // @ts-expect-error a misspelled built-in sound fails check
  assert.match(playing('explod'), /unknown sound "explod"; play a built-in sound \(blip, coin, explode, hit, jump, lose, score, shoot\) or a \.wav, \.mp3, or \.ogg file/)
  assert.match(playing('coin', { volume: 2 }), /volume must be from 0 to 1, got 2/)
  assert.match(playing('coin', { pitch: 0 }), /pitch must be a finite number greater than 0, got 0/)
  // @ts-expect-error ctx.play's options are volume and pitch
  assert.match(playing('coin', { speed: 2 }), /ctx\.play has no option "speed"; its options are volume and pitch/)
  const missing = defineGame({ entities: { ball }, update: (_, ctx) => ctx.play('pew.wav') })
  assert.throws(() => simulate(missing, { ticks: 1, assets }), /no sound "pew\.wav" in the game's folder, which has laser\.wav$/)
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
