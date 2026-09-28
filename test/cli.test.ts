import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { describe } from '../src/load.ts'
import { ENGINE, ROOT, VERSION, mcpCommand } from '../src/package.ts'

const CLI = join(ROOT, 'src', 'cli.ts')
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function fourjs(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
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
    "import { defineGame } from '@aksheyd/fourjs'",
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
    readonly tools?: ReadonlyArray<{ readonly name: string }>
    readonly content?: ReadonlyArray<{ readonly text: string }>
  }
}

function mcp() {
  const server = spawn(process.execPath, [CLI, '--mcp'], { cwd: ROOT })
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
  return { ready, request, close: () => server.kill() }
}

test('check passes Pong, and sim prints exact state as JSON with the chosen fields', () => {
  assert.deepEqual(fourjs('check', 'games/pong'), { code: 0, out: 'ok: true\nentities: 10\n' })
  const args = ['--ticks', '60', '--press', 'Space@1', '--hold', 'W@1-30', '--only', 'left_paddle', '--fields', 'y', '--format', 'json']
  const { code, out } = fourjs('sim', 'games/pong', ...args)
  assert.equal(code, 0, out)
  assert.deepEqual(JSON.parse(out).entities, [{ name: 'left_paddle', y: 1.1 }])
})

test('type errors in game.ts and view.ts and runtime errors name the file and line on one line', () => {
  const typo = fourjs('check', folder({ 'game.ts': game({ update: 'world.ball.vxx = 2' }) }))
  assert.equal(typo.code, 1)
  assert.match(typo.out, /code: TYPE_ERROR\nmessage: "?test\/\.tmp\/game-\w+\/game\.ts:6: Property 'vxx' does not exist/)

  const view = "import type { ViewFrame } from '@aksheyd/fourjs'\n\nexport function draw({ tick }: ViewFrame): void {\n  tick.toFixed(2).push(1)\n}\n"
  const badView = fourjs('check', folder({ 'game.ts': game({ update: 'world.ball.x += 1' }), 'view.ts': view }))
  assert.equal(badView.code, 1)
  assert.match(badView.out, /message: "?test\/\.tmp\/game-\w+\/view\.ts:4: Property 'push' does not exist/)

  const clock = fourjs('sim', folder({ 'game.ts': game({ update: 'world.ball.x = Math.random()' }) }), '--ticks', '5')
  assert.equal(clock.code, 1)
  assert.match(clock.out, /message: "?test\/\.tmp\/game-\w+\/game\.ts:6: Math\.random\(\) would make runs differ; .* \(in update at tick 1\)/)
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

test('a --driver file picks keys for sim from the typed world', () => {
  const driver = [
    "import type { Driver, EntitiesOf } from '@aksheyd/fourjs'",
    "import type chase from './game.ts'",
    '',
    "const drive: Driver<EntitiesOf<typeof chase>> = ({ world }) => (world.ball.x < 3 ? ['Right'] : [])",
    'export default drive',
    '',
  ].join('\n')
  const dir = folder({ 'game.ts': game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1', update: "if (ctx.input.held('Right')) world.ball.x += 1" }), 'driver.ts': driver })
  const { code, out } = fourjs('sim', dir, '--ticks', '10', '--driver', join(dir, 'driver.ts'), '--fields', 'x', '--format', 'json')
  assert.equal(code, 0, out)
  assert.deepEqual(JSON.parse(out).entities, [{ name: 'ball', x: 3 }])
})

test('sim --until prints the tick the condition first held and suggests a shot of that tick', () => {
  const args = ['--ticks', '3600', '--press', 'Space@1', '--until', 'match.left=1', '--only', 'match', '--fields', 'left', '--format', 'json']
  const { code, out } = fourjs('sim', 'games/pong', ...args)
  assert.equal(code, 0, out)
  const { tick, reached, entities, cta } = JSON.parse(out)
  assert.deepEqual({ tick, reached, entities }, { tick: 131, reached: true, entities: [{ name: 'match', left: 1 }] })
  assert.equal(cta.commands[0].command, 'fourjs shot games/pong --at 131 --press Space@1')
})

test('check names an image the folder lacks, and sim takes --pointer, prints the sounds played, and suggests a shot with the same input', () => {
  const clicks = "if (ctx.input.pressed('Mouse')) { world.ball.x = ctx.input.pointer.x; ctx.play('blip') }"
  const missing = fourjs('check', folder({ 'game.ts': game({ fields: "x: 0, y: 0, w: 0.1, h: 0.1, image: 'rok.png'", update: clicks }), 'rock.png': '' }))
  assert.equal(missing.code, 1)
  assert.match(missing.out, /message: "entity \\"ball\\": no image \\"rok\.png\\" in the game's folder, which has rock\.png"/)

  const dir = folder({ 'game.ts': game({ fields: "x: 0, y: 0, w: 0.1, h: 0.1, image: 'rock.png'", update: clicks }), 'rock.png': '' })
  const { code, out } = fourjs('sim', dir, '--ticks', '3', '--press', 'Mouse@2', '--pointer', '-1.5,0.5@2', '--fields', 'x', '--format', 'json')
  assert.equal(code, 0, out)
  const { entities, sounds, cta } = JSON.parse(out)
  assert.deepEqual({ entities, sounds }, { entities: [{ name: 'ball', x: -1.5 }], sounds: [{ tick: 2, name: 'blip', volume: 1, pitch: 1 }] })
  assert.ok(cta.commands[0].command.endsWith(' --at 3 --press Mouse@2 --pointer -1.5,0.5@2'), cta.commands[0].command)
})

test('the MCP server reports the package version, offers every command but run, and runs the code on disk after an edit', async () => {
  const dir = folder({ 'game.ts': game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1, speed: 1', update: 'world.ball.x += world.ball.speed' }) })
  const server = mcp()
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

test('mcp add registers node with this CLI from a clone or an install, and npx for a copy in npx\'s cache or an install on a path with a space', () => {
  const command = (cli: string) => mcpCommand({ cli, version: '1.2.3' })
  assert.equal(command('/work/fourjs/src/cli.ts'), 'node /work/fourjs/src/cli.ts --mcp')
  assert.equal(command('/work/my games/fourjs/src/cli.ts'), 'node "/work/my games/fourjs/src/cli.ts" --mcp')
  assert.equal(command('/usr/local/lib/node_modules/@aksheyd/fourjs/lib/cli.js'), 'node /usr/local/lib/node_modules/@aksheyd/fourjs/lib/cli.js --mcp')
  assert.equal(command('C:\\Users\\Ada Byron\\game\\node_modules\\@aksheyd\\fourjs\\lib\\cli.js'), 'npx -y @aksheyd/fourjs@1.2.3 --mcp')
  assert.equal(command('/home/ada/.npm/_npx/2c3b1a/node_modules/@aksheyd/fourjs/lib/cli.js'), 'npx -y @aksheyd/fourjs@1.2.3 --mcp')
  assert.equal(command('C:\\Users\\Ada Byron\\AppData\\Local\\npm-cache\\_npx\\2c3b1a\\node_modules\\@aksheyd\\fourjs\\lib\\cli.js'), 'npx -y @aksheyd/fourjs@1.2.3 --mcp')
  assert.equal(mcpCommand(), mcpCommand({ cli: CLI, version: VERSION }))
})

test('new writes a starter game that passes check and its own test, and only the game files inside a project', () => {
  const parent = mkdtempSync(join(TMP, 'new-'))
  made.push(parent)
  const dir = relative(ROOT, join(parent, 'catch'))
  const created = fourjs('new', dir, '--format', 'json')
  assert.equal(created.code, 0, created.out)
  assert.deepEqual(JSON.parse(created.out).files, ['game.ts', 'game.test.ts'])
  assert.deepEqual(fourjs('check', dir), { code: 0, out: 'ok: true\nentities: 6\n' })
  const own = spawnSync(process.execPath, ['--test', dir], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(own.status, 0, own.stdout + own.stderr)
})

test('outside a project, new also writes a package.json and tsconfig.json and says to run npm install first, and it refuses a folder that isn\'t empty', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fourjs-new-'))
  try {
    const dir = join(parent, 'Space Catch')
    const created = fourjs('new', dir, '--format', 'json')
    assert.equal(created.code, 0, created.out)
    const { files, test: own, cta } = JSON.parse(created.out)
    assert.deepEqual({ files, own }, { files: ['game.ts', 'game.test.ts', 'package.json', 'tsconfig.json'], own: 'npm test' })
    assert.match(cta.description, /^Run npm install in .*Space Catch.* first/)
    assert.equal(cta.commands[0].command, 'fourjs check .')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual([manifest.name, manifest.type, manifest.scripts.test, manifest.devDependencies['@aksheyd/fourjs']], ['space-catch', 'module', 'node --test', `^${VERSION}`])
    assert.equal(JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).compilerOptions.module, 'nodenext')
    const again = fourjs('new', dir)
    assert.equal(again.code, 1)
    assert.match(again.out, /^code: USAGE\nmessage: .*already exists and isn't an empty folder/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a game in a folder outside the repo with no package.json, which TypeScript alone reads as CommonJS, checks and runs without the package installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fourjs-bare-'))
  try {
    writeFileSync(join(dir, 'speed.ts'), 'export const SPEED = 2\n')
    const source = game({ fields: 'x: 0, y: 0, w: 0.1, h: 0.1', update: 'world.ball.x += SPEED' })
    writeFileSync(join(dir, 'game.ts'), `import { SPEED } from './speed.ts'\n${source}`)
    assert.deepEqual(fourjs('check', dir), { code: 0, out: 'ok: true\nentities: 1\n' })
    const { code, out } = fourjs('sim', dir, '--ticks', '3', '--fields', 'x', '--format', 'json')
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(out).entities, [{ name: 'ball', x: 6 }])
    writeFileSync(join(dir, 'game.ts'), `import { SPEED } from './speed.ts'\n${source.replace('+= SPEED', '+= SPEED.length')}`)
    assert.match(fourjs('check', dir).out, /code: TYPE_ERROR\nmessage: "?.*game\.ts:7: Property 'length' does not exist on type/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sim ends quietly when its reader closes the pipe', async () => {
  const child = spawn(process.execPath, [CLI, 'sim', 'games/pong', '--ticks', '600', '--every', '1'], { cwd: ROOT })
  let errors = ''
  child.stderr.on('data', (chunk) => (errors += chunk))
  child.stdout.once('data', () => child.stdout.destroy())
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.deepEqual({ code, errors }, { code: 0, errors: '' })
})
