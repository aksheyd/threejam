import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Page } from 'puppeteer-core'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { exportGame } from '../src/export.ts'
import { runGame } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { buildPage, findChrome, serve } from '../src/serve.ts'
import { launchChrome, openPage, shoot } from '../src/shot.ts'
import { PROBE, checkProbe } from './probe.ts'

const chrome = findChrome()
// A page call that hangs fails within a minute, well inside CI's job timeout, so the report says why.
const launch = () => launchChrome(chrome ?? 'no Chrome', { protocolTimeout: 60_000 })
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

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

test('with a driver that taps using the keys of the tick before, the page reaches the state sim computes, parts and all', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'driver-'))
  made.push(dir)
  const driver = join(dir, 'flap.ts')
  writeFileSync(driver, FLAP)
  const expected = (await runGame('games/flappy', { seed: 7, ticks: 900, driver })).snapshots[0].entities
  assert.ok(expected.some((entity) => entity.name === 'pipes[2].parts.bottom_cap'))
  const page = await buildPage({ dir: 'games/flappy', config: { mode: 'shot' }, driver })
  const server = await serve({ page })
  const browser = await launch()
  try {
    const tab = await browser.newPage()
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 7, drive: true })
      window.engine.advanceTo(900)
      return window.engine.state()
    })
    assert.deepEqual(actual, expected)
  } finally {
    await browser.close()
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

test('with the portable math, trig-heavy code reaches the same state in the page as in sim', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'math-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), MATH_HEAVY)
  const expected = (await runGame(dir, { ticks: 600 })).snapshots[0].entities
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  const browser = await launch()
  try {
    const tab = await browser.newPage()
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 0 })
      window.engine.advanceTo(600)
      return window.engine.state()
    })
    assert.deepEqual(actual, expected)
  } finally {
    await browser.close()
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

test("in another locale and time zone, the page computes what sim does and refuses what sim refuses, even through what a game's top level keeps", { skip: !chrome && 'needs Chrome' }, async () => {
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
  const browser = await launch()
  try {
    const tab = await browser.newPage()
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
    await browser.close()
    server.close()
    await page.dispose()
  }
})

test("review blockers 1 to 4 in a page set to de-DE and Asia/Kolkata: game code finds no frame, no host global, and no path to the platform's clock, zone, or locale, a promise can't write after its tick, and every reset gives sim's state", { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'probe-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), PROBE)
  const expected = (await runGame(dir, { ticks: 2 })).snapshots[0].entities
  checkProbe(expected[0].out, { bare: true })
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  const browser = await launch()
  try {
    const tab = await browser.newPage()
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
    await browser.close()
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

test("a page that runs ticks in one batch or in several gives sim's run of a game that makes a global, sets one the page has, and puts its own Math.random in place, and the page keeps its own", { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'keeper-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), KEEPER)
  const expected = (await runGame(dir, { ticks: 3 })).snapshots[0].entities
  assert.deepEqual(expected, [{ name: 'probe', seen: ['undefined undefined refused', '1 player 0.25', '2 player 0.25'] }])
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  const browser = await launch()
  try {
    for (const batches of [1, 3]) {
      const tab = await browser.newPage()
      await openPage(tab, server.url)
      await tab.waitForFunction('window.engine !== undefined')
      const actual = await tab.evaluate((batches: number) => {
        window.engine.reset({ seed: 0 })
        if (batches === 1) window.engine.advanceTo(3)
        else for (let tick = 1; tick <= batches; tick++) window.engine.step()
        return { state: window.engine.state(), name: [typeof Object.getOwnPropertyDescriptor(window, 'name')?.get, window.name] }
      }, batches)
      assert.deepEqual(actual, { state: expected, name: ['function', ''] }, `${batches} batches`)
      await tab.close()
    }
  } finally {
    await browser.close()
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

test('from the first frame the page draws images with square pixels and turned parts where sim puts them, and follows a mouse schedule as sim does', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'picture-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), PICTURE)
  writeFileSync(join(dir, 'quad.png'), Buffer.from(QUAD_PNG, 'base64'))
  const input = { ticks: 6, press: ['Mouse@2,4'], hold: ['MouseRight@3-5'], pointer: ['0.5,0.25@3', '-1.5,-1@5'] }
  const expected = (await runGame(dir, input)).snapshots[0].entities
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  const server = await serve({ page })
  const browser = await launch()
  try {
    const tab = await browser.newPage()
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
    await browser.close()
    server.close()
    await page.dispose()
  }
})

test('played by the mouse autopilot, Asteroids reaches the state sim computes in the page, which records the sounds sim lists', { skip: !chrome && 'needs Chrome' }, async () => {
  const driver = join('games', 'asteroids', 'autopilot.ts')
  const expected = await runGame('games/asteroids', { ticks: 600, driver })
  assert.ok(expected.sounds.some((sound) => sound.name === 'explode'))
  const page = await buildPage({ dir: 'games/asteroids', config: { mode: 'shot' }, driver })
  const server = await serve({ page })
  const browser = await launch()
  try {
    const tab = await browser.newPage()
    await openPage(tab, server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate(() => {
      window.engine.reset({ seed: 0, drive: true })
      window.engine.advanceTo(600)
      return { entities: window.engine.state(), sounds: window.engine.sounds() }
    })
    assert.deepEqual(actual, { entities: expected.snapshots[0].entities, sounds: expected.sounds })
  } finally {
    await browser.close()
    server.close()
    await page.dispose()
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

test('an exported file opened from disk starts with the seed export fixed, runs its view.ts, and reaches the state sim computes for scheduled keys', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-export-'))
  const browser = await launch()
  try {
    const file = join(dir, 'pong.html')
    await exportGame({ dir: 'games/pong', out: file, seed: 9 })
    const input = { seed: 4, ticks: 600, press: ['Space@1'], hold: ['W@1-60', 'Down@30-200'] }
    const expected = simulate(pong, input).snapshots[0].entities
    const tab = await browser.newPage()
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
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exported Asteroids draws its SVG rocks and plays sounds with nothing but the file, and picks a new seed each load', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-export-'))
  const browser = await launch()
  try {
    const file = join(dir, 'asteroids.html')
    await exportGame({ dir: 'games/asteroids', out: file })
    const tab = await browser.newPage()
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
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit 48: shot repeats a frame byte for byte on one machine, images and text included', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-shot-'))
  try {
    const driver = join('games', 'asteroids', 'autopilot.ts')
    const shots = await Promise.all(['one', 'two'].map((name) => shoot({ dir: 'games/asteroids', at: [120], driver, out: join(dir, name, 'frame.png') })))
    const [first, second] = shots.map(([file]) => readFileSync(file))
    assert.ok(first.equals(second), 'two shots of one run differ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a page that fails in shot is the game's failure, told in one line without the page's stack or the server's address", { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'broken-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { rock: { w: 1, h: 1, image: 'rock.png' } }, update() {} })\n")
  writeFileSync(join(dir, 'rock.png'), 'not a png')
  await assert.rejects(shoot({ dir, at: [1], out: join(dir, 'frame.png') }), {
    name: 'GameError',
    message: "the page failed: the image rock.png couldn't be loaded; check that the file is a whole image of its type",
  })
})

test('shot writes one PNG per tick into a folder it creates', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-shot-'))
  try {
    const files = await shoot({ dir: 'games/pong', at: [1, 30], out: join(dir, 'new', 'frame.png') })
    assert.deepEqual(files, [join(dir, 'new', 'frame-001.png'), join(dir, 'new', 'frame-030.png')])
    for (const file of files) assert.equal(readFileSync(file).toString('latin1', 1, 4), 'PNG')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
