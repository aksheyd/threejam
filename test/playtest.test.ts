import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { Recorder } from '../src/browser/playtest.ts'
import { CENTER } from '../src/input.ts'
import { typecheck } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { Recording, playtestSource, type Change } from '../src/playtest.ts'
import { buildPage, serve } from '../src/serve.ts'
import { KEYS } from '../src/types.ts'
import { spawnCli } from './children.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(TMP, 'playtest-'))
  made.push(dir)
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}

const GAME = "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1 } }, update() {} })\n"
const TOKEN = 'session-token'
// Node ends a process on Windows without the signal its handlers would hear, so run can't save there when a test stops it.
const SIGNALS = { skip: process.platform === 'win32' && 'Node ends a process on Windows without the signal its handlers would hear' }

async function until(what: string, check: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 10_000; !check(); await new Promise((wait) => setTimeout(wait, 20))) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
  }
}

// A run server that records, as run --record starts one.
async function recording() {
  const page = await buildPage({ dir: folder({ 'game.ts': GAME }), config: { mode: 'run', seed: 0, token: TOKEN, record: true } })
  const kept = new Recording()
  const server = await serve({ page, token: TOKEN, recording: kept })
  return { page, kept, url: server.url, close: () => (server.close(), page.dispose()) }
}

// What one part of a playtest gets from the run server, sent as the page sends it.
function sendPart(url: string, query: Record<string, string | number>, body: string): Promise<number> {
  return new Promise((done, fail) => {
    const search = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, String(value)]))
    const sent = request(new URL(`/record?${search}`, url), { method: 'POST' }, (response) => {
      done(response.statusCode ?? 0)
      response.resume()
    })
    sent.on('error', fail)
    sent.end(body)
  })
}

test("run keeps a playtest as one session whole from its first tick: it takes each part where the last ended and a session started over from its first change, and refuses keys and pointers the engine doesn't take, ticks out of order, a part out of place, and a page from before the latest save", async () => {
  const { page, kept, url, close } = await recording()
  try {
    const part = (from: number, ticks: number, changes: unknown, { session = 'a', build = page.build } = {}) => sendPart(url, { token: TOKEN, build, session, seed: -4, from, ticks }, JSON.stringify(changes))
    const statuses = {
      first: await part(0, 10, [[2, ['Space']], [5, ['up', 'Space'], { x: 0.5, y: -0.25 }]]),
      next: await part(2, 20, [[12, []]]),
      unknownKey: await part(3, 30, [[25, ['Esc']]]),
      offScreen: await part(3, 30, [[25, [], { x: 2.5, y: 0 }]]),
      notANumber: await part(3, 30, [[25, [], { x: null, y: 0 }]]),
      tickAgain: await part(3, 30, [[20, ['W']]]),
      pastItsTicks: await part(3, 24, [[25, ['W']]]),
      notJson: await sendPart(url, { token: TOKEN, build: page.build, session: 'a', seed: -4, from: 3, ticks: 30 }, '[[25, ['),
      gap: await part(4, 30, [[25, ['W']]]),
      otherSession: await part(3, 30, [[25, ['W']]], { session: 'b' }),
      olderBuild: await part(0, 5, [[1, ['W']]], { session: 'c', build: page.build - 1 }),
      startedOutOfOrder: await part(0, 5, [[3, ['W']], [2, []]], { session: 'c' }),
      tooBig: await sendPart(url, { token: TOKEN, build: page.build, session: 'a', seed: -4, from: 3, ticks: 30 }, `[${' '.repeat(1024 * 1024)}]`),
    }
    assert.deepEqual(statuses, { first: 204, next: 204, unknownKey: 400, offScreen: 400, notANumber: 400, tickAgain: 400, pastItsTicks: 400, notJson: 400, gap: 409, otherSession: 409, olderBuild: 409, startedOutOfOrder: 400, tooBig: 413 })
    assert.deepEqual(kept.latest(page.build), { build: page.build, id: 'a', seed: -4, changes: [[2, ['Space']], [5, ['Space', 'Up'], { x: 0.5, y: -0.25 }], [12, []]], ticks: 20 })
    assert.equal(await part(0, 3, [[1, ['W']]], { session: 'd' }), 204)
    assert.deepEqual(kept.latest(page.build), { build: page.build, id: 'd', seed: -4, changes: [[1, ['W']]], ticks: 3 })
    // A save since the session's page loaded starts the playtest over.
    assert.equal(kept.latest(page.build + 1), undefined)
  } finally {
    await close()
  }
})

// On every tick the pointer moves, so every tick is a change, which the test can write down without the recorder.
function play(recorder: Recorder, first: number, last: number): void {
  for (let tick = first; tick <= last; tick++) recorder.add(tick, tick % 3 === 0 ? ['W'] : [], { x: tick / 10_000, y: -tick / 10_000 })
}

function played(last: number): Change[] {
  return Array.from({ length: last }, (_, i) => [i + 1, (i + 1) % 3 === 0 ? ['W'] : [], { x: (i + 1) / 10_000, y: -(i + 1) / 10_000 }])
}

test("a page's recorder sends run its session in parts of at most 1000 changes, and once run refuses one, as it does after another page starts a session, sends its session again from the first change, whole", async () => {
  const { page, kept, url, close } = await recording()
  const fetching = globalThis.fetch
  const sent: string[] = []
  // The page's fetch reaches run's page by a path alone.
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetching(new URL(String(input), url), init)
    sent.push(`${JSON.parse(String(init?.body)).length} changes: ${response.status}`)
    return response
  }
  try {
    // The counts first, so a session that isn't whole fails without a diff of thousands of changes.
    const whole = (seed: number, last: number) => {
      const session = kept.latest(page.build)
      assert.deepEqual({ seed: session?.seed, ticks: session?.ticks, changes: session?.changes.length }, { seed, ticks: last, changes: last })
      assert.deepEqual(session?.changes, played(last))
    }
    const first = new Recorder({ token: TOKEN, build: page.build })
    first.start(5)
    play(first, 1, 2500)
    await first.flush()
    whole(5, 2500)
    const second = new Recorder({ token: TOKEN, build: page.build })
    second.start(6)
    play(second, 1, 10)
    await second.flush()
    whole(6, 10)
    play(first, 2501, 4000)
    await first.flush()
    whole(5, 4000)
    assert.deepEqual(sent, [
      ...['1000 changes: 204', '1000 changes: 204', '500 changes: 204'],
      '10 changes: 204',
      ...['1000 changes: 409', '1000 changes: 204', '1000 changes: 204', '1000 changes: 204', '1000 changes: 204'],
    ])
  } finally {
    globalThis.fetch = fetching
    await close()
  }
})

test("a page's recorder starts each session with every key up, so a key still held from the session before is the new session's first change", async () => {
  const { page, kept, url, close } = await recording()
  const fetching = globalThis.fetch
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => fetching(new URL(String(input), url), init)
  try {
    const recorder = new Recorder({ token: TOKEN, build: page.build })
    recorder.start(1)
    recorder.add(1, ['W'], CENTER)
    recorder.add(2, ['W'], CENTER)
    // The pointer stays in the middle, where a session starts it, so only the keys can make the new session's first tick a change.
    recorder.start(2)
    recorder.add(1, ['W'], CENTER)
    recorder.add(2, ['W'], CENTER)
    await recorder.flush()
    const session = kept.latest(page.build)
    assert.deepEqual({ seed: session?.seed, changes: session?.changes, ticks: session?.ticks }, { seed: 2, changes: [[1, ['W']]], ticks: 2 })
  } finally {
    globalThis.fetch = fetching
    await close()
  }
})

test('a playtest of thousands of ticks that each move the pointer passes the type check that check and a new project use', async () => {
  const dir = folder({})
  const file = join(dir, 'playtest.ts')
  const changes = played(3000).map(([tick, , pointer]): Change => [tick, KEYS.filter((_, i) => (tick + i) % 7 === 0), pointer])
  writeFileSync(file, playtestSource({ seed: 5, ticks: 3010, changes }))
  assert.deepEqual(await typecheck({ file, dom: false }), [])
})

// run --record, with a part posted as the page posts it, then whatever comes before a signal stops run.
async function stopped(t: TestContext, file: string, meanwhile: () => void) {
  const dir = folder({ 'game.ts': GAME })
  const run = spawnCli(['run', dir, '--serve-only', '--record', file], t.signal)
  let out = ''
  run.stdout.on('data', (chunk) => (out += chunk))
  run.stderr.on('data', (chunk) => (out += chunk))
  const exited = new Promise((done) => run.once('close', done))
  await until('run to serve the page', () => out.includes('\n'))
  const url = out.slice(out.lastIndexOf(' ') + 1, -1)
  const config = await (await fetch(url)).text()
  const [token, build] = [/"token":"([\w-]+)"/.exec(config)?.[1] ?? '', /"build":(\d+)/.exec(config)?.[1] ?? '']
  assert.equal(await sendPart(url, { token, build, session: 'a', seed: 2, from: 0, ticks: 10 }, '[[1, ["W"]]]'), 204)
  meanwhile()
  run.kill('SIGTERM')
  return { code: await exited, out: out.slice(out.indexOf('\n') + 1) }
}

test("run saves a playtest only where its check passes as run stops, so a file or a link put at the path while the person plays stays as it was, and nothing is written through the link", SIGNALS, async (t) => {
  const dir = folder({})
  mkdirSync(join(dir, 'outside'))
  const notes = join(dir, 'notes.ts')
  assert.deepEqual(await stopped(t, notes, () => writeFileSync(notes, 'export const mine = 1\n')), {
    code: 1,
    out: `Error (IO_ERROR): couldn't save the playtest to ${notes}, which is a file run didn't record now\n`,
  })
  assert.equal(readFileSync(notes, 'utf8'), 'export const mine = 1\n')
  const link = join(dir, 'playtest.ts')
  const target = join('outside', 'planted.desktop')
  assert.deepEqual(await stopped(t, link, () => symlinkSync(target, link)), { code: 1, out: `Error (IO_ERROR): couldn't save the playtest to ${link}, which is a link now\n` })
  assert.deepEqual({ link: readlinkSync(link), outside: readdirSync(join(dir, 'outside')) }, { link: target, outside: [] })
})

test('run --record takes a playtest it saved before, and leaves it as it was when no tick ran before run stopped', SIGNALS, async (t) => {
  const dir = folder({ 'game.ts': GAME })
  const file = join(dir, 'playtest.ts')
  const earlier = playtestSource({ seed: 1, ticks: 2, changes: [[1, ['Space']]] })
  writeFileSync(file, earlier)
  const run = spawnCli(['run', dir, '--serve-only', '--record', file], t.signal)
  let out = ''
  run.stdout.on('data', (chunk) => (out += chunk))
  const exited = new Promise((done) => run.once('close', done))
  await until('run to serve the page', () => out.includes('\n'))
  run.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.equal(out.slice(out.indexOf('\n') + 1), `Saved no playtest to ${file}, since no tick ran after run started or a file was last saved.\nStopped.\n`)
  assert.equal(readFileSync(file, 'utf8'), earlier)
})

test('when a signal stops run --record, run waits a moment for the parts of the playtest still on their way: it saves one that gets its answer then, and stops waiting for one whose body stops halfway', SIGNALS, async (t) => {
  const dir = folder({ 'game.ts': GAME })
  const file = join(dir, 'playtest.ts')
  const run = spawnCli(['run', dir, '--serve-only', '--record', file], t.signal)
  let out = ''
  run.stdout.on('data', (chunk) => (out += chunk))
  run.stderr.on('data', (chunk) => (out += chunk))
  const exited = new Promise((done) => run.once('close', done))
  await until('run to serve the page', () => out.includes('\n'))
  const url = new URL(out.slice(out.lastIndexOf(' ') + 1, -1))
  const config = await (await fetch(url)).text()
  const [token, build] = [/"token":"([\w-]+)"/.exec(config)?.[1] ?? '', /"build":(\d+)/.exec(config)?.[1] ?? '']
  // A part on its way: its headers, which Node answers with 100 Continue once it has them, and all of its body but the last byte.
  const begin = (query: Record<string, string | number>, body: string) => {
    const part = { socket: connect(Number(url.port), '127.0.0.1'), answered: '', rest: body.slice(-1) }
    part.socket.on('data', (chunk) => (part.answered += chunk)).on('error', () => {})
    const search = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, String(value)]))
    part.socket.write(`POST /record?${search} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: ${body.length}\r\nExpect: 100-continue\r\n\r\n${body.slice(0, -1)}`)
    return part
  }
  const late = begin({ token, build, session: 'a', seed: 2, from: 0, ticks: 10 }, '[[1, ["W"]]]')
  const stalled = begin({ token, build, session: 'a', seed: 2, from: 1, ticks: 20 }, '[[15, []]]')
  try {
    await until('run to take both parts', () => late.answered.includes('100 Continue') && stalled.answered.includes('100 Continue'))
    run.kill('SIGTERM')
    // Well past when run would save the playtest if it didn't wait.
    await new Promise((done) => setTimeout(done, 200))
    late.socket.write(late.rest)
    const code = await Promise.race([exited, new Promise((done) => setTimeout(() => done('still running 10 s after its SIGTERM'), 10_000).unref())])
    const statuses = (answered: string) => answered.split('\r\n').filter((line) => line.startsWith('HTTP/'))
    assert.deepEqual({ code, late: statuses(late.answered), stalled: statuses(stalled.answered) }, { code: 0, late: ['HTTP/1.1 100 Continue', 'HTTP/1.1 204 No Content'], stalled: ['HTTP/1.1 100 Continue'] })
    assert.match(out, new RegExp(`\nSaved the playtest, 10 ticks with seed 2, to ${file.replaceAll('.', '\\.')}; replay it with [^\n]+\nStopped\\.\n$`))
  } finally {
    late.socket.destroy()
    stalled.socket.destroy()
  }
})
