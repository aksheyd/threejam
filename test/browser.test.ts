import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import puppeteer, { type Page } from 'puppeteer-core'
import asteroids from '../games/asteroids/game.ts'
import flappy from '../games/flappy/game.ts'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { exportGame } from '../src/export.ts'
import { gameFiles, loadDriver, loadGame } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { buildPage, findChrome, serve } from '../src/serve.ts'
import { openPage, shoot } from '../src/shot.ts'

const chrome = findChrome()
// A page call that hangs fails within a minute, well inside CI's job timeout, so the report says why.
const launch = () => puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 60_000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
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
  const expected = simulate(flappy, { seed: 7, ticks: 900, drive: await loadDriver(driver) }).snapshots[0].entities
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
  const expected = simulate(await loadGame(dir), { ticks: 600 }).snapshots[0].entities
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
  const expected = simulate(await loadGame(dir), { ...input, assets: gameFiles(dir).assets }).snapshots[0].entities
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
  const expected = simulate(asteroids, { ticks: 600, drive: await loadDriver(driver) })
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
