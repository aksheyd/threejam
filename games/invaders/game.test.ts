import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, pick, simulate, type EntityState, type LogEntry, type SimOptions } from '@aksheyd/fourjs'
import { autopilot } from './autopilot.ts'
import game from './game.ts'

const logLine = ({ tick, text }: LogEntry) => `[tick ${tick}] ${text}`

// Runs once and returns the chosen entities by name after any tick, plus the log.
function play(options: SimOptions) {
  const { snapshots, logs } = simulate(game, { ...options, every: 1 })
  const at = (tick: number, only: string): Record<string, EntityState> =>
    Object.fromEntries(pick(snapshots[tick].entities, only).map((e) => [e.name, e]))
  return { at, logs: logs.map(logLine) }
}

function close(actual: unknown, expected: number): void {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${actual} should be ${expected}`)
}

test('Space starts without firing, held Space refires, hits score by row and speed the march up, and the cannon stops at the edges', () => {
  const held = play({ ticks: 30, hold: ['Space@1-30'] }).at(30, 'game,shot')
  assert.equal(held.game.state, 'play')
  assert.equal(held.shot.visible, false)

  const firing = play({ ticks: 34, press: ['Space@1'], hold: ['Space@3-'] })
  assert.deepEqual(firing.logs.slice(1), ['[tick 16] score +10 for invaders[4][5] = 10', '[tick 34] score +10 for invaders[3][5] = 20'])
  assert.equal(firing.at(17, 'shot').shot.visible, true)
  const { score, fleet, 'invaders[4][5]': invader } = firing.at(34, 'score,fleet,invaders[4][5]')
  assert.equal(score.text, '0020')
  assert.equal(invader.visible, false)
  assert.deepEqual([fleet.alive_count, fleet.interval], [53, 32])

  const cannonX = (hold: string) => play({ ticks: 200, press: ['Space@1'], hold: [hold], set: ['fleet.bomb_gap_max=5000'] }).at(200, 'cannon').cannon.x
  close(cannonX('Left@2-31'), -0.6)
  close(cannonX('Right@2-'), 1.9 - 0.195 / 2)
})

test('a bomb costs a life and pauses play, the last life ends the game, and a press after the hint plays again', () => {
  const hit = play({ ticks: 234, press: ['Space@1'] })
  assert.ok(hit.logs.includes('[tick 144] cannon hit by bomb1: 2 lives left'))
  const dying = hit.at(144, 'game,lives,life2,fleet')
  assert.deepEqual([dying.game.state, dying.lives.text, dying.life2.visible], ['dying', '2', false])
  assert.equal(hit.at(150, 'cannon').cannon.visible, false)
  const paused = hit.at(233, 'game,fleet')
  assert.equal(paused.game.state, 'dying')
  assert.deepEqual([paused.fleet.steps, paused.fleet.wait], [dying.fleet.steps, dying.fleet.wait])
  assert.equal(hit.at(234, 'game').game.state, 'play')

  const last = play({ ticks: 207, set: ['game.lives=1'], press: ['Space@1,205,207'] })
  assert.ok(last.logs.includes('[tick 144] GAME OVER: the last life is lost (final score 0)'))
  const over = last.at(144, 'game,message,ground')
  assert.deepEqual([over.game.state, over.message.text, over.message.color, over.ground.color], ['over', 'GAME OVER', '#ff3333', '#ff3333'])
  assert.equal(last.at(204, 'hint').hint.text, '')
  const ignored = last.at(206, 'game,hint')
  assert.deepEqual([ignored.game.state, ignored.hint.text], ['over', 'PRESS SPACE TO PLAY AGAIN'])
  const again = last.at(207, 'game,ground,invaders,bunkers,shields')
  assert.deepEqual([again.game.state, again.game.lives, again.ground.color], ['play', 1, '#33ff33'])
  assert.ok(Object.values(again).every((e) => e.visible !== false))
  assert.equal(last.logs.at(-1), '[tick 207] the invasion begins with 1 life')
})

test('the autopilot clears the wave as the fleet drops and shields erode, then plays again', () => {
  const session = new Session(game)
  const drive = autopilot()
  session.start()
  let dropped = false
  let eroded = false
  for (let tick = 1; tick <= 2200; tick++) {
    dropped ||= session.world.fleet.sy !== 0
    eroded ||= session.world.shields.destroyed !== 0
    session.step(session.drive(drive))
  }
  const logs = session.logs.map(logLine)
  const win = logs.findIndex((line) => line.includes('YOU WIN'))
  assert.ok(win > 0, 'the wave should be cleared')
  assert.equal(logs.slice(0, win).filter((line) => / for invaders\[\d\]\[\d+\] = /.test(line)).length, 55)
  assert.match(logs[win], /YOU WIN: the wave is cleared \(final score (99\d|1\d{3})\)$/)
  assert.ok(dropped && eroded)
  assert.match(logs[win + 1], /the invasion begins with 3 lives$/)
})
