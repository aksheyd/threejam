import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, simulate, type EntitiesOf, type EntityState, type SimOptions } from 'threejam'
import autopilot from './autopilot.ts'
import asteroids from './game.ts'

// Runs once and returns the chosen entities by name after any tick, with the sounds and the log.
function play(options: SimOptions<EntitiesOf<typeof asteroids>>) {
  const { snapshots, sounds, logs } = simulate(asteroids, { ...options, every: 1 })
  const at = (tick: number, only: string): Record<string, EntityState> =>
    Object.fromEntries(pick(snapshots[tick].entities, only).map((e) => [e.name, e]))
  return { at, sounds, logs }
}

function close(actual: unknown, expected: number): void {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} should be ${expected}`)
}

test('Left and Right turn the ship, Up thrusts it with its flame showing, and it wraps from the top edge to the bottom', () => {
  const turned = play({ ticks: 46, press: ['Space@1'], hold: ['Left@2-31', 'D@32-46'] })
  close(turned.at(31, 'ship').ship.angle, 2)
  close(turned.at(46, 'ship').ship.angle, 1)

  const flying = play({ ticks: 77, press: ['Space@1'], hold: ['Up@2-76'] })
  const [before, after] = [flying.at(74, 'ship').ship, flying.at(75, 'ship').ship]
  assert.deepEqual([after.x, after.vy], [0, 2.2])
  close(after.y, Number(before.y) + 2.2 / 60 - 3.2)
  const flame = (tick: number) => flying.at(tick, 'ship.parts.flame')['ship.parts.flame'].visible
  assert.deepEqual([flame(1), flame(2), flame(76), flame(77)], [false, true, true, false])
})

test('each shot takes the first hidden bullet from the pool with a sound, and a full pool waits for a bullet to expire', () => {
  const { at, sounds } = play({ ticks: 21, press: ['Space@1'], hold: ['Space@10-20'], set: ['ship.bullet_ticks=10', 'ship.fire_ticks=1'] })
  assert.deepEqual(
    sounds.map(({ tick, name, volume }) => [tick, name, volume]),
    [10, 11, 12, 13, 20].map((tick) => [tick, 'shoot', 0.5]),
  )
  const { x, y, vx, vy, age } = at(10, 'bullets[0]')['bullets[0]']
  assert.deepEqual({ x, y, vx, vy, age }, { x: 0, y: 0.1, vx: 0, vy: 3.2, age: 0 })
  const ages = (tick: number) => Object.values(at(tick, 'bullets')).map((bullet) => (bullet.visible === false ? '-' : bullet.age))
  assert.deepEqual([ages(19), ages(20), ages(21)], [[9, 8, 7, 6], [0, 9, 8, 7], [1, '-', 9, 8]])
})

test('a bullet breaks a big rock into two medium ones and a medium one into two small ones, and each scores with an explosion pitched by its size', () => {
  const { snapshots, sounds } = simulate(asteroids, { ticks: 600, drive: autopilot, every: 1 })
  const tally = (tick: number) => {
    const rocks = pick(snapshots[tick].entities, 'rocks').filter((rock) => rock.visible !== false)
    const count = (kind: string) => rocks.filter((rock) => rock.kind === kind).length
    return [count('big'), count('medium'), count('small'), Number(pick(snapshots[tick].entities, 'game')[0].score)]
  }
  for (const [pitch, change] of [
    [0.6, [-1, 2, 0, 20]],
    [1, [0, -1, 2, 50]],
    [1.6, [0, 0, -1, 100]],
  ] as const) {
    const { tick } = sounds.filter((sound) => sound.name === 'explode' && sound.pitch === pitch)[0]
    const [was, now] = [tally(tick - 1), tally(tick)]
    assert.deepEqual(
      now.map((n, i) => n - was[i]),
      change,
      `the first explosion at pitch ${pitch}, on tick ${tick}`,
    )
  }
  const halves = pick(snapshots[25].entities, 'rocks').filter((rock) => rock.visible !== false && rock.kind === 'medium')
  assert.deepEqual([halves.length, halves[0].x, halves[0].y], [2, halves[1].x, halves[1].y])
  assert.notDeepEqual([halves[0].vx, halves[0].vy], [halves[1].vx, halves[1].vy])
})

test('a rock that reaches the ship costs a life with a sound, and a new ship comes back to the middle 90 ticks later, blinking while it can\'t be hit', () => {
  const { at, sounds, logs } = play({ ticks: 594, press: ['Space@1'] })
  assert.deepEqual(logs.at(-1), { tick: 497, text: 'the ship hit rocks[3], 2 lives left' })
  assert.deepEqual(
    sounds.filter((sound) => sound.tick === 497).map((sound) => sound.name),
    ['explode', 'lose'],
  )
  const hit = at(497, 'ship,game,lives')
  assert.deepEqual([hit.ship.visible, hit.game.state, hit.lives.text], [false, 'dead', 'LIVES 2'])
  assert.equal(at(586, 'game').game.state, 'dead')
  const { ship, game } = at(587, 'ship,game')
  assert.deepEqual([game.state, ship.x, ship.y, ship.safe], ['play', 0, 0, 120])
  assert.deepEqual([588, 593, 594].map((tick) => at(tick, 'ship').ship.visible), [true, true, false])
})

test('losing the last life ends the game, and Space plays again only once the prompt shows', () => {
  const set = ['game.start_lives=1']
  const early = play({ ticks: 557, press: ['Space@1,530,557'], set })
  const over = early.at(497, 'game,message,prompt')
  assert.deepEqual([over.game.state, over.message.text, over.prompt.text], ['over', 'GAME OVER', ''])
  assert.deepEqual(early.logs.at(-1), { tick: 497, text: 'GAME OVER with 20 points' })
  const ignored = early.at(557, 'game,prompt')
  assert.deepEqual([early.at(556, 'prompt').prompt.text, ignored.prompt.text, ignored.game.state], ['', 'PRESS SPACE OR CLICK TO PLAY AGAIN', 'over'])

  const again = play({ ticks: 558, press: ['Space@1,558'], set })
  const { game, rocks } = { game: again.at(558, 'game').game, rocks: Object.values(again.at(558, 'rocks')) }
  assert.deepEqual([game.state, game.score, game.lives, game.wave], ['play', 0, 1, 1])
  assert.deepEqual(rocks.filter((rock) => rock.visible !== false).map((rock) => rock.kind), ['big', 'big', 'big', 'big'])
  assert.deepEqual(again.logs.slice(-2), [
    { tick: 558, text: 'wave 1 brings 4 big rocks' },
    { tick: 558, text: 'a new game with 1 life' },
  ])
})

test('holding the mouse turns the ship toward the pointer the short way round and fires at it, and the right button thrusts', () => {
  const { at } = play({ ticks: 67, press: ['Space@1'], hold: ['Mouse@2-67', 'MouseRight@66-67'], pointer: ['-1,0@2', '1,-1@30'] })
  const angle = (tick: number) => Number(at(tick, 'ship').ship.angle)
  assert.ok(angle(24) < Math.PI / 2)
  assert.deepEqual([angle(25), angle(29)], [Math.PI / 2, Math.PI / 2])
  const { x, vx } = at(29, 'bullets[3]')['bullets[3]']
  assert.deepEqual([x, vx], [-0.1, -3.2])

  assert.ok(angle(40) > angle(30) && angle(63) < 0, 'turning left, through a half turn, is the short way to the pointer at (1, -1)')
  assert.equal(angle(65), (-3 * Math.PI) / 4)
  const moving = at(67, 'ship,ship.parts.flame')
  assert.ok(Number(moving.ship.vx) > 0 && Number(moving.ship.vy) < 0 && moving['ship.parts.flame'].visible === true)
})
