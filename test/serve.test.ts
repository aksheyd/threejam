import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../src/package.ts'
import { NO_DEVTOOLS_PORT, findChrome, openWindow } from '../src/serve.ts'
import { launchChrome } from '../src/shot.ts'

const chrome = findChrome()
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

// Fails after 10 s, naming what it waited for, so a page that never gets there fails the test instead of hanging it.
async function until(what: string, check: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 10_000; !check(); await new Promise((wait) => setTimeout(wait, 20))) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
  }
}

test('when Chrome fails to start, shot closes its server and esbuild and removes its temporary folder', () => {
  const temp = mkdtempSync(join(TMP, 'temp-'))
  made.push(temp)
  const shot = pathToFileURL(join(ROOT, 'src', 'shot.ts')).href
  const script = `import { shoot } from ${JSON.stringify(shot)}\nawait shoot({ dir: 'games/pong', at: [1], out: 'frame.png' }).catch((error) => console.log(error.message))`
  const env = { ...process.env, CHROME_PATH: join(temp, 'no-chrome'), TMPDIR: temp, TEMP: temp, TMP: temp }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 })
  assert.deepEqual({ status: result.status, named: result.stdout.includes('no-chrome'), left: readdirSync(temp) }, { status: 0, named: true, left: [] }, result.stderr)
})

test('commands other than shot start without loading Puppeteer', () => {
  const hook = "import { registerHooks } from 'node:module'\nregisterHooks({ resolve: (specifier, context, next) => { if (specifier.startsWith('puppeteer')) throw new Error(`loaded ${specifier}`); return next(specifier, context) } })"
  const cli = join(ROOT, 'src', 'cli.ts')
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, cli, 'sim', 'games/pong', '--ticks', '1'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

// A launcher like Linux's google-chrome scripts, which put their own switches before ThreeJam's; this one also notes what it was given.
function wrapper(dir: string, switches: readonly string[]): string {
  const sh = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`
  const file = join(dir, 'chrome')
  const lines = ['#!/bin/sh', `env > ${sh(join(dir, 'env'))}`, `printf '%s\\n' "$@" > ${sh(join(dir, 'args'))}`, `exec ${[chrome ?? 'no Chrome', ...switches].map(sh).join(' ')} "$@"`]
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 })
  return file
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  await new Promise((closed) => server.close(closed))
  if (address === null || typeof address === 'string') throw new Error('no free port')
  return address.port
}

// What a wrapper handed Chrome: the environment, and the switches after its own.
function given(dir: string): { env: string[]; args: string[]; profile: string | undefined } {
  const args = readFileSync(join(dir, 'args'), 'utf8').split('\n').filter(Boolean)
  const profile = args.findLast((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  return { env: readFileSync(join(dir, 'env'), 'utf8').split('\n'), args, profile }
}

const wrapped = { skip: (!chrome && 'needs Chrome') || (process.platform === 'win32' && 'wrapper scripts are for macOS and Linux'), timeout: 60_000 }

test("shot's Chrome talks over a pipe, opens no DevTools port even when a wrapper script asks for one, and sees none of our environment but what it needs", wrapped, async () => {
  const dir = mkdtempSync(join(TMP, 'wrapper-'))
  made.push(dir)
  const port = await freePort()
  process.env.THREEJAM_CANARY = 'secret'
  try {
    const browser = await launchChrome(wrapper(dir, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`]))
    try {
      await browser.newPage()
      const { env, args, profile } = given(dir)
      await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`))
      assert.deepEqual(
        {
          endpoint: browser.wsEndpoint(),
          pipe: args.includes('--remote-debugging-pipe'),
          port: args.findLast((arg) => arg.startsWith('--remote-debugging-port=')),
          activePort: profile !== undefined && existsSync(join(profile, 'DevToolsActivePort')),
          wrapperProfile: existsSync(join(dir, 'profile')),
          unsafeSwiftShader: args.includes('--enable-unsafe-swiftshader'),
          isolationOff: args.some((arg) => arg.startsWith('--disable-features=') && arg.split(/[=,]/).includes('IsolateSandboxedIframes')),
          canary: env.some((line) => line.startsWith('THREEJAM_CANARY=')),
        },
        { endpoint: '', pipe: true, port: NO_DEVTOOLS_PORT, activePort: false, wrapperProfile: false, unsafeSwiftShader: false, isolationOff: false, canary: false },
      )
    } finally {
      await browser.close()
    }
  } finally {
    delete process.env.THREEJAM_CANARY
  }
})

test("run's window opens no DevTools port even when a wrapper script asks for one, and sees none of our environment but what it needs", wrapped, async () => {
  const dir = mkdtempSync(join(TMP, 'wrapper-'))
  made.push(dir)
  const port = await freePort()
  let loaded = false
  const site = createServer((incoming, response) => {
    if (incoming.url === '/loaded') loaded = true
    response.writeHead(200, { 'content-type': 'text/html' }).end("<script>fetch('/loaded')</script>")
  })
  await new Promise<void>((listening) => site.listen(0, '127.0.0.1', listening))
  const address = site.address()
  if (address === null || typeof address === 'string') throw new Error('the page server has no port')
  const { CHROME_PATH } = process.env
  // Headless, so the window needs no display.
  process.env.CHROME_PATH = wrapper(dir, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`])
  process.env.THREEJAM_CANARY = 'secret'
  const app = openWindow(`http://127.0.0.1:${address.port}/`)
  let exited = false
  void app?.exited.then(() => (exited = true))
  try {
    assert.ok(app)
    await until('Chrome to load the page', () => loaded || exited)
    assert.equal(exited, false, 'Chrome exited before it loaded the page')
    const { env, args, profile } = given(dir)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`))
    assert.deepEqual(
      {
        port: args.findLast((arg) => arg.startsWith('--remote-debugging-port=')),
        activePort: profile !== undefined && existsSync(join(profile, 'DevToolsActivePort')),
        wrapperProfile: existsSync(join(dir, 'profile')),
        canary: env.some((line) => line.startsWith('THREEJAM_CANARY=')),
      },
      { port: NO_DEVTOOLS_PORT, activePort: false, wrapperProfile: false, canary: false },
    )
  } finally {
    app?.close()
    await app?.exited
    site.close()
    if (CHROME_PATH === undefined) delete process.env.CHROME_PATH
    else process.env.CHROME_PATH = CHROME_PATH
    delete process.env.THREEJAM_CANARY
  }
})
