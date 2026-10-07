import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import pong from '../games/pong/game.ts'
import { layoutKeys, type Box, type Layout } from '../src/browser/touch.ts'
import { Session, parseGame } from '../src/engine.ts'
import { ROOT } from '../src/package.ts'
import { KEYS, type Key } from '../src/types.ts'

// Phones held either way, small and large, tablets, a touch screen on a laptop, a window exactly as wide as the game for its height, and short windows or embeds.
const SCREENS: readonly (readonly [number, number])[] = [
  [320, 568], [360, 640], [375, 667], [390, 844], [393, 659], [393, 851], [412, 915], [430, 932],
  [568, 320], [640, 360], [667, 375], [734, 343], [844, 390], [851, 393], [932, 430],
  [768, 1024], [820, 1180], [1024, 768], [1180, 820], [1000, 600], [1280, 800], [800, 600],
  [480, 270], [400, 225], [365, 200],
]

// The keys a game has read after its first tick, and after 3000 ticks of keys mashed at random, which gets each example game through its states.
function keysOf(game: Parameters<typeof parseGame>[0]): { first: readonly Key[]; all: readonly Key[] } {
  const session = new Session(parseGame(game), { seed: 1 })
  session.start()
  session.step([])
  const first = session.keysRead
  let state = 1
  const random = () => (state = (state * 48271) % 2147483647) / 2147483647
  for (let tick = 0; tick < 3000; tick++) session.step(KEYS.filter((key) => key !== 'Mouse' && random() < 0.1))
  return { first, all: session.keysRead }
}

const games = readdirSync(join(ROOT, 'games'), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
const read = Object.fromEntries(
  await Promise.all(games.map(async (name) => [name, keysOf(Reflect.get(await import(pathToFileURL(join(ROOT, 'games', name, 'game.ts')).href), 'default'))] as const)),
)

// Where the page puts the canvas in the room the keys leave, as its fit does.
function canvasIn({ room }: Layout, width: number, height: number): Box {
  const [w, h] = [width - room.left - room.right, height - room.top - room.bottom]
  const scale = Math.min(w / 800, h / 600)
  return { x: room.left + (w - Math.floor(800 * scale)) / 2, y: room.top + (h - Math.floor(600 * scale)) / 2, w: Math.floor(800 * scale), h: Math.floor(600 * scale) }
}

function apart(a: Box, b: Box): boolean {
  return a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
}

test("a session lists the keys game code has asked ctx.input about, as it asks, in the order KEYS has them, keys kept in entities' fields among them", () => {
  const session = new Session(pong, { seed: 0 })
  session.start()
  assert.deepEqual(session.keysRead, [])
  session.step([])
  assert.deepEqual(session.keysRead, ['Space'])
  session.step(['Space'])
  assert.deepEqual(session.keysRead, ['S', 'W', 'Space', 'Up', 'Down'])
})

test('on every screen, each example game gets a key for each keyboard key it reads, on the screen and clear of its bottom edge, apart from the others and from the game, which keeps at least half its size, and at least 44 pixels wherever the shorter side is 320 or more', () => {
  for (const [name, { first, all }] of Object.entries(read)) {
    for (const keys of [first, all]) {
      for (const [width, height] of SCREENS) {
        const layout = layoutKeys(keys, width, height)
        const where = `${name} on ${width}x${height} with ${keys.join(' ')}`
        assert.deepEqual(layout.buttons.map((button) => button.key).toSorted(), keys.filter((key) => key !== 'Mouse' && key !== 'MouseRight').toSorted(), where)
        const canvas = canvasIn(layout, width, height)
        assert.ok(canvas.w >= Math.min(width / 800, height / 600) * 400, `${where}: the game shrinks to ${canvas.w}x${canvas.h}`)
        for (const [i, { key, box }] of layout.buttons.entries()) {
          if (Math.min(width, height) >= 320) assert.ok(box.w >= 44 && box.h >= 44, `${where}: ${key} is ${box.w}x${box.h}`)
          // A phone keeps its bottom edge for a swipe, and a jam's widget puts a badge in a corner there.
          assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height - 40, `${where}: ${key} is off the screen or by its bottom edge at ${JSON.stringify(box)}`)
          assert.ok(apart(box, canvas), `${where}: ${key} covers the game`)
          for (const other of layout.buttons.slice(i + 1)) assert.ok(apart(box, other.box), `${where}: ${key} covers ${other.key}`)
        }
      }
    }
  }
})

test('a key an example game reads only once it is under way moves neither the game nor the keys already there', () => {
  for (const [name, { first, all }] of Object.entries(read)) {
    for (const [width, height] of SCREENS) {
      const [before, after] = [layoutKeys(first, width, height), layoutKeys(all, width, height)]
      const where = `${name} on ${width}x${height}`
      if (before.buttons.length > 0) assert.deepEqual(after.room, before.room, where)
      for (const { key, box } of before.buttons) assert.deepEqual(after.buttons.find((button) => button.key === key)?.box, box, `${where}: ${key} moved`)
    }
  }
})

test("Pong's two players each get a side, W and S on the left and the arrows on the right, with Space below the arrows like a space bar", () => {
  const { buttons } = layoutKeys(read.pong.all, 851, 393)
  const side = (key: Key) => {
    const box = buttons.find((button) => button.key === key)?.box
    assert.ok(box, `Pong has no ${key} key`)
    return box.x + box.w / 2 < 851 / 2 ? 'left' : 'right'
  }
  assert.deepEqual(Object.fromEntries((['W', 'S', 'Up', 'Down', 'Space'] as const).map((key) => [key, side(key)])), { W: 'left', S: 'left', Up: 'right', Down: 'right', Space: 'right' })
  const box = (key: Key) => buttons.find((button) => button.key === key)?.box
  assert.ok((box('Space')?.y ?? 0) > (box('Down')?.y ?? Infinity) && (box('Space')?.w ?? 0) > 2 * (box('Down')?.w ?? Infinity))
})

test("keys are 13% of the screen's shorter side on a phone held either way, and in a short window or embed too, where 44-pixel keys would leave the game under half its width, so the game keeps the width it had", () => {
  // In the windows, Pong's game was 210, 178, and 165 pixels wide with keys of that share, and 44-pixel keys would leave it 144, 64, and 28.
  const sizes = [[393, 851, 393, 51], [851, 393, 457, 51], [480, 270, 210, 35], [400, 225, 178, 29], [365, 200, 165, 26]] as const
  for (const [width, height, game, key] of sizes) {
    const layout = layoutKeys(read.pong.all, width, height)
    const screen = `${width}x${height}`
    assert.deepEqual({ screen, game: canvasIn(layout, width, height).w, keys: [...new Set(layout.buttons.map(({ box }) => box.h))] }, { screen, game, keys: [key] })
  }
})
