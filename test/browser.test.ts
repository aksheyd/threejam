import assert from 'node:assert/strict'
import { test } from 'node:test'
import puppeteer from 'puppeteer-core'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { buildPage, findChrome, serve } from '../src/serve.ts'

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
