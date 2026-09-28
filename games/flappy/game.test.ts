import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, simulate, type EntityState, type LogEntry } from '@aksheyd/fourjs'
import flappy from './game.ts'

function byName(entities: readonly EntityState[]): Record<string, EntityState> {
  return Object.fromEntries(entities.map((entity) => [entity.name, entity]))
}

function lines(logs: readonly LogEntry[]): string[] {
  return logs.map(({ tick, text }) => `[tick ${tick}] ${text}`)
}

test('one flap falls to the ground, and Space gets ready again only after PRESS SPACE shows', () => {
  const at = simulate(flappy, { ticks: 87, press: ['Space@1,86'], every: 1 }).snapshots.map((s) => byName(pick(s.entities, 'bird,title,prompt')))
  assert.deepEqual([at[0].bird.state, at[1].bird.state, at[1].bird.vy], ['ready', 'play', 2.3])
  assert.equal(at[50].bird.vy, -3.5)
  assert.equal(at[55].bird.state, 'play')
  assert.deepEqual([at[56].bird.state, at[56].bird.y, at[56].title.text], ['over', -0.96, 'GAME OVER'])
  assert.deepEqual([at[85].prompt.text, at[86].prompt.text], ['', 'PRESS SPACE'])
  assert.equal(at[87].bird.state, 'over', 'a press on the tick PRESS SPACE appears is too early')

  const again = byName(simulate(flappy, { ticks: 87, press: ['Space@1,87'] }).snapshots[0].entities)
  assert.deepEqual([again.bird.state, again.bird.y, again.bird.score, again['pipes[0]'].x, again.title.text], ['ready', 0.1, 0, 2.25, 'GET READY'])
})

test('each gap passed scores once, and flying above the fourth gap hits its top pipe', () => {
  const set = ['pipes[*].gap_min=0.1', 'pipes[*].gap_max=0.1']
  const flaps = [...Array.from({ length: 12 }, (_, i) => 1 + 36 * i), 415, 433]
  const { snapshots, logs } = simulate(flappy, { ticks: 460, press: [`Space@${flaps.join(',')}`], set })
  assert.deepEqual(lines(logs), [
    '[tick 209] passed pipe1, score 1',
    '[tick 305] passed pipe2, score 2',
    '[tick 401] passed pipe3, score 3',
    '[tick 457] hit pipes[0].parts.top at score 3',
  ])
  const { bird } = byName(snapshots[0].entities)
  assert.deepEqual([bird.state, bird.score], ['over', 3])
})

test('a bot that flaps whenever it sinks below the next gap keeps scoring through new random gaps', () => {
  const gaps = new Set<number>()
  const { snapshots } = simulate(flappy, {
    ticks: 1200,
    seed: 0,
    drive: ({ world: { bird, pipes } }) => {
      const next = pipes.filter((pipe) => pipe.x + pipe.parts.top_cap.w / 2 > bird.x - bird.w / 2).sort((a, b) => a.x - b.x)[0]
      gaps.add(next.y)
      return bird.state === 'ready' || (bird.y < next.y - 0.12 && bird.vy < 0) ? ['Space'] : []
    },
  })
  const { bird } = byName(snapshots[0].entities)
  assert.deepEqual([bird.state, bird.score], ['play', 11])
  assert.equal(gaps.size, 12, 'every pipe that wraps around comes back with a new gap')
})
