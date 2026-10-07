import assert from 'node:assert/strict'
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { exportGame } from '../src/export.ts'
import { ROOT } from '../src/package.ts'
import { Recording } from '../src/playtest.ts'
import { NO_DEVTOOLS_PORT, buildPage, openWindow, removeProfile, removeSocketFolders, serve, socketFolders, type AppWindow } from '../src/serve.ts'
import { closeChrome, launchChrome, openPage } from '../src/shot.ts'
import { CHROME as chrome, testChrome } from './chrome.ts'
import { reached, spawnCli } from './children.ts'

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
async function until(what: string | (() => string), check: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 10_000; !check(); await new Promise((wait) => setTimeout(wait, 20))) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${typeof what === 'string' ? what : what()}`)
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

test('the run server answers only its own page, and /quit, /events, and /record only with the session token, whatever another page or host sends', async () => {
  const token = 'session-token'
  const page = await buildPage({ dir: folder({ 'game.ts': GAME }), config: { mode: 'run', seed: 0, token, record: true } })
  let quits = 0
  const recording = new Recording()
  const server = await serve({ page, token, onQuit: () => (quits += 1), recording })
  try {
    const { host, port } = new URL(server.url)
    const status = async (path: string, headers: Record<string, string> = {}, method = 'GET') => (await call(new URL(path, server.url).href, { method, headers })).status
    const quit = `/quit?token=${token}`
    const record = `/record?build=${page.build}&session=a&seed=0&from=0&ticks=0`
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
        recordWithoutToken: await status(record, {}, 'POST'),
        recordFromElsewhere: await status(`${record}&token=${token}`, { origin: 'http://127.0.0.1:8765' }, 'POST'),
      },
      { noToken: 403, wrongToken: 403, otherPort: 403, website: 403, file: 403, rebound: 403, events: 403, includedScript: 403, recordWithoutToken: 403, recordFromElsewhere: 403 },
    )
    assert.deepEqual([quits, recording.latest(page.build)], [0, undefined])
    assert.equal(await status(`/events?token=${token}`, { 'sec-fetch-site': 'same-origin' }), 200)
    assert.equal(await status(`${record}&token=${token}`, { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, 'POST'), 400)
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
  const { browser, close } = await testChrome()
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
    await close()
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
    assert.ok(Buffer.from(page.bundle).toString().includes('INSIDE-VALUE'))
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
    assert.ok(Buffer.from(page.bundle).toString().includes('HELPER-VALUE'))
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

const unreadable = { skip: (process.platform === 'win32' && "a file's mode doesn't stop Windows reading it") || (process.getuid?.() === 0 && 'root reads any file') }

test("run answers an image it can't read with an error and goes on serving", unreadable, async (t) => {
  const dir = folder({ 'game.ts': GAME, 'tile.png': PNG })
  chmodSync(join(dir, 'tile.png'), 0)
  const run = spawnCli(['run', dir, '--serve-only'], t.signal)
  let out = ''
  run.stdout.on('data', (chunk) => (out += chunk))
  await until('run to serve the page', () => out.includes('\n'))
  const url = out.slice(out.lastIndexOf(' ') + 1, -1)
  const status = async (path: string) => (await call(new URL(path, url).href)).status
  assert.deepEqual({ image: await status('/assets/tile.png'), page: await status('/') }, { image: 500, page: 200 })
})

test("a page that follows saves rebuilds once when an image stops being readable, not on each of esbuild's polls of it", unreadable, async () => {
  const dir = folder({ 'game.ts': GAME, 'tile.png': PNG })
  let rebuilds = 0
  const page = await buildPage({ dir, config: { mode: 'run', seed: 0, token: 'session-token' }, onRebuild: () => (rebuilds += 1) })
  try {
    chmodSync(join(dir, 'tile.png'), 0)
    await until('the page to rebuild', () => rebuilds > 0)
    await new Promise((wait) => setTimeout(wait, 1000))
    assert.equal(rebuilds, 1)
  } finally {
    await page.dispose()
  }
})

test("a page that follows saves reports a game file it can't read once, and counts it as one build, not on each of esbuild's polls of it, so a page that loads meanwhile isn't told to reload again and again", unreadable, async () => {
  const dir = folder({ 'game.ts': GAME })
  const reports: string[][] = []
  const page = await buildPage({ dir, config: { mode: 'run', seed: 0, token: 'session-token' }, onRebuild: (errors) => reports.push(errors) })
  try {
    chmodSync(join(dir, 'game.ts'), 0)
    await until('the page to rebuild', () => reports.length > 0)
    await new Promise((wait) => setTimeout(wait, 1000))
    // The first build, then the one that couldn't read the file.
    assert.deepEqual({ reports: reports.map((errors) => errors.length > 0), build: page.build }, { reports: [true], build: 2 })
  } finally {
    await page.dispose()
  }
})

test('run keeps its page in memory, so even killed while it serves, it leaves nothing in the temporary folder', async (t) => {
  const temp = mkdtempSync(join(TMP, 'temp-'))
  made.push(temp)
  const run = spawnCli(['run', folder({ 'game.ts': GAME }), '--serve-only'], t.signal, ROOT, { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp })
  let [out, errors] = ['', '']
  run.stdout.on('data', (chunk) => (out += chunk))
  run.stderr.on('data', (chunk) => (errors += chunk))
  // run's own exit, not the end of its output: esbuild's service shares run's stderr, and once watching it outlives a run killed while one of its pings is unanswered, until a file it watches changes.
  let ended: string | undefined
  run.once('exit', (code, signal) => (ended = signal ?? `exit code ${code}`))
  const saw = () => `stdout ${JSON.stringify(out)}, stderr ${JSON.stringify(errors)}, ${ended === undefined ? 'still running' : `ended by ${ended}`}`
  await until(() => `run to serve the page: ${saw()}`, () => out.includes('\n') || ended !== undefined)
  assert.equal(ended, undefined, `run ended before it served the page: ${saw()}`)
  run.kill('SIGKILL')
  await until(() => `run to end once killed: ${saw()}`, () => ended !== undefined)
  assert.deepEqual(readdirSync(temp), [])
})

test("a Chrome that shot kills for a page that never returns leaves nothing in the temporary folder, which a killed Chrome's socket would", { skip: !chrome && 'needs Chrome', timeout: 60_000 }, () => {
  // The system's temporary folder, since one deep in a checkout can be too long for Chrome on Linux to start in.
  const temp = mkdtempSync(join(tmpdir(), 'threejam-temp-'))
  made.push(temp)
  const dir = folder({ 'game.ts': GAME, 'view.ts': 'for (;;) {}\n' })
  const shot = pathToFileURL(join(ROOT, 'src', 'shot.ts')).href
  const options = JSON.stringify({ dir, at: [1], out: join(dir, 'frame.png'), timeout: 2 })
  const script = `import { shoot } from ${JSON.stringify(shot)}\nawait shoot(${options}).catch((error) => console.log(error.code + ': ' + error.message))`
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' })
  // On Windows, Chrome's helpers can hold a file in shot's profile a moment after Chrome is killed, and shot leaves those for the OS.
  const left = readdirSync(temp).filter((name) => process.platform !== 'win32' || !name.startsWith('threejam-chrome-'))
  const printed = 'TIMEOUT: the page ran past the 2 s time limit as it loaded; look for a loop that never ends in view.ts, or allow more time with --timeout'
  assert.deepEqual({ status: result.status, printed: result.stdout.trim(), left }, { status: 0, printed, left: [] }, result.stderr)
})

test('on Windows, Chrome keeps its temporary files in its profile, so those a killed Chrome leaves go with the profile', { skip: (!chrome && 'needs Chrome') || (process.platform !== 'win32' && "elsewhere they stay in TMPDIR, beside Chrome's socket"), timeout: 60_000 }, async () => {
  // A temporary folder of the test's own in place of the system's, which Chrome would use without a profile to keep its files in.
  const temp = mkdtempSync(join(tmpdir(), 'threejam-temp-'))
  made.push(temp)
  const { TEMP, TMP } = process.env
  Object.assign(process.env, { TEMP: temp, TMP: temp })
  const profile = mkdtempSync(join(temp, 'threejam-chrome-'))
  const killer = new AbortController()
  try {
    const browser = await launchChrome(chrome ?? 'no Chrome', { profile, signal: killer.signal })
    const tab = await browser.newPage()
    void tab.evaluate('for (;;) {}').catch(() => {})
    // Chrome writes a snapshot to a temporary file it removes once the page has saved itself there, which a stuck page never does.
    void (await tab.createCDPSession()).send('Page.captureSnapshot').catch(() => {})
    const kept = join(profile, 'temp')
    await until("Chrome to make the snapshot's temporary file", () => readdirSync(temp).length > 1 || (existsSync(kept) && readdirSync(kept).length > 0))
    await closeChrome(browser, killer, { stuck: true })
  } finally {
    killer.abort()
    for (const [name, value] of Object.entries({ TEMP, TMP })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    removeProfile(profile)
  }
  // Chrome's helpers can hold a file in its profile a moment after Chrome is killed, and shot leaves those for the OS.
  assert.deepEqual(readdirSync(temp).filter((name) => name !== basename(profile)), [])
})

test('closing a Chrome that crashed waits for the processes it started, which outlive it a moment and can still write to its profile', { skip: !chrome && 'needs Chrome', timeout: 60_000 }, async () => {
  const profile = folder({})
  const killer = new AbortController()
  const browser = await launchChrome(chrome ?? 'no Chrome', { profile, signal: killer.signal })
  const crashed = browser.process()
  try {
    if (!crashed?.pid) throw new Error('Chrome has no process')
    await browser.newPage()
    const exited = once(crashed, 'exit')
    const closed = once(crashed, 'close')
    // Chrome's own process alone, as when it crashes.
    process.kill(crashed.pid, 'SIGKILL')
    await exited
    await closeChrome(browser, killer)
    // On macOS and Linux every process Chrome starts shares its output, which ends once all of them have exited.
    assert.deepEqual([crashed.stdout?.readableEnded, crashed.stderr?.readableEnded], [true, true])
    // Once Chrome's close event has come, closing it again returns at once, where waiting for that event would wait out its 10 s.
    await closed
    const started = Date.now()
    await closeChrome(browser, killer)
    const took = Date.now() - started
    assert.ok(took < 1000, `closing again took ${took} ms`)
  } finally {
    killer.abort()
    removeProfile(profile)
  }
})

test("a Chrome that doesn't close in the time it's given is killed, with every process it started", { skip: (!chrome && 'needs Chrome') || (process.platform === 'win32' && 'stopping a process is for macOS and Linux'), timeout: 60_000 }, async () => {
  const profile = folder({})
  const killer = new AbortController()
  const browser = await launchChrome(chrome ?? 'no Chrome', { profile, signal: killer.signal })
  const stopped = browser.process()
  try {
    if (!stopped?.pid) throw new Error('Chrome has no process')
    await browser.newPage()
    // A stopped Chrome neither answers nor exits, like one that hangs as it closes.
    process.kill(stopped.pid, 'SIGSTOP')
    const started = Date.now()
    let killed = Number.POSITIVE_INFINITY
    stopped.once('exit', () => (killed = Date.now() - started))
    await closeChrome(browser, killer, { wait: 100 })
    assert.deepEqual({ signal: stopped.signalCode, ended: [stopped.stdout?.readableEnded, stopped.stderr?.readableEnded] }, { signal: 'SIGKILL', ended: [true, true] })
    // Killed once its 100 ms are up, well short of the 10 s that closing waits for unless told otherwise; the end of Chrome's output, which comes after, can take longer on a slow machine.
    assert.ok(killed < 5000, `Chrome was killed ${killed} ms after closing began`)
  } finally {
    killer.abort()
    removeProfile(profile)
  }
})

// Whether the system's temporary folder can hold a TMPDIR of this many bytes, of threejam- and mkdtemp's 6 characters at the least.
const roomFor = (bytes: number) => join(tmpdir(), 'threejam-XXXXXX').length <= bytes

test("shot's Chrome starts in a TMPDIR with no room for a folder of shot's, since its socket goes there and Linux caps a socket's path at 107 bytes", { skip: (!chrome && 'needs Chrome') || (process.platform !== 'linux' && "the cap is Linux's") || (!roomFor(50) && "the system's temporary folder is too long to hold a 50-byte TMPDIR"), timeout: 60_000 }, () => {
  // Chrome's socket lands 41 to 45 bytes past TMPDIR, depending on its build, so at 50 it fits with too little room for a folder like threejam-chrome-XXXXXX in between.
  const temp = mkdtempSync(join(tmpdir(), 'threejam-'.padEnd(50 - tmpdir().length - 7, 'x')))
  made.push(temp)
  const shot = pathToFileURL(join(ROOT, 'src', 'shot.ts')).href
  const options = JSON.stringify({ dir: 'games/pong', at: [1], out: join(folder({}), 'frame.png') })
  const script = `import { shoot } from ${JSON.stringify(shot)}\nawait shoot(${options}).then(() => console.log('ok'), (error) => console.log(error.code + ': ' + error.message))`
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' })
  assert.deepEqual({ length: temp.length, status: result.status, printed: result.stdout.trim(), left: readdirSync(temp) }, { length: 50, status: 0, printed: 'ok', left: [] }, result.stderr)
})

test("on Linux, a TMPDIR too long for Chrome's socket gets shot and run's window to say to set a shorter one, and to remove the folders they made there, but no other program's", { skip: (!chrome && 'needs Chrome') || (process.platform !== 'linux' && "the cap is Linux's"), timeout: 60_000 }, () => {
  // At least 70 bytes, too long for Google Chrome as well as Chromium.
  const temp = mkdtempSync(join(tmpdir(), 'threejam-'.padEnd(70 - tmpdir().length - 7, 'x')))
  made.push(temp)
  // An empty folder of another Chromium program's, which has the name Chrome's socket folder could have.
  mkdirSync(join(temp, 'org.chromium.Chromium.others'))
  const dir = mkdtempSync(join(TMP, 'long-'))
  made.push(dir)
  // Headless, so the window needs no display.
  const window = wrapper(dir, ['--headless=new'])
  // What shot leaves is printed before the window starts, which would otherwise remove it too.
  const script = [
    "import { readdirSync } from 'node:fs'",
    `import { shoot } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'shot.ts')).href)}`,
    `import { openWindow } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'serve.ts')).href)}`,
    `await shoot(${JSON.stringify({ dir: 'games/pong', at: [1], out: join(dir, 'frame.png') })}).catch((error) => console.log(error.message))`,
    `console.log(JSON.stringify(readdirSync(${JSON.stringify(temp)})))`,
    "await openWindow('http://127.0.0.1:9/')?.exited",
  ].join('\n')
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, CHROME_PATH: window }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' })
  const hint = `as Chrome on Linux does in a TMPDIR over 62 bytes, where its socket goes, and ${temp} is ${Buffer.byteLength(temp)}; set TMPDIR to a shorter folder, like /tmp`
  const [shot, leftByShot] = result.stdout.trim().split('\n')
  assert.deepEqual(
    { status: result.status, shot, leftByShot: JSON.parse(leftByShot ?? 'null'), run: result.stderr.trim(), left: readdirSync(temp) },
    { status: 0, shot: `Chrome at ${window} didn't start: it exited as soon as it started, ${hint}`, leftByShot: ['org.chromium.Chromium.others'], run: `Chrome at ${window} exited as soon as it started, ${hint}.`, left: ['org.chromium.Chromium.others'] },
  )
})

test("a new socket folder goes only when its socket's path would pass the 107 bytes Linux allows, so one whose socket fits exactly stays", { skip: (process.platform !== 'linux' && "the cap is Linux's") || (!roomFor(66) && "the system's temporary folder is too long to hold a 66-byte TMPDIR") }, () => {
  // At 66 bytes, a socket in Google Chrome's folder takes exactly 107, and one in Chromium's, whose name is 5 bytes longer, 111.
  const temp = mkdtempSync(join(tmpdir(), 'threejam-'.padEnd(66 - tmpdir().length - 7, 'x')))
  made.push(temp)
  const before = socketFolders(temp)
  for (const name of ['com.google.Chrome.abc123', 'org.chromium.Chromium.abc123']) mkdirSync(join(temp, name))
  removeSocketFolders(temp, before)
  assert.deepEqual({ length: temp.length, left: readdirSync(temp) }, { length: 66, left: ['com.google.Chrome.abc123'] })
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

// A word quoted for sh.
const sh = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

// A launcher like Linux's google-chrome scripts, which put their own switches before ThreeJam's; this one also notes what it was given, and its process ID, which Chrome takes over, after running any shell lines it's given first.
function wrapper(dir: string, switches: readonly string[], first: readonly string[] = []): string {
  const file = join(dir, 'chrome')
  const lines = ['#!/bin/sh', `echo $$ > ${sh(join(dir, 'pid'))}`, `env > ${sh(join(dir, 'env'))}`, `printf '%s\\n' "$@" > ${sh(join(dir, 'args'))}`, ...first, `exec ${[chrome ?? 'no Chrome', ...switches].map(sh).join(' ')} "$@"`]
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 })
  return file
}

// A page that tells the test once a browser has loaded it.
async function loadingPage(): Promise<{ url: string; loaded: () => boolean; close: () => void }> {
  let loaded = false
  const site = createServer((incoming, response) => {
    if (incoming.url === '/loaded') loaded = true
    response.writeHead(200, { 'content-type': 'text/html' }).end("<script>fetch('/loaded')</script>")
  })
  await new Promise<void>((listening) => site.listen(0, '127.0.0.1', listening))
  const address = site.address()
  if (address === null || typeof address === 'string') throw new Error('the page server has no port')
  return { url: `http://127.0.0.1:${address.port}/`, loaded: () => loaded, close: () => site.close() }
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

test("shot's Chrome talks over a pipe, opens no DevTools port even when a wrapper script asks for one, sees none of our environment but what it needs, and leaves Ctrl-C, SIGTERM, and SIGHUP to shot", wrapped, async () => {
  const dir = mkdtempSync(join(TMP, 'wrapper-'))
  made.push(dir)
  const port = await freePort()
  process.env.THREEJAM_CANARY = 'secret'
  // Puppeteer's own listeners would end the process on Ctrl-C before shot has cleaned up.
  const listening = () => (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => process.listenerCount(signal))
  const before = listening()
  try {
    const { browser, close } = await testChrome(wrapper(dir, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`]))
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
          listening: listening(),
        },
        { endpoint: '', pipe: true, port: NO_DEVTOOLS_PORT, activePort: false, wrapperProfile: false, unsafeSwiftShader: false, isolationOff: false, canary: false, listening: before },
      )
    } finally {
      await close()
    }
  } finally {
    delete process.env.THREEJAM_CANARY
  }
})

test("run's window opens no DevTools port even when a wrapper script asks for one, sees none of our environment but what it needs, and leaves nothing behind when it's stopped", wrapped, async (t) => {
  const dir = mkdtempSync(join(TMP, 'wrapper-'))
  made.push(dir)
  const port = await freePort()
  const page = await loadingPage()
  const { CHROME_PATH } = process.env
  // Headless, so the window needs no display.
  process.env.CHROME_PATH = wrapper(dir, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`])
  process.env.THREEJAM_CANARY = 'secret'
  const app = openWindow(page.url)
  let exited = false
  void app?.exited.then(() => (exited = true))
  try {
    assert.ok(app)
    await until('Chrome to load the page', () => page.loaded() || exited)
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
    assert.ok(profile)
    // Esc stops the window with a signal, which leaves Chrome's socket and its folder for run to remove.
    const socket = dirname(readlinkSync(join(profile, 'SingletonSocket')))
    const closing = Date.now()
    app.close()
    await until("run to remove the window's profile and its socket's folder", () => !existsSync(profile) && !existsSync(socket))
    t.diagnostic(`run removed the window's profile ${Date.now() - closing} ms after closing it`)
  } finally {
    app?.close()
    await app?.exited
    page.close()
    if (CHROME_PATH === undefined) delete process.env.CHROME_PATH
    else process.env.CHROME_PATH = CHROME_PATH
    delete process.env.THREEJAM_CANARY
  }
})

// Opens run's window on a page that reports it loaded, with CHROME_PATH set to chrome, the launcher in dir, and has the test work with the window once the page has loaded, its profile and socket's folder, and Chrome's process ID, which is its process group's on macOS and Linux.
async function windowed(dir: string, chrome: string, test: (window: { app: AppWindow; closed: () => boolean; profile: string; socket: string; group: number }) => Promise<void>, options?: { grace?: number }): Promise<void> {
  const page = await loadingPage()
  const { CHROME_PATH } = process.env
  process.env.CHROME_PATH = chrome
  const app = openWindow(page.url, options)
  let exited = false
  let closed = false
  void app?.exited.then(() => (exited = true))
  void app?.closed.then(() => (closed = true))
  try {
    assert.ok(app)
    await until('Chrome to load the page', () => page.loaded() || exited)
    assert.equal(exited, false, 'Chrome exited before it loaded the page')
    const { profile } = given(dir)
    assert.ok(profile)
    const socket = dirname(readlinkSync(join(profile, 'SingletonSocket')))
    const group = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    assert.ok(reached(-group, 0), `Chrome, process ${group}, leads no process group of its own`)
    await test({ app, closed: () => closed, profile, socket, group })
  } finally {
    app?.close()
    page.close()
    if (CHROME_PATH === undefined) delete process.env.CHROME_PATH
    else process.env.CHROME_PATH = CHROME_PATH
  }
}

// Closes run's window on a Chrome whose output a process outside its group holds, and whose profile a process in its group would write to after Chrome exits, with CHROME_PATH set to the launcher's path, or to its name alone with its folder first on PATH.
async function lateWriter(byName: boolean): Promise<void> {
  const dir = mkdtempSync(join(TMP, 'wrapper-'))
  made.push(dir)
  const holder = join(dir, 'holder')
  // In a session of its own, like Chrome's crash handlers, a process holds the output Chrome was given for 30 s.
  const hold = `${sh(process.execPath)} -e ${sh(`const held = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(holder)}, String(held.pid)); held.unref()`)}`
  // In Chrome's process group, a process writes to the profile 300 ms after Chrome exits, as a helper that outlives Chrome could, then runs on.
  const late = `(while kill -0 $$ 2>/dev/null; do sleep 0.05; done; sleep 0.3; for arg in "$@"; do case $arg in --user-data-dir=*) profile=\${arg#--user-data-dir=} ;; esac; done; mkdir -p "$profile/late"; sleep 30) &`
  const chrome = wrapper(dir, ['--headless=new'], [hold, late])
  const { PATH } = process.env
  if (byName) process.env.PATH = `${dir}${delimiter}${PATH}`
  try {
    await windowed(dir, byName ? basename(chrome) : chrome, async ({ app, closed, profile, socket, group }) => {
      app.close()
      await until("run's window to close", closed)
      await new Promise((wait) => setTimeout(wait, 500))
      assert.deepEqual(
        { group: alive(group), holder: alive(Number(readFileSync(holder, 'utf8'))), profile: existsSync(profile), socket: existsSync(socket) },
        { group: false, holder: true, profile: false, socket: false },
      )
    })
  } finally {
    process.env.PATH = PATH
    if (existsSync(holder)) process.kill(Number(readFileSync(holder, 'utf8')), 'SIGKILL')
  }
}

test("closing run's window kills what is left of Chrome's process group once Chrome exits, then removes its profile, without waiting for a process outside the group that holds Chrome's output, as its crash handlers can on macOS", wrapped, () => lateWriter(false))

test("a CHROME_PATH that's a name found on PATH, like chromium, gives run's window a Chrome that leads its own process group, so closing it still ends every process Chrome started before the profile goes", wrapped, () => lateWriter(true))

test("a CHROME_PATH that's missing or a folder gets run's window to say it couldn't start Chrome and open the default browser instead, leaving no profile", { skip: process.platform === 'win32' && 'the stand-in browsers are shell scripts' }, async (t) => {
  const dir = mkdtempSync(join(TMP, 'opener-'))
  made.push(dir)
  const temp = mkdtempSync(join(TMP, 'opener-tmp-'))
  made.push(temp)
  const opened = join(dir, 'opened')
  // run opens the default browser with open on macOS and xdg-open elsewhere, by name, so these stand in for them.
  for (const name of ['open', 'xdg-open']) writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${sh(opened)}\n`, { mode: 0o755 })
  const printed: string[] = []
  t.mock.method(process.stderr, 'write', (chunk: string) => printed.push(chunk) > 0)
  const { PATH, CHROME_PATH, TMPDIR } = process.env
  process.env.PATH = `${dir}${delimiter}${PATH}`
  process.env.TMPDIR = temp
  const missing = join(dir, 'chrome')
  try {
    for (const chrome of [missing, dir]) {
      process.env.CHROME_PATH = chrome
      const url = `http://127.0.0.1:9/${basename(chrome)}`
      await openWindow(url)?.closed
      await until(`the default browser to open ${url}`, () => existsSync(opened) && readFileSync(opened, 'utf8').split('\n').includes(url))
    }
  } finally {
    process.env.PATH = PATH
    for (const [name, value] of Object.entries({ CHROME_PATH, TMPDIR })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assert.deepEqual(
    { printed, profiles: readdirSync(temp) },
    {
      printed: [`Couldn't start ${missing} (spawn ${missing} ENOENT), so the default browser opens the game.\n`, `Couldn't start ${dir} (spawn ${dir} EACCES), so the default browser opens the game.\n`],
      profiles: [],
    },
  )
})

test("closing run's window removes Chrome's socket folder even once Chrome has taken away its profile's link to it, as a Chrome killed while it closes can", { skip: process.platform === 'win32' && 'the stand-in Chrome is a shell script' }, async () => {
  const dir = mkdtempSync(join(TMP, 'unlinking-'))
  made.push(dir)
  // The system's temporary folder, since one deep in a checkout can be too long for the socket on Linux.
  const temp = mkdtempSync(join(tmpdir(), 'threejam-unlinking-'))
  made.push(temp)
  // It links its profile to a socket in a folder of its own, as Chrome does, and when asked to close it removes the links and exits, leaving the folder.
  const chrome = join(dir, 'chrome')
  const lines = [
    '#!/bin/sh',
    'for arg in "$@"; do case $arg in --user-data-dir=*) profile=${arg#--user-data-dir=} ;; esac; done',
    'folder=$(mktemp -d "$TMPDIR/com.google.Chrome.XXXXXX")',
    ': > "$folder/SingletonSocket"',
    ': > "$folder/SingletonCookie"',
    'ln -s "$folder/SingletonSocket" "$profile/SingletonSocket"',
    'ln -s "$folder/SingletonCookie" "$profile/SingletonCookie"',
    `trap 'rm "$profile/SingletonSocket" "$profile/SingletonCookie"; : > ${sh(join(dir, 'unlinked'))}; exit 0' TERM`,
    `: > ${sh(join(dir, 'started'))}`,
    'sleep 30 & wait $!',
  ]
  writeFileSync(chrome, `${lines.join('\n')}\n`, { mode: 0o755 })
  const { CHROME_PATH, TMPDIR } = process.env
  process.env.CHROME_PATH = chrome
  process.env.TMPDIR = temp
  const app = openWindow('http://127.0.0.1:9/')
  for (const [name, value] of Object.entries({ CHROME_PATH, TMPDIR })) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  assert.ok(app)
  let closed = false
  void app.closed.then(() => (closed = true))
  await until('the stand-in Chrome to start', () => existsSync(join(dir, 'started')))
  app.close()
  await until("run's window to close", () => closed)
  assert.deepEqual({ unlinked: existsSync(join(dir, 'unlinked')), left: readdirSync(temp) }, { unlinked: true, left: [] })
})

test("run's window kills a Chrome still running when the time it has to close is up, with every process it started, and removes its profile", wrapped, async () => {
  const dir = mkdtempSync(join(TMP, 'wrapper-'))
  made.push(dir)
  await windowed(
    dir,
    wrapper(dir, ['--headless=new']),
    async ({ app, closed, profile, socket, group }) => {
      // A stopped Chrome stands in for one too busy to exit when asked; its helpers run on.
      process.kill(group, 'SIGSTOP')
      try {
        const closing = Date.now()
        app.close()
        await until("run's window to close", closed)
        assert.deepEqual(
          { waited: Date.now() - closing >= 200, group: alive(group), profile: existsSync(profile), socket: existsSync(socket) },
          { waited: true, group: false, profile: false, socket: false },
        )
      } finally {
        // A Chrome that the window failed to kill exits on the SIGTERM it was sent, rather than staying stopped and keeping this test's process running.
        try {
          process.kill(group, 'SIGCONT')
        } catch {
          // It was killed.
        }
      }
    },
    { grace: 200 },
  )
})

// Whether any process is left in a process group.
function alive(group: number): boolean {
  try {
    process.kill(-group, 0)
    return true
  } catch {
    return false
  }
}

// Starts run with a headless window, in a TMPDIR of its own, and waits until the window has loaded the game; Chrome's process ID is its process group's.
async function runWindowed(t: TestContext, name: string): Promise<{ run: ChildProcessWithoutNullStreams; window: number; profile: string; socket: string }> {
  const dir = mkdtempSync(join(TMP, `${name}-`))
  made.push(dir)
  // The system's temporary folder, since one deep in a checkout can be too long for Chrome on Linux to start in.
  const temp = mkdtempSync(join(tmpdir(), `threejam-${name}-`))
  made.push(temp)
  let loaded = false
  const site = createServer((incoming, response) => {
    if (incoming.url === '/loaded') loaded = true
    response.writeHead(204).end()
  })
  await new Promise<void>((listening) => site.listen(0, '127.0.0.1', listening))
  t.after(() => site.close())
  const address = site.address()
  if (address === null || typeof address === 'string') throw new Error('the test server has no port')
  // The game's view tells the test once the window has loaded the game.
  const view = `export function init(): void {\n  void fetch('http://127.0.0.1:${address.port}/loaded', { mode: 'no-cors' })\n}\n`
  // Headless, so the window needs no display.
  const env = { ...process.env, CHROME_PATH: wrapper(dir, ['--headless=new']), TMPDIR: temp, TEMP: temp, TMP: temp }
  const run = spawnCli(['run', folder({ 'game.ts': GAME, 'view.ts': view })], t.signal, ROOT, env)
  await until('the window to load the game', () => loaded)
  const { profile } = given(dir)
  assert.ok(profile)
  return { run, window: Number(readFileSync(join(dir, 'pid'), 'utf8')), profile, socket: dirname(readlinkSync(join(profile, 'SingletonSocket'))) }
}

test("closing the terminal that run is in closes its window and removes the window's profile before run stops, as Ctrl-C does", wrapped, async (t) => {
  const { run, window, profile, socket } = await runWindowed(t, 'hangup')
  const { pid } = run
  assert.ok(pid)
  const exited = new Promise((done) => run.once('close', done))
  const hangUp = () => {
    if (run.exitCode === null && run.signalCode === null) process.kill(pid, 'SIGHUP')
  }
  const pause = (ms: number) => new Promise((wait) => setTimeout(wait, ms))
  // A stopped Chrome stands in for one slow to exit, which run waits for before it removes the window's profile, up to the 2 s it gives the window to close.
  process.kill(window, 'SIGSTOP')
  // The terminal takes no more output, and it hangs up on run twice, from its shell and then from the kernel.
  run.stdout.destroy()
  hangUp()
  await pause(100)
  hangUp()
  const stoppedFirst = await Promise.race([exited.then(() => true), pause(300).then(() => false)])
  process.kill(window, 'SIGCONT')
  await exited
  assert.deepEqual({ stoppedFirst, profile: existsSync(profile), socket: existsSync(socket), chrome: alive(window) }, { stoppedFirst: false, profile: false, socket: false, chrome: false })
})

test("killing run, even with SIGKILL, ends its window's Chrome and every process Chrome started", wrapped, async (t) => {
  // Nothing is left to remove the window's profile then, which goes with the test's temporary folder.
  const { run, window } = await runWindowed(t, 'killed')
  const exited = new Promise((done) => run.once('exit', done))
  run.kill('SIGKILL')
  await exited
  const killed = Date.now()
  // Chrome itself too, since a Chrome that leads no group would pass for one whose group is gone.
  await until("the window's Chrome to end", () => !alive(window) && !reached(window, 0))
  const took = Date.now() - killed
  t.diagnostic(`Chrome's process group ended ${took} ms after run was killed`)
  assert.ok(took < 2000, `Chrome's process group outlived run by ${took} ms`)
})
