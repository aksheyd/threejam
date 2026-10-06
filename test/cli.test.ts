import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { crashed, describe } from '../src/load.ts'
import { ENGINE, ROOT, VERSION, mcpCommand } from '../src/package.ts'

const CLI = join(ROOT, 'src', 'cli.ts')
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function threejam(...args: string[]) {
  return threejamWith({}, ...args)
}

function threejamWith(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
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

// A test that times out aborts its signal, which kills the child, so it can't hold the run open; the abort's error is expected then.
function spawnCli(args: string[], signal: AbortSignal, cwd = ROOT) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, signal })
  child.on('error', (error) => {
    if (!signal.aborted) throw error
  })
  return child
}

function mcp(signal: AbortSignal, cwd = ROOT) {
  const server = spawnCli(['--mcp'], signal, cwd)
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
  return { ready, request, notify: (method: string, params: object) => send({ method, params }), close: () => server.kill() }
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

test('a number on the command line is digits, so hex, exponents, and an empty string fail as USAGE, and the schema clients see has the real minimums', () => {
  const refused = [
    [['sim', 'games/pong', '--ticks', '0x10'], '--ticks: expected a whole number from 0 up, got "0x10"'],
    [['sim', 'games/pong', '--ticks', ''], '--ticks: expected a whole number from 0 up, got ""'],
    [['sim', 'games/pong', '--ticks', '5', '--every', '0'], '--every: expected a whole number from 1 up, got 0'],
    [['sim', 'games/pong', '--ticks', '5', '--seed', '1e2'], '--seed: expected a whole number, got "1e2"'],
    [['sim', 'games/pong', '--ticks', '5', '--press', 'Space@0x5'], '--press "Space@0x5": "0x5" should be a tick from 1 up'],
    [['shot', 'games/pong', '--at', ''], '--at "" should be whole ticks from 0 up, like 1,120,600'],
    [['sim', '', '--ticks', '5'], "<dir>: can't be empty"],
  ]
  for (const [args, message] of refused) {
    const { code, out } = threejam(...args, '--format', 'json')
    assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message } })
  }
  const { options } = JSON.parse(threejam('sim', '--schema', '--format', 'json').out)
  const { ticks, every, seed } = options.properties
  assert.deepEqual([ticks.type, ticks.minimum, every.minimum, seed.type, options.required], ['integer', 0, 1, 'integer', ['ticks']])
})

test('shot checks -o before it runs the game or starts Chrome, with one rule for one tick or many', () => {
  const broken = folder({ 'game.ts': game({ update: 'world.ball.x += ;' }) })
  for (const [out, at] of [['frame.jpg', '1'], ['frame.jpg', '1,2'], ['frame', '1'], ['frame', '1,2']]) {
    const shot = threejamWith({ CHROME_PATH: join(TMP, 'no-chrome') }, 'shot', broken, '--at', at, '-o', out, '--format', 'json')
    assert.deepEqual({ code: shot.code, failure: JSON.parse(shot.out) }, { code: 1, failure: { code: 'USAGE', message: `-o ${JSON.stringify(out)} should be a .png file, like frame.png` } })
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
    // finding 6: a game's log, errors, and suggested commands are data from the game, not directions to the agent.
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

test('audit 1 and 2: a looping game does not block other MCP calls, even after a cancel, and an oversized reply is refused with a hint', async (t) => {
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
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 8000)),
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

test('sim ends quietly when its reader closes the pipe', async (t) => {
  const child = spawnCli(['sim', 'games/pong', '--ticks', '600', '--every', '1'], t.signal)
  let errors = ''
  child.stderr.on('data', (chunk) => (errors += chunk))
  child.stdout.once('data', () => child.stdout.destroy())
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.deepEqual({ code, errors }, { code: 0, errors: '' })
})
