import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { exportGame } from '../src/export.ts'
import { ROOT } from '../src/package.ts'
import { NO_DEVTOOLS_PORT, buildPage, findChrome, openWindow, serve } from '../src/serve.ts'
import { launchChrome, openPage } from '../src/shot.ts'

const chrome = findChrome()
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function folder(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(TMP, 'serve-'))
  made.push(dir)
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}

const GAME = "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1 } }, update() {} })\n"
// A 2x2 image: red and green on top, blue and white below.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC', 'base64')

// Fails after 10 s, naming what it waited for, so a page that never gets there fails the test instead of hanging it.
async function until(what: string, check: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 10_000; !check(); await new Promise((wait) => setTimeout(wait, 20))) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
  }
}

// The status and headers of one request, with the headers a browser would send, including ones fetch won't let a caller set, like Host.
function call(url: string, { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((done, fail) => {
    const sent = request(url, { method, headers }, (response) => {
      done({ status: response.statusCode ?? 0, headers: response.headers })
      response.destroy()
    })
    sent.on('error', fail)
    sent.end()
  })
}

test('the run server answers only its own page, and /quit and /events only with the session token, whatever another page or host sends', async () => {
  const token = 'session-token'
  const page = await buildPage({ dir: folder({ 'game.ts': GAME }), config: { mode: 'run', seed: 0, token } })
  let quits = 0
  const server = await serve({ page, token, onQuit: () => (quits += 1) })
  try {
    const { host, port } = new URL(server.url)
    const status = async (path: string, headers: Record<string, string> = {}, method = 'GET') => (await call(new URL(path, server.url).href, { method, headers })).status
    const quit = `/quit?token=${token}`
    assert.deepEqual(
      {
        noToken: await status('/quit', {}, 'POST'),
        wrongToken: await status('/quit?token=session-tokem', {}, 'POST'),
        otherPort: await status(quit, { origin: 'http://127.0.0.1:8765' }, 'POST'),
        website: await status(quit, { origin: 'https://evil.example' }, 'POST'),
        file: await status(quit, { origin: 'null' }, 'POST'),
        rebound: await status(quit, { host: `evil.example:${port}` }, 'POST'),
        events: await status('/events'),
        includedScript: await status('/bundle.js', { 'sec-fetch-site': 'same-site' }),
      },
      { noToken: 403, wrongToken: 403, otherPort: 403, website: 403, file: 403, rebound: 403, events: 403, includedScript: 403 },
    )
    assert.equal(quits, 0)
    assert.equal(await status(`/events?token=${token}`, { 'sec-fetch-site': 'same-origin' }), 200)
    assert.equal(await status(quit, { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, 'POST'), 200)
    assert.equal(quits, 1)
  } finally {
    server.close()
    await page.dispose()
  }
})

test('no page may frame the game, and its images, SVGs above all, run nothing when opened, and an SVG downloads instead', async () => {
  const page = await buildPage({ dir: folder({ 'game.ts': GAME, 'tile.png': PNG, 'evil.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' }), config: { mode: 'shot' } })
  const server = await serve({ page })
  try {
    const headers = async (path: string) => {
      const { status, headers } = await call(new URL(path, server.url).href)
      return [status, headers['content-security-policy'], headers['x-content-type-options'], headers['content-disposition']]
    }
    const asset = "sandbox; default-src 'none'; frame-ancestors 'none'"
    assert.deepEqual(
      [await headers('/'), await headers('/assets/tile.png'), await headers('/assets/evil.svg')],
      [
        [200, "frame-ancestors 'none'", 'nosniff', undefined],
        [200, asset, 'nosniff', undefined],
        [200, asset, 'nosniff', 'attachment'],
      ],
    )
  } finally {
    server.close()
    await page.dispose()
  }
})

const HOSTILE = (game: string) => `<!doctype html><body><script>
const report = (what) => fetch('/report?' + what)
addEventListener('message', () => report('svg-message'))
const frame = document.createElement('iframe')
frame.onload = () => report('framed')
frame.src = '${game}assets/evil.svg'
document.body.append(frame)
fetch('${game}quit', { method: 'POST', mode: 'no-cors' }).then(() => report('posted'), () => report('posted'))
</script></body>`

test('another page on this machine, or a file, can neither end a run nor run script from its SVG, while the game page follows reloads and quits with Esc', { skip: !chrome && 'needs Chrome', timeout: 60_000 }, async () => {
  const reports: string[] = []
  let game = ''
  const hostile = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/report?')) {
      reports.push(incoming.url.slice('/report?'.length))
      response.writeHead(204).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(HOSTILE(game))
  })
  await new Promise<void>((ready) => hostile.listen(0, '127.0.0.1', ready))
  const address = hostile.address()
  if (address === null || typeof address === 'string') throw new Error('the hostile server has no port')
  const attacker = `http://127.0.0.1:${address.port}/`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fff"/><script>document.title = 'ran'; parent.postMessage('ran', '*'); fetch('${attacker}report?svg-ran', { mode: 'no-cors' })</script></svg>`
  const dir = folder({ 'game.ts': GAME, 'evil.svg': svg, 'tile.png': PNG })
  const token = 'session-token'
  const page = await buildPage({ dir, config: { mode: 'run', seed: 0, token } })
  let quits = 0
  const server = await serve({ page, token, onQuit: () => (quits += 1) })
  game = server.url
  const file = join(dir, 'hostile.html')
  writeFileSync(file, `<script>const done = () => fetch('${attacker}report?file-posted', { mode: 'no-cors' }); fetch('${game}quit', { method: 'POST', mode: 'no-cors' }).then(done, done)</script>`)
  const browser = await launchChrome(chrome ?? 'no Chrome', { protocolTimeout: 60_000 })
  try {
    const tab = await browser.newPage()
    await openPage(tab, attacker)
    await until('the attacking page to post /quit', () => reports.includes('posted'))
    assert.equal(quits, 0, 'a page on another port ended the session')
    await until('the attacking page to frame the SVG', () => reports.includes('framed'))
    await tab.goto(pathToFileURL(file).href)
    await until('the file to post /quit', () => reports.includes('file-posted'))
    assert.equal(quits, 0, 'a file ended the session')
    const session = await tab.createCDPSession()
    await session.send('Browser.setDownloadBehavior', { behavior: 'deny' })
    await tab.goto(`${game}assets/evil.svg`).catch(() => {})
    assert.deepEqual({ reports: reports.filter((what) => what.startsWith('svg')), title: await tab.title() }, { reports: [], title: '' })

    const player = await browser.newPage()
    let listening = false
    player.on('response', (response) => void (response.url().includes('/events?') && response.status() === 200 && (listening = true)))
    await openPage(player, game)
    await until('the game page to listen for reloads', () => listening)
    const reloaded = player.waitForNavigation()
    server.reload()
    await reloaded
    await player.waitForFunction('window.engine !== undefined')
    await player.keyboard.press('Escape')
    await until('Esc to end the session', () => quits === 1)
  } finally {
    await browser.close()
    server.close()
    hostile.close()
    await page.dispose()
  }
})

test('a page bundles the files in its game\'s folder but refuses one from outside it, whether code, JSON, or through a link, and export then writes nothing', async () => {
  const root = mkdtempSync(join(TMP, 'bundle-'))
  made.push(root)
  const [dir, outside] = [join(root, 'game'), join(root, 'outside')]
  mkdirSync(dir)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.ts'), "export const secret = 'CANARY-OUTSIDE'\n")
  writeFileSync(join(outside, 'secret.json'), '{ "token": "CANARY-JSON" }\n')
  writeFileSync(join(dir, 'inside.ts'), "export const inside = 'INSIDE-VALUE'\n")
  const game = (line: string, value: string) =>
    writeFileSync(join(dir, 'game.ts'), `${line}\nimport { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1, label: ${value} } }, update() {} })\n`)
  const refused = (specifier: string, file: string) =>
    new RegExp(`game\\.ts:1: can't bundle "${specifier.replaceAll('.', '\\.')}", which is .*${file.replaceAll('.', '\\.')}: a game may import only its own folder and ThreeJam's files$`)

  game("import { secret } from '../outside/secret.ts'", 'secret')
  await assert.rejects(buildPage({ dir, config: { mode: 'shot' } }), { name: 'BuildError', message: refused('../outside/secret.ts', 'outside/secret.ts') })
  const out = join(root, 'game.html')
  await assert.rejects(exportGame({ dir, out }), { name: 'BuildError', message: refused('../outside/secret.ts', 'outside/secret.ts') })
  assert.equal(existsSync(out), false)

  game("import data from '../outside/secret.json'", 'data.token')
  await assert.rejects(buildPage({ dir, config: { mode: 'shot' } }), { message: refused('../outside/secret.json', 'outside/secret.json') })

  if (process.platform !== 'win32') {
    symlinkSync(join(outside, 'secret.ts'), join(dir, 'link.ts'))
    game("import { secret } from './link.ts'", 'secret')
    await assert.rejects(buildPage({ dir, config: { mode: 'shot' } }), { message: refused('./link.ts', 'outside/secret.ts') })
  }

  game("import { inside } from './inside.ts'", 'inside')
  const page = await buildPage({ dir, config: { mode: 'shot' } })
  try {
    assert.ok(readFileSync(join(page.outdir, 'bundle.js'), 'utf8').includes('INSIDE-VALUE'))
  } finally {
    await page.dispose()
  }
})

test("a page's driver may import from its own folder, but its game may not, as in sim", async () => {
  const root = mkdtempSync(join(TMP, 'roles-'))
  made.push(root)
  const [dir, bot] = [join(root, 'game'), join(root, 'bot')]
  mkdirSync(dir)
  mkdirSync(bot)
  writeFileSync(join(bot, 'helper.ts'), "export const helper = 'HELPER-VALUE'\n")
  writeFileSync(join(bot, 'secret.ts'), "export const secret = 'CANARY-DRIVER-FOLDER'\n")
  writeFileSync(join(bot, 'bot.ts'), "import { helper } from './helper.ts'\n\nexport default () => (helper === '' ? ['Space'] : [])\n")
  const driver = join(bot, 'bot.ts')
  writeFileSync(join(dir, 'game.ts'), GAME)
  const page = await buildPage({ dir, config: { mode: 'shot' }, driver })
  try {
    assert.ok(readFileSync(join(page.outdir, 'bundle.js'), 'utf8').includes('HELPER-VALUE'))
  } finally {
    await page.dispose()
  }
  writeFileSync(join(dir, 'game.ts'), `import { secret } from '../bot/secret.ts'\n${GAME.replace('w: 0.1,', 'w: 0.1, label: secret,')}`)
  await assert.rejects(buildPage({ dir, config: { mode: 'shot' }, driver }), {
    name: 'BuildError',
    message: /game\.ts:1: can't bundle "\.\.\/bot\/secret\.ts", which is .*bot\/secret\.ts: a game may import only its own folder and ThreeJam's files$/,
  })
})

test('when Chrome fails to start, shot closes its server and esbuild and removes its temporary folder', () => {
  const temp = mkdtempSync(join(TMP, 'temp-'))
  made.push(temp)
  const shot = pathToFileURL(join(ROOT, 'src', 'shot.ts')).href
  const script = `import { shoot } from ${JSON.stringify(shot)}\nawait shoot({ dir: 'games/pong', at: [1], out: 'frame.png' }).catch((error) => console.log(error.message))`
  const env = { ...process.env, CHROME_PATH: join(temp, 'no-chrome'), TMPDIR: temp, TEMP: temp, TMP: temp }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 })
  assert.deepEqual({ status: result.status, named: result.stdout.includes('no-chrome'), left: readdirSync(temp) }, { status: 0, named: true, left: [] }, result.stderr)
})

test("a Chrome that shot kills for a page that never returns leaves nothing in the temporary folder, which a killed Chrome's sockets would", { skip: !chrome && 'needs Chrome', timeout: 60_000 }, () => {
  const temp = mkdtempSync(join(TMP, 'temp-'))
  made.push(temp)
  const dir = folder({ 'game.ts': GAME, 'view.ts': 'for (;;) {}\n' })
  const shot = pathToFileURL(join(ROOT, 'src', 'shot.ts')).href
  const options = JSON.stringify({ dir, at: [1], out: join(dir, 'frame.png'), timeout: 2 })
  const script = `import { shoot } from ${JSON.stringify(shot)}\nawait shoot(${options}).catch((error) => console.log(error.code))`
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' })
  assert.deepEqual({ status: result.status, printed: result.stdout.trim(), left: readdirSync(temp) }, { status: 0, printed: 'TIMEOUT', left: [] }, result.stderr)
})

test('a Chrome that exits as it starts fails with one line naming it, though over a pipe its own output is lost, and a folder or a file that runs nothing says so', { skip: process.platform === 'win32' && 'the stand-in Chrome is a shell script' }, async () => {
  const dir = mkdtempSync(join(TMP, 'exits-'))
  made.push(dir)
  const fake = join(dir, 'chrome')
  writeFileSync(fake, '#!/bin/sh\necho "no display" >&2\nexit 3\n', { mode: 0o755 })
  await assert.rejects(launchChrome(fake), {
    name: 'BrowserError',
    message: `Chrome at ${fake} didn't start: it exited as soon as it started; set CHROME_PATH to a working Chrome or Chromium`,
  })
  await assert.rejects(launchChrome(dir), { name: 'BrowserError', message: `${dir} is a folder; set CHROME_PATH to the executable file of Chrome or Chromium, or Edge on Windows` })
  writeFileSync(join(dir, 'notes.txt'), 'not a program', { mode: 0o644 })
  await assert.rejects(launchChrome(join(dir, 'notes.txt')), { name: 'BrowserError', message: `${join(dir, 'notes.txt')} isn't executable; set CHROME_PATH to the executable file of Chrome or Chromium` })
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
