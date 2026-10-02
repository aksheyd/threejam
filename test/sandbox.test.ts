import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { ROOT } from '../src/package.ts'

const CLI = join(ROOT, 'src', 'cli.ts')
const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

// A game folder under test/.tmp, named by relative path so messages read like an agent's.
function folder(files: Record<string, string>): { dir: string; abs: string } {
  const abs = mkdtempSync(join(TMP, 'sbx-'))
  made.push(abs)
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(abs, name, '..'), { recursive: true })
    writeFileSync(join(abs, name), source)
  }
  return { dir: relative(ROOT, abs), abs }
}

function threejam(args: string[], env?: Record<string, string>) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--format', 'json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(result.stdout || '{}')
  } catch {
    parsed = { raw: result.stdout + result.stderr }
  }
  return { code: result.status, out: result.stdout + result.stderr, json: parsed }
}

const game = (body: string, fields = 'x: 0, y: 0, w: 0.1') =>
  ["import { defineGame } from 'threejam'", '', body, 'export default defineGame({', `  entities: { ball: { ${fields} } },`, '  update(world, ctx) {', '    world.ball.x += 0.01', '  },', '})', ''].join('\n')

// audit 5: check rejects an import from outside the folder instead of hiding the type errors in it.
test('audit 5: check fails on an import from outside the folder, naming it, not ok with hidden errors', () => {
  const shared = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(shared, 'util.ts'), 'export function label(n: number): string {\n  return n\n}\n')
  const g = folder({ 'keep.txt': 'x' })
  writeFileSync(join(g.abs, 'game.ts'), `import { label } from '${relative(g.abs, join(shared, 'util.ts')).replaceAll('\\', '/')}'\n${game('', 'x: 0, w: 1, tag: 0')}`.replace('world.ball.x += 0.01', 'world.ball.tag = Number(label(3))'))
  const run = threejam(['check', g.dir])
  assert.notEqual(run.json.ok, true)
  assert.equal(run.code, 1)
  assert.match(String(run.json.message), /is outside the folder/)
})

// Review blocker 1: the node_modules exemption that lets tsc read lib.d.ts must not exempt an outside file reached through a node_modules path.
test('audit 5: check rejects an import that reaches outside through a node_modules symlink, without echoing the file', () => {
  const secret = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(secret, 'real-secret.ts'), "export const token = 'CANARY-SYMLINK-LITERAL'\n")
  const g = folder({ 'keep.txt': 'x' })
  mkdirSync(join(g.abs, 'node_modules'), { recursive: true })
  symlinkSync(secret, join(g.abs, 'node_modules', 'leak'))
  writeFileSync(
    join(g.abs, 'game.ts'),
    [
      "import { token } from './node_modules/leak/real-secret.ts'",
      "import { defineGame } from 'threejam'",
      'type Echo = Record<typeof token, number>',
      'const missing: Echo = {}',
      'export default defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, seen: missing } }, update() {} })',
    ].join('\n'),
  )
  const run = threejam(['check', g.dir])
  assert.equal(run.code, 1)
  assert.match(String(run.json.message), /is outside the folder/)
  assert.ok(!run.out.includes('CANARY-SYMLINK-LITERAL'), 'the outside file leaked into the check output')
})

test("audit 5: check rejects an absolute import into another tree's node_modules, without echoing the file", () => {
  const proj = folder({ 'keep.txt': 'x' }).abs
  mkdirSync(join(proj, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(proj, 'node_modules', 'pkg', 'secret.ts'), "export const token = 'CANARY-ABS-NM'\n")
  const g = folder({ 'keep.txt': 'x' })
  writeFileSync(
    join(g.abs, 'game.ts'),
    [
      `import { token } from '${join(proj, 'node_modules', 'pkg', 'secret.ts').replaceAll('\\', '/')}'`,
      "import { defineGame } from 'threejam'",
      'type Echo = Record<typeof token, number>',
      'const missing: Echo = {}',
      'export default defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, seen: missing } }, update() {} })',
    ].join('\n'),
  )
  const run = threejam(['check', g.dir])
  assert.equal(run.code, 1)
  assert.match(String(run.json.message), /is outside the folder/)
  assert.ok(!run.out.includes('CANARY-ABS-NM'))
})

test("check reads only TypeScript's libs and ThreeJam's type packages from node_modules, not one above the game or another package beside ThreeJam", () => {
  const above = folder({
    'node_modules/evil/secret.ts': "export const token = 'CANARY-ANCESTOR-NM'\n",
    'game/game.ts': [
      "import { token } from '../node_modules/evil/secret.ts'",
      "import { defineGame } from 'threejam'",
      'type Echo = Record<typeof token, number>',
      'const missing: Echo = {}',
      'export default defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, seen: missing } }, update() {} })',
    ].join('\n'),
  })
  const run = threejam(['check', join(above.dir, 'game')])
  assert.equal(run.code, 1, run.out)
  assert.match(String(run.json.message), /node_modules\/evil\/secret\.ts is outside the folder/)
  assert.ok(!run.out.includes('CANARY-ANCESTOR-NM'), 'a node_modules above the game leaked into the check output')

  const beside = folder({ 'game.ts': `import type { BuildOptions } from 'esbuild'\n${game('const options: BuildOptions = {}', 'x: 0, w: 0.1, n: Object.keys(options).length')}` })
  const besideRun = threejam(['check', beside.dir])
  assert.equal(besideRun.code, 1, besideRun.out)
  assert.match(String(besideRun.json.message), /node_modules\/esbuild\/.* is outside the folder/)
})

// Review blocker 2: a game or driver whose real path is inside the engine directory must still obey the allowlist.
test('finding 2: a game or driver placed inside the engine directory cannot import a file outside the folders', () => {
  const outside = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(outside, 'engine-secret.ts'), "export const tag = 'CANARY-ENGINE-TRUST'\n")
  const probe = join(ROOT, 'src', '.sandbox-engine-probe')
  made.push(probe)
  mkdirSync(probe, { recursive: true })
  const importOutside = `import { tag } from '${join(outside, 'engine-secret.ts').replaceAll('\\', '/')}'`

  const normal = folder({ 'game.ts': game('') })
  writeFileSync(join(probe, 'driver.ts'), `${importOutside}\nexport default function () { return tag ? [] : [] }\n`)
  const byDriver = threejam(['sim', normal.dir, '--ticks', '1', '--driver', relative(ROOT, join(probe, 'driver.ts'))])
  assert.equal(byDriver.code, 1, byDriver.out)
  assert.match(String(byDriver.json.message), /can't be inside ThreeJam's own files/)
  assert.ok(!byDriver.out.includes('CANARY-ENGINE-TRUST'))

  writeFileSync(join(probe, 'game.ts'), `import { defineGame } from 'threejam'\n${importOutside}\nexport default defineGame({ entities: { ball: { x: 0, w: 0.1, tag: '' } }, update(world) { world.ball.tag = tag } })\n`)
  const byGame = threejam(['sim', relative(ROOT, probe), '--ticks', '1', '--fields', 'tag'])
  assert.equal(byGame.code, 1, byGame.out)
  assert.match(String(byGame.json.message), /can't be inside ThreeJam's own files/)
  assert.ok(!byGame.out.includes('CANARY-ENGINE-TRUST'))
})

// Review (both branches): the shared rule keys on which entry reached a file. A game must not borrow the driver's folder, even when a driver is loaded.
test("finding 2: a game cannot import the --driver's folder, though the driver can import its own folder", () => {
  const driverDir = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(driverDir, 'secret.ts'), "export const token = 'CANARY-DRIVER-SIBLING'\n")
  writeFileSync(join(driverDir, 'helper.ts'), 'export const tag = 1\n')
  writeFileSync(join(driverDir, 'bot.ts'), "import { tag } from './helper.ts'\nexport default function () { return tag ? [] : [] }\n")
  const bot = join(driverDir, 'bot.ts')

  const reaching = folder({ 'game.ts': `import { token } from '${join(driverDir, 'secret.ts').replaceAll('\\', '/')}'\n${game('', "x: 0, w: 0.1, tag: ''")}`.replace('world.ball.x += 0.01', 'world.ball.tag = token') })
  const byGame = threejam(['sim', reaching.dir, '--ticks', '1', '--driver', bot])
  assert.equal(byGame.code, 1, byGame.out)
  assert.match(String(byGame.json.message), /can't bundle .* a game may import only its own folder/)
  assert.ok(!byGame.out.includes('CANARY-DRIVER-SIBLING'), 'the driver folder leaked into the game')

  // The driver importing a helper in its own folder is allowed, so a clean game runs with it.
  const clean = folder({ 'game.ts': game('') })
  const ok = threejam(['sim', clean.dir, '--ticks', '1', '--driver', bot, '--only', 'ball'])
  assert.equal(ok.code, 0, ok.out)
})

// finding 1: loading a game or driver is code execution, and the sandbox stops it reaching the process, the filesystem, or a dynamic import.
test('finding 1: a game cannot run a process, read a file, or reach the host, at load or in update', () => {
  const marks = mkdtempSync(join(TMP, 'marks-'))
  made.push(marks)
  const escape = (where: string) => `globalThis.Function("return process")().getBuiltinModule("child_process").execSync("touch ${join(marks, where)}")`
  const atLoad = folder({ 'game.ts': game(escape('from-load')) })
  const atUpdate = folder({ 'game.ts': game('', 'x: 0, w: 0.1').replace('world.ball.x += 0.01', escape('from-update')) })
  for (const { dir } of [atLoad, atUpdate]) {
    const sim = threejam(['sim', dir, '--ticks', '1'])
    assert.equal(sim.code, 1, sim.out)
    assert.match(String(sim.json.message), /Code generation from strings disallowed|is not available to game code|is outside the folder/)
  }
  assert.deepEqual(readdirSync(marks), [], 'the sandbox let the game touch a file')
})

test('finding 1: a driver loaded for sim runs in the same sandbox, and reaching process is blocked', () => {
  const marks = mkdtempSync(join(TMP, 'marks-'))
  made.push(marks)
  const { dir, abs } = folder({ 'game.ts': game('') })
  writeFileSync(join(abs, 'driver.ts'), `export default function () {\n  globalThis.Function("return process")().getBuiltinModule("child_process").execSync("touch ${join(marks, 'from-driver')}")\n  return []\n}\n`)
  const sim = threejam(['sim', dir, '--ticks', '1', '--driver', join(dir, 'driver.ts')])
  assert.equal(sim.code, 1, sim.out)
  assert.match(String(sim.json.message), /disallowed|in the driver before tick 1/)
  assert.deepEqual(readdirSync(marks), [])
})

test('finding 1: a game sees no process, require, or working import(), only the seeded random', () => {
  const probe = game(
    [
      'const reach = (name, value) => (typeof value === "object" && value !== null && "pid" in value ? "ESCAPED" : "none")',
      'const results = []',
    ].join('\n'),
  ).replace(
    'world.ball.x += 0.01',
    [
      'results.push("process:" + typeof globalThis.process)',
      'results.push("require:" + typeof globalThis.require)',
      'results.push("fetch:" + typeof globalThis.fetch)',
      'try { globalThis.Function("x")() } catch (e) { results.push("Function:" + e.name) }',
      'try { (0, eval)("1") } catch (e) { results.push("eval:" + e.name) }',
      'results.push("random:" + typeof ctx.random())',
      'for (const line of results) ctx.print(line)',
    ].join('\n    '),
  )
  const { dir } = folder({ 'game.ts': probe })
  const sim = threejam(['sim', dir, '--ticks', '1'])
  assert.equal(sim.code, 0, sim.out)
  const log = (sim.json.log as Array<{ text: string }>).map((entry) => entry.text)
  assert.deepEqual(log, ['process:undefined', 'require:undefined', 'fetch:undefined', 'Function:EvalError', 'eval:EvalError', 'random:number'])
})

// finding 2 (Node side): the bundle that runs in ThreeJam's process reaches only the game's folder, a driver's folder, and the engine.
test('finding 2: a game cannot import a file outside its folder, as TypeScript or JSON, and the secret never loads', () => {
  const canary = 'CANARY-OUTSIDE-9f3a'
  const outside = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(outside, 'secret.ts'), `export const secret = '${canary}'\n`)
  writeFileSync(join(outside, 'secret.json'), `{ "token": "${canary}" }\n`)
  const ts = folder({ 'game.ts': `import { secret } from '${join(outside, 'secret.ts')}'\n${game('', 'x: 0, w: 0.1, tag: secret')}` })
  const tsRun = threejam(['check', ts.dir])
  assert.equal(tsRun.code, 1)
  assert.match(String(tsRun.json.message), /is outside the folder/)
  assert.ok(!tsRun.out.includes(canary), 'the outside file leaked into the output')

  const jsonGame = folder({ 'keep.txt': 'x' })
  writeFileSync(join(jsonGame.abs, 'game.ts'), `import data from '${relative(jsonGame.abs, join(outside, 'secret.json')).replaceAll('\\', '/')}'\n${game('', 'x: 0, w: 0.1, tag: data.token')}`)
  const jsonRun = threejam(['sim', jsonGame.dir, '--ticks', '1'])
  assert.equal(jsonRun.code, 1)
  assert.match(String(jsonRun.json.message), /can't bundle .* a game may import only its own folder/)
  assert.ok(!jsonRun.out.includes(canary))
})

test('finding 2: game.ts cannot be a symlink to a file elsewhere, but a sibling import in the folder works', () => {
  const outside = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(outside, 'elsewhere.ts'), "export default { entities: {}, update() {} }\n")
  const linked = folder({ 'keep.txt': 'x' })
  symlinkSync(join(outside, 'elsewhere.ts'), join(linked.abs, 'game.ts'))
  const link = threejam(['sim', linked.dir, '--ticks', '1'])
  assert.equal(link.code, 1)
  assert.match(String(link.json.message), /must be a file in its own folder, not a link elsewhere/)

  const ok = folder({ 'game.ts': `import { vx } from './helper.ts'\n${game('', 'x: 0, w: 0.1, vx')}`.replace('world.ball.x += 0.01', 'world.ball.x += world.ball.vx'), 'helper.ts': 'export const vx = 2\n' })
  const run = threejam(['sim', ok.dir, '--ticks', '3', '--fields', 'x'])
  assert.equal(run.code, 0, run.out)
  assert.deepEqual(run.json.entities, [{ name: 'ball', x: 6 }])
})

// finding 5: nothing writes the loaded game to a predictable, world-readable temp file.
test('finding 5: a run writes no game bundle to a temp folder, and leaves none behind', () => {
  const tmp = mkdtempSync(join(TMP, 'tmproot-'))
  made.push(tmp)
  const { dir } = folder({ 'game.ts': game('') })
  const run = threejam(['check', dir], { TMPDIR: tmp, TMP: tmp, TEMP: tmp })
  assert.equal(run.code, 0, run.out)
  assert.ok(!existsSync(join(tmp, 'threejam-modules')), 'the fixed threejam-modules folder is back')
  // check writes a tsconfig to its own mkdtemp dir and removes it; nothing else stays.
  assert.deepEqual(readdirSync(tmp), [], `the run left files in the temp folder: ${readdirSync(tmp).join(', ')}`)
})

// audit 1: a game that never returns is stopped with a TIMEOUT code that names where it was.
test('audit 1: an endless loop in a game fails with TIMEOUT, not a hang', () => {
  const { dir } = folder({ 'game.ts': game('').replace('world.ball.x += 0.01', 'if (ctx.tick === 2) { for (;;) {} }') })
  const started = Date.now()
  const sim = threejam(['sim', dir, '--ticks', '5', '--timeout', '2'])
  assert.equal(sim.code, 1)
  assert.equal(sim.json.code, 'TIMEOUT')
  assert.match(String(sim.json.message), /time limit.*in update at tick 2/)
  assert.ok(Date.now() - started < 8000, 'the loop was not stopped near its budget')
})

// audit 15: a long run of loads does not keep temp files; each load is its own short-lived process.
test('audit 15: repeated loads leave no growing temp files', () => {
  const tmp = mkdtempSync(join(TMP, 'tmproot-'))
  made.push(tmp)
  const { dir } = folder({ 'game.ts': game('') })
  for (let i = 0; i < 6; i++) threejam(['sim', dir, '--ticks', '1', '--only', 'ball'], { TMPDIR: tmp, TMP: tmp, TEMP: tmp })
  assert.deepEqual(readdirSync(tmp), [], `loads left temp files: ${readdirSync(tmp).join(', ')}`)
})

// The sandbox fixes the realm's globals before a game's module loads, and still keeps runs deterministic.
test('the sandbox prepares the realm before the game loads, and the same seed still repeats a run', () => {
  const { dir } = folder({ 'game.ts': game('', 'x: 0, w: 0.1, roll: 0').replace('world.ball.x += 0.01', 'world.ball.roll = ctx.random()') })
  const first = threejam(['sim', dir, '--ticks', '1', '--seed', '7', '--fields', 'roll'])
  const again = threejam(['sim', dir, '--ticks', '1', '--seed', '7', '--fields', 'roll'])
  assert.equal(first.code, 0, first.out)
  assert.deepEqual(first.json.entities, again.json.entities)
  const other = threejam(['sim', dir, '--ticks', '1', '--seed', '8', '--fields', 'roll'])
  assert.notDeepEqual(first.json.entities, other.json.entities)
})
