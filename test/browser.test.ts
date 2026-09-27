import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import puppeteer from 'puppeteer-core'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { ROOT, loadDriver, loadGame } from '../src/load.ts'
import { buildPage, findChrome, serve } from '../src/serve.ts'
import { shoot } from '../src/shot.ts'

const chrome = findChrome()
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const FOLLOW = [
  "import type { Driver, EntitiesOf } from 'fourjs'",
  "import type pong from '../../../games/pong/game.ts'",
  '',
  'const follow: Driver<EntitiesOf<typeof pong>> = ({ world, tick }) => {',
  "  if (tick === 1) return ['Space']",
  '  const gap = world.ball.y - world.left_paddle.y',
  "  return gap > 0.05 ? ['W'] : gap < -0.05 ? ['S'] : []",
  '}',
  'export default follow',
  '',
].join('\n')

test('with a driver, the page reaches exactly the state sim computes', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'driver-'))
  made.push(dir)
  const driver = join(dir, 'follow.ts')
  writeFileSync(driver, FOLLOW)
  const expected = simulate(pong, { seed: 7, ticks: 900, drive: await loadDriver(driver) }).snapshots[0].entities
  const page = await buildPage({ dir: 'games/pong', config: { mode: 'shot' }, driver })
  const server = await serve({ outdir: page.outdir })
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const tab = await browser.newPage()
    await tab.goto(server.url)
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
  "import { defineGame } from 'fourjs'",
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
  const server = await serve({ outdir: page.outdir })
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const tab = await browser.newPage()
    await tab.goto(server.url)
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

test('shot writes one PNG per tick into a folder it creates', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fourjs-shot-'))
  try {
    const files = await shoot({ dir: 'games/pong', at: [1, 30], out: join(dir, 'new', 'frame.png') })
    assert.deepEqual(files, [join(dir, 'new', 'frame-001.png'), join(dir, 'new', 'frame-030.png')])
    for (const file of files) assert.equal(readFileSync(file).toString('latin1', 1, 4), 'PNG')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
