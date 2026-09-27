import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { ROOT } from '../src/load.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function four(...args: string[]) {
  const result = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], { cwd: ROOT, encoding: 'utf8' })
  return { code: result.status, out: result.stdout + result.stderr }
}

// Games must live inside the package so their `import 'fourjs'` resolves.
function game(update: string): string {
  const dir = mkdtempSync(join(TMP, 'game-'))
  made.push(dir)
  const source = [
    "import { defineGame } from 'fourjs'",
    '',
    'export default defineGame({',
    '  entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, vx: 1 } },',
    `  update(world, ctx) {`,
    `    ${update}`,
    '  },',
    '})',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'game.ts'), source)
  return relative(ROOT, dir)
}

test('check passes Pong and sim prints exact state as JSON', () => {
  assert.deepEqual(four('check', 'games/pong'), { code: 0, out: 'ok: true\nentities: 10\n' })
  const { code, out } = four('sim', 'games/pong', '--ticks', '60', '--press', 'Space@1', '--hold', 'W@1-30', '--only', 'left_paddle', '--format', 'json')
  assert.equal(code, 0, out)
  const [paddle] = JSON.parse(out).entities
  assert.equal(paddle.y, 1.1)
})

test('type errors and runtime errors name the game file and line', () => {
  const typo = four('check', game('world.ball.vxx = 2'))
  assert.equal(typo.code, 1)
  assert.match(typo.out, /code: TYPE_ERROR/)
  assert.match(typo.out, /game-\w+\/game\.ts:6: Property 'vxx' does not exist/)

  const clock = four('sim', game('world.ball.x = Math.random()'), '--ticks', '5')
  assert.equal(clock.code, 1)
  assert.match(clock.out, /game-\w+\/game\.ts:6: Math\.random\(\) would make runs differ.*\\n {2}in update at tick 1/)
})

test('the MCP server lists check, sim, and shot as tools and hides run', async () => {
  const server = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), '--mcp'], { cwd: ROOT })
  const replies: Array<{ id: number; result: { tools: Array<{ name: string }> } }> = []
  server.stdout.setEncoding('utf8')
  let buffered = ''
  const listed = new Promise<void>((resolve) => {
    server.stdout.on('data', (chunk: string) => {
      buffered += chunk
      for (const line of buffered.split('\n').slice(0, -1)) if (line.trim()) replies.push(JSON.parse(line))
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1)
      if (replies.some((r) => r.id === 2)) resolve()
    })
  })
  const send = (message: object) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
  send({ method: 'notifications/initialized' })
  send({ id: 2, method: 'tools/list', params: {} })
  await listed
  server.kill()
  const tools = replies.find((r) => r.id === 2)?.result.tools.map((t) => t.name)
  assert.deepEqual(tools?.sort(), ['check', 'shot', 'sim'])
})
