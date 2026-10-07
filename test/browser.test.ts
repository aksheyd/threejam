import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { BoundingBox, HTTPRequest, KeyInput, Page } from 'puppeteer-core'
import pong from '../games/pong/game.ts'
import { parseGame, simulate } from '../src/engine.ts'
import { RunError } from '../src/errors.ts'
import { exportGame } from '../src/export.ts'
import { runGame } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { buildPage, serve } from '../src/serve.ts'
import { openPage, shoot } from '../src/shot.ts'
import { isDrive, type Drive, type Snapshot } from '../src/types.ts'
import { CHROME as chrome, testChrome, type TestChrome } from './chrome.ts'
import { spawnCli } from './children.ts'
import { PROBE, checkProbe } from './probe.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
// The one Chrome the tests here share. The first page test starts it, since when a name pattern matches no test here, Node runs after without waiting for before.
let shared: Promise<TestChrome> | undefined
// shot's stuck pages, which use up their whole time limits, 10 s, so they run beside the other tests here rather than in shot.test.ts, which the runner starts last. They start once the first page test ends, so they don't compete with its start of the Chrome.
let stuck: Promise<string[]> | undefined
after(async () => {
  await stuck?.catch(() => {})
  await (await shared?.catch(() => undefined))?.close()
  made.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function stuckShots(): Promise<string[]> {
  if (stuck === undefined) {
    stuck = stuckPages()
    stuck.catch(() => {})
  }
  return stuck
}

// A tab in the one Chrome every test here shares, closed when its test ends, even one that fails.
async function newTab(t: TestContext): Promise<Page> {
  shared ??= testChrome()
  const tab = await (await shared).browser.newPage()
  t.after(() => (tab.isClosed() ? undefined : tab.close()))
  // A test's after hooks run in the order they were added, so this one comes once its tab has closed.
  t.after(() => void stuckShots())
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
  const loaded: unknown = Reflect.get(await import(pathToFileURL(driver).href), 'default')
  assert.ok(isDrive(loaded))
  const drive: Drive = loaded
  const games = readdirSync(join(ROOT, 'games'), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [join('games', entry.name)] : []))
  assert.ok(games.length >= 7, games.join(', '))
  // One game at a time in one tab, with sim's runs from this process, since the tests above check the sandbox's runs against the page.
  const tab = await newTab(t)
  for (const game of games) {
    const played = parseGame(Reflect.get(await import(pathToFileURL(join(ROOT, game, 'game.ts')).href), 'default'))
    const page = await buildPage({ dir: game, config: { mode: 'shot' }, driver })
    const server = await serve({ page })
    try {
      await openPage(tab, server.url)
      await tab.waitForFunction('window.engine !== undefined')
      for (const seed of [3, 11]) {
        const { snapshots, sounds } = simulate(played, { ticks: 1500, seed, drive })
        const actual = await tab.evaluate((s) => {
          window.engine.reset({ seed: s, drive: true })
          window.engine.advanceTo(1500)
          return { entities: window.engine.state(), sounds: window.engine.sounds() }
        }, seed)
        assert.deepEqual(actual, { entities: snapshots[0].entities, sounds }, `${game} with seed ${seed}`)
      }
    } finally {
      server.close()
      await page.dispose()
    }
  }
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

test("an exported page lays out at a phone's own width, so the game spans the width of a phone held upright", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-export-'))
  try {
    const file = join(dir, 'pong.html')
    await exportGame({ dir: 'games/pong', out: file })
    const tab = await newTab(t)
    // A phone lays a page out 980 pixels wide unless the page says to use the phone's own width.
    await tab.setViewport({ width: 393, height: 851, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true })
    await openPage(tab, pathToFileURL(file).href)
    await tab.waitForFunction('window.engine !== undefined')
    const layout = await tab.evaluate(() => {
      const canvas = document.querySelector('canvas')
      if (!canvas) throw new Error('the page has no canvas')
      const { left, right, top, bottom } = canvas.getBoundingClientRect()
      return { width: innerWidth, left, right, onScreen: top >= 0 && bottom <= innerHeight }
    })
    assert.deepEqual(layout, { width: 393, left: 0, right: 393, onScreen: true })
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

test('a played page holds a mouse button pressed while another is held, whichever comes first, holds one tapped meanwhile for a tick, and keeps the other held when either lets go', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'buttons-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), INPUT)
  const file = join(dir, 'input.html')
  await exportGame({ dir, out: file })
  const tab = await newTab(t)
  await tab.setViewport({ width: 1000, height: 600, deviceScaleFactor: 1 })
  await openPage(tab, pathToFileURL(file).href)
  await tab.waitForFunction('window.engine !== undefined')
  await tab.evaluate(() => {
    window.engine.pause()
    window.engine.reset({ seed: 0 })
  })
  const step = () => tab.evaluate(() => window.engine.step())
  // The browser sends a button pressed or let go while another is held as a pointermove, not a pointerdown or pointerup.
  await tab.mouse.move(500, 300)
  await tab.mouse.down({ button: 'left' })
  await step()
  await tab.mouse.down({ button: 'right' })
  await step()
  await tab.mouse.up({ button: 'right' })
  await step()
  await tab.mouse.down({ button: 'right' })
  await tab.mouse.up({ button: 'right' })
  await step()
  await step()
  await tab.mouse.up({ button: 'left' })
  await step()
  await tab.mouse.down({ button: 'right' })
  await step()
  await tab.mouse.down({ button: 'left' })
  await step()
  await tab.mouse.up({ button: 'right' })
  await step()
  await tab.mouse.up({ button: 'left' })
  await step()
  assert.deepEqual(await tab.evaluate(() => window.engine.state('input')[0].ticks), [
    'Mouse @ 0 0',
    'Mouse MouseRight @ 0 0',
    'Mouse @ 0 0',
    'Mouse MouseRight @ 0 0',
    'Mouse @ 0 0',
    ' @ 0 0',
    'MouseRight @ 0 0',
    'Mouse MouseRight @ 0 0',
    'Mouse @ 0 0',
    ' @ 0 0',
  ])
})

test('on a touch screen, a played page follows a finger dragged on the game until it lifts, and lets go of Mouse when the browser takes a touch over, as it does one dragged beside the game', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'touch-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), INPUT)
  const file = join(dir, 'input.html')
  await exportGame({ dir, out: file })
  const tab = await newTab(t)
  // The 800 by 600 canvas sits in the middle, from x 100 to 900, with the page itself on either side.
  await tab.setViewport({ width: 1000, height: 600, deviceScaleFactor: 1, hasTouch: true })
  await tab.evaluateOnNewDocument(() => {
    const seen: string[] = []
    Reflect.set(window, 'seen', seen)
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend']) addEventListener(type, () => seen.push(type), { passive: true })
    addEventListener('pointermove', (event) => seen.push(`pointermove ${event.clientX},${event.clientY}`))
  })
  await openPage(tab, pathToFileURL(file).href)
  await tab.waitForFunction('window.engine !== undefined')
  await tab.evaluate(() => {
    window.engine.pause()
    window.engine.reset({ seed: 0 })
  })
  const step = () => tab.evaluate(() => window.engine.step())
  // Chrome answers for a touch before the page has had its events, so each tick waits until the page has seen one of the events the touch should end with.
  const saw = (events: string[], times = 1) => tab.waitForFunction((wanted, count) => (Reflect.get(window, 'seen') as string[]).filter((each) => wanted.includes(each)).length >= count, { timeout: 10_000 }, events, times)
  const drag = async ([fromX, fromY]: [number, number], [toX, toY]: [number, number], { moved, times }: { moved: string[]; times: number }) => {
    await tab.touchscreen.touchStart(fromX, fromY)
    await saw(['touchstart'], times)
    await step()
    for (let i = 1; i <= 4; i++) await tab.touchscreen.touchMove(fromX + ((toX - fromX) * i) / 4, fromY + ((toY - fromY) * i) / 4)
    await saw(moved)
    await step()
    await tab.touchscreen.touchEnd()
    await saw(['touchend'], times)
    await step()
  }
  // A cancel, which a finger on the game shouldn't get, also ends the wait, so the ticks show where the pointer stopped.
  await drag([500, 300], [700, 450], { moved: ['pointermove 700,450', 'pointercancel'], times: 1 })
  // The browser takes over a finger dragged on the page beside the game to pan the page, which ends the pointer with a pointercancel instead of a pointerup.
  await drag([80, 300], [10, 300], { moved: ['pointercancel'], times: 2 })
  assert.deepEqual(await tab.evaluate(() => window.engine.state('input')[0].ticks), ['Mouse @ 0 0', 'Mouse @ 1 -0.75', ' @ 1 -0.75', 'Mouse @ -2 0', ' @ -2 0', ' @ -2 0'])
  assert.deepEqual(await tab.evaluate(() => (Reflect.get(window, 'seen') as string[]).filter((each) => each === 'pointerup' || each === 'pointercancel')), ['pointerup', 'pointercancel'])
})

// A snapshot as JSON carries it, which is how render_game_to_text gives one.
function asText(snapshot: Snapshot | undefined): unknown {
  return JSON.parse(JSON.stringify(snapshot))
}

test('advanceTime takes the clock from a page playing on its own, starts its run over as it was last reset, and steps the ticks its milliseconds cover, carrying part of one to the next call, so render_game_to_text gives the state sim gives at that tick until engine.resume() gives the clock back, while a page engine.pause() paused goes on from its tick', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-export-'))
  try {
    const file = join(dir, 'flappy.html')
    await exportGame({ dir: 'games/flappy', out: file, seed: 5 })
    const expected = await runGame('games/flappy', { seed: 5, ticks: 121, press: ['Space@61'], every: 1 })
    const reseeded = await runGame('games/flappy', { seed: 9, ticks: 1 })
    const tab = await newTab(t)
    const { errors } = watch(tab)
    await openPage(tab, pathToFileURL(file).href)
    await tab.waitForFunction(() => window.engine.tick > 30)
    // The state once each call has run in turn.
    const after = (...calls: number[]) =>
      tab.evaluate(async (ms: number[]) => {
        for (const each of ms) await window.advanceTime(each)
        return JSON.parse(window.render_game_to_text())
      }, calls)
    const frames = (count: number, ms: number) => Array.from({ length: count }, () => ms)
    // A tap just before the first call belongs to the run that call starts over, so it doesn't count.
    const first = await tab.evaluate(async (ms: number[]) => {
      for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code: 'Space' }))
      for (const each of ms) await window.advanceTime(each)
      return JSON.parse(window.render_game_to_text())
    }, frames(6, 1000 / 360))
    const seen = [first, await after(...frames(59, 1000 / 60))]
    // A tap between calls counts on the next tick.
    await tab.keyboard.press('Space')
    seen.push(await after(1000), await after(10), await after(10))
    await new Promise((wait) => setTimeout(wait, 200))
    seen.push(await after())
    assert.deepEqual(seen, [1, 60, 120, 120, 121, 121].map((tick) => asText(expected.snapshots[tick])))
    await tab.evaluate(() => {
      window.engine.resume()
      window.engine.reset({ seed: 9 })
    })
    await tab.waitForFunction(() => window.engine.tick > 20)
    assert.deepEqual(await after(1000 / 60), asText(reseeded.snapshots[0]))
    // The call's frame is drawn by the time it resolves, as the page draws it again a frame later.
    const redrawn = await tab.evaluate(async () => {
      const canvas = document.querySelector('canvas')
      if (!canvas) throw new Error('the page has no canvas to read')
      await window.advanceTime(1000)
      const drawn = canvas.toDataURL()
      await new Promise(requestAnimationFrame)
      return drawn === canvas.toDataURL()
    })
    assert.ok(redrawn, "the frame the page drew after advanceTime resolved differs from the one it showed then")
    // A page that engine.pause() paused goes on from its tick rather than starting over.
    await tab.evaluate(() => window.engine.resume())
    await tab.waitForFunction(() => window.engine.tick > 80)
    const paused = await tab.evaluate(() => {
      window.engine.pause()
      return window.engine.tick
    })
    const goneOn = await after(1000 / 60)
    assert.deepEqual(goneOn, asText((await runGame('games/flappy', { seed: 9, ticks: paused + 1 })).snapshots[0]))
    assert.deepEqual(errors, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// What OpenAI's develop-web-game client puts in a page before it loads: requestAnimationFrame, setTimeout, and setInterval of its own around the browser's, and an advanceTime that only waits that long, for a game that has none.
function clientShim(): void {
  const frame = window.requestAnimationFrame.bind(window)
  const timeout = window.setTimeout.bind(window)
  const interval = window.setInterval.bind(window)
  Reflect.set(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => frame((now) => callback(now)))
  Reflect.set(window, 'setTimeout', (handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => timeout(() => handler(...rest), ms))
  Reflect.set(window, 'setInterval', (handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => interval(() => handler(...rest), ms))
  window.advanceTime = (ms) =>
    new Promise((done) => {
      const start = performance.now()
      const wait = (now: number) => (now - start >= ms ? done() : frame(wait))
      frame(wait)
    })
}

// The keys OpenAI's client presses for its buttons.
const CLIENT_KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', enter: 'Enter', space: 'Space', a: 'KeyA', b: 'KeyB' } as const satisfies Record<string, KeyInput>

interface ClientStep {
  readonly buttons: ReadonlyArray<keyof typeof CLIENT_KEYS | 'left_mouse_button'>
  readonly frames: number
  readonly mouse_x?: number
  readonly mouse_y?: number
}

// A burst as OpenAI's client plays it: each step's buttons go down, the mouse at its point on the canvas, then advanceTime(1000 / 60) runs once a frame, each in a call of its own, and the buttons come up.
async function burst(tab: Page, canvas: BoundingBox, steps: readonly ClientStep[]): Promise<void> {
  for (const step of steps) {
    for (const button of step.buttons) {
      if (button !== 'left_mouse_button') {
        await tab.keyboard.down(CLIENT_KEYS[button])
        continue
      }
      await tab.mouse.move(canvas.x + (step.mouse_x ?? canvas.width / 2), canvas.y + (step.mouse_y ?? canvas.height / 2))
      await tab.mouse.down({ button: 'left' })
    }
    for (let frame = 0; frame < step.frames; frame++) {
      await tab.evaluate(async () => {
        if (typeof window.advanceTime === 'function') await window.advanceTime(1000 / 60)
      })
    }
    for (const button of step.buttons) {
      if (button === 'left_mouse_button') await tab.mouse.up({ button: 'left' })
      else await tab.keyboard.up(CLIENT_KEYS[button])
    }
  }
}

// The example the skill gives its client, with the mouse 90 pixels down the canvas rather than 80, which on a 960 by 720 canvas puts it at x -1.5 and y 1.125.
const CLIENT_STEPS: readonly ClientStep[] = [
  { buttons: ['left_mouse_button'], frames: 2, mouse_x: 120, mouse_y: 90 },
  { buttons: [], frames: 6 },
  { buttons: ['right'], frames: 8 },
  { buttons: ['space'], frames: 4 },
]

test("driven as OpenAI's develop-web-game client drives a game, with its own advanceTime put in first, a run page gives sim's state from render_game_to_text after each burst, however long the client waits between them, and its canvas shows that state, with nothing in the console", { skip: !chrome && 'needs Chrome' }, async (t) => {
  // Each burst is 20 ticks: the mouse on its first 2, Right on 9 to 16, and Space on 17 to 20.
  const expected = await runGame('games/asteroids', {
    seed: 2,
    ticks: 60,
    hold: ['Mouse@1-2,21-22,41-42', 'Right@9-16,29-36,49-56', 'Space@17-20,37-40,57-60'],
    pointer: ['-1.5,1.125@1'],
    every: 20,
  })
  const token = 'session-token'
  const page = await buildPage({ dir: 'games/asteroids', config: { mode: 'run', seed: 2, token } })
  const server = await serve({ page, token })
  try {
    const tab = await newTab(t)
    // Playwright's window, which the client keeps, fits the game to a 960 by 720 canvas.
    await tab.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
    const { errors } = watch(tab)
    await tab.evaluateOnNewDocument(clientShim)
    await openPage(tab, server.url, { waitUntil: 'domcontentloaded' })
    await new Promise((wait) => setTimeout(wait, 500))
    await tab.evaluate(() => window.dispatchEvent(new Event('resize')))
    const canvas = await (await tab.$('canvas'))?.boundingBox()
    assert.ok(canvas)
    assert.deepEqual(canvas, { x: 160, y: 0, width: 960, height: 720 })
    const seen: Array<{ state: unknown; size: number[]; bullets: number[][] }> = []
    for (let iteration = 0; iteration < 3; iteration++) {
      await burst(tab, canvas, CLIENT_STEPS)
      await new Promise((wait) => setTimeout(wait, 250))
      // The client saves the canvas as a PNG, read back here at the middle of each bullet in flight.
      const shot = await tab.evaluate(async () => {
        const drawn = document.querySelector('canvas')
        const copy = document.createElement('canvas')
        const context = copy.getContext('2d')
        if (!drawn || !context) throw new Error('the page has no canvas to read')
        const image = new Image()
        image.src = drawn.toDataURL('image/png')
        await image.decode()
        copy.width = image.width
        copy.height = image.height
        context.drawImage(image, 0, 0)
        const bullets = window.engine.state('bullets').filter((bullet) => bullet.visible !== false)
        const at = (x: number, y: number) => [...context.getImageData(((x + 2) / 4) * image.width, ((1.5 - y) / 3) * image.height, 1, 1).data.slice(0, 3)]
        return { size: [image.width, image.height], bullets: bullets.map((bullet) => at(Number(bullet.x), Number(bullet.y))) }
      })
      seen.push({ state: JSON.parse(await tab.evaluate(() => window.render_game_to_text())), ...shot })
    }
    assert.deepEqual(seen.map(({ state }) => state), [20, 40, 60].map((tick) => asText(expected.snapshots.find((snapshot) => snapshot.tick === tick))))
    // A bullet is a white dot on black.
    for (const { size, bullets } of seen) {
      assert.deepEqual(size, [960, 720])
      assert.ok(bullets.length > 0 && bullets.every((rgb) => rgb.every((channel) => channel > 200)), JSON.stringify(bullets))
    }
    assert.deepEqual(errors, [])
  } finally {
    server.close()
    await page.dispose()
  }
})

// A 2x2 image to load, and a game that fails on tick 3.
const FAILS_AT_3 = [
  "import { defineGame } from 'threejam'",
  '',
  'export default defineGame({',
  "  entities: { tile: { w: 1, h: 1, image: 'quad.png' } },",
  '  update(world, ctx) {',
  "    if (ctx.tick === 3) throw new Error('no tick 3')",
  '  },',
  '})',
  '',
].join('\n')

test("a run page's advanceTime holds a call that comes while the game's images load, in place of the one the client put there, and rejects it if the game fails to start, refuses what isn't milliseconds, and once the game fails rejects with the game's error, as the page says why", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'hooks-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), FAILS_AT_3)
  writeFileSync(join(dir, 'quad.png'), Buffer.from(QUAD_PNG, 'base64'))
  const expected = await runGame(dir, { ticks: 1 })
  const token = 'session-token'
  const page = await buildPage({ dir, config: { mode: 'run', seed: 0, token } })
  const server = await serve({ page, token })
  // The page opens with its image's request held here, so its game can't start until the request goes on, or fails if it's cut off.
  const holding = async (tab: Page): Promise<HTTPRequest[]> => {
    const held: HTTPRequest[] = []
    await tab.setRequestInterception(true)
    tab.on('request', (request) => {
      if (request.url().includes('/assets/')) held.push(request)
      else request.continue().catch(() => {})
    })
    await openPage(tab, server.url, { waitUntil: 'domcontentloaded' })
    await until('the page to ask for its image', () => held.length > 0)
    return held
  }
  try {
    const tab = await newTab(t)
    await tab.evaluateOnNewDocument(clientShim)
    const held = await holding(tab)
    const before = await tab.evaluate(() => {
      Reflect.set(window, 'early', window.advanceTime(1000 / 60).then(() => JSON.parse(window.render_game_to_text())))
      try {
        return window.render_game_to_text()
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    for (const request of held) await request.continue()
    const early = await tab.evaluate(() => Reflect.get(window, 'early'))
    assert.deepEqual({ before, early }, { before: "the game hasn't started yet; await advanceTime(0), which waits for it", early: asText(expected.snapshots[0]) })
    const outcomes = await tab.evaluate(async () => {
      const outcome = (ms: number) => window.advanceTime(ms).then(() => JSON.parse(window.render_game_to_text()).tick, (error: unknown) => (error instanceof Error ? error.message : String(error)))
      return [await outcome(-1), await outcome(Number.NaN), await outcome(1000 / 60), await outcome(1000 / 60), await outcome(0), JSON.parse(window.render_game_to_text()).tick, document.querySelector('pre')?.textContent]
    })
    assert.deepEqual(outcomes, [
      'advanceTime takes the milliseconds to step, a number from 0 up like 1000 / 60 for one tick, not -1',
      'advanceTime takes the milliseconds to step, a number from 0 up like 1000 / 60 for one tick, not NaN',
      2,
      'no tick 3',
      'no tick 3',
      3,
      'no tick 3\n\nFix the game and save; the page reloads.',
    ])
    // A game that fails before it starts, here with its image cut off, rejects a call that waits for it, which would otherwise wait for good.
    const cut = await newTab(t)
    const cutOff = await holding(cut)
    await cut.evaluate(() => Reflect.set(window, 'early', window.advanceTime(1000 / 60).then(() => 'stepped', (error: unknown) => (error instanceof Error ? error.message : String(error)))))
    for (const request of cutOff) await request.abort()
    const refused = await cut.evaluate(() => Promise.race([Reflect.get(window, 'early'), new Promise((done) => setTimeout(() => done('still waiting after 10 s'), 10_000))]))
    assert.equal(refused, "the image quad.png couldn't be loaded; check that the file is a whole image of its type")
  } finally {
    server.close()
    await page.dispose()
  }
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

test("run serves the game at its seed, says on the page why a save doesn't build, in place of the game and even after a refresh, until one that does reloads it at that seed, and stops once Esc on such a page ends the session", { skip: !chrome && 'needs Chrome' }, async (t) => {
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
  const playing = () => tab.evaluate(() => [window.engine.seed, window.engine.state('dot')[0].version])
  assert.deepEqual(await playing(), [5, 1])

  // The message quotes the save, markup and all, which the page shows as it is.
  writeFileSync(join(dir, 'game.ts'), version(1).replace('update() {}', "update() { '' '</script><b>' }"))
  await until("run to print the save that doesn't build", () => errors.includes('\n'))
  assert.ok(errors.startsWith(`${shown}/game.ts:3: `) && errors.includes('</script><b>') && errors.indexOf('\n') === errors.length - 1, errors)
  const why = `${errors.trim()}\n\nFix the game and save; the page reloads.`
  const notice = async () => (await tab.waitForSelector('pre'))?.evaluate((box) => box.textContent)
  assert.equal(await notice(), why)
  await tab.reload()
  assert.deepEqual([await notice(), await tab.evaluate(() => typeof window.engine)], [why, 'undefined'])

  const reloaded = tab.waitForNavigation()
  writeFileSync(join(dir, 'game.ts'), version(2))
  await reloaded
  await tab.waitForFunction('window.engine !== undefined')
  assert.deepEqual(await playing(), [5, 2])

  writeFileSync(join(dir, 'game.ts'), version(2).replace('update() {}', 'update() {'))
  await tab.waitForSelector('pre')
  await tab.keyboard.press('Escape')
  // Giving up says what run printed and what the page shows, which tells an Esc that never reached run from a run slow to stop.
  await until('Esc on the page that says why to end the session', () => run.exitCode !== null).catch(async (error: Error) => {
    const shown = await tab.$$eval('pre', (boxes) => boxes.map((box) => box.textContent)).catch(() => 'nothing, since the tab is gone')
    throw new Error(`${error.message}; run printed ${JSON.stringify(out)}, and the page shows ${JSON.stringify(shown)}`)
  })
  // The page's notice of why comes first, then the one Esc adds.
  const ended = await tab.$$eval('pre', (boxes) => boxes.at(-1)?.textContent)
  assert.deepEqual({ code: await exited, out, ended }, { code: 0, out: `Playing ${shown} with seed 5 at ${url}\nStopped.\n`, ended: 'Session ended.' })
})

test("run's page ends on the newest save even when that save builds while the page is still reloading for the one before, whether it builds or not", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'run-'))
  made.push(dir)
  const file = join(dir, 'game.ts')
  const save = (n: number) => `import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1, save: ${n} } }, update() {} })\n`
  writeFileSync(file, save(1))
  const run = spawnCli(['run', dir, '--serve-only'], t.signal)
  let [out, errors] = ['', '']
  run.stdout.on('data', (chunk) => (out += chunk))
  run.stderr.on('data', (chunk) => (errors += chunk))
  await until('run to serve the page', () => out.includes('\n'))
  const url = out.slice(out.lastIndexOf(' ') + 1, -1)
  const tab = await newTab(t)
  // Each page notes when it starts to hear of reloads.
  await tab.evaluateOnNewDocument(() => {
    const Events = EventSource
    window.EventSource = class extends Events {
      constructor(...args: ConstructorParameters<typeof EventSource>) {
        super(...args)
        this.addEventListener('open', () => Reflect.set(window, 'listening', true))
      }
    }
  })
  // A page asks to hear of reloads only once its script runs, so holding that request back stands in for a page that a busy machine is slow to reload.
  const asked: HTTPRequest[] = []
  let holding = false
  let loads = 0
  await tab.setRequestInterception(true)
  tab.on('request', (request) => {
    const listens = request.url().includes('/events?')
    if (listens) asked.push(request)
    if (request.isNavigationRequest()) loads += 1
    if (!(listens && holding)) request.continue().catch(() => {})
  })
  // The page reloads for the first save, and asks to hear of reloads only once run has built the second.
  const late = async (first: string, second: string, built: () => Promise<void>) => {
    await tab.waitForFunction(() => Reflect.get(window, 'listening') === true, { timeout: 10_000 })
    holding = true
    const reloaded = tab.waitForNavigation()
    const before = asked.length
    writeFileSync(file, first)
    await reloaded
    await until('the reloaded page to ask to hear of reloads', () => asked.length > before)
    writeFileSync(file, second)
    await built()
    holding = false
    await asked.at(-1)?.continue()
  }
  await openPage(tab, url)

  await late(save(2), save(2).replace('update() {}', 'update() {'), () => until("run to print the save that doesn't build", () => errors.includes('\n')))
  const notice = await tab.waitForSelector('pre', { timeout: 10_000 })
  assert.equal(await notice?.evaluate((box) => box.textContent), `${errors.trim()}\n\nFix the game and save; the page reloads.`)

  // The script run serves changes once a save that builds has built, as run reloads its pages for it.
  const served = async (text: string) => {
    for (const deadline = Date.now() + 10_000; !(await (await fetch(new URL('bundle.js', url))).text()).includes(text); await new Promise((wait) => setTimeout(wait, 20))) {
      if (Date.now() > deadline) throw new Error(`gave up waiting for run to build ${text}`)
    }
  }
  await late(save(3), save(4), () => served('save: 4'))
  await tab.waitForFunction(() => window.engine?.state('dot')[0].save === 4, { timeout: 10_000 })
  // Then the page stays: told to reload once more, it would ask for its document again within moments of listening, and then to hear of reloads.
  await tab.waitForFunction(() => Reflect.get(window, 'listening') === true, { timeout: 10_000 })
  const settled = { loads, listens: asked.length }
  await new Promise((wait) => setTimeout(wait, 500))
  assert.deepEqual({ loads, listens: asked.length }, settled, 'the page that plays save 4 went on reloading')
})

// Each tick, what the game sees of its input: the keys held, the keys pressed, both in KEYS's order, and where the pointer is, exactly; and a number from ctx.random(), which only the seed decides. Enter ends the game with an error.
const SEEN = [
  "import { KEYS, defineGame, listOf } from 'threejam'",
  '',
  'export default defineGame({',
  "  entities: { probe: { w: 0.1, h: 0.1, seen: listOf('') } },",
  '  update({ probe }, ctx) {',
  "    if (ctx.input.pressed('Enter')) throw new Error('Enter ends this game')",
  '    const { x, y } = ctx.input.pointer',
  "    const held = KEYS.filter((key) => ctx.input.held(key)).join(' ')",
  "    const pressed = KEYS.filter((key) => ctx.input.pressed(key)).join(' ')",
  '    probe.seen.push(`${held} / ${pressed} @ ${x} ${y} ${ctx.random()}`)',
  '  },',
  '})',
  '',
].join('\n')

// run with --record on a game in a folder of its own, and what it prints.
async function recordRun(t: TestContext, seed: number) {
  const dir = mkdtempSync(join(TMP, 'playtest-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), SEEN)
  const shown = relative(ROOT, dir).replaceAll(sep, '/')
  const record = `${shown}/tests/playtest.ts`
  const run = spawnCli(['run', shown, '--serve-only', '--seed', String(seed), '--record', record], t.signal)
  const printed = { out: '' }
  run.stdout.on('data', (chunk) => (printed.out += chunk))
  const exited = new Promise((done) => run.once('close', done))
  await until('run to serve the page', () => printed.out.includes('\n'))
  const url = printed.out.slice(printed.out.lastIndexOf(' ') + 1, -1)
  assert.equal(printed.out, `Playing ${shown} with seed ${seed}, recording to ${record}, at ${url}\n`)
  const tab = await newTab(t)
  await openPage(tab, url)
  await tab.waitForFunction('window.engine !== undefined')
  // Waits until the page has played count more ticks, in its own time.
  const ticks = async (count: number) => {
    const from = await tab.evaluate(() => window.engine.tick)
    await tab.waitForFunction((last: number) => window.engine.tick >= last, {}, from + count)
  }
  const pause = () => tab.evaluate(() => (window.engine.pause(), { tick: window.engine.tick, entities: window.engine.state() }))
  return { dir, shown, record, file: join(ROOT, record), run, printed, exited, tab, ticks, pause }
}

test('a playtest that run records replays in sim, in simulate, and in a page to the state the page reached tick for tick, keys, taps, and the mouse alike, holds nothing after its last tick, and refuses another seed', { skip: !chrome && 'needs Chrome' }, async (t) => {
  const { dir, shown, record, file, printed, exited, tab, ticks, pause } = await recordRun(t, 7)
  await tab.keyboard.down('KeyD')
  await ticks(3)
  await tab.keyboard.up('KeyD')
  // A save reloads the page, which starts the game and the playtest over.
  const reloaded = tab.waitForNavigation()
  writeFileSync(join(dir, 'game.ts'), SEEN.replace('w: 0.1', 'w: 0.2'))
  await reloaded
  await tab.waitForFunction('window.engine !== undefined')
  await tab.keyboard.down('KeyW')
  await ticks(4)
  // Between pixels, so the pointer lands on numbers like 0.061249999999999805, which a replay must have exactly.
  await tab.mouse.move(412.25, 150.75)
  await ticks(2)
  await tab.keyboard.press('Space')
  await ticks(2)
  await tab.keyboard.up('KeyW')
  await tab.mouse.down()
  await tab.mouse.move(799.5, 0.25, { steps: 3 })
  await ticks(3)
  await tab.mouse.up()
  await tab.mouse.down({ button: 'right' })
  await ticks(2)
  await tab.mouse.up({ button: 'right' })
  // Held through Esc, so the ticks after the playtest's last show whether it lets go.
  await tab.keyboard.down('KeyS')
  await ticks(2)
  const played = await pause()
  await tab.keyboard.press('Escape')
  await tab.keyboard.up('KeyS')
  assert.equal(await exited, 0)
  const replay = `threejam sim ${shown} --driver ${record} --seed 7 --ticks ${played.tick}`
  assert.equal(printed.out.slice(printed.out.indexOf('\n') + 1), `Saved the playtest, ${played.tick} ticks with seed 7, to ${record}; replay it with ${replay}\nStopped.\n`)
  const [probe] = played.entities
  assert.ok(probe.w === 0.2 && Array.isArray(probe.seen) && probe.seen.length === played.tick, JSON.stringify(probe))

  assert.deepEqual((await runGame(dir, { ticks: played.tick, seed: 7, driver: file })).snapshots[0].entities, played.entities)
  const game = parseGame(Reflect.get(await import(pathToFileURL(join(dir, 'game.ts')).href), 'default'))
  const drive: unknown = Reflect.get(await import(pathToFileURL(file).href), 'default')
  assert.ok(isDrive(drive))
  assert.deepEqual(simulate(game, { ticks: played.tick, seed: 7, drive }).snapshots[0].entities, played.entities)
  const [{ seen: longer }] = simulate(game, { ticks: played.tick + 3, seed: 7, drive }).snapshots[0].entities
  assert.ok(Array.isArray(longer) && longer.slice(-3).every((seen) => String(seen).startsWith(' /  @ ')), JSON.stringify(longer))
  await assert.rejects(runGame(dir, { ticks: 1, seed: 8, driver: file }), { message: 'this playtest was recorded with seed 7, so replay it with seed 7' })

  const page = await buildPage({ dir, config: { mode: 'shot' }, driver: file })
  const server = await serve({ page })
  try {
    const replayTab = await newTab(t)
    await openPage(replayTab, server.url)
    await replayTab.waitForFunction('window.engine !== undefined')
    const replayed = await replayTab.evaluate((last: number) => {
      window.engine.reset({ seed: 7, drive: true })
      window.engine.advanceTo(last)
      return window.engine.state()
    }, played.tick)
    assert.deepEqual(replayed, played.entities)
  } finally {
    server.close()
    await page.dispose()
  }
})

test('run saves what its page has sent when a signal stops it instead of Esc: the parts the page sends as it plays, and every tick through one where the game fails, at which the replay fails too', { skip: (!chrome && 'needs Chrome') || (process.platform === 'win32' && 'Node ends a process on Windows without the signal its handlers would hear') }, async (t) => {
  const { dir, record, file, run, printed, exited, tab, ticks, pause } = await recordRun(t, 3)
  const sent: string[] = []
  tab.on('response', (response) => void (response.url().includes('/record?') && response.status() === 204 && sent.push(new URL(response.url()).searchParams.get('ticks') ?? '')))
  await tab.keyboard.down('ArrowLeft')
  await ticks(5)
  await tab.mouse.click(200.5, 450.5)
  await ticks(3)
  // Paused, the page sends only as it goes, since nothing has ended the session.
  const played = await pause()
  await until('the page to send run every tick it played', () => sent.includes(String(played.tick)))
  await tab.evaluate(() => window.engine.resume())
  await ticks(2)
  await tab.keyboard.press('Enter')
  await tab.waitForSelector('pre')
  const failed = await tab.evaluate(() => window.engine.tick)
  await until('the page to send run the tick where the game failed', () => sent.includes(String(failed)))
  run.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.match(printed.out, new RegExp(`\nSaved the playtest, ${failed} ticks with seed 3, to ${record.replaceAll('.', '\\.')}; replay it with [^\n]+\nStopped\\.\n$`))
  assert.deepEqual((await runGame(dir, { ticks: played.tick, seed: 3, driver: file })).snapshots[0].entities, played.entities)
  await assert.rejects(runGame(dir, { ticks: failed, seed: 3, driver: file }), (error: unknown) => error instanceof RunError && error.phase === 'update' && error.tick === failed && error.message === 'Enter ends this game')
})

test("a run --record page that a browser client takes over with advanceTime records from the takeover's tick 0, with a key still held then, the pointer where the mouse was, and without a tap from before, sends it as the client steps it, and the playtest replays in simulate to what render_game_to_text gave", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const { dir, shown, record, file, printed, exited, tab, ticks } = await recordRun(t, 4)
  // The ticks each send runs through, of the sends the page starts once the client has taken it over, which can only be the new session's.
  let takenOver = false
  const sentSince = new WeakSet<HTTPRequest>()
  const sent: string[] = []
  tab.on('request', (request) => void (takenOver && request.url().includes('/record?') && sentSince.add(request)))
  tab.on('response', (response) => void (sentSince.has(response.request()) && response.status() === 204 && sent.push(new URL(response.url()).searchParams.get('ticks') ?? '')))
  // As the client's first burst does, before its first call: the page plays on with them, so the session before the takeover has them too.
  await tab.keyboard.down('KeyA')
  await tab.mouse.move(600, 450)
  await ticks(5)
  // A tap just before the first call, which starts the run over without it.
  await tab.evaluate(async () => {
    for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code: 'Space' }))
    await window.advanceTime(1000 / 60)
  })
  takenOver = true
  // One call a frame, each in a call of its own, as the client makes them.
  const frames = async (count: number) => {
    for (let frame = 0; frame < count; frame++) await tab.evaluate(() => window.advanceTime(1000 / 60))
  }
  await frames(2)
  await tab.keyboard.down('KeyD')
  await frames(3)
  await tab.mouse.move(250.5, 120.25)
  await frames(2)
  await tab.keyboard.up('KeyA')
  await tab.keyboard.press('Space')
  await frames(3)
  const text = JSON.parse(await tab.evaluate(() => window.render_game_to_text()))
  // A client never presses Esc, which sends the rest, so the playtest is what the page sends while the client holds its clock.
  await until('the page to send run every tick the client stepped', () => sent.includes('11'))
  await tab.keyboard.press('Escape')
  await tab.keyboard.up('KeyD')
  assert.equal(await exited, 0)
  const replay = `threejam sim ${shown} --driver ${record} --seed 4 --ticks 11`
  assert.equal(printed.out.slice(printed.out.indexOf('\n') + 1), `Saved the playtest, 11 ticks with seed 4, to ${record}; replay it with ${replay}\nStopped.\n`)
  assert.match(text.entities[0].seen[0], /^A \/ A @ 1 -0\.75 /)
  const game = parseGame(Reflect.get(await import(pathToFileURL(join(dir, 'game.ts')).href), 'default'))
  const drive: unknown = Reflect.get(await import(pathToFileURL(file).href), 'default')
  assert.ok(isDrive(drive))
  assert.deepEqual(asText(simulate(game, { ticks: 11, seed: 4, drive }).snapshots[0]), text)
})

test("a played page that fails as it runs, or whose image won't load, stops and says why on the page, and in run what to fix", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const game = (update: string, rock = 'w: 1, h: 1') => `import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { rock: { ${rock} } }, update(world, ctx) { ${update} } })\n`
  const stops = game("if (ctx.tick === 3) throw new Error('no tick 3')")
  const draw = "import type { ViewFrame } from 'threejam'\n\nexport function draw({ tick }: ViewFrame): void {\n  if (tick > 1) throw new Error('no frame today')\n}\n"
  // The notice, and the tick 5 frames after it shows, by when a page that played on would be past the tick that failed.
  const shown = async (tab: Page, url: string) => {
    await openPage(tab, url)
    await tab.waitForSelector('pre')
    return tab.evaluate(async () => {
      for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame)
      return [document.querySelector('pre')?.textContent, window.engine?.tick]
    })
  }
  const token = 'session-token'
  const cases: ReadonlyArray<readonly [Record<string, string | Buffer>, RegExp, number | null]> = [
    [{ 'game.ts': stops }, /^no tick 3\n\nFix the game and save; the page reloads\.$/, 3],
    [{ 'game.ts': game(''), 'view.ts': draw }, /^view\.ts: no frame today \(in draw at tick \d+\)\n\nFix the game and save; the page reloads\.$/, null],
    [{ 'game.ts': game('', "w: 1, h: 1, image: 'rock.png'"), 'rock.png': 'not a png' }, /^the image rock\.png couldn't be loaded; check that the file is a whole image of its type\n\nFix the file and save; the page reloads\.$/, null],
  ]
  for (const [files, notice, tick] of cases) {
    const dir = mkdtempSync(join(TMP, 'stops-'))
    made.push(dir)
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
    const page = await buildPage({ dir, config: { mode: 'run', seed: 0, token } })
    const server = await serve({ page, token })
    try {
      const [text, at] = await shown(await newTab(t), server.url)
      assert.match(String(text), notice)
      if (tick !== null) assert.equal(at, tick)
    } finally {
      server.close()
      await page.dispose()
    }
  }
  const dir = mkdtempSync(join(TMP, 'stops-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), stops)
  await exportGame({ dir, out: join(dir, 'stops.html') })
  assert.deepEqual(await shown(await newTab(t), pathToFileURL(join(dir, 'stops.html')).href), ['no tick 3', 3])
})

test("a run page whose game or view.ts fails as it loads says why on the page, instead of staying blank, and still reloads when a fix is saved and quits with Esc", { skip: !chrome && 'needs Chrome' }, async (t) => {
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
    let quits = 0
    const server = await serve({ page, token, onQuit: () => (quits += 1) })
    try {
      const tab = await newTab(t)
      const listening = tab.waitForResponse((response) => response.url().includes('/events?'))
      await openPage(tab, server.url)
      await tab.waitForSelector('pre')
      const shown = await tab.$eval('pre', (box) => box.textContent ?? '')
      assert.ok(shown.startsWith(reason) && shown.endsWith('\n\nFix the game and save; the page reloads.'), shown)
      assert.equal((await listening).status(), 200, `the page ${reason} doesn't listen for reloads`)
      await tab.keyboard.press('Escape')
      await until(`Esc to end the session on the page ${reason}`, () => quits === 1)
    } finally {
      server.close()
      await page.dispose()
    }
  }
})

// How long shot took with each stuck page, and how it ended the page's Chrome.
async function stuckPages(): Promise<string[]> {
  const stuckAt = async (view: string, timeout: number, when: string) => {
    const dir = mkdtempSync(join(TMP, 'stuck-'))
    made.push(dir)
    writeFileSync(join(dir, 'game.ts'), "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1 } }, update() {} })\n")
    writeFileSync(join(dir, 'view.ts'), view)
    // The Chrome that shot starts, as Node's child_process channel shows it.
    const spawned: ChildProcess[] = []
    const spot = (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'process' in message && message.process instanceof ChildProcess) spawned.push(message.process)
    }
    subscribe('child_process', spot)
    const started = Date.now()
    try {
      await assert.rejects(shoot({ dir, at: [1, 2], out: join(dir, 'frame.png'), timeout }), {
        name: 'LimitError',
        message: `the page ran past the ${timeout} s time limit ${when}; look for a loop that never ends in view.ts, or allow more time with --timeout`,
      })
    } finally {
      unsubscribe('child_process', spot)
    }
    const took = Date.now() - started
    const shotChrome = spawned.find((child) => child.spawnargs.includes('--remote-debugging-pipe'))
    assert.ok(shotChrome, `shot started no Chrome with a page stuck ${when}`)
    if (shotChrome.exitCode === null && shotChrome.signalCode === null) await once(shotChrome, 'exit')
    // Closing Chrome ends it with 0, and killing it ends it by SIGKILL, or on Windows, where taskkill sends no signal, with another code.
    const ended = shotChrome.signalCode ?? shotChrome.exitCode
    assert.ok(process.platform === 'win32' ? ended !== 0 : ended === 'SIGKILL', `shot ended its Chrome with ${ended} with a page stuck ${when}, rather than killing it`)
    // The limit runs from the moment the page loads, so shot can't stop before it has passed, however fast or slow the machine.
    assert.ok(took >= timeout * 1000, `shot stopped ${took} ms into a time limit of ${timeout} s with a page stuck ${when}`)
    return `shot took ${took} ms with a page stuck ${when}, against a time limit of ${timeout} s, and killed its Chrome, which ended with ${ended}`
  }
  // The page never finishes loading, so the limit runs out as it loads however fast the machine is.
  const loading = await stuckAt('for (;;) {}\n', 2, 'as it loaded')
  // Loading and drawing tick 1 take well under this even on a slow machine, so the limit runs out at tick 2.
  return [loading, await stuckAt("import type { ViewFrame } from 'threejam'\n\nexport function draw({ tick }: ViewFrame): void {\n  if (tick === 2) for (;;) {}\n}\n", 8, 'drawing tick 2')]
}

// The stuck pages run beside the page tests before this one, so its own duration leaves their time out, and it reports it instead.
test("shot's page gets --timeout too, from the moment it loads, so a view.ts that never returns fails with TIMEOUT and Chrome is killed", { skip: !chrome && 'needs Chrome' }, async (t) => {
  for (const line of await stuckShots()) t.diagnostic(line)
})
