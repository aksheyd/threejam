import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test } from 'node:test'
import { real, within } from '../src/confine.ts'
import { sandboxEnv } from '../src/load.ts'
import { PORTABLE } from '../src/math.ts'
import { ROOT } from '../src/package.ts'
import { CLI } from './children.ts'
import { PROBE, checkProbe } from './probe.ts'

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

test('check fails on an import from outside the folder, naming it, instead of passing with the type errors in that file hidden', () => {
  const shared = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(shared, 'util.ts'), 'export function label(n: number): string {\n  return n\n}\n')
  const g = folder({ 'keep.txt': 'x' })
  writeFileSync(join(g.abs, 'game.ts'), `import { label } from '${relative(g.abs, join(shared, 'util.ts')).replaceAll('\\', '/')}'\n${game('', 'x: 0, w: 1, tag: 0')}`.replace('world.ball.x += 0.01', 'world.ball.tag = Number(label(3))'))
  const run = threejam(['check', g.dir])
  assert.notEqual(run.json.ok, true)
  assert.equal(run.code, 1)
  assert.match(String(run.json.message), /is outside the folder/)
})

// The node_modules exemption that lets tsc read lib.d.ts must not exempt an outside file reached through a node_modules path.
test('check rejects an import that reaches outside through a node_modules symlink, without echoing the file', () => {
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

test("check rejects an absolute import into another tree's node_modules, without echoing the file", () => {
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

test('a folder holds a file by the name its filesystem gives it, not by case folded by hand', () => {
  const root = mkdtempSync(join(TMP, 'case-'))
  made.push(root)
  // Plain letters name one folder on a case-insensitive volume and two elsewhere; lowercasing İ adds a character, and Windows keeps the two names apart.
  for (const [name, other] of [['Pong', 'pong'], ['Game\u0130', `game${'\u0130'.toLowerCase()}`]]) {
    mkdirSync(join(root, name))
    if (!existsSync(join(root, other))) mkdirSync(join(root, other))
    writeFileSync(join(root, other, 'secret.ts'), '')
    assert.equal(within(real(join(root, name)), real(join(root, other, 'secret.ts'))), existsSync(join(root, name, 'secret.ts')), `${name} and ${other}`)
  }
})

test("a runtime import of three fails in check, sim, and the page, pointing to the THREE a view receives, while import type from 'three' passes", () => {
  const hint = /a game may import only its own folder and ThreeJam's files; use the THREE that init and draw receive in view\.ts, and import type from 'three' for its types$/
  const inGame = folder({ 'game.ts': `import * as THREE from 'three'\n${game('', 'x: 0, w: 0.1')}`.replace('world.ball.x += 0.01', 'world.ball.x = THREE.MathUtils.clamp(2, 0, 1)') })
  const sim = threejam(['sim', inGame.dir, '--ticks', '1'])
  assert.equal(sim.code, 1, sim.out)
  assert.match(String(sim.json.message), hint)

  const init = (body: string) => `import type { ViewSetup } from 'threejam'\n\nexport function init({ THREE, scene }: ViewSetup): void {\n  ${body}\n}\n`
  const inView = folder({ 'game.ts': game(''), 'view.ts': `import { Mesh } from 'three'\n${init('scene.add(THREE ? new Mesh() : new Mesh())')}` })
  const checked = threejam(['check', inView.dir])
  assert.equal(checked.code, 1, checked.out)
  assert.match(String(checked.json.message), /view\.ts:1: can't bundle "three"/)
  assert.match(String(checked.json.message), hint)
  const out = join(inView.abs, 'page.html')
  const exported = threejam(['export', inView.dir, '-o', out])
  assert.equal(exported.code, 1, exported.out)
  assert.match(String(exported.json.message), hint)
  assert.equal(existsSync(out), false)

  const typed = folder({ 'game.ts': game(''), 'view.ts': `import type { Mesh } from 'three'\n${init('const mesh: Mesh = new THREE.Mesh()\n  scene.add(mesh)')}` })
  assert.equal(threejam(['check', typed.dir]).code, 0)
  const typedOut = join(typed.abs, 'page.html')
  const typedRun = threejam(['export', typed.dir, '-o', typedOut])
  assert.equal(typedRun.code, 0, typedRun.out)
  assert.ok(existsSync(typedOut))
})

// A game or driver whose real path is inside the engine's folder still obeys the import rule.
test('a game or driver placed inside the engine directory cannot import a file outside the folders', () => {
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
  assert.equal(byDriver.json.code, 'BUILD_ERROR')
  assert.ok(!byDriver.out.includes('CANARY-ENGINE-TRUST'))

  writeFileSync(join(probe, 'game.ts'), `import { defineGame } from 'threejam'\n${importOutside}\nexport default defineGame({ entities: { ball: { x: 0, w: 0.1, tag: '' } }, update(world) { world.ball.tag = tag } })\n`)
  const byGame = threejam(['sim', relative(ROOT, probe), '--ticks', '1', '--fields', 'tag'])
  assert.equal(byGame.code, 1, byGame.out)
  assert.match(String(byGame.json.message), /can't be inside ThreeJam's own files/)
  assert.equal(byGame.json.code, 'BUILD_ERROR')
  assert.ok(!byGame.out.includes('CANARY-ENGINE-TRUST'))
})

// The import rule keys on which entry reached a file, so a game can't borrow the driver's folder, even when a driver is loaded.
test("a game cannot import the --driver's folder, though the driver can import its own folder", () => {
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

// Loading a game or driver runs its code, and the sandbox stops it reaching the process, the filesystem, or a dynamic import.
test('a game cannot run a process, read a file, or reach the host, at load or in update', () => {
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

test('a driver loaded for sim runs in the same sandbox, and reaching process is blocked', () => {
  const marks = mkdtempSync(join(TMP, 'marks-'))
  made.push(marks)
  const { dir, abs } = folder({ 'game.ts': game('') })
  writeFileSync(join(abs, 'driver.ts'), `export default function () {\n  globalThis.Function("return process")().getBuiltinModule("child_process").execSync("touch ${join(marks, 'from-driver')}")\n  return []\n}\n`)
  const sim = threejam(['sim', dir, '--ticks', '1', '--driver', join(dir, 'driver.ts')])
  assert.equal(sim.code, 1, sim.out)
  assert.match(String(sim.json.message), /disallowed|in the driver before tick 1/)
  assert.deepEqual(readdirSync(marks), [])
})

test('a game sees no process, require, or working import(), only the seeded random', () => {
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

// The bundle the sandbox runs, like the page's, reaches only the game's folder, a driver's folder, and the engine.
test('a game cannot import a file outside its folder, as TypeScript or JSON, and the secret never loads', () => {
  const canary = 'CANARY-OUTSIDE-9f3a'
  const outside = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(outside, 'secret.ts'), `export const secret = '${canary}'\n`)
  writeFileSync(join(outside, 'secret.json'), `{ "token": "${canary}" }\n`)
  const ts = folder({ 'game.ts': `import { secret } from '${join(outside, 'secret.ts').replaceAll('\\', '/')}'\n${game('', 'x: 0, w: 0.1, tag: secret')}` })
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

test('game.ts cannot be a symlink to a file elsewhere, but a sibling import in the folder works', () => {
  const outside = folder({ 'keep.txt': 'x' }).abs
  writeFileSync(join(outside, 'elsewhere.ts'), "export default { entities: {}, update() {} }\n")
  const linked = folder({ 'keep.txt': 'x' })
  symlinkSync(join(outside, 'elsewhere.ts'), join(linked.abs, 'game.ts'))
  const link = threejam(['sim', linked.dir, '--ticks', '1'])
  assert.equal(link.code, 1)
  assert.match(String(link.json.message), /must be a file in its own folder, not a link elsewhere/)
  assert.equal(link.json.code, 'BUILD_ERROR')

  const ok = folder({ 'game.ts': `import { vx } from './helper.ts'\n${game('', 'x: 0, w: 0.1, vx')}`.replace('world.ball.x += 0.01', 'world.ball.x += world.ball.vx'), 'helper.ts': 'export const vx = 2\n' })
  const run = threejam(['sim', ok.dir, '--ticks', '3', '--fields', 'x'])
  assert.equal(run.code, 0, run.out)
  assert.deepEqual(run.json.entities, [{ name: 'ball', x: 6 }])
})

// Nothing writes the loaded game to a predictable, world-readable temp file.
test('a run writes no game bundle to a temp folder, and leaves none behind', () => {
  const tmp = mkdtempSync(join(TMP, 'tmproot-'))
  made.push(tmp)
  const { dir } = folder({ 'game.ts': game('') })
  const run = threejam(['check', dir], { TMPDIR: tmp, TMP: tmp, TEMP: tmp })
  assert.equal(run.code, 0, run.out)
  assert.ok(!existsSync(join(tmp, 'threejam-modules')), 'the fixed threejam-modules folder is back')
  // check writes a tsconfig to its own mkdtemp dir and removes it; nothing else stays.
  assert.deepEqual(readdirSync(tmp), [], `the run left files in the temp folder: ${readdirSync(tmp).join(', ')}`)
})

test('an endless loop in a game fails with TIMEOUT, naming where it was, instead of hanging', () => {
  const { dir } = folder({ 'game.ts': game('').replace('world.ball.x += 0.01', 'if (ctx.tick === 2) { for (;;) {} }') })
  const started = Date.now()
  const sim = threejam(['sim', dir, '--ticks', '5', '--timeout', '2'])
  assert.equal(sim.code, 1)
  assert.equal(sim.json.code, 'TIMEOUT')
  assert.match(String(sim.json.message), /time limit.*in update at tick 2/)
  assert.ok(Date.now() - started < 8000, 'the loop was not stopped near its budget')
})

test('a game that keeps more than the 1 GB a sandbox may grow to runs out of memory with GAME_ERROR on any machine, and with --every, the message says the snapshots it keeps count toward that', () => {
  // 8 MB more every tick: 1.6 GB by tick 200, which V8's own limit would allow on a machine with 16 GB.
  const { dir } = folder({ 'game.ts': game('const kept: number[][] = []').replace('world.ball.x += 0.01', 'kept.push(new Array(1_000_000).fill(ctx.tick + 0.5))') })
  const sim = threejam(['sim', dir, '--ticks', '200'])
  assert.deepEqual({ code: sim.code, json: sim.json }, { code: 1, json: { code: 'GAME_ERROR', message: 'the game ran out of memory; look for a list or a loop that keeps growing' } })
  const every = threejam(['sim', dir, '--ticks', '200', '--every', '50'])
  const message = 'the game ran out of memory, and the snapshots --every 50 keeps count toward it; keep fewer with --only, a larger --every, or --until, or look for a list or a loop that keeps growing'
  assert.deepEqual({ code: every.code, json: every.json }, { code: 1, json: { code: 'GAME_ERROR', message } })
})

// Each load is a process of its own that shares only the temporary folder with the next, so what a long run of loads would leave there, as an MCP server's would, shows after two.
test('repeated loads leave no growing temp files', () => {
  const tmp = mkdtempSync(join(TMP, 'tmproot-'))
  made.push(tmp)
  const { dir } = folder({ 'game.ts': game('') })
  for (let i = 0; i < 2; i++) threejam(['sim', dir, '--ticks', '1', '--only', 'ball'], { TMPDIR: tmp, TMP: tmp, TEMP: tmp })
  assert.deepEqual(readdirSync(tmp), [], `loads left temp files: ${readdirSync(tmp).join(', ')}`)
})

test("sim gives one run whatever the machine's language and time zone, formatting as en-US does and dates in UTC", () => {
  const update = [
    'const day = new Date(Date.UTC(2024, 0, 31, 23, 30))',
    "world.ball.texts = [(1234567.5).toLocaleString(), day.toLocaleString(), new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day), ['b', 'a', 'C', 'ä'].sort((a, b) => a.localeCompare(b)).join(''), 'i'.toLocaleUpperCase()]",
  ].join('\n    ')
  const { dir } = folder({ 'game.ts': game('', "x: 0, w: 0.1, texts: ['']").replace('world.ball.x += 0.01', update) })
  const settings = [
    { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' },
    { LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8', TZ: 'Europe/Paris' },
    { LANG: 'hi_IN.UTF-8', LC_ALL: 'hi_IN.UTF-8', TZ: 'Asia/Kolkata' },
    { LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'America/Los_Angeles' },
  ]
  const expected = [{ name: 'ball', texts: ['1,234,567.5', '1/31/2024, 11:30:00 PM', 'Wednesday, January 31, 2024', 'aäbC', 'I'] }]
  for (const env of settings) {
    const run = threejam(['sim', dir, '--ticks', '1', '--fields', 'texts'], env)
    assert.equal(run.code, 0, run.out)
    assert.deepEqual(run.json.entities, expected, env.LANG)
  }
})

test("what a game's top level keeps from Math, Date, or a driver's factory is guarded in sim, while top-level code itself computes with the platform's Math", () => {
  const kept = folder({
    'game.ts': game('const { sin } = Math\nconst TOP = Math.sin(1e22)', 'x: 0, w: 0.1, kept: 0, inline: 0, top: 0').replace(
      'world.ball.x += 0.01',
      'world.ball.kept = sin(1e22)\n    world.ball.inline = Math.sin(1e22)\n    world.ball.top = TOP',
    ),
  })
  const run = threejam(['sim', kept.dir, '--ticks', '1', '--fields', 'kept,inline,top'])
  assert.equal(run.code, 0, run.out)
  const [{ kept: sine, inline, top }] = run.json.entities as Array<{ kept: number; inline: number; top: number }>
  assert.equal(sine, inline)
  assert.ok(Math.abs(sine - PORTABLE.sin(1e22)) < 1e-4 && Math.abs(top - Math.sin(1e22)) < 1e-4 && Math.abs(sine - top) > 0.1, run.out)

  const failing: Array<[string, Record<string, string>, RegExp]> = [
    ['a kept Math.random', { 'game.ts': game('const random = Math.random').replace('world.ball.x += 0.01', 'world.ball.x = random()') }, /game\.ts:7: Math\.random\(\) would make runs differ.*\(in update at tick 1\)$/],
    ['a kept Date.now', { 'game.ts': game('const now = Date.now').replace('world.ball.x += 0.01', 'world.ball.x = now() % 1') }, /game\.ts:7: Date\.now\(\) would make runs differ/],
    ['Math.random at the top level', { 'game.ts': game('const SEED = Math.random()') }, /game\.ts:3: Math\.random\(\) would make runs differ; use ctx\.random\(\), which is seeded$/],
  ]
  for (const [name, files, message] of failing) {
    const sim = threejam(['sim', folder(files).dir, '--ticks', '1'])
    assert.equal(sim.code, 1, `${name}: ${sim.out}`)
    assert.match(String(sim.json.message), message, name)
  }
  const { dir, abs } = folder({ 'game.ts': game('') })
  writeFileSync(join(abs, 'driver.ts'), "import { defineDriver } from 'threejam'\n\nexport default defineDriver(() => {\n  const wait = Math.random() * 10\n  return ({ tick }) => (tick > wait ? ['Space'] : [])\n})\n")
  const driven = threejam(['sim', dir, '--ticks', '5', '--driver', join(dir, 'driver.ts')])
  assert.equal(driven.code, 1, driven.out)
  assert.match(String(driven.json.message), /driver\.ts:4: Math\.random\(\) would make runs differ/)
})

test("game code in sim's realm finds the stand-ins a page gives it for crypto and performance, so both refuse them alike", () => {
  const probe = game('').replace(
    'world.ball.x += 0.01',
    [
      'const host = globalThis',
      "ctx.print(typeof host.crypto, typeof host.crypto.subtle, Object.keys(host.performance).join(','))",
      'try { host.crypto.randomUUID() } catch (error) { ctx.print(error.message) }',
      'try { host.Temporal.Now.instant() } catch (error) { ctx.print(host.Temporal ? error.message : "Temporal.Now.instant() would make runs differ") }',
    ].join('\n    '),
  )
  const sim = threejam(['sim', folder({ 'game.ts': probe }).dir, '--ticks', '1'])
  assert.equal(sim.code, 0, sim.out)
  const log = (sim.json.log as Array<{ text: string }>).map((entry) => entry.text)
  assert.deepEqual(log.map((line) => line.split(';')[0]), ['object undefined now', 'crypto.randomUUID() would make runs differ', 'Temporal.Now.instant() would make runs differ'])
})

test("check reads only declaration files from ThreeJam's type packages, not other files there or the code packages those types name", () => {
  const types = join(ROOT, 'node_modules', '@types', 'three')
  const code = join(ROOT, 'node_modules', 'fflate')
  const planted = [join(types, 'tj-canary.ts'), ...(existsSync(join(code, 'package.json')) ? [join(code, 'tj-canary.ts')] : [])]
  try {
    for (const file of planted) {
      const canary = `CANARY-${relative(ROOT, file).replace(/\W+/g, '-')}`
      writeFileSync(file, `export const token = '${canary}'\n`)
      const g = folder({
        'game.ts': [
          `import { token } from '${file.replaceAll('\\', '/')}'`,
          "import { defineGame } from 'threejam'",
          'type Echo = Record<typeof token, number>',
          'const missing: Echo = {}',
          'export default defineGame({ entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, seen: missing } }, update() {} })',
        ].join('\n'),
      })
      const run = threejam(['check', g.dir])
      assert.equal(run.code, 1, run.out)
      assert.match(String(run.json.message), /is outside the folder/)
      assert.ok(!run.out.includes(canary), `check quoted ${relative(ROOT, file)}`)
    }
  } finally {
    for (const file of planted) rmSync(file, { force: true })
  }
})

test("outside any project, where three doesn't resolve, a runtime import of three still points to the THREE a view receives", () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-three-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), game(''))
  writeFileSync(join(dir, 'view.ts'), "import { Mesh } from 'three'\nimport type { ViewSetup } from 'threejam'\n\nexport function init({ scene }: ViewSetup): void {\n  scene.add(new Mesh())\n}\n")
  const checked = threejam(['check', dir])
  assert.equal(checked.code, 1, checked.out)
  assert.match(String(checked.json.message), /view\.ts:1: Could not resolve "three"; use the THREE that init and draw receive in view\.ts, and import type from 'three' for its types$/)
})

test("a path that still holds a .. is never inside a folder, as when real() can't resolve it and hands it back", () => {
  const root = real(mkdtempSync(join(TMP, 'dots-')))
  made.push(root)
  const climbing = [root, 'missing', '..', '..', 'outside', 'secret.ts'].join(sep)
  assert.equal(real(climbing), climbing)
  assert.equal(within(root, climbing), false)
  assert.equal(within(root, [root, 'a..b', 'c.ts'].join(sep)), true)
})

test("in sim, on three machines' settings and once more on the first, the probe gives one output, with every path to the clock, zone, and locale guarded", () => {
  const { dir } = folder({ 'game.ts': PROBE })
  const settings = [
    { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' },
    { LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Europe/Istanbul' },
    { LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8', TZ: 'Europe/Paris' },
    { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' },
  ]
  const outs = settings.map((env) => {
    const run = threejam(['sim', dir, '--ticks', '2', '--fields', 'out,n'], env)
    assert.equal(run.code, 0, run.out)
    const [probe] = run.json.entities as Array<{ out: unknown; n: number }>
    checkProbe(probe.out, { bare: true })
    assert.equal(probe.n, 0)
    return probe.out
  })
  for (const out of outs.slice(1)) assert.deepEqual(out, outs[0])
})

test("a defineDriver factory that keeps Date's own constructor reads no clock through it", () => {
  const { dir, abs } = folder({ 'game.ts': game('') })
  writeFileSync(
    join(abs, 'driver.ts'),
    "import { defineDriver } from 'threejam'\n\nexport default defineDriver(() => {\n  const start = (Date.prototype.constructor as DateConstructor).now()\n  return ({ tick }) => (tick > start ? [] : ['Space'])\n})\n",
  )
  const driven = threejam(['sim', dir, '--ticks', '2', '--driver', join(dir, 'driver.ts')])
  assert.equal(driven.code, 1, driven.out)
  assert.match(String(driven.json.message), /driver\.ts:4: Date\.now\(\) would make runs differ/)
})

test("sim's sandbox runs in UTC and en-US and takes nothing else from our environment, whatever ours is set to", () => {
  const names = ['TZ', 'LANG', 'LC_ALL', 'LC_TIME', 'THREEJAM_TEST_TOKEN'] as const
  const saved = names.map((name) => process.env[name])
  Object.assign(process.env, { TZ: 'Europe/Istanbul', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', LC_TIME: 'fr_FR.UTF-8', THREEJAM_TEST_TOKEN: 'secret' })
  try {
    const { SystemRoot, ...env } = sandboxEnv()
    assert.deepEqual(env, { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
    assert.equal(SystemRoot, process.platform === 'win32' ? process.env.SystemRoot : undefined)
  } finally {
    names.forEach((name, i) => {
      const value = saved[i]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
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
