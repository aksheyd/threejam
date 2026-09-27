import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import puppeteer from 'puppeteer-core'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { buildPage, findChrome, serve } from '../src/serve.ts'
import { shoot } from '../src/shot.ts'

const chrome = findChrome()

test('the page reaches exactly the state sim computes for the same inputs', { skip: !chrome && 'needs Chrome' }, async () => {
  const inputs = { seed: 7, ticks: 900, press: ['Space@1'], hold: ['W@1-120', 'Down@200-500'] }
  const expected = simulate(pong, inputs).snapshots[0].entities
  const page = await buildPage('games/pong', { mode: 'shot' })
  const server = await serve(page.outdir)
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const tab = await browser.newPage()
    await tab.goto(server.url)
    await tab.waitForFunction('window.engine !== undefined')
    const actual = await tab.evaluate((o) => {
      const engine = window.engine as { reset(o: unknown): number; advanceTo(t: number): number; state(): unknown }
      engine.reset(o)
      engine.advanceTo(o.ticks)
      return engine.state()
    }, inputs)
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
    const files = await shoot('games/pong', { at: [1, 30], out: join(dir, 'new', 'frame.png') })
    assert.deepEqual(files, [join(dir, 'new', 'frame-001.png'), join(dir, 'new', 'frame-030.png')])
    for (const file of files) assert.equal(readFileSync(file).toString('latin1', 1, 4), 'PNG')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
