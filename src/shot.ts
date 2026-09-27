import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import puppeteer from 'puppeteer-core'
import { UsageError } from './errors.ts'
import { buildPage, findChrome, serve } from './serve.ts'

export interface ShotOptions {
  at: number[]
  out: string
  seed?: number
  press?: string[]
  hold?: string[]
  set?: string[]
}

export function parseTicks(text: string): number[] {
  const ticks = text.split(',').map((part) => Number(part.trim()))
  if (ticks.some((tick) => !Number.isInteger(tick) || tick < 0)) {
    throw new UsageError(`--at ${JSON.stringify(text)} should be whole ticks from 0 up, like 1,120,600`)
  }
  return [...new Set(ticks)].sort((a, b) => a - b)
}

export function framePaths(out: string, at: number[]): string[] {
  if (at.length === 1) return [out]
  const width = Math.max(3, String(Math.max(...at)).length)
  const dot = out.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [out.slice(0, dot), out.slice(dot)] : [out, '.png']
  return at.map((tick) => `${stem}-${String(tick).padStart(width, '0')}${extension}`)
}

export async function shoot(dir: string, options: ShotOptions): Promise<string[]> {
  const chrome = findChrome()
  if (!chrome) throw new UsageError('shot needs Chrome or Chromium; set CHROME_PATH to its executable')
  const page = await buildPage(dir, { mode: 'shot' })
  const server = await serve(page.outdir)
  // Software rendering makes frames the same on every machine.
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
  })
  try {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 })
    const errors: string[] = []
    tab.on('pageerror', (error) => errors.push(error instanceof Error ? error.message : String(error)))
    await tab.goto(server.url, { waitUntil: 'load' })
    await tab.waitForFunction('window.engine !== undefined', { timeout: 15000 }).catch(() => {
      throw new Error(`the page didn't start${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`)
    })
    const ticks = Math.max(...options.at)
    const reset = { seed: options.seed ?? 0, ticks, press: options.press, hold: options.hold, set: options.set }
    await tab.evaluate((o) => (window.engine as { reset(o: unknown): number }).reset(o), reset)
    const paths = framePaths(options.out, options.at)
    for (const path of paths) mkdirSync(dirname(path), { recursive: true })
    for (const [i, tick] of options.at.entries()) {
      await tab.evaluate((t) => (window.engine as { advanceTo(t: number): number }).advanceTo(t), tick)
      await tab.screenshot({ path: paths[i] as `${string}.png`, clip: { x: 0, y: 0, width: 800, height: 600 } })
    }
    return paths
  } finally {
    await browser.close()
    server.close()
    await page.dispose()
  }
}
