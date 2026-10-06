import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, before, test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Page } from 'puppeteer-core'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { exportGame } from '../src/export.ts'
import { runGame } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { buildPage, serve } from '../src/serve.ts'
import { openPage } from '../src/shot.ts'
import { CHROME as chrome, testChrome, type TestChrome } from './chrome.ts'
import { spawnCli } from './children.ts'
import { PROBE, checkProbe } from './probe.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
let shared: TestChrome | undefined
before(async () => {
  if (chrome) shared = await testChrome()
})
after(async () => {
  await shared?.close()
  made.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

// A tab in the one Chrome every test here shares, closed when its test ends, even one that fails.
async function newTab(t: TestContext): Promise<Page> {
  if (shared === undefined) throw new Error('this test needs Chrome')
  const tab = await shared.browser.newPage()
  t.after(() => (tab.isClosed() ? undefined : tab.close()))
  return tab
}

const FLAP = [
  "import type { Driver, EntitiesOf } from 'threejam'",
  "import type flappy from '../../../games/flappy/game.ts'",
  '',
  'const flap: Driver<EntitiesOf<typeof flappy>> = ({ world: { bird, pipes }, keys }) => {',
  '  const next = pipes.filter((pipe) => pipe.x + pipe.parts.top_cap.w / 2 > bird.x).sort((a, b) => a.x - b.x)[0]',
  "  return (bird.state !== 'play' || bird.y < next.y - 0.12) && !keys.includes('Space') ? ['Space'] : []",
  '}',
  'export default flap',
  '',
].join('\n')

test('with a driver that taps using the keys of the tick before, the page reaches the state sim computes, parts and all', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'driver-'))
  made.push(dir)
  const driver = join(dir, 'flap.ts')
  writeFileSync(driver, FLAP)
  const expected = (await runGame('games/flappy', { seed: 7, ticks: 900, driver })).snapshots[0].entities
  assert.ok(expected.some((entity) => entity.name === 'pipes[2].parts.bottom_cap'))
  const page = await buildPage({ dir: 'games/flappy', config: { mode: 'shot' }, driver })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 7, drive: true })
      window.engine.advanceTo(900)
      return window.engine.state()
    })
    assert.deepEqual(actual, expected)
  } finally {
    server.close()
    await page.dispose()
  }
})

const MATH_HEAVY = [
  "import { defineGame } from 'threejam'",
  '',
  'export default defineGame({',
  '  entities: { dot: { x: 0.5, y: 0.25, w: 0.1, h: 0.1 } },',
  '  update(world, ctx) {',
  '    const { dot } = world',
  '    const a = Math.sin(dot.x * 7.3 + ctx.tick) + Math.cos(dot.y * 3.1 - ctx.tick / 7)',
  '    const b = Math.atan2(dot.y, dot.x - 0.3) + Math.exp(-Math.abs(a)) + Math.log(1 + Math.abs(b0(a)))',
  '    dot.x = Math.cbrt(a) / 3',
  '    dot.y = Math.tanh(b) - Math.asinh(a) / 9',
  '  },',
  '})',
  '',
  'function b0(value: number): number {',
  '  return Math.sinh(value / 4) + Math.acos(Math.max(-1, Math.min(1, value / 3)))',
  '}',
  '',
].join('\n')

test('with the portable math, trig-heavy code reaches the same state in the page as in sim', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'math-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), MATH_HEAVY)
  const expected = (await runGame(dir, { ticks: 600 })).snapshots[0].entities
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 0 })
      window.engine.advanceTo(600)
      return window.engine.state()
    })
    assert.deepEqual(actual, expected)
  } finally {
    server.close()
    await page.dispose()
  }
})

const ELSEWHERE = [
  "import { defineGame } from 'threejam'",
  '',
  'const { sin, cos } = Math',
  'const random = Math.random',
  'const now = Date.now',
  'const TOP = Math.tan(0.3)',
  '',
  'export default defineGame({',
  "  entities: { probe: { kept: 0, inline: 0, top: 0, texts: [''], refused: [''] } },",
  '  update({ probe }, ctx) {',
  '    const day = new Date(Date.UTC(2024, 0, 31, 23, 30) + ctx.tick * 60_000)',
  '    probe.kept = sin(1e22 + ctx.tick) + cos(ctx.tick)',
  '    probe.inline = Math.sin(1e22 + ctx.tick) + Math.cos(ctx.tick)',
  '    probe.top = TOP',
  "    probe.texts = [(1234567.5 + ctx.tick).toLocaleString(), day.toLocaleString(), new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day), ['b', 'a', 'C', 'ä'].sort((a, b) => a.localeCompare(b)).join('')]",
  '    const host: Record<string, any> = globalThis',
  '    const tries = [() => random(), () => now(), () => host.crypto.randomUUID(), () => host.performance.now(), () => new Intl.DateTimeFormat().format(), () => day.getHours(), () => new WeakRef(day), () => Object.assign(ctx, { dt: 1 })]',
  "    probe.refused = tries.map((attempt) => { try { attempt(); return 'allowed' } catch (error: any) { return String(error.message).split(';')[0] } })",
  '  },',
  '})',
  '',
].join('\n')

test("in another locale and time zone, the page computes what sim does and refuses what sim refuses, even through what a game's top level keeps", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'elsewhere-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), ELSEWHERE)
  const expected = (await runGame(dir, { ticks: 30 })).snapshots[0].entities
  const [probe] = expected
  assert.equal(probe.kept, probe.inline)
  assert.deepEqual(probe.refused, [
    'Math.random() would make runs differ',
    'Date.now() would make runs differ',
    'crypto.randomUUID() would make runs differ',
    'performance.now() would make runs differ',
    'Intl.DateTimeFormat format() with no date would make runs differ',
    'date.getHours() would make runs differ',
    'new WeakRef() would make runs differ',
    "Cannot assign to read only property 'dt' of object '#<Object>'",
  ])
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    await tab.emulateTimezone('Asia/Kolkata')
    await (await tab.createCDPSession()).send('Emulation.setLocaleOverride', { locale: 'de-DE' })
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 0 })
      window.engine.advanceTo(30)
      return { state: window.engine.state(), page: [new Intl.NumberFormat().format(1234567.5), new Intl.DateTimeFormat().resolvedOptions().timeZone !== 'UTC'] }
    })
    assert.deepEqual(actual.page, ['1.234.567,5', true])
    assert.deepEqual(actual.state, expected)
  } finally {
    server.close()
    await page.dispose()
  }
})

test("in a page set to de-DE and Asia/Kolkata, game code finds no frame, no host global, and no path to the platform's clock, zone, or locale, a promise can't write after its tick, and every reset gives sim's state", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'probe-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), PROBE)
  const expected = (await runGame(dir, { ticks: 2 })).snapshots[0].entities
  checkProbe(expected[0].out, { bare: true })
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    const { errors } = watch(tab)
    await tab.emulateTimezone('Asia/Kolkata')
    await (await tab.createCDPSession()).send('Emulation.setLocaleOverride', { locale: 'de-DE' })
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    for (const round of [1, 2]) {
      const ran = await tab.evaluate(() => {
        window.engine.reset({ seed: 0 })
        window.engine.advanceTo(2)
        return window.engine.state()
      })
      // The promise's write comes after the evaluate that ran its tick.
      const after = await tab.evaluate(() => window.engine.state())
      assert.deepEqual({ ran, after }, { ran: expected, after: expected }, `round ${round}`)
    }
    const host = await tab.evaluate(() => [window.length, typeof navigator.language, new Intl.NumberFormat().format(1234567.5)])
    assert.deepEqual(host, [0, 'string', '1.234.567,5'])
    assert.deepEqual(errors, ['entity "probe" is read-only here; only start and update change the game', 'entity "probe" is read-only here; only start and update change the game'])
  } finally {
    server.close()
    await page.dispose()
  }
})

const KEEPER = [
  "import { defineGame, listOf } from 'threejam'",
  '',
  'const host: Record<string, any> = globalThis',
  '',
  'function attempt(read: () => unknown): string {',
  '  try {',
  '    return String(read())',
  '  } catch {',
  "    return 'refused'",
  '  }',
  '}',
  '',
  'export default defineGame({',
  "  entities: { probe: { seen: listOf('') } },",
  '  update({ probe }, ctx) {',
  "    probe.seen.push([String(host.counter), String(host.name), attempt(() => Math.random())].join(' '))",
  '    host.counter = (host.counter ?? 0) + 1',
  '    if (ctx.tick !== 1) return',
  "    host.name = 'player'",
  '    Math.random = () => 0.25',
  '  },',
  '})',
  '',
].join('\n')

test("a page that runs ticks in one batch or in several gives sim's run of a game that makes a global, sets one the page has, and puts its own Math.random in place, and the page keeps its own", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'keeper-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), KEEPER)
  const expected = (await runGame(dir, { ticks: 3 })).snapshots[0].entities
  assert.deepEqual(expected, [{ name: 'probe', seen: ['undefined undefined refused', '1 player 0.25', '2 player 0.25'] }])
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    for (const batches of [1, 3]) {
      const tab = await newTab(t)
      await openPage(tab, server.url)
      await tab.waitForFunction('window.engine !== undefined')
      const actual = await tab.evaluate((batches: number) => {
        window.engine.reset({ seed: 0 })
        if (batches === 1) window.engine.advanceTo(3)
        else for (let tick = 1; tick <= batches; tick++) window.engine.step()
        return { state: window.engine.state(), name: [typeof Object.getOwnPropertyDescriptor(window, 'name')?.get, window.name] }
      }, batches)
      assert.deepEqual(actual, { state: expected, name: ['function', ''] }, `${batches} batches`)
    }
  } finally {
    server.close()
    await page.dispose()
  }
})

// A 2x2 image: red and green on top, blue and white below.
const QUAD_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC'

const PICTURE = [
  "import { defineGame } from 'threejam'",
  '',
  'export default defineGame({',
  "  background: '#000000',",
  '  entities: {',
  "    tile: { x: -1, w: 2, h: 2, image: 'quad.png' },",
  "    arm: { x: 1, angle: Math.PI / 2, parts: { tip: { x: 0.5, w: 0.4, h: 0.1, color: '#ff00ff' } } },",
  "    cursor: { w: 0.05, h: 0.05, color: '#ffff00', clicks: 0, dragged: 0 },",
  '  },',
  '  update({ cursor }, ctx) {',
  '    cursor.x = ctx.input.pointer.x',
  '    cursor.y = ctx.input.pointer.y',
  "    if (ctx.input.pressed('Mouse')) cursor.clicks += 1",
  "    if (ctx.input.held('MouseRight')) cursor.dragged += 1",
  '  },',
  '})',
  '',
].join('\n')

test('from the first frame the page draws images with square pixels and turned parts where sim puts them, and follows a mouse schedule as sim does', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'picture-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), PICTURE)
  writeFileSync(join(dir, 'quad.png'), Buffer.from(QUAD_PNG, 'base64'))
  const input = { ticks: 6, press: ['Mouse@2,4'], hold: ['MouseRight@3-5'], pointer: ['0.5,0.25@3', '-1.5,-1@5'] }
  const expected = (await runGame(dir, input)).snapshots[0].entities
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    // Just inside each of the image's four pixels where they meet, 100 screen pixels apart, then on the turned part and where it would be unturned.
    const spots = [[195, 295], [205, 295], [195, 305], [205, 305], [600, 170], [630, 200]]
    const actual = await tab.evaluate(
      (options, points) => {
        window.engine.reset(options)
        const copy = document.createElement('canvas')
        copy.width = 800
        copy.height = 600
        const context = copy.getContext('2d')
        const canvas = document.querySelector('canvas')
        if (!context || !canvas) throw new Error('the page has no canvas to read')
        context.drawImage(canvas, 0, 0)
        const pixels = points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)])
        window.engine.advanceTo(options.ticks)
        return { pixels, state: window.engine.state() }
      },
      { seed: 0, ...input },
      spots,
    )
    assert.deepEqual(actual.pixels, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 0, 255], [0, 0, 0]])
    assert.deepEqual(actual.state, expected)
  } finally {
    server.close()
    await page.dispose()
  }
})

// The 2x2 image above as a GIF with a second frame, all black, after it; as a lossless WebP; and as a 16x16 JPEG whose colors each fill whole 8x8 blocks, which it keeps to within a shade or two.
const QUAD_GIF = 'R0lGODlhAgACAJIAAP8AAAD/AAAA/////wAAAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAgACAAADAwghkwAh+QQECgAAACwAAAAAAgACAAADA0hKCQA7'
const QUAD_WEBP = 'UklGRiwAAABXRUJQVlA4TB8AAAAvAUAAAB8gEEjeHzqN+RcQFPwf3fxHZA/gBgwR/Q8BAA=='
const QUAD_JPEG =
  '/9j/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAGBwEBAQEAAAAAAAAAAAAAAAAABwgGEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAEAAQAwESAAISAAMSAP/aAAwDAQACEQMRAD8AFiDKKqP6a15WlFhUFJrf/9k='

const FORMATS = [
  "import { defineGame } from 'threejam'",
  '',
  'export default defineGame({',
  "  background: '#000000',",
  '  entities: {',
  "    gif: { x: -1.35, w: 1.2, h: 1.2, image: 'quad.gif' },",
  "    webp: { x: 0, w: 1.2, h: 1.2, image: 'quad.webp' },",
  "    jpeg: { x: 1.35, w: 1.2, h: 1.2, image: 'quad.jpg' },",
  '  },',
  '  update() {},',
  '})',
  '',
].join('\n')

test('the page draws GIF, WebP, and JPEG images as it does PNGs, and a GIF as its first frame', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'formats-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), FORMATS)
  for (const [name, data] of [['quad.gif', QUAD_GIF], ['quad.webp', QUAD_WEBP], ['quad.jpg', QUAD_JPEG]]) writeFileSync(join(dir, name), Buffer.from(data, 'base64'))
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    // The middle of each quarter of each image: the GIF's centered at x 130 on the screen, the WebP's at 400, and the JPEG's at 670.
    const spots = [130, 400, 670].flatMap((x) => [[x - 60, 240], [x + 60, 240], [x - 60, 360], [x + 60, 360]])
    const pixels = await tab.evaluate((points) => {
      window.engine.reset({ seed: 0 })
      const copy = document.createElement('canvas')
      copy.width = 800
      copy.height = 600
      const context = copy.getContext('2d')
      const canvas = document.querySelector('canvas')
      if (!context || !canvas) throw new Error('the page has no canvas to read')
      context.drawImage(canvas, 0, 0)
      return points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)])
    }, spots)
    const quad = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]
    assert.deepEqual(pixels.slice(0, 8), [...quad, ...quad])
    const off = pixels.slice(8).flatMap((rgb, i) => rgb.map((channel, j) => Math.abs(channel - quad[i][j])))
    assert.ok(Math.max(...off) <= 4, JSON.stringify(pixels.slice(8)))
  } finally {
    server.close()
    await page.dispose()
  }
})

test('played by the mouse autopilot, Asteroids reaches the state sim computes in the page, which records the sounds sim lists', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const driver = join('games', 'asteroids', 'autopilot.ts')
  const expected = await runGame('games/asteroids', { ticks: 600, driver })
  assert.ok(expected.sounds.some((sound) => sound.name === 'explode'))
  const page = await buildPage({ dir: 'games/asteroids', config: { mode: 'shot' }, driver })
  const server = await serve({ page })
  try {
    const tab = await newTab(t)
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 0, drive: true })
      window.engine.advanceTo(600)
      return { entities: window.engine.state(), sounds: window.engine.sounds() }
    })
    assert.deepEqual(actual, { entities: expected.snapshots[0].entities, sounds: expected.sounds })
  } finally {
    server.close()
    await page.dispose()
  }
})

// On every tick each key is down with a chance of 0.15, and the pointer lands anywhere on the screen, by the driver's own seeded numbers.
const MONKEY = [
  "import { KEYS, defineDriver } from 'threejam'",
  '',
  'export default defineDriver(() => ({ random }) => ({ keys: KEYS.filter(() => random() < 0.15), pointer: { x: random() * 4 - 2, y: random() * 3 - 1.5 } }))',
  '',
].join('\n')

test('every example game, played by a seeded random driver for 1500 ticks with each of two seeds, reaches the state and sounds sim computes in the page', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'monkey-'))
  made.push(dir)
  const driver = join(dir, 'monkey.ts')
  writeFileSync(driver, MONKEY)
  const games = readdirSync(join(ROOT, 'games'), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [join('games', entry.name)] : []))
  assert.ok(games.length >= 7, games.join(', '))
  const seeds = [3, 11]
  await Promise.all(
    games.map(async (game) => {
      const [runs, page] = await Promise.all([Promise.all(seeds.map((seed) => runGame(game, { ticks: 1500, seed, driver }))), buildPage({ dir: game, config: { mode: 'shot' }, driver })])
      const server = await serve({ page })
      try {
        const tab = await newTab(t)
        await openPage(tab, server.url)
        await tab.waitForFunction('window.engine !== undefined')
        for (const [i, seed] of seeds.entries()) {
          const actual = await tab.evaluate((s) => {
            window.engine.reset({ seed: s, drive: true })
            window.engine.advanceTo(1500)
            return { entities: window.engine.state(), sounds: window.engine.sounds() }
          }, seed)
          assert.deepEqual(actual, { entities: runs[i].snapshots[0].entities, sounds: runs[i].sounds }, `${game} with seed ${seed}`)
        }
      } finally {
        server.close()
        await page.dispose()
      }
    }),
  )
})

// Every error the page reports, and every address it asks for.
function watch(tab: Page): { errors: string[]; requests: string[] } {
  const seen = { errors: new Array<string>(), requests: new Array<string>() }
  tab.on('pageerror', (error) => seen.errors.push(error instanceof Error ? error.message : String(error)))
  tab.on('console', (message) => void (message.type() === 'error' && seen.errors.push(message.text())))
  tab.on('request', (request) => void seen.requests.push(request.url()))
  return seen
}

test('an exported file opened from disk starts with the seed export fixed, runs its view.ts, and reaches the state sim computes for scheduled keys', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-export-'))
  try {
    const file = join(dir, 'pong.html')
    await exportGame({ dir: 'games/pong', out: file, seed: 9 })
    const input = { seed: 4, ticks: 600, press: ['Space@1'], hold: ['W@1-60', 'Down@30-200'] }
    const expected = simulate(pong, input).snapshots[0].entities
    const tab = await newTab(t)
    const { errors } = watch(tab)
    await openPage(tab, pathToFileURL(file).href)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate((options) => {
      const seed = window.engine.seed
      window.engine.reset(options)
      window.engine.advanceTo(options.ticks)
      return { seed, state: window.engine.state() }
    }, input)
    assert.deepEqual({ ...actual, errors }, { seed: 9, state: expected, errors: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exported Asteroids draws its SVG rocks and plays sounds with nothing but the file, and picks a new seed each load', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-export-'))
  try {
    const file = join(dir, 'asteroids.html')
    await exportGame({ dir: 'games/asteroids', out: file })
    const tab = await newTab(t)
    await tab.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 })
    const { errors, requests } = watch(tab)
    await tab.evaluateOnNewDocument(() => {
      const started: string[] = []
      const start = AudioScheduledSourceNode.prototype.start
      AudioScheduledSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        started.push(this.constructor.name)
        return start.apply(this, args)
      }
      Reflect.set(window, 'started', started)
    })
    await openPage(tab, pathToFileURL(file).href)
    await tab.waitForFunction('window.engine !== undefined')
    const first = await tab.evaluate(() => window.engine.seed)
    // The middle of each rock on the screen, which the rock's image covers, against the black background, once they drift in from the edges.
    const pixels = await tab.evaluate(() => {
      window.engine.pause()
      window.engine.reset({ seed: 0 })
      window.engine.step(180)
      const copy = document.createElement('canvas')
      copy.width = 800
      copy.height = 600
      const context = copy.getContext('2d')
      const canvas = document.querySelector('canvas')
      if (!context || !canvas) throw new Error('the page has no canvas to read')
      context.drawImage(canvas, 0, 0)
      const rocks = window.engine.state('rocks').filter((rock) => rock.visible !== false && Math.abs(Number(rock.x)) < 1.9 && Math.abs(Number(rock.y)) < 1.4)
      return rocks.map((rock) => [...context.getImageData(((Number(rock.x) + 2) / 4) * 800, ((1.5 - Number(rock.y)) / 3) * 600, 1, 1).data.slice(0, 3)])
    })
    assert.ok(pixels.length > 0 && pixels.every((rgb) => rgb.some((channel) => channel > 20)), JSON.stringify(pixels))
    await tab.evaluate(() => window.engine.resume())
    await tab.keyboard.press('Space')
    await tab.keyboard.down('Space')
    await tab.waitForFunction(() => window.engine.sounds().some((sound) => sound.name === 'shoot'))
    await tab.waitForFunction(() => Reflect.get(window, 'started').includes('OscillatorNode'))
    await tab.keyboard.up('Space')
    await tab.reload()
    await tab.waitForFunction('window.engine !== undefined')
    const second = await tab.evaluate(() => window.engine.seed)
    assert.notEqual(first, second)
    assert.deepEqual({ errors, elsewhere: requests.filter((url) => !/^(file|data):/.test(url)) }, { errors: [], elsewhere: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Each tick, the keys held, in KEYS's order, and where the pointer is.
const INPUT = [
  "import { KEYS, defineGame, listOf } from 'threejam'",
  '',
  'export default defineGame({',
  "  entities: { input: { ticks: listOf('') } },",
  '  update({ input }, ctx) {',
  '    const { x, y } = ctx.input.pointer',
  "    input.ticks.push(`${KEYS.filter((key) => ctx.input.held(key)).join(' ')} @ ${x} ${y}`)",
  '  },',
  '})',
  '',
].join('\n')

test("a played page takes keys by where they sit, holds a tap shorter than a tick for one tick, drops what's held when it loses focus, and puts the pointer where the mouse is in world units, kept on the screen", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'input-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), INPUT)
  const file = join(dir, 'input.html')
  await exportGame({ dir, out: file })
  const tab = await newTab(t)
  // The 800 by 600 canvas sits in the middle, from x 100 to 900.
  await tab.setViewport({ width: 1000, height: 600, deviceScaleFactor: 1 })
  await openPage(tab, pathToFileURL(file).href)
  await tab.waitForFunction('window.engine !== undefined')
  await tab.evaluate(() => {
    window.engine.pause()
    window.engine.reset({ seed: 0 })
  })
  const step = () => tab.evaluate(() => window.engine.step())
  await tab.keyboard.press('KeyW')
  await step()
  await step()
  await tab.keyboard.down('ArrowUp')
  await step()
  await step()
  await tab.evaluate(() => window.dispatchEvent(new Event('blur')))
  await step()
  await tab.keyboard.up('ArrowUp')
  for (const key of ['Digit3', 'Numpad7', 'NumpadEnter', 'ShiftRight', 'ControlLeft', 'AltRight', 'Tab', 'Backspace', 'Space', 'ArrowLeft', 'KeyZ'] as const) await tab.keyboard.press(key)
  await step()
  await tab.keyboard.down('Meta')
  await tab.keyboard.press('KeyQ')
  await tab.keyboard.up('Meta')
  await tab.keyboard.press('F1')
  await tab.keyboard.press('Escape')
  await step()
  await tab.mouse.click(500, 150)
  await step()
  await tab.mouse.move(700, 450)
  await tab.mouse.down({ button: 'right' })
  await step()
  await tab.mouse.move(980, 300)
  await step()
  await tab.mouse.up({ button: 'right' })
  await step()
  assert.deepEqual(await tab.evaluate(() => window.engine.state('input')[0].ticks), [
    'W @ 0 0',
    ' @ 0 0',
    'Up @ 0 0',
    'Up @ 0 0',
    ' @ 0 0',
    'Z 3 7 Space Enter Tab Backspace Shift Ctrl Alt Left @ 0 0',
    ' @ 0 0',
    'Mouse @ 0 0.75',
    'MouseRight @ 1 -0.75',
    'MouseRight @ 2 0',
    ' @ 2 0',
  ])
})

// A silent mono WAV of 16-bit samples at 8000 a second.
function wav(seconds: number): Buffer {
  const rate = 8000
  const data = Buffer.alloc(Math.round(seconds * rate) * 2)
  const header = Buffer.alloc(44)
  header.write('RIFFxxxxWAVEfmt ', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const SOUND_FILES = [
  "import { defineGame } from 'threejam'",
  '',
  'export default defineGame({',
  '  entities: { dot: { w: 0.1, h: 0.1 } },',
  '  update(world, ctx) {',
  "    if (ctx.input.pressed('Space')) ctx.play('beep.wav', { pitch: 2 })",
  '  },',
  '})',
  '',
].join('\n')

test("a played page decodes the game's sound files and plays one at its pitch once a key wakes its audio, and tells the console of a file it can't decode", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const page = async (sound: string, contents: Buffer) => {
    const dir = mkdtempSync(join(TMP, 'sound-'))
    made.push(dir)
    writeFileSync(join(dir, 'game.ts'), SOUND_FILES)
    writeFileSync(join(dir, sound), contents)
    await exportGame({ dir, out: join(dir, 'sound.html') })
    const tab = await newTab(t)
    // What the page's audio does: how many files it decodes, its context, and each buffer it plays, by length and rate.
    await tab.evaluateOnNewDocument(() => {
      const audio = { decoded: 0, contexts: new Array<AudioContext>(), played: new Array<[number, number]>() }
      const decode = BaseAudioContext.prototype.decodeAudioData
      BaseAudioContext.prototype.decodeAudioData = function (...args: Parameters<typeof decode>) {
        return decode.apply(this, args).then((buffer) => {
          audio.decoded += 1
          return buffer
        })
      }
      window.AudioContext = class extends AudioContext {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args)
          audio.contexts.push(this)
        }
      }
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        audio.played.push([this.buffer?.duration ?? 0, this.playbackRate.value])
        return start.apply(this, args)
      }
      Reflect.set(window, 'audio', audio)
    })
    const seen = watch(tab)
    await openPage(tab, pathToFileURL(join(dir, 'sound.html')).href)
    await tab.waitForFunction('window.engine !== undefined')
    return { tab, errors: seen.errors }
  }

  const { tab, errors } = await page('beep.wav', wav(0.25))
  await tab.waitForFunction(() => Reflect.get(window, 'audio').decoded === 1)
  await tab.keyboard.press('Enter')
  await tab.waitForFunction(() => Reflect.get(window, 'audio').contexts[0].state === 'running')
  await tab.keyboard.press('Space')
  await tab.waitForFunction(() => Reflect.get(window, 'audio').played.length > 0)
  assert.deepEqual({ played: await tab.evaluate(() => Reflect.get(window, 'audio').played), errors }, { played: [[0.25, 2]], errors: [] })

  const broken = await page('beep.ogg', Buffer.from('not a sound'))
  await until("the page to report the file it can't decode", () => broken.errors.length > 0)
  assert.deepEqual(broken.errors, ["Error: the sound beep.ogg couldn't be decoded; check that the file is a whole sound of its type"])
  await broken.tab.waitForFunction(() => window.engine.tick > 30)
})

async function until(what: string, check: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 10_000; !check(); await new Promise((wait) => setTimeout(wait, 20))) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
  }
}

test("run serves the game at its seed, reloads the page at that seed when a save builds, prints a save that doesn't and plays on, and stops once Esc ends the session", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'run-'))
  made.push(dir)
  const version = (n: number) => `import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1, version: ${n} } }, update() {} })\n`
  writeFileSync(join(dir, 'game.ts'), version(1))
  const shown = relative(ROOT, dir).replaceAll(sep, '/')
  const run = spawnCli(['run', shown, '--serve-only', '--seed', '5'], t.signal)
  let [out, errors] = ['', '']
  run.stdout.on('data', (chunk) => (out += chunk))
  run.stderr.on('data', (chunk) => (errors += chunk))
  const exited = new Promise((done) => run.once('close', done))
  await until('run to serve the page', () => out.includes('\n'))
  const url = out.slice(out.lastIndexOf(' ') + 1, -1)
  assert.equal(out, `Playing ${shown} with seed 5 at ${url}\n`)
  const tab = await newTab(t)
  const listening = tab.waitForResponse((response) => response.url().includes('/events?'))
  await openPage(tab, url)
  await tab.waitForFunction('window.engine !== undefined')
  await listening
  // The seed, the game's version, and whether this is still the page marked before the saves.
  const playing = () => tab.evaluate(() => [window.engine.seed, window.engine.state('dot')[0].version, Reflect.has(window, 'marked')])
  await tab.evaluate(() => Reflect.set(window, 'marked', true))

  writeFileSync(join(dir, 'game.ts'), version(1).replace('update() {}', 'update() {'))
  await until("run to print the save that doesn't build", () => errors.includes('\n'))
  assert.ok(errors.startsWith(`${shown}/game.ts:3: `) && errors.indexOf('\n') === errors.length - 1, errors)
  assert.deepEqual(await playing(), [5, 1, true])

  const reloaded = tab.waitForNavigation()
  writeFileSync(join(dir, 'game.ts'), version(2))
  await reloaded
  await tab.waitForFunction('window.engine !== undefined')
  assert.deepEqual(await playing(), [5, 2, false])

  await tab.keyboard.press('Escape')
  assert.equal(await exited, 0)
  assert.deepEqual({ out, notice: await tab.$eval('pre', (box) => box.textContent) }, { out: `Playing ${shown} with seed 5 at ${url}\nStopped.\n`, notice: 'Session ended.' })
})

test("a run page whose game or view.ts fails as it loads says why on the page, instead of staying blank, and still reloads when a fix is saved", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const game = "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1 } }, update() {} })\n"
  const cases: ReadonlyArray<readonly [Record<string, string>, string]> = [
    [{ 'game.ts': game, 'view.ts': 'export const init = 5\n' }, 'view.ts: init must be a function'],
    [{ 'game.ts': game, 'view.ts': "throw new Error('no view today')\n" }, 'view.ts: no view today (as it loaded)'],
    [{ 'game.ts': `${game}export const started = Date.now()\n` }, 'Date.now() would make runs differ'],
  ]
  const token = 'session-token'
  for (const [files, reason] of cases) {
    const dir = mkdtempSync(join(TMP, 'notice-'))
    made.push(dir)
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
    const page = await buildPage({ dir, config: { mode: 'run', seed: 0, token } })
    const server = await serve({ page, token })
    try {
      const tab = await newTab(t)
      const listening = tab.waitForResponse((response) => response.url().includes('/events?'))
      await openPage(tab, server.url)
      await tab.waitForSelector('pre')
      const shown = await tab.$eval('pre', (box) => box.textContent ?? '')
      assert.ok(shown.startsWith(reason) && shown.endsWith('\n\nFix the game and save; the page reloads.'), shown)
      assert.equal((await listening).status(), 200, `the page ${reason} doesn't listen for reloads`)
    } finally {
      server.close()
      await page.dispose()
    }
  }
})
