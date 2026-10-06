import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { parseGame, simulate } from '../src/engine.ts'
import { ROOT } from '../src/package.ts'
import { KEYS, type Key } from '../src/types.ts'

// Ways to play no game expects: mashing every key, holding them all at once, and tapping the keys games start and fire with on every other tick.
const STYLES: Readonly<Record<string, (random: () => number, tick: number) => Key[]>> = {
  mashing: (random) => KEYS.filter(() => random() < 0.15),
  'every key held': () => [...KEYS],
  'rapid taps': (_, tick) => (tick % 2 === 1 ? ['Space', 'Enter', 'Mouse', 'MouseRight'] : []),
}

const games = readdirSync(join(ROOT, 'games'), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))

for (const name of games) {
  test(`${name} plays on through mashing, every key held, and rapid taps, with the pointer anywhere, for 1800 ticks with each of two seeds`, async () => {
    const game = parseGame(Reflect.get(await import(pathToFileURL(join(ROOT, 'games', name, 'game.ts')).href), 'default'))
    for (const [style, keys] of Object.entries(STYLES)) {
      for (const seed of [1, 2]) {
        try {
          simulate(game, { ticks: 1800, seed, drive: ({ random, tick }) => ({ keys: keys(random, tick), pointer: { x: random() * 4 - 2, y: random() * 3 - 1.5 } }) })
        } catch (error) {
          throw new Error(`${style} with seed ${seed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
  })
}
