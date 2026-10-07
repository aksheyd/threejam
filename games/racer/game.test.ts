import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, pick, simulate, type EntitiesOf, type EntityState, type SimOptions } from 'threejam'
import autopilot from './autopilot.ts'
import racer from './game.ts'
import { KINDS, LANES, LENGTHS } from './road.ts'

// Runs once and returns the chosen entities by name after any tick, with the sounds and the log.
function play(options: SimOptions<EntitiesOf<typeof racer>>) {
  const { snapshots, sounds, logs } = simulate(racer, { ...options, every: 1 })
  const at = (tick: number, only: string): Record<string, EntityState> =>
    Object.fromEntries(pick(snapshots[tick].entities, only).map((e) => [e.name, e]))
  return { at, sounds: sounds.map(({ tick, name }) => `${name}@${tick}`), logs: logs.map(({ tick, text }) => `[tick ${tick}] ${text}`) }
}

function close(actual: unknown, expected: number): void {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} should be ${expected}`)
}

// A race already under way with no rows of traffic coming, so a test can place its own cars and coins.
const UNDER_WAY = ['race.state=play', 'race.first_row=1000']
const raced = ({ world }: { world: { race: { state: string } } }) => world.race.state === 'won' || world.race.state === 'lost'

test('nothing moves until Space starts the race, then the car speeds up by accel to its top speed while the clock counts down from 60', () => {
  const idle = play({ ticks: 60, hold: ['Left@1-60', 'Right@1-60'] }).at(60, 'car,race,traffic,time,distance_left,speedometer,message,panel')
  assert.deepEqual([idle.race.state, idle.car.x, idle.car.speed, idle.race.distance, idle.race.clock], ['ready', 0, 0, 0, 3600])
  assert.ok(Object.values(idle).filter((e) => e.name.startsWith('traffic')).every((other) => other.visible === false))
  assert.deepEqual([idle.time.text, idle.distance_left.text, idle.speedometer.text, idle.message.text, idle.panel.visible], ['TIME 60', '3.2 KM TO GO', '0 KM/H', 'RACER', true])

  const { at, logs } = play({ ticks: 300, press: ['Space@1'], set: ['race.first_row=1000'] })
  assert.deepEqual(logs, ['[tick 1] the race starts with 60 seconds on the clock'])
  close(at(60, 'car').car.speed, 1.8)
  assert.deepEqual([Number(at(199, 'car').car.speed) < 6, at(200, 'car').car.speed, at(300, 'car').car.speed], [true, 6, 6])
  // 0.03 more a tick for 200 ticks, then 6 a second for 100.
  const done = at(300, 'race,time,distance_left,speedometer,message,panel')
  close(done.race.distance, (0.03 * 200 * 201) / 2 / 60 + 10)
  assert.deepEqual([done.race.clock, done.time.text, done.distance_left.text, done.speedometer.text, done.message.text, done.panel.visible], [3301, 'TIME 56', '3.0 KM TO GO', '216 KM/H', '', false])
})

test('Left and Right turn the wheel over in 5 ticks and back in 5 when let go, and the road edges stop the car', () => {
  const { at } = play({ ticks: 90, press: ['Space@1'], hold: ['Right@2-11', 'Left@30-90'], set: ['race.first_row=1000'] })
  close(at(6, 'car').car.steer, 1)
  // The wheel's 0.2, 0.4, 0.6, 0.8, then 1 for six ticks and back down, each a tick of steer_speed's 0.04.
  close(at(11, 'car').car.x, 0.04 * 8)
  close(at(16, 'car').car.x, 0.04 * 10)
  close(at(16, 'car').car.steer, 0)
  close(at(90, 'car').car.x, -(0.9 - 0.3 / 2))
})

test("a car run into spins the racer out for a second at the traffic's speed, with the wheel doing nothing, and slides off the road braking, pushing off it a car it slides into", () => {
  const driving = (index: number, x: number) => [`traffic[${index}].visible=true`, `traffic[${index}].x=${x}`, `traffic[${index}].y=3`, `traffic[${index}].speed=2.5`]
  const { at, sounds, logs } = play({ ticks: 300, set: [...UNDER_WAY, ...driving(0, 0), ...driving(1, 0.6)], hold: ['Right@234-292'] })
  // Both cars drive at the traffic's 2.5, their backs 3.64 ahead of the car's front, which gains on them once it's faster.
  assert.deepEqual(logs, ['[tick 233] crashed into traffic[0] with 3.1 km to go'])
  assert.deepEqual(sounds, ['hit@233'])
  const hit = at(233, 'car,race,traffic[0],traffic[1]')
  assert.deepEqual([hit.car.speed, hit.car.spin, hit.race.crashes, hit['traffic[0]'].crashed, hit['traffic[0]'].drift, hit['traffic[1]'].crashed], [2.5, 60, 1, true, 1, false])
  close(at(263, 'car').car.angle, Math.PI)
  // Right is held for all of the spin, and the car comes out of it straight, where it went in.
  const back = at(293, 'car')
  assert.deepEqual([back.car.spin, back.car.angle ?? 0, back.car.speed, back.car.x, back.car.steer], [0, 0, 2.5, 0, 0])
  close(at(297, 'car').car.speed, 2.62)
  // The wreck brakes 2.5 a second as it slides right 2.4 a second until it's 1.3 out, and the car it meets in 7 ticks rides 0.34 to its right.
  close(at(263, 'traffic[0]')['traffic[0]'].speed, 1.25)
  const pushed = at(240, 'traffic[0],traffic[1]')
  assert.deepEqual([pushed['traffic[1]'].crashed, pushed['traffic[1]'].drift], [true, 1])
  const parked = at(297, 'traffic[0],traffic[1]')
  assert.deepEqual([parked['traffic[0]'].speed, Number(parked['traffic[1]'].speed) > 0], [0, true])
  close(parked['traffic[0]'].x, 1.32)
  close(parked['traffic[1]'].x, 1.32 + 0.34)

  // A wreck still sliding across the road knocks a coin away, which counts for nothing, and hits the car once it has slid 0.04 a tick from 0.6 to within 0.32 of it.
  const wreck = ['traffic[0].visible=true', 'traffic[0].crashed=true', 'traffic[0].drift=-1', 'traffic[0].x=0.6', 'traffic[0].y=-1.1']
  const swept = play({ ticks: 8, set: [...UNDER_WAY, ...wreck, 'coins[0].visible=true', 'coins[0].x=0.3', 'coins[0].y=-1.1'] })
  assert.deepEqual([swept.at(1, 'coins[0]')['coins[0]'].visible, swept.at(2, 'coins[0]')['coins[0]'].visible, swept.at(8, 'race').race.coins], [true, false, 0])
  assert.deepEqual([swept.logs, swept.sounds, swept.at(8, 'car').car.spin], [['[tick 8] crashed into traffic[0] with 3.2 km to go'], ['hit@8'], 60])
})

test('a coin adds a second to the clock with a sound, and Space only starts a race again once the race is over and the prompt shows', () => {
  const coin = play({ ticks: 240, set: [...UNDER_WAY, 'coins[0].visible=true', 'coins[0].y=3'] })
  assert.deepEqual(coin.sounds, ['coin@236'])
  const taken = coin.at(236, 'race,coins[0]')
  assert.deepEqual([taken.race.clock, taken.race.coins, taken['coins[0]'].visible], [3600 - 236 + 60, 1, false])

  const { at, sounds, logs } = play({ ticks: 250, press: ['Space@1,200,250'], set: ['race.start_clock=180', 'race.first_row=1000'] })
  assert.deepEqual(sounds, ['blip@61', 'blip@121', 'lose@181'])
  assert.deepEqual(logs, ['[tick 1] the race starts with 3 seconds on the clock', '[tick 181] TIME UP with 3.1 km to go', '[tick 250] the race starts with 3 seconds on the clock'])
  const over = at(181, 'race,message,detail,prompt,panel')
  assert.deepEqual([over.race.state, over.message.text, over.detail.text, over.prompt.text, over.panel.visible], ['lost', 'TIME UP', '3.1 KM TO GO', '', true])
  assert.deepEqual([at(200, 'race').race.state, at(241, 'prompt').prompt.text], ['lost', 'PRESS SPACE TO RACE AGAIN'])
  // The race is over, so from the 5.4 it reached in 180 ticks the car eases down to the traffic's speed, 0.03 a tick.
  close(at(249, 'car').car.speed, 5.4 - 0.03 * 69)
  const again = at(250, 'race,car,panel')
  assert.deepEqual([again.race.state, again.race.clock, again.car.speed, again.panel.visible], ['play', 180, 0.03, false])
  close(again.race.distance, 0.03 / 60)
})

test('a race that starts after one runs out of time starts with none of its traffic, coins, crashes, or kept lane', () => {
  // Seed 2's autopilot runs out of a 15-second clock with cars and coins on the road, two coins taken, a crash, and the right lane kept, then races again.
  const { at, logs } = play({ ticks: 1082, seed: 2, drive: autopilot, set: ['race.start_clock=900'] })
  assert.deepEqual(logs.at(-1), '[tick 1082] the race starts with 15 seconds on the clock')
  const shown = (tick: number, group: string) => Object.values(at(tick, group)).filter((each) => each.visible !== false).length
  const before = at(1081, 'race').race
  assert.deepEqual([before.state, before.coins, before.crashes, before.lane, shown(1081, 'traffic'), shown(1081, 'coins')], ['lost', 2, 1, 2, 7, 3])
  const after = at(1082, 'race').race
  assert.deepEqual([after.state, after.coins, after.crashes, after.lane, shown(1082, 'traffic'), shown(1082, 'coins')], ['play', 0, 0, 1, 0, 0])
})

test("the car that reaches the finish line wins with the seconds it has to spare, then eases down to the traffic's speed, and a coin it takes after counts for nothing", () => {
  const { at, sounds, logs } = play({ ticks: 420, press: ['Space@1'], set: ['race.finish=20', 'race.first_row=1000'] })
  assert.deepEqual(sounds, ['score@300'])
  assert.deepEqual(logs.at(-1), '[tick 300] FINISH with 55.0 seconds to spare, 0 crashes, and 0 coins')
  const won = at(300, 'race,message,detail,finish_line')
  assert.deepEqual([won.race.state, won.message.text, won.detail.text], ['won', 'FINISH', '55.0 SECONDS TO SPARE'])
  close(won.finish_line.y, -1.1 + 0.23 + 20 - Number(won.race.distance))
  assert.deepEqual([at(299, 'race').race.state, at(420, 'race').race.clock], ['play', 3301])
  assert.equal(at(417, 'car').car.speed, 2.5)

  // The coin is over the car on ticks 319 to 331, after the finish at tick 300.
  const late = play({ ticks: 420, set: [...UNDER_WAY, 'race.finish=20', 'coins[0].visible=true', 'coins[0].y=7.75'] })
  assert.deepEqual([late.sounds, late.at(331, 'coins[0]')['coins[0]'].visible, late.at(420, 'race').race.coins, late.at(420, 'race').race.clock], [['score@300'], true, 0, 3300])
})

test('each row of traffic is a gap apart, more after a row of two, keeps free the lane the row before kept free or one beside it, and has coins only in its free lanes, so the autopilot, which reads only the road, always gets through', () => {
  const session = new Session(racer, { seed: 0 })
  session.start()
  // A row comes on the tick its gap runs out, so it's at most one tick's gain on the traffic short of its gap.
  const slack = (session.world.car.top_speed - session.world.race.traffic_speed) / 60
  let [kept, travel, last, rows, pairs, later] = [session.world.race.lane, 0, 0, 0, 0, 0]
  const kinds = new Set<string>()
  while (session.world.race.state !== 'won' && session.tick < 4000) {
    const shown = new Set([...session.world.traffic, ...session.world.coins].filter((each) => each.visible).map((each) => each.name))
    session.step(session.drive(autopilot))
    const { car, coins, race, traffic, finish_line } = session.world
    travel += Math.max(0, car.speed - race.traffic_speed) / 60
    assert.ok([...traffic.filter((other) => other.visible).map((other) => other.y + other.h / 2), ...coins.filter((coin) => coin.visible).map((coin) => coin.y)].every((y) => y >= race.behind), `tick ${session.tick}: something behind the car is still on the road`)
    const fresh = traffic.filter((other) => other.visible && !shown.has(other.name))
    if (fresh.length === 0) continue
    const lanes = fresh.map((other) => LANES.indexOf(other.x))
    const coinLanes = coins.filter((coin) => coin.visible && !shown.has(coin.name)).map((coin) => LANES.indexOf(coin.x))
    const where = `tick ${session.tick}: lanes ${lanes} and coins ${coinLanes} with ${race.lane} kept after ${kept}, ${travel.toFixed(3)} after a row of ${last}`
    assert.ok(lanes.length <= 2 && !lanes.includes(race.lane) && Math.abs(race.lane - kept) <= 1 && coinLanes.every((lane) => !lanes.includes(lane)), where)
    if (rows > 0) assert.ok(travel > race.gap_min + (last === 2 ? race.pair_gap : 0) - slack, where)
    assert.ok(finish_line.y >= race.spawn_y && fresh.every((other) => other.h === LENGTHS[other.kind] && other.h <= LENGTHS.truck), where)
    for (const other of fresh) kinds.add(other.kind)
    ;[kept, travel, last, rows] = [race.lane, 0, lanes.length, rows + 1]
    if (lanes.length === 2) race.distance > race.finish / 2 ? (later += 1) : (pairs += 1)
  }
  assert.equal(session.world.race.state, 'won')
  assert.ok(rows > 60 && later > 2 * pairs, `${rows} rows, ${pairs} of two cars in the first half and ${later} in the second`)
  assert.deepEqual([...kinds].toSorted(), [...KINDS].toSorted())
  for (let seed = 1; seed < 10; seed++) assert.equal(simulate(racer, { ticks: 4000, seed, drive: autopilot, until: raced }).world.race.state, 'won', `seed ${seed}`)
})

test('a car held anywhere across the road, from one edge to the other, runs into the traffic', () => {
  // The racer and the traffic are 0.64 wide together, so they touch closer than 0.32, more than the 0.3 from a line between lanes to the middle of either.
  for (let seed = 0; seed < 3; seed++) {
    for (let x = -75; x <= 75; x++) {
      const { reached } = simulate(racer, { ticks: 3600, seed, set: ['race.state=play', `car.x=${x / 100}`], until: ({ world }) => world.race.crashes > 0 })
      assert.ok(reached, `seed ${seed}: a car held at x ${x / 100} never crashed`)
    }
  }
})
