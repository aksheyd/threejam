import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { crashed, describe, sandboxEnv } from '../src/load.ts'
import { ENGINE, ROOT, VERSION, mcpCommand } from '../src/package.ts'
import { findChrome } from '../src/serve.ts'
import { callLimit, framePaths } from '../src/shot.ts'
import { CLI, reached, spawnCli, stopTree } from './children.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function threejam(...args: string[]) {
  return threejamWith({}, ...args)
}

// spawnSync holds up the test's own timeout, so a run that never ends, like a run that starts serving, is killed here.
function threejamWith(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000, killSignal: 'SIGKILL' })
  return { code: result.status, out: result.stdout + result.stderr }
}

// Inside the repo, so messages name the files by short relative paths.
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(TMP, 'game-'))
  made.push(dir)
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return relative(ROOT, dir)
}

function game({ fields = 'x: 0, y: 0, w: 0.1, h: 0.1, vx: 1', update }: { fields?: string; update: string }): string {
  return [
    "import { defineGame } from 'threejam'",
    '',
    'export default defineGame({',
    `  entities: { ball: { ${fields} } },`,
    '  update(world, ctx) {',
    `    ${update}`,
    '  },',
    '})',
    '',
  ].join('\n')
}

interface Reply {
  readonly id?: number
  readonly result?: {
    readonly serverInfo?: { readonly version: string }
    readonly instructions?: string
    readonly tools?: ReadonlyArray<{ readonly name: string; readonly inputSchema?: { readonly properties?: Record<string, { readonly description?: string }> } }>
    readonly content?: ReadonlyArray<{ readonly text: string }>
    readonly isError?: boolean
  }
}

function mcp(signal: AbortSignal, cwd = ROOT, env?: NodeJS.ProcessEnv) {
  const server = spawnCli(['--mcp'], signal, cwd, env)
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((done) => server.once('exit', (code, by) => done([code, by])))
  const waiting = new Map<number, (reply: Reply) => void>()
  let buffered = ''
  let next = 1
  server.stdout.setEncoding('utf8')
  server.stdout.on('data', (chunk: string) => {
    const lines = (buffered + chunk).split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines.filter((l) => l.trim())) {
      const reply: Reply = JSON.parse(line)
      if (reply.id !== undefined) waiting.get(reply.id)?.(reply)
    }
  })
  const send = (message: object) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (method: string, params: object) =>
    new Promise<Reply>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      send({ id, method, params })
    })
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }).then((reply) => {
    send({ method: 'notifications/initialized' })
    return reply
  })
  return { ready, request, notify: (method: string, params: object) => send({ method, params }), close: () => stopTree(server), kill: (signal: NodeJS.Signals) => server.kill(signal), end: () => server.stdin.end(), exited, pid: server.pid }
}

test('check passes Pong, and sim prints exact state as JSON with the chosen fields', () => {
  assert.deepEqual(threejam('check', 'games/pong'), { code: 0, out: 'ok: true\nentities: 10\n' })
  const args = ['--ticks', '60', '--press', 'Space@1', '--hold', 'W@1-30', '--only', 'left_paddle', '--fields', 'y', '--format', 'json']
  const { code, out } = threejam('sim', 'games/pong', ...args)
  assert.equal(code, 0, out)
  assert.deepEqual(JSON.parse(out).entities, [{ name: 'left_paddle', y: 1.1 }])
})

test('type errors in game.ts and view.ts and runtime errors name the file and line on one line', () => {
  const typo = threejam('check', folder({ 'game.ts': game({ update: 'world.ball.vxx = 2' }) }))
  assert.equal(typo.code, 1)
  assert.match(typo.out, /code: TYPE_ERROR\nmessage: "?test\/\.tmp\/game-\w+\/game\.ts:6: Property 'vxx' does not exist/)

  const view = "import type { ViewFrame } from 'threejam'\n\nexport function draw({ tick }: ViewFrame): void {\n  tick.toFixed(2).push(1)\n}\n"
  const badView = threejam('check', folder({ 'game.ts': game({ update: 'world.ball.x += 1' }), 'view.ts': view }))
  assert.equal(badView.code, 1)
  assert.match(badView.out, /message: "?test\/\.tmp\/game-\w+\/view\.ts:4: Property 'push' does not exist/)

  const clock = threejam('sim', folder({ 'game.ts': game({ update: 'world.ball.x = Math.random()' }) }), '--ticks', '5')
  assert.equal(clock.code, 1)
  assert.match(clock.out, /message: "?test\/\.tmp\/game-\w+\/game\.ts:6: Math\.random\(\) would make runs differ; .* \(in update at tick 1\)/)
})

test("check's type error for console, document, or setTimeout in game logic says what game logic uses instead", () => {
  const dir = folder({ 'game.ts': game({ update: "console.log(ctx.tick)\n    document.title = 'x'\n    setTimeout(() => {}, 10)" }) })
  const at = `${dir.replaceAll(sep, '/')}/game.ts`
  const { code, out } = threejam('check', dir, '--format', 'json')
  const message = [
    `${at}:6: Cannot find name 'console'. Here, use ctx.print(...), which sim shows with the tick.`,
    `${at}:7: Cannot find name 'document'. Here, game logic has no page; draw in view.ts.`,
    `${at}:8: Cannot find name 'setTimeout'. Here, count ticks with ctx.tick instead.`,
  ].join('; ')
  assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'TYPE_ERROR', message } })
})

test('--filter-output log prints only the log and the suggested command', () => {
  const { code, out } = threejam('sim', 'games/pong', '--ticks', '200', '--press', 'Space@1', '--filter-output', 'log', '--format', 'json')
  assert.equal(code, 0, out)
  const cta = { description: 'Suggested command:', commands: [{ command: 'threejam shot games/pong --at 200 --press Space@1', description: 'See this tick as a PNG' }] }
  assert.deepEqual(JSON.parse(out), { log: [{ tick: 131, text: 'left scores, 1-0' }], cta })
})

test("a failure's code says what went wrong: BUILD_ERROR for a syntax error from sim and check alike, IO_ERROR for a folder new can't make, and BROWSER_ERROR without Chrome", () => {
  const broken = folder({ 'game.ts': game({ update: 'world.ball.x += ;' }) })
  const sim = threejam('sim', broken, '--ticks', '1')
  assert.match(sim.out, /^code: BUILD_ERROR\nmessage: "test\/\.tmp\/game-\w+\/game\.ts:6: Unexpected \\";\\""\n$/)
  assert.deepEqual(threejam('check', broken), sim)

  const parent = mkdtempSync(join(TMP, 'io-'))
  made.push(parent)
  writeFileSync(join(parent, 'file'), '')
  assert.match(threejam('new', join(parent, 'file', 'game')).out, /^code: IO_ERROR\n/)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    mkdirSync(join(parent, 'locked'), { mode: 0o500 })
    assert.match(threejam('new', join(parent, 'locked', 'game')).out, /^code: IO_ERROR\nmessage: .*permission denied/)
  }

  const shot = threejamWith({ CHROME_PATH: join(parent, 'no-chrome') }, 'shot', 'games/pong', '--at', '1', '-o', join(parent, 'frame.png'))
  assert.match(shot.out, /^code: BROWSER_ERROR\nmessage: .*no-chrome/)
})

test("incur's own refusals print one line with the code USAGE: a missing or fractional number, an unknown flag, and a flag with no value", () => {
  const cases = [
    [['sim', 'games/pong'], '--ticks:'],
    [['sim', 'games/pong', '--ticks', '5', '--seed', '1.5'], '--seed:'],
    [['sim', 'games/pong', '--ticks', '5', '--nope', '3'], 'Unknown flag: --nope'],
    [['shot', 'games/pong', '--at'], 'Missing value for flag: --at'],
  ] as const
  for (const [args, named] of cases) {
    const { code, out } = threejam(...args)
    assert.equal(code, 1, out)
    assert.match(out, /^code: USAGE\nmessage: [^\n]+\n$/)
    assert.ok(out.includes(named), out)
  }
})

test('a number on the command line is digits, so hex, exponents, and an empty string fail as USAGE, and the schema clients see has the real limits', () => {
  const refused = [
    [['sim', 'games/pong', '--ticks', '0x10'], '--ticks: expected a whole number from 0 up, got "0x10"'],
    [['sim', 'games/pong', '--ticks', ''], '--ticks: expected a whole number from 0 up, got ""'],
    [['sim', 'games/pong', '--ticks', '5', '--every', '0'], '--every: expected a whole number from 1 up, got 0'],
    [['sim', 'games/pong', '--ticks', '5', '--seed', '1e2'], '--seed: expected a whole number, got "1e2"'],
    [['sim', 'games/pong', '--ticks', '5', '--timeout', '2500000'], '--timeout: expected a number of seconds above 0, up to 86400, got 2500000'],
    [['sim', 'games/pong', '--ticks', '5', '--press', 'Space@0x5'], '--press "Space@0x5": "0x5" should be a tick from 1 up'],
    [['shot', 'games/pong', '--at', ''], '--at "" should be whole ticks from 0 up, like 1,120,600'],
    [['sim', '', '--ticks', '5'], "<dir>: can't be empty"],
  ]
  for (const [args, message] of refused) {
    const { code, out } = threejam(...args, '--format', 'json')
    assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message } })
  }
  const { options } = JSON.parse(threejam('sim', '--schema', '--format', 'json').out)
  const { ticks, every, seed, timeout } = options.properties
  assert.deepEqual([ticks.type, ticks.minimum, every.minimum, seed.type, timeout.maximum, options.required], ['integer', 0, 1, 'integer', 86_400, ['ticks']])
})

test('shot and export check -o before they run the game or start Chrome, with one rule for one tick or many', () => {
  const broken = folder({ 'game.ts': game({ update: 'world.ball.x += ;' }) })
  for (const [out, at] of [['frame.jpg', '1'], ['frame.jpg', '1,2'], ['frame', '1'], ['frame', '1,2']]) {
    const shot = threejamWith({ CHROME_PATH: join(TMP, 'no-chrome') }, 'shot', broken, '--at', at, '-o', out, '--format', 'json')
    assert.deepEqual({ code: shot.code, failure: JSON.parse(shot.out) }, { code: 1, failure: { code: 'USAGE', message: `-o ${JSON.stringify(out)} should be a .png file, like frame.png` } })
  }
  const exported = threejam('export', broken, '-o', 'page.txt', '--format', 'json')
  assert.deepEqual({ code: exported.code, failure: JSON.parse(exported.out) }, { code: 1, failure: { code: 'USAGE', message: '-o "page.txt" should be an .html file, like pong.html' } })
})

test("shot lets each call into Chrome run past Puppeteer's 180 s when --timeout gives its page longer, and keeps 180 s as the least", () => {
  assert.deepEqual([callLimit(2), callLimit(30), callLimit(300), callLimit(86_400)], [180_000, 180_000, 330_000, 86_430_000])
})

test('several frames keep the .png of -o after their numbers, in its case, even when -o is only .png', () => {
  assert.deepEqual(framePaths('frames/F.PNG', [1, 20]), ['frames/F-001.PNG', 'frames/F-020.PNG'])
  assert.deepEqual(framePaths('.png', [1, 2]), ['-001.png', '-002.png'])
})

test("export makes the folders its file goes in, and one under /proc, where Node's recursive mkdir never returns, fails new, export, and shot at once", () => {
  const nested = mkdtempSync(join(TMP, 'out-'))
  made.push(nested)
  const file = join(nested, 'two', 'levels', 'pong.html')
  assert.equal(threejam('export', 'games/pong', '-o', file).code, 0)
  assert.ok(readFileSync(file, 'utf8').startsWith('<!doctype html>'))
  if (process.platform !== 'linux') return
  const proc = `/proc/threejam-${process.pid}`
  const runs = [['new', `${proc}/game`], ['export', 'games/pong', '-o', `${proc}/pong.html`], ...(findChrome() ? [['shot', 'games/pong', '-o', `${proc}/frame.png`]] : [])]
  for (const args of runs) {
    const result = spawnSync(process.execPath, [CLI, ...args, '--format', 'json'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })
    assert.deepEqual(
      { status: result.status, failure: JSON.parse(result.stdout || '{}') },
      { status: 1, failure: { code: 'IO_ERROR', message: `couldn't make the folder ${proc}: no such file or directory` } },
      args.join(' '),
    )
  }
})

test("run checks the game before it serves a page, so one that can't start fails in the terminal instead of showing a blank page", () => {
  const { code, out } = threejam('run', folder({ 'game.ts': 'export default {}\n' }), '--serve-only')
  assert.equal(code, 1, out)
  assert.match(out, /^Error \(GAME_ERROR\): [^\n]+\n$/)
})

test("run reports a page that doesn't build with its code instead of a bare error", () => {
  const dir = folder({ 'game.ts': game({ update: 'world.ball.x += 1' }), 'view.ts': 'export function draw( {\n' })
  const { code, out } = threejam('run', dir, '--serve-only')
  assert.equal(code, 1, out)
  assert.match(out, /^Error \(BUILD_ERROR\): test\/\.tmp\/game-\w+\/view\.ts:2: [^\n]+\n$/)
})

test("a sandbox V8 stopped for want of memory is the game's failure, and another stop names the last line before V8's native stack", () => {
  const frames = '----- Native stack trace -----\n 1: 0xb8d0a3 node::Abort() [node]\n 2: 0x7f9116e3ea76\n'
  const memory = crashed(`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n${frames}`, 'SIGABRT')
  assert.deepEqual([memory.name, memory.message], ['GameError', 'the game ran out of memory; look for a list or a loop that keeps growing'])
  assert.equal(crashed(`Segmentation fault\n${frames}`, 'SIGSEGV').message, 'the sandbox running the game stopped with SIGSEGV: Segmentation fault')
})

test('an error names the first file on its stack outside the engine, even one whose path has a space, and no place when only Node internals are there', () => {
  const internal = new Error('entities must be an object')
  internal.stack = `Error: ${internal.message}\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`
  assert.equal(describe(internal), 'entities must be an object')

  const game = join(ROOT, 'test', '.tmp', 'my game', 'game.ts')
  const thrown = new Error('boom')
  const engine = (file: string) => pathToFileURL(join(ENGINE, file)).href
  thrown.stack = `Error: boom\n    at Math.<anonymous> (${engine('guard.ts')}:10:11)\n    at Object.update (${game}:6:25)\n    at ${engine('engine.ts')}:90:53`
  assert.equal(describe(thrown), `${relative(process.cwd(), game).replaceAll(sep, '/')}:6: boom`)
})

test("a game is TypeScript, so check and sim refuse a game.js, and a view.js beside a game.ts, saying to rename it", () => {
  const source = game({ update: 'world.ball.x += 1' })
  const js = folder({ 'game.js': source })
  const message = `${js.replaceAll(sep, '/')} (${join(ROOT, js).replaceAll(sep, '/')}) has game.js, but ThreeJam reads only game.ts; rename it to game.ts`
  for (const args of [['check', js], ['sim', js, '--ticks', '1']]) {
    const { code, out } = threejam(...args, '--format', 'json')
    assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message } })
  }
  const view = folder({ 'game.ts': source, 'view.js': 'export function draw() {}\n' })
  assert.match(threejam('check', view).out, /^code: USAGE\nmessage: .*has view\.js, but ThreeJam reads only view\.ts; rename it to view\.ts"?\n$/)
})

test('a --driver that is empty or a folder fails as USAGE naming where it led, instead of reaching the bundler', () => {
  const at = (path: string) => join(ROOT, path).replaceAll(sep, '/')
  for (const [driver, named] of [['', `"" (${at('')})`], ['games', `games (${at('games')})`]]) {
    const { code, out } = threejam('sim', 'games/pong', '--ticks', '1', '--driver', driver, '--format', 'json')
    assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message: `--driver ${named} isn't a file; give the driver's file, like bot.ts` } })
  }
})

test('a --driver file picks keys for sim from the typed world', () => {
  const driver = [
    "import type { Driver, EntitiesOf } from 'threejam'",
    "import type chase from './game.ts'",
    '',
    "const drive: Driver<EntitiesOf<typeof chase>> = ({ world }) => (world.ball.x < 3 ? ['Right'] : [])",
    'export default drive',
    '',
  ].join('\n')
  const dir = folder({ 'game.ts': game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1', update: "if (ctx.input.held('Right')) world.ball.x += 1" }), 'driver.ts': driver })
  const { code, out } = threejam('sim', dir, '--ticks', '10', '--driver', join(dir, 'driver.ts'), '--fields', 'x', '--format', 'json')
  assert.equal(code, 0, out)
  assert.deepEqual(JSON.parse(out).entities, [{ name: 'ball', x: 3 }])
})

test('sim prints numbers to 4 decimal places, and --exact prints them as simulate has them and as --until compares them, so a value it prints stops a run', () => {
  const args = ['sim', 'games/pong', '--ticks', '50', '--press', 'Space@1', '--only', 'ball', '--fields', 'x', '--format', 'json']
  const x = (...more: string[]) => JSON.parse(threejam(...args, ...more).out).entities[0].x
  const exact = simulate(pong, { ticks: 50, press: ['Space@1'] }).world.ball.x
  assert.deepEqual([x(), x('--exact')], [Math.round(exact * 1e4) / 1e4, exact])
  const until = ['--ticks', '600', '--press', 'Space@1', '--until', `ball.x=${exact}`, '--only', 'ball', '--format', 'json']
  const stopped = JSON.parse(threejam('sim', 'games/pong', ...until).out)
  assert.deepEqual([stopped.tick, stopped.reached], [50, true])
})

test('sim --until prints the tick the condition first held and suggests a shot of that tick', () => {
  const args = ['--ticks', '3600', '--press', 'Space@1', '--until', 'match.left=1', '--only', 'match', '--fields', 'left', '--format', 'json']
  const { code, out } = threejam('sim', 'games/pong', ...args)
  assert.equal(code, 0, out)
  const { tick, reached, entities, cta } = JSON.parse(out)
  assert.deepEqual({ tick, reached, entities }, { tick: 131, reached: true, entities: [{ name: 'match', left: 1 }] })
  assert.equal(cta.commands[0].command, 'threejam shot games/pong --at 131 --press Space@1')
})

test('check names an image the folder lacks, and sim takes --pointer, prints the sounds played, and suggests a shot with the same input', () => {
  const clicks = "if (ctx.input.pressed('Mouse')) { world.ball.x = ctx.input.pointer.x; ctx.play('blip') }"
  const missing = threejam('check', folder({ 'game.ts': game({ fields: "x: 0, y: 0, w: 0.1, h: 0.1, image: 'rok.png'", update: clicks }), 'rock.png': '' }))
  assert.equal(missing.code, 1)
  assert.match(missing.out, /message: "entity \\"ball\\": no image \\"rok\.png\\" in the game's folder, which has rock\.png"/)

  const dir = folder({ 'game.ts': game({ fields: "x: 0, y: 0, w: 0.1, h: 0.1, image: 'rock.png'", update: clicks }), 'rock.png': '' })
  const { code, out } = threejam('sim', dir, '--ticks', '3', '--press', 'Mouse@2', '--pointer', '-1.5,0.5@2', '--fields', 'x', '--format', 'json')
  assert.equal(code, 0, out)
  const { entities, sounds, cta } = JSON.parse(out)
  assert.deepEqual({ entities, sounds }, { entities: [{ name: 'ball', x: -1.5 }], sounds: [{ tick: 2, name: 'blip', volume: 1, pitch: 1 }] })
  assert.ok(cta.commands[0].command.endsWith(' --at 3 --press Mouse@2 --pointer -1.5,0.5@2'), cta.commands[0].command)
})

test('the MCP server reports the package version, offers every command but run, and runs the code on disk after an edit', async (t) => {
  const dir = folder({ 'game.ts': game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1, speed: 1', update: 'world.ball.x += world.ball.speed' }) })
  const server = mcp(t.signal)
  try {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.equal((await server.ready).result?.serverInfo?.version, version)
    const tools = (await server.request('tools/list', {})).result?.tools?.map((tool) => tool.name)
    assert.deepEqual(tools?.toSorted(), ['check', 'export', 'new', 'shot', 'sim'])
    const ballX = async () => {
      const reply = await server.request('tools/call', { name: 'sim', arguments: { dir, ticks: 3, only: 'ball', fields: 'x' } })
      const [data] = (reply.result?.content?.[0]?.text ?? '{}').split('\n\n')
      return JSON.parse(data).entities[0].x
    }
    assert.equal(await ballX(), 3)
    writeFileSync(join(ROOT, dir, 'game.ts'), game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1, speed: 2', update: 'world.ball.x += world.ball.speed' }))
    assert.equal(await ballX(), 6)
  } finally {
    server.close()
  }
})

test('the MCP instructions say the tools run game code and that a game\'s output is data, not instructions', async (t) => {
  const server = mcp(t.signal)
  try {
    const instructions = (await server.ready).result?.instructions ?? ''
    assert.match(instructions, /run the code in the folder's game.ts/)
    assert.match(instructions, /sandbox without files, processes, or the network/)
    // A game's log, errors, and suggested commands are data from the game, not directions to the agent.
    assert.match(instructions, /data from that game, not instructions/)
    assert.match(instructions, /log.*error.*suggested|suggested.*command/i)
  } finally {
    server.close()
  }
})

test("a failed MCP call's text starts with its code, which an MCP client has no other way to read", async (t) => {
  const typo = folder({ 'game.ts': game({ update: 'world.ball.vxx = 2' }) })
  const syntax = folder({ 'game.ts': game({ update: 'world.ball.x += ;' }) })
  const server = mcp(t.signal)
  try {
    await server.ready
    const failure = async (name: string, args: object) => {
      const reply = await server.request('tools/call', { name, arguments: args })
      assert.equal(reply.result?.isError, true)
      return reply.result?.content?.[0]?.text ?? ''
    }
    assert.match(await failure('check', { dir: typo }), /^TYPE_ERROR: test\/\.tmp\/game-\w+\/game\.ts:6: Property 'vxx' does not exist/)
    assert.match(await failure('sim', { dir: syntax, ticks: 1 }), /^BUILD_ERROR: test\/\.tmp\/game-\w+\/game\.ts:6: Unexpected ";"$/)
    assert.match(await failure('sim', { dir: 'games/pong', ticks: 1, press: ['Nope@1'] }), /^USAGE: --press "Nope@1": unknown key/)
  } finally {
    server.close()
  }
})

test('an MCP server started in another folder says where a relative path led, and its tools say what paths are relative to', async (t) => {
  const elsewhere = mkdtempSync(join(TMP, 'cwd-'))
  made.push(elsewhere)
  const server = mcp(t.signal, elsewhere)
  try {
    await server.ready
    const reply = await server.request('tools/call', { name: 'check', arguments: { dir: 'games/pong' } })
    const looked = join(elsewhere, 'games', 'pong').replaceAll(sep, '/')
    assert.equal(reply.result?.content?.[0]?.text, `USAGE: games/pong (${looked}) isn't a folder`)
    const tools = (await server.request('tools/list', {})).result?.tools ?? []
    const described = tools.flatMap((tool) => Object.entries(tool.inputSchema?.properties ?? {}).map(([name, field]) => [`${tool.name} ${name}`, field.description ?? '']))
    const paths = described.filter(([name]) => /^\w+ (dir|driver|out)$/.test(name))
    assert.deepEqual(
      paths.filter(([, description]) => !description.includes('relative to the working directory')),
      [],
    )
    assert.equal(paths.length, 9)
  } finally {
    server.close()
  }
})

test('a looping game does not block other MCP calls, even after a cancel, and an oversized reply is refused with a hint', async (t) => {
  const loop = folder({ 'game.ts': game({ update: 'if (ctx.tick === 2) for (;;) {}' }) })
  const server = mcp(t.signal)
  try {
    await server.ready
    // A sim that loops until its own short time budget. Cancelling it gets no reply, so it is never awaited; it proves the server keeps serving.
    const looping = server.request('tools/call', { name: 'sim', arguments: { dir: loop, ticks: 5, timeout: 2 } })
    void looping.catch(() => {})
    server.notify('notifications/cancelled', { requestId: 2, reason: 'test' })
    // Another tool call still answers while that one is stuck.
    const answered = await Promise.race([
      server.request('tools/call', { name: 'check', arguments: { dir: 'games/pong' } }).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 8000).unref()),
    ])
    assert.equal(answered, 'answered')
    // A reply that would be too large for a client's context is refused, with how to narrow it.
    const big = await server.request('tools/call', { name: 'sim', arguments: { dir: 'games/invaders', ticks: 600, every: 1 } })
    assert.equal(big.result?.isError, true)
    assert.match(big.result?.content?.[0]?.text ?? '', /\b(only|fields|every|until)\b/)
  } finally {
    server.close()
  }
})

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

// A game whose type check takes TypeScript over a minute, in memory that stays flat: each call takes only the last of thousands of overloads, so TypeScript checks its arguments, variables rather than numbers, against every one.
function slowCheck(): string {
  const last = 2999
  const overloads = Array.from({ length: last + 1 }, (_, i) => `declare function pick(a: 0, b: 0, c: 0, d: 0, n: ${i}): ${i}`)
  const calls = Array.from({ length: 8000 }, () => 'pick(z, z, z, z, l)').join(', ')
  return folder({ 'game.ts': [game({ update: 'world.ball.x += 1' }), `const z = 0, l = ${last}`, ...overloads, `export const picked = [${calls}]`, ''].join('\n') })
}

test('a type check that runs past --timeout fails with TIMEOUT once its time is up, without waiting for TypeScript to finish', () => {
  const started = Date.now()
  assert.deepEqual(threejam('check', slowCheck(), '--timeout', '0.5'), {
    code: 1,
    out: 'code: TIMEOUT\nmessage: "the type check ran past the 0.5 s time limit; a type in the game may not terminate, or allow more time with --timeout"\n',
  })
  // On Windows, a check that waited for the tsc.exe that tsc.js starts, rather than for tsc.js, would wait for TypeScript to finish.
  assert.ok(Date.now() - started < 15_000, `check took ${Date.now() - started} ms`)
})

test('a type check that prints more than 1 MB, as thousands of type errors do, fails with OUTPUT_TOO_LARGE and shows none of it', () => {
  const errors = Array.from({ length: 15_000 }, (_, i) => `export const n${i}: number = 's${i}'`)
  assert.deepEqual(threejam('check', folder({ 'game.ts': [game({ update: 'world.ball.x += 1' }), ...errors, ''].join('\n') })), {
    code: 1,
    out: 'code: OUTPUT_TOO_LARGE\nmessage: "the type check printed more than 1 MB, as thousands of type errors do, so it shows none; look for code that repeats one mistake, like a long list of data"\n',
  })
})

test("check still type-checks a game when its environment holds what bash, macOS's sh, would take as its own: exported functions, SHELLOPTS, BASHOPTS, and TMOUT", () => {
  const env = { 'BASH_FUNC_kill%%': '() { :; }', 'BASH_FUNC_read%%': '() { :; }', SHELLOPTS: 'noexec', BASHOPTS: 'extdebug', TMOUT: '1' }
  const typo = threejamWith(env, 'check', folder({ 'game.ts': game({ update: 'world.ball.vxx = 2' }) }))
  assert.equal(typo.code, 1)
  assert.match(typo.out, /^code: TYPE_ERROR\nmessage: "?test\/\.tmp\/game-\w+\/game\.ts:6: Property 'vxx' does not exist/)
})

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

test('mcp add registers node with this CLI from a clone or an install, and npx for a copy in npx\'s cache or an install on a path with a space', () => {
  const command = (cli: string) => mcpCommand({ cli, version: '1.2.3' })
  assert.equal(command('/work/threejam/src/cli.ts'), 'node /work/threejam/src/cli.ts --mcp')
  assert.equal(command('/work/my games/threejam/src/cli.ts'), 'node "/work/my games/threejam/src/cli.ts" --mcp')
  assert.equal(command('/usr/local/lib/node_modules/threejam/lib/cli.js'), 'node /usr/local/lib/node_modules/threejam/lib/cli.js --mcp')
  assert.equal(command('C:\\Users\\Ada Byron\\game\\node_modules\\threejam\\lib\\cli.js'), 'npx -y threejam@1.2.3 --mcp')
  assert.equal(command('/home/ada/.npm/_npx/2c3b1a/node_modules/threejam/lib/cli.js'), 'npx -y threejam@1.2.3 --mcp')
  assert.equal(command('C:\\Users\\Ada Byron\\AppData\\Local\\npm-cache\\_npx\\2c3b1a\\node_modules\\threejam\\lib\\cli.js'), 'npx -y threejam@1.2.3 --mcp')
  assert.equal(mcpCommand(), mcpCommand({ cli: CLI, version: VERSION }))
})

test("mcp add takes only the forms its help shows, refusing any other word, or a flag without its value, that incur would skip and so register with every agent", () => {
  const home = mkdtempSync(join(TMP, 'home-'))
  const bin = mkdtempSync(join(TMP, 'bin-'))
  made.push(home, bin)
  // Were the check to fail, PATH has no npx for incur to register through, and Amp's settings would land in this home.
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home, PATH: bin }
  const not = (word: string) => `mcp add takes --agent NAME, --command CMD or -c CMD, and --no-global, not "${word}"`
  const nameless = "--agent needs an agent's name, like --agent claude-code"
  const refused = [
    [['mcp', 'add', '-a', 'claude-code'], not('-a')],
    [['mcp', 'add', '--agents', 'claude-code'], not('--agents')],
    [['mcp', 'add', '--agnet', 'claude-code'], not('--agnet')],
    [['mcp', 'add', '--agent=claude-code'], not('--agent=claude-code')],
    [['mcp', 'add', '--agent'], nameless],
    [['mcp', 'add', '--agent', '', '--no-global'], nameless],
    [['mcp', 'add', '--agent', '--no-global'], nameless],
    [['mcp', 'add', '--agent', 'claude-code', '-c'], '-c needs the command agents will run, like -c "npx threejam --mcp"'],
  ] as const
  for (const [args, message] of refused) {
    const { code, out } = threejamWith(env, '--format', 'json', ...args)
    assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message } }, args.join(' '))
  }
  for (const args of [['--agent', 'claude-code', '--format', 'json'], ['--agent', 'claude-code', '--command', 'node cli.ts --mcp', '--no-global'], ['-c', 'node cli.ts --mcp']]) {
    assert.match(threejamWith(env, 'mcp', 'add', ...args).out, /MCP_ADD_FAILED/, args.join(' '))
  }
  assert.deepEqual(readdirSync(home), [])
})

test('new writes a starter game that passes check and its own test, and only the game files inside a project', () => {
  const parent = mkdtempSync(join(TMP, 'new-'))
  made.push(parent)
  const dir = relative(ROOT, join(parent, 'catch'))
  const created = threejam('new', dir, '--format', 'json')
  assert.equal(created.code, 0, created.out)
  assert.deepEqual(JSON.parse(created.out).files, ['game.ts', 'game.test.ts'])
  assert.deepEqual(threejam('check', dir), { code: 0, out: 'ok: true\nentities: 6\n' })
  const own = spawnSync(process.execPath, ['--test', dir], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(own.status, 0, own.stdout + own.stderr)
})

test('outside a project, new also writes a package.json and tsconfig.json and says to run npm install first, and it refuses a folder that isn\'t empty', () => {
  const parent = mkdtempSync(join(tmpdir(), 'threejam-new-'))
  try {
    const dir = join(parent, 'Space Catch')
    const created = threejam('new', dir, '--format', 'json')
    assert.equal(created.code, 0, created.out)
    const { files, test: own, cta } = JSON.parse(created.out)
    assert.deepEqual({ files, own }, { files: ['game.ts', 'game.test.ts', 'package.json', 'tsconfig.json'], own: 'npm test' })
    assert.match(cta.description, /^Run npm install in .*Space Catch.* first/)
    assert.equal(cta.commands[0].command, 'threejam check .')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual([manifest.name, manifest.type, manifest.scripts.test, manifest.devDependencies.threejam], ['space-catch', 'module', 'node --test', `^${VERSION}`])
    assert.equal(JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).compilerOptions.module, 'nodenext')
    const again = threejam('new', dir)
    assert.equal(again.code, 1)
    assert.match(again.out, /^code: USAGE\nmessage: .*already exists and isn't an empty folder/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a game in a folder outside the repo with no package.json, which TypeScript alone reads as CommonJS, checks and runs without the package installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-bare-'))
  try {
    writeFileSync(join(dir, 'speed.ts'), 'export const SPEED = 2\n')
    const source = game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1', update: 'world.ball.x += SPEED' })
    writeFileSync(join(dir, 'game.ts'), `import { SPEED } from './speed.ts'\n${source}`)
    assert.deepEqual(threejam('check', dir), { code: 0, out: 'ok: true\nentities: 1\n' })
    const { code, out } = threejam('sim', dir, '--ticks', '3', '--fields', 'x', '--format', 'json')
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(out).entities, [{ name: 'ball', x: 6 }])
    writeFileSync(join(dir, 'game.ts'), `import { SPEED } from './speed.ts'\n${source.replace('+= SPEED', '+= SPEED.length')}`)
    assert.match(threejam('check', dir).out, /code: TYPE_ERROR\nmessage: "?.*game\.ts:7: Property 'length' does not exist on type/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('sim ends quietly when its reader closes the pipe', async (t) => {
  const child = spawnCli(['sim', 'games/pong', '--ticks', '600', '--every', '1'], t.signal)
  let errors = ''
  child.stderr.on('data', (chunk) => (errors += chunk))
  child.stdout.once('data', () => child.stdout.destroy())
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.deepEqual({ code, errors }, { code: 0, errors: '' })
})
