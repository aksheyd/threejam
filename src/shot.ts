import { once } from 'node:events'
import { accessSync, constants, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import type { Browser, Page } from 'puppeteer-core'
import { BrowserError, GameError, IoError, UsageError, quote } from './errors.ts'
import { LimitError, gameFailure, isSystemError, timeLimit } from './load.ts'
import { makeFolder, saveFile } from './output.ts'
import { NO_DEVTOOLS_PORT, buildPage, chromeEnv, findChrome, removeProfile, removeSocketFolders, serve, socketFolders, tmpdirHint, type Server } from './serve.ts'
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
  // Seconds the page may spend running the game and its view.ts, DEFAULT_TIMEOUT unless given.
  readonly timeout?: number
}

export function parseTicks(text: string): number[] {
  const parts = text.split(',').map((part) => part.trim())
  if (parts.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)))) {
    throw new UsageError(`--at ${quote(text)} should be whole ticks from 0 up, like 1,120,600`)
  }
  return [...new Set(parts.map(Number))].sort((a, b) => a - b)
}

// One rule for one tick or many, checked before Chrome starts.
export function framePaths(out: string, at: readonly number[]): string[] {
  if (!/\.png$/i.test(out)) throw new UsageError(`-o ${quote(out)} should be a .png file, like frame.png`)
  if (at.length === 1) return [out]
  const width = Math.max(3, String(Math.max(...at)).length)
  // Past the check above, the name ends in .png in some case, even a name that's only that.
  const [stem, extension] = [out.slice(0, -4), out.slice(-4)]
  return at.map((tick) => `${stem}-${String(tick).padStart(width, '0')}${extension}`)
}

// Chrome on Windows sometimes aborts a new tab's first navigation, so an aborted one gets one more try.
export async function openPage(tab: Page, url: string, { timeout }: { timeout?: number } = {}): Promise<void> {
  try {
    await tab.goto(url, { waitUntil: 'load', timeout })
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('net::ERR_ABORTED'))) throw error
    await tab.goto(url, { waitUntil: 'load', timeout })
  }
}

// Headless Chrome, driven over a pipe instead of a DevTools port, with only the environment it needs; profile, when given, holds its profile, temp its temporary files in place of TMPDIR, by default on Windows a folder in the profile, switches go before ThreeJam's own, which they can't override, and signal kills it with every process it started.
export async function launchChrome(chrome: string, { protocolTimeout, profile, temp = profileTemp(profile), switches = [], signal }: { protocolTimeout?: number; profile?: string; temp?: string; switches?: readonly string[]; signal?: AbortSignal } = {}): Promise<Browser> {
  const where = chrome.replaceAll(sep, '/')
  const found = statSync(chrome, { throwIfNoEntry: false })
  if (found === undefined) throw new BrowserError(`there's no Chrome at ${where}; set CHROME_PATH to the executable of Chrome or Chromium, or Edge on Windows`)
  if (found.isDirectory()) throw new BrowserError(`${where} is a folder; set CHROME_PATH to the executable file of Chrome or Chromium, or Edge on Windows`)
  if (!executable(chrome)) throw new BrowserError(`${where} isn't executable; set CHROME_PATH to the executable file of Chrome or Chromium`)
  // Only shot loads Puppeteer, so the other commands start without it.
  const { default: puppeteer } = await import('puppeteer-core')
  // Puppeteer's defaults turn off IsolateSandboxedIframes so it can reach sandboxed frames, which these pages don't have.
  const defaults = (await puppeteer.defaultArgs({ browser: 'chrome', headless: true, userDataDir: profile })).map((arg) => {
    if (!arg.startsWith('--disable-features=')) return arg
    const features = arg.slice('--disable-features='.length).split(',')
    return `--disable-features=${features.filter((feature) => feature !== 'IsolateSandboxedIframes').join(',')}`
  })
  const env = temp === undefined ? chromeEnv() : { ...chromeEnv(), TMPDIR: temp, TMP: temp, TEMP: temp }
  if (temp !== undefined) makeFolder(temp)
  const before = socketFolders(env.TMPDIR)
  try {
    return await puppeteer.launch({
      executablePath: chrome,
      pipe: true,
      env,
      protocolTimeout,
      signal,
      ignoreDefaultArgs: true,
      // Software rendering repeats a frame byte for byte on one machine; on another it looks the same, though some pixels can be one shade off.
      args: [...defaults, ...switches, '--use-gl=angle', '--use-angle=swiftshader', '--remote-debugging-pipe', NO_DEVTOOLS_PORT],
    })
  } catch (error) {
    // Over a pipe, a Chrome that exits as it starts only closes the connection, which Puppeteer reports with a TargetCloseError its types don't export.
    if (!(error instanceof Error && error.name === 'TargetCloseError')) throw new BrowserError(`Chrome at ${where} didn't start: ${firstLine(error)}; set CHROME_PATH to a working Chrome or Chromium`)
    const hint = tmpdirHint(env.TMPDIR)
    if (hint !== undefined) removeSocketFolders(env.TMPDIR, before)
    throw new BrowserError(`Chrome at ${where} didn't start: it exited as soon as it started${hint === undefined ? '; set CHROME_PATH to a working Chrome or Chromium' : `, ${hint}`}`)
  }
}

// On Windows, where Chrome keeps no socket in its temporary folder, one in its profile holds its temporary files, so those a killed Chrome leaves go with the profile.
function profileTemp(profile: string | undefined): string | undefined {
  return process.platform === 'win32' && profile !== undefined ? join(profile, 'temp') : undefined
}

export async function shoot({ dir, at, out, seed, press, hold, pointer, driver, set, timeout: given }: ShotOptions): Promise<string[]> {
  const timeout = timeLimit(given)
  const paths = framePaths(out, at)
  const chrome = findChrome()
  if (!chrome) throw new BrowserError('shot needs Chrome or Chromium, or Edge on Windows; set CHROME_PATH to its executable')
  const page = await buildPage({ dir, config: { mode: 'shot' }, driver })
  let server: Server | undefined
  let browser: Browser | undefined
  let stuck = false
  const killer = new AbortController()
  // A profile of shot's own, so that it and the socket it links to go after Chrome, however Chrome stopped.
  let profile: string | undefined
  try {
    const { PuppeteerError } = await import('puppeteer-core')
    server = await serve({ page })
    profile = mkdtempSync(join(tmpdir(), 'threejam-chrome-'))
    browser = await launchChrome(chrome, { profile, protocolTimeout: callLimit(timeout), signal: killer.signal })
    const tab = await browser.newPage()
    await tab.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 })
    const crashed = pageFailure(tab)
    // The game and its view.ts run as the page loads and in reset and advanceTo, which share one time limit; screenshots and saving them don't count.
    let spent = 0
    const limited = async <T>(when: string, work: Promise<T>): Promise<T> => {
      const started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => {
        const message = `the page ran past the ${timeout} s time limit ${when}; look for a loop that never ends in view.ts, or allow more time with --timeout`
        timer = setTimeout(() => {
          stuck = true
          reject(new LimitError('TIMEOUT', message))
        }, Math.max(0, timeout * 1000 - spent))
      })
      try {
        return await Promise.race([work, crashed, late])
      } finally {
        clearTimeout(timer)
        spent += Date.now() - started
      }
    }
    // What the page's code throws is the game's, while Puppeteer's own errors mean Chrome failed.
    const inPage = <T>(when: string, work: Promise<T>) =>
      limited(
        when,
        work.catch((error: unknown) => {
          throw error instanceof PuppeteerError ? error : gameFailure(firstLine(error))
        }),
      )
    await limited('as it loaded', openPage(tab, server.url, { timeout: 0 }))
    await limited('as it loaded', tab.waitForFunction('window.engine !== undefined', { timeout: 0 }))
    const reset: ResetOptions = { seed: seed ?? 0, ticks: Math.max(...at), press, hold, pointer, set, drive: driver !== undefined }
    await inPage('drawing tick 0', tab.evaluate((options) => window.engine.reset(options), reset))
    for (const path of paths) makeFolder(dirname(path))
    for (const [i, tick] of at.entries()) {
      await inPage(`drawing tick ${tick}`, tab.evaluate((t) => window.engine.advanceTo(t), tick))
      saveFile(paths[i], await tab.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 800, height: 600 } }))
    }
    return paths
  } catch (error) {
    const known = [UsageError, GameError, BrowserError, IoError, LimitError].some((kind) => error instanceof kind)
    if (known || isSystemError(error)) throw error
    throw new BrowserError(`Chrome failed while drawing the game: ${firstLine(error)}`)
  } finally {
    await closeChrome(browser, killer, { stuck })
    server?.close()
    await page.dispose()
    if (profile !== undefined) removeProfile(profile)
  }
}

// Puppeteer ends any one call into Chrome after 180 s unless told otherwise, which would cut short a page step that a longer --timeout allows.
export function callLimit(seconds: number): number {
  return Math.max(180_000, (seconds + 30) * 1000)
}

// A page stuck in the game's loop isn't waited on: Chrome is killed then, as when closing takes longer than wait milliseconds.
export async function closeChrome(browser: Browser | undefined, killer: AbortController, { stuck = false, wait = 10_000 }: { stuck?: boolean; wait?: number } = {}): Promise<void> {
  const chrome = browser?.process()
  if (browser === undefined || !chrome) return
  const running = chrome.exitCode === null && chrome.signalCode === null
  // On macOS and Linux every process Chrome starts shares its output, which ends once none is left to write to the profile, even after Chrome itself has crashed; on Windows its sandboxed helpers don't inherit it.
  const gone = Promise.allSettled([running && once(chrome, 'exit'), ...[chrome.stdout, chrome.stderr].map((output) => output && finished(output))])
  // Aborting has Puppeteer kill Chrome's process group, or its process tree on Windows; on Linux that leaves only Chrome's crash handlers, which exit once Chrome is gone.
  if (running && (stuck || !(await within(wait, browser.close().catch(() => {}))))) killer.abort()
  await within(10_000, gone)
}

// Whether work settled within ms milliseconds.
async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<false>((done) => (timer = setTimeout(() => done(false), ms)))
  const settled = await Promise.race([work.then(() => true), waited])
  clearTimeout(timer)
  return settled
}

// Windows has no execute permission to check, so there any file passes.
function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Puppeteer puts the page's stack, with the page server's address, in an error's message after its first line.
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0].trim()
}

function pageFailure(tab: Page): Promise<never> {
  const failed = new Promise<never>((_, reject) => {
    tab.on('pageerror', (error) => reject(gameFailure(`the page failed: ${firstLine(error)}`)))
  })
  failed.catch(() => {})
  return failed
}
