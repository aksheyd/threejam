import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { sandboxEnv } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { findChrome } from '../src/serve.ts'
import { CLI, mcp, reached, spawnCli, type Reply } from './children.ts'
import { TMP, folder, game, made, slowCheck } from './games.ts'

// The processes in a process group, as ps lists them on macOS and Linux.
function inGroup(group: number | undefined): number[] {
  const { stdout } = spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
  return stdout.split('\n').flatMap((line) => {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    return pgid === group ? [pid] : []
  })
}

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !check(); await new Promise((wait) => setTimeout(wait, 50))) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
  }
}

// The process that parent started to run something matching what, once ps lists it on macOS and Linux.
async function started(parent: number | undefined, what: RegExp): Promise<number> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((wait) => setTimeout(wait, 50))) {
    const { stdout } = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
    for (const line of stdout.split('\n')) {
      const [pid, ppid, ...args] = line.trim().split(/\s+/)
      if (Number(ppid) === parent && what.test(args.join(' '))) return Number(pid)
    }
  }
  throw new Error(`gave up waiting for ${parent} to start a process matching ${what}`)
}

// ps still lists a process that has exited until it's reaped, as a zombie.
function ended(pid: number): boolean {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return state === '' || state.startsWith('Z')
}

// What Linux shows of a sandbox once its shell has become Node: its environment, but for the SHLVL=0 that bash's exec adds, and which descriptors are sockets, which should be only the server's 0 to 2.
async function sandboxed(pid: number): Promise<{ env: string[]; sockets: number[] }> {
  await until('the sandbox to become Node', () => realpathSync(`/proc/${pid}/exe`) === realpathSync(process.execPath))
  const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter((entry) => entry !== '' && entry !== 'SHLVL=0')
  const sockets = readdirSync(`/proc/${pid}/fd`).filter((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith('socket:'))
  return { env: env.sort(), sockets: sockets.map(Number).sort((a, b) => a - b) }
}

test("closing a test's MCP server, or aborting its signal as a test that times out does, stops the server and every process it started", { skip: process.platform === 'win32' && 'process groups are for macOS and Linux' }, async (t) => {
  const loop = folder({ 'game.ts': game({ update: 'for (;;) {}' }) })
  for (const end of ['close', 'abort'] as const) {
    const timedOut = new AbortController()
    const server = mcp(AbortSignal.any([t.signal, timedOut.signal]))
    await server.ready
    void server.request('tools/call', { name: 'sim', arguments: { dir: loop, ticks: 1, timeout: 60 } })
    const sandbox = await started(server.pid, /--permission/)
    if (end === 'close') server.close()
    else timedOut.abort()
    await until(`the server and its sandbox to stop on its ${end}`, () => inGroup(server.pid).length === 0 && ended(sandbox))
  }
})

// A game whose type check never finishes: it imports a FIFO that nothing writes to, which TypeScript waits to read.
function stalledCheck(): string {
  const dir = folder({ 'game.ts': `import './stall.ts'\n${game({ update: 'world.ball.x += 1' })}` })
  assert.equal(spawnSync('mkfifo', [join(ROOT, dir, 'stall.ts')]).status, 0)
  return dir
}

test("an MCP server killed with SIGKILL takes the sandbox running a game, and check's type check, with it, instead of leaving them to run on", { skip: process.platform === 'win32' && "Windows ends a process's children with it, since libuv puts each in a job object" }, async (t) => {
  const loop = folder({ 'game.ts': game({ update: 'for (;;) {}' }) })
  const stalled = stalledCheck()
  // A killed server can't remove the folder its type check reads, so its temporary files go in a folder of the test's.
  const tmp = mkdtempSync(join(TMP, 'tmp-'))
  made.push(tmp)
  const server = mcp(t.signal, ROOT, { ...process.env, TMPDIR: tmp })
  await server.ready
  void server.request('tools/call', { name: 'sim', arguments: { dir: loop, ticks: 1, timeout: 60 } })
  const sandbox = await started(server.pid, /--permission/)
  if (process.platform === 'linux') assert.deepEqual(await sandboxed(sandbox), { env: Object.entries(sandboxEnv()).map(([name, value]) => `${name}=${value}`).sort(), sockets: [0, 1, 2] })
  void server.request('tools/call', { name: 'check', arguments: { dir: stalled, timeout: 60 } })
  const children = [sandbox, await started(server.pid, /--listFiles/)]
  try {
    server.kill('SIGKILL')
    await until('the sandbox and the type check to end with their server', () => children.every(ended))
  } finally {
    for (const pid of children) if (!ended(pid)) process.kill(pid, 'SIGKILL')
  }
})

test("an MCP server fed its requests through a pipe that closes once they're written, as with echo or cat piped into threejam --mcp, answers each of them before it exits", () => {
  const batch = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'tools/call', params: { name: 'sim', arguments: { dir: 'games/pong', ticks: 1, only: 'ball', fields: 'x,y' } } },
  ]
  const input = batch.map((message) => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`).join('')
  const piped = spawnSync(process.execPath, [CLI, '--mcp'], { cwd: ROOT, input, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' })
  const replies: Reply[] = piped.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(
    { status: piped.status, ids: replies.map((reply) => reply.id), sim: replies.at(-1)?.result?.content?.[0]?.text.split('\n')[0] },
    { status: 0, ids: [1, 2, 3], sim: '{"tick":1,"entities":[{"name":"ball","x":0,"y":0}]}' },
  )
})

test("an MCP server whose client closes stdin gives the calls still running 2 s to finish, then exits without answering them, ending a sim's sandbox, check's type check and the folder it reads, and a shot through shot's own cleanup, which kills its Chrome and removes Chrome's profile and socket folders", async (t) => {
  const loop = folder({ 'game.ts': game({ update: 'for (;;) {}' }) })
  const stuck = folder({ 'game.ts': game({ update: 'world.ball.x += 1' }), 'view.ts': 'for (;;) {}\n' })
  // The system's temporary folder, since one deep in a checkout can be too long for Chrome on Linux to start in.
  const tmp = mkdtempSync(join(tmpdir(), 'threejam-temp-'))
  made.push(tmp)
  const server = mcp(t.signal, ROOT, { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp })
  await server.ready
  const answered: string[] = []
  const call = (name: string, args: object) => void server.request('tools/call', { name, arguments: args }).then(() => answered.push(name))
  call('sim', { dir: loop, ticks: 1, timeout: 60 })
  // Only on macOS and Linux can ps find the server's children and a FIFO hold a type check open.
  const children: number[] = []
  if (process.platform !== 'win32') {
    children.push(await started(server.pid, /--permission/))
    call('check', { dir: stalledCheck(), timeout: 60 })
    children.push(await started(server.pid, /--listFiles/))
  }
  if (findChrome()) {
    call('shot', { dir: stuck, at: '1', out: join(stuck, 'frame.png'), timeout: 60 })
    // Chrome fills its profile as it starts.
    await until("the shot's Chrome to start", () => readdirSync(tmp).some((name) => name.startsWith('threejam-chrome-') && readdirSync(join(tmp, name)).length > 0))
  }
  const closed = Date.now()
  server.end()
  assert.deepEqual(await Promise.race([server.exited, new Promise((done) => setTimeout(done, 10_000, 'still running').unref())]), [0, null])
  // The calls' 2 s, by a timer the server may start a moment before this clock reads it, then at most 2 s for the shot's cleanup.
  const took = Date.now() - closed
  t.diagnostic(`the server exited ${took} ms after its client closed stdin`)
  assert.ok(took >= 1900 && took < 5000, `the server took ${took} ms to exit`)
  await until('the sandbox and the type check to end with their server', () => children.every(ended))
  // On Windows, Chrome's helpers can hold a file in shot's profile a moment after Chrome is killed, and shot leaves those for the OS.
  const left = readdirSync(tmp).filter((name) => process.platform !== 'win32' || !name.startsWith('threejam-chrome-'))
  const chrome = process.platform === 'win32' ? [] : spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.includes(`--user-data-dir=${tmp}`))
  assert.deepEqual({ left, chrome, answered }, { left: [], chrome: [], answered: [] })
})

test('check stopped by Ctrl-C, SIGTERM, or the SIGHUP of a closed terminal during its type check removes the folder the type check reads, then ends by that signal, even when the terminal sends SIGHUP twice at once', { skip: process.platform === 'win32' && 'Windows has neither a SIGTERM or SIGHUP a process can catch nor FIFOs' }, async (t) => {
  const stalled = stalledCheck()
  const stop = async (signal: NodeJS.Signals, times: number) => {
    const tmp = mkdtempSync(join(TMP, 'tmp-'))
    made.push(tmp)
    const check = spawnCli(['check', stalled, '--timeout', '60'], t.signal, ROOT, { ...process.env, TMPDIR: tmp })
    const typecheck = await started(check.pid, /--listFiles/)
    assert.match(readdirSync(tmp).join(), /^threejam-check-\w+$/)
    for (let i = 0; i < times; i++) check.kill(signal)
    await until(`check to end on ${signal}`, () => check.exitCode !== null || check.signalCode !== null)
    assert.deepEqual([check.exitCode, check.signalCode, readdirSync(tmp)], [null, signal, []])
    await until(`the type check to end with check on ${signal}`, () => ended(typecheck))
  }
  await Promise.all([stop('SIGINT', 1), stop('SIGTERM', 1), stop('SIGHUP', 1), stop('SIGHUP', 2)])
})

test("shot stopped by Ctrl-C, SIGTERM, or a closed terminal's two SIGHUPs removes what it and Chrome made, then ends by the signal, writing nothing", { skip: (!findChrome() && 'needs Chrome') || (process.platform === 'win32' && 'signals are for macOS and Linux'), timeout: 60_000 }, async (t) => {
  // Drawing tick 2 never returns, so a shot that has saved tick 1 is still running, with Chrome long started.
  const dir = folder({ 'game.ts': game({ update: '' }), 'view.ts': "import type { ViewFrame } from 'threejam'\n\nexport function draw({ tick }: ViewFrame): void {\n  if (tick === 2) for (;;) {}\n}\n" })
  const ends = await Promise.all((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(async (signal) => {
    // The system's temporary folder, since one deep in a checkout can be too long for Chrome on Linux to start in.
    const temp = mkdtempSync(join(tmpdir(), 'threejam-temp-'))
    made.push(temp)
    const shot = spawnCli(['shot', dir, '--at', '1,2', '--timeout', '30', '-o', join(dir, `${signal}.png`)], t.signal, ROOT, { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp })
    let printed = ''
    for (const output of [shot.stdout, shot.stderr]) output.on('data', (chunk) => (printed += chunk))
    const ended = new Promise((done) => shot.once('exit', (code, name) => done(name ?? code)))
    // Three shots start Chrome at once, which a slow machine can take a while over.
    await until(`shot to save tick 1 before its ${signal}`, () => existsSync(join(ROOT, dir, `${signal}-001.png`)), 30_000)
    if (shot.pid === undefined) throw new Error('shot has no process')
    // kill sends SIGTERM to the process alone; a terminal sends Ctrl-C to its whole group, and as it closes, SIGHUP, after which writes fail.
    if (signal === 'SIGTERM') shot.kill(signal)
    else if (signal === 'SIGINT') process.kill(-shot.pid, signal)
    else {
      shot.stdout.destroy()
      shot.stderr.destroy()
      process.kill(-shot.pid, signal)
      // The shell passes the terminal's SIGHUP on a moment later, as the shot cleans up, or once it has ended.
      await new Promise((wait) => setTimeout(wait, 10))
      reached(-shot.pid, signal)
    }
    return [signal, { ended: await ended, printed, left: readdirSync(temp) }]
  }))
  assert.deepEqual(Object.fromEntries(ends), {
    SIGINT: { ended: 'SIGINT', printed: '', left: [] },
    SIGTERM: { ended: 'SIGTERM', printed: '', left: [] },
    SIGHUP: { ended: 'SIGHUP', printed: '', left: [] },
  })
})

test('a shot stopped just as Chrome answers the call that starts it or the one that opens its tab, where Puppeteer would wait on the killed Chrome for good or for 30 s, still cleans up and ends by the signal', { skip: !findChrome() && 'needs Chrome', timeout: 60_000 }, async (t) => {
  const dir = folder({ 'game.ts': game({ update: '' }) })
  const ends = await Promise.all(['Target.setAutoAttach', 'Target.createTarget'].map(async (method) => {
    const temp = mkdtempSync(join(tmpdir(), 'threejam-temp-'))
    made.push(temp)
    const stopped = join(ROOT, dir, `${method}.stopped`)
    // Loaded before the CLI, it stops the shot as a SIGTERM does, right after Chrome answers method.
    const stopper = join(ROOT, dir, `${method}.mjs`)
    writeFileSync(stopper, [
      "import { writeFileSync } from 'node:fs'",
      "import { Connection } from 'puppeteer-core/internal/cdp/Connection.js'",
      'const send = Connection.prototype.send',
      'Connection.prototype.send = function (method, ...rest) {',
      '  const reply = send.call(this, method, ...rest)',
      `  if (method === ${JSON.stringify(method)}) reply.then(() => (writeFileSync(${JSON.stringify(stopped)}, ''), process.emit('SIGTERM', 'SIGTERM')), () => {})`,
      '  return reply',
      '}',
      '',
    ].join('\n'))
    const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(stopper).href}` }
    const shot = spawnCli(['shot', dir, '-o', join(dir, `${method}.png`)], t.signal, ROOT, env)
    let printed = ''
    for (const output of [shot.stdout, shot.stderr]) output.on('data', (chunk) => (printed += chunk))
    const exited = new Promise((done) => shot.once('exit', (code, name) => done(name ?? code)))
    await until(`shot to be stopped after ${method}`, () => existsSync(stopped), 30_000)
    // Well past the most cleaning up takes, and short of the 30 s Puppeteer would wait for the tab.
    const ended = await Promise.race([exited, new Promise((done) => setTimeout(() => done('still running 20 s after its SIGTERM'), 20_000).unref())])
    // A Chrome killed as it starts can leave one of the temporary files it makes then, which on macOS and Linux stay in TMPDIR; on Windows, its helpers can hold a file in shot's profile a moment after it's killed, and shot leaves those for the OS.
    const left = readdirSync(temp).filter((name) => !/^\.(com\.google\.Chrome|org\.chromium\.Chromium)\.\w{6}$/.test(name) && (process.platform !== 'win32' || !name.startsWith('threejam-chrome-')))
    return [method, { ended, printed, left }]
  }))
  // Windows can't end a process by a signal, so there shot exits with 128 and the signal's number.
  const ended = process.platform === 'win32' ? 143 : 'SIGTERM'
  assert.deepEqual(Object.fromEntries(ends), {
    'Target.setAutoAttach': { ended, printed: '', left: [] },
    'Target.createTarget': { ended, printed: '', left: [] },
  })
})

// Lines that run shots in a process of their own, whose output shows what happened.
function isolated(lines: readonly string[]): { ended: number | string | null; printed: string } {
  const script = [`import { interruptible } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'shot.ts')).href)}`, ...lines].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
  return { ended: result.signal ?? result.status, printed: result.stdout + result.stderr }
}

// What Node does when SIGTERM arrives.
const TERM = "process.emit('SIGTERM', 'SIGTERM')"

// Windows can't end a process by a signal, so there shot exits with 128 and the signal's number.
const TERMINATED = process.platform === 'win32' ? 143 : 'SIGTERM'

test('a signal stops the running shots and any that start before they are done, ends the process once each has cleaned up, and no shot settles, so none answers the call it ran for', () => {
  // A shot that starts after the signal has its killer aborted before its work begins.
  const cleaning = (name: string, ms: number) => `(killer) => new Promise((done) => { const clean = () => setTimeout(() => done(console.log('${name} cleaned up')), ${ms}); if (killer.signal.aborted) clean(); else killer.signal.addEventListener('abort', clean) })`
  const shot = (name: string, ms: number) => `void interruptible(${cleaning(name, ms)}).finally(() => console.log('${name} settled'))`
  assert.deepEqual(isolated([shot('first', 50), shot('second', 300), TERM, shot('late', 100)]), { ended: TERMINATED, printed: 'first cleaned up\nlate cleaned up\nsecond cleaned up\n' })
})

test("a shot that a signal stops while it's stuck where killing Chrome doesn't reach holds the process no longer than its grace", () => {
  assert.deepEqual(isolated(['void interruptible(() => new Promise(() => setInterval(() => {}, 1000)), 200).finally(() => console.log("settled"))', TERM]), { ended: TERMINATED, printed: '' })
})

test("an exit waits at most its time for the shots it stops, counting a kill that holds the process meanwhile, as Puppeteer's taskkill of Chrome does on Windows", () => {
  // The kill holds the process for 600 ms and the cleanup takes 600 ms more, against the exit's 500 ms, so the exit comes as the kill ends.
  const shot = "void interruptible((killer) => new Promise((done) => killer.signal.addEventListener('abort', () => { for (const until = Date.now() + 600; Date.now() < until; ); setTimeout(done, 600) })))"
  const endShots = `import { endShots } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'shot.ts')).href)}`
  const lines = [endShots, shot, 'const started = Date.now()', 'await endShots(500)', "console.log(Date.now() - started < 900 ? 'in time' : `after ${Date.now() - started} ms`)"]
  assert.deepEqual(isolated(lines), { ended: 0, printed: 'in time\n' })
})

test('a shot whose work throws before returning a promise fails with that error and stops catching signals', () => {
  const lines = ["await interruptible(() => { throw new Error('thrown') }).catch((error) => console.log(error.message))", "console.log(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal)).join(' '))"]
  assert.deepEqual(isolated(lines), { ended: 0, printed: 'thrown\n0 0 0\n' })
})

test('when something else in the process takes the signal a shot ends it by, the shots that start once the stopped ones are done run as usual', () => {
  const stopped = "void interruptible((killer) => new Promise((done) => killer.signal.addEventListener('abort', done))).finally(() => console.log('stopped settled'))"
  const lines = ["process.on('SIGTERM', () => {})", stopped, TERM, 'await new Promise((done) => setTimeout(done, 100))', "console.log(await interruptible(async () => 'later ran'))"]
  assert.deepEqual(isolated(lines), { ended: 0, printed: 'later ran\n' })
})

test("a signal during a type check and a shot removes the type check's folder, waits for the shot to clean up, then ends the process as the signal would", () => {
  const tmp = mkdtempSync(join(TMP, 'tmp-'))
  made.push(tmp)
  const lines = [
    `import { typecheck } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'load.ts')).href)}`,
    `Object.assign(process.env, { TMPDIR: ${JSON.stringify(tmp)}, TMP: ${JSON.stringify(tmp)}, TEMP: ${JSON.stringify(tmp)} })`,
    `void typecheck({ file: ${JSON.stringify(join(ROOT, slowCheck(), 'game.ts'))}, dom: false, timeout: 60 }).catch(() => {})`,
    "void interruptible((killer) => new Promise((done) => killer.signal.addEventListener('abort', () => setTimeout(() => done(console.log('shot cleaned up')), 200))))",
    TERM,
  ]
  assert.deepEqual({ ...isolated(lines), left: readdirSync(tmp) }, { ended: TERMINATED, printed: 'shot cleaned up\n', left: [] })
})
