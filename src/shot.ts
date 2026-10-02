import { mkdirSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { UsageError, quote } from './errors.ts'
import { buildPage, findChrome, serve, type Server } from './serve.ts'
import type { ResetOptions } from './browser/client.ts'

export interface ShotOptions {
  readonly dir: string
  readonly at: readonly number[]
  readonly out: string
  readonly seed?: number
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly pointer?: readonly string[]
  readonly driver?: string
  readonly set?: readonly string[]
}

export function parseTicks(text: string): number[] {
  const ticks = text.split(',').map((part) => Number(part.trim()))
  if (ticks.some((tick) => !Number.isInteger(tick) || tick < 0)) {
    throw new UsageError(`--at ${quote(text)} should be whole ticks from 0 up, like 1,120,600`)
  }
  return [...new Set(ticks)].sort((a, b) => a - b)
}

export function framePaths(out: string, at: readonly number[]): string[] {
  if (at.length === 1) return [out]
  const width = Math.max(3, String(Math.max(...at)).length)
  const extension = extname(out)
  const stem = out.slice(0, out.length - extension.length)
  return at.map((tick) => `${stem}-${String(tick).padStart(width, '0')}${extension || '.png'}`)
}

// Chrome on Windows sometimes aborts a new tab's first navigation, so an aborted one gets one more try.
export async function openPage(tab: Page, url: string): Promise<void> {
  try {
    await tab.goto(url, { waitUntil: 'load' })
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('net::ERR_ABORTED'))) throw error
    await tab.goto(url, { waitUntil: 'load' })
  }
}

export async function shoot({ dir, at, out, seed, press, hold, pointer, driver, set }: ShotOptions): Promise<string[]> {
  const chrome = findChrome()
  if (!chrome) throw new UsageError('shot needs Chrome or Chromium, or Edge on Windows; set CHROME_PATH to its executable')
  const page = await buildPage({ dir, config: { mode: 'shot' }, driver })
  let server: Server | undefined
  let browser: Browser | undefined
  try {
    server = await serve({ page })
    // Only shot loads Puppeteer, so the other commands start without it.
    const { default: puppeteer } = await import('puppeteer-core')
    // Software rendering makes frames the same on every machine.
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
    })
    const tab = await browser.newPage()
    await tab.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 })
    const crashed = pageFailure(tab)
    const until = <T>(work: Promise<T>) => Promise.race([work, crashed])
    await until(openPage(tab, server.url))
    await until(tab.waitForFunction('window.engine !== undefined', { timeout: 15000 }))
    const reset: ResetOptions = { seed: seed ?? 0, ticks: Math.max(...at), press, hold, pointer, set, drive: driver !== undefined }
    await until(tab.evaluate((options) => window.engine.reset(options), reset))
    const paths = framePaths(out, at)
    for (const path of paths) mkdirSync(dirname(path), { recursive: true })
    for (const [i, tick] of at.entries()) {
      await until(tab.evaluate((t) => window.engine.advanceTo(t), tick))
      await tab.screenshot({ path: pngPath(paths[i]), clip: { x: 0, y: 0, width: 800, height: 600 } })
    }
    return paths
  } finally {
    await browser?.close()
    server?.close()
    await page.dispose()
  }
}

function pageFailure(tab: Page): Promise<never> {
  const failed = new Promise<never>((_, reject) => {
    tab.on('pageerror', (error) => reject(new Error(`the page failed: ${error instanceof Error ? error.message : String(error)}`)))
  })
  failed.catch(() => {})
  return failed
}

function pngPath(path: string): `${string}.png` {
  if (!path.endsWith('.png')) throw new UsageError(`${path} must end in .png`)
  return `${path.slice(0, -4)}.png`
}
