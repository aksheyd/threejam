import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import pong from '../games/pong/game.ts'
import { simulate } from '../src/engine.ts'
import { crashed, describe } from '../src/load.ts'
import { ENGINE, ROOT, VERSION, mcpCommand, runningNode } from '../src/package.ts'
import { playtestSource } from '../src/playtest.ts'
import { findChrome } from '../src/serve.ts'
import { callLimit, framePaths } from '../src/shot.ts'
import { CLI, mcp, spawnCli } from './children.ts'
import { TMP, folder, game, made, slowCheck } from './games.ts'

function threejam(...args: string[]) {
  return threejamWith({}, ...args)
}

// spawnSync holds up the test's own timeout, so a run that never ends, like a run that starts serving, is killed here.
function threejamWith(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000, killSignal: 'SIGKILL' })
  return { code: result.status, out: result.stdout + result.stderr }
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

test("export adds each script --script names right before the end of the body, as a jam's widget asks to be added, with its & and \" escaped, refuses one without an https:// address before it runs the game, and adds none of its own", () => {
  const broken = folder({ 'game.ts': game({ update: 'world.ball.x += ;' }) })
  for (const script of ['http://jam.pieter.com/2026/widget.js', 'widget.js']) {
    const refused = threejam('export', broken, '-o', join(broken, 'page.html'), '--script', script, '--format', 'json')
    const message = `--script ${JSON.stringify(script)} should be the https:// address of a script, like https://jam.pieter.com/2026/widget.js`
    assert.deepEqual({ code: refused.code, failure: JSON.parse(refused.out) }, { code: 1, failure: { code: 'USAGE', message } })
  }
  const dir = mkdtempSync(join(TMP, 'scripts-'))
  made.push(dir)
  const [plain, jam] = [join(dir, 'plain.html'), join(dir, 'jam.html')]
  assert.equal(threejam('export', 'games/pong', '-o', plain).code, 0)
  // A host keeps a " as it is, where it would end the attribute and start an onerror of its own.
  const scripts = ['https://jam.pieter.com/2026/widget.js', 'https://example.com/a.js?x=1&y="2"', 'https://x"onerror="alert(1)"x.example/w.js']
  assert.equal(threejam('export', 'games/pong', '-o', jam, ...scripts.flatMap((script) => ['--script', script])).code, 0)
  const remote = (file: string) => readFileSync(file, 'utf8').match(/<script[^>]* src=[^>]*>/g) ?? []
  assert.deepEqual(remote(plain), [])
  const tags = [
    '<script async src="https://jam.pieter.com/2026/widget.js"></script>',
    '<script async src="https://example.com/a.js?x=1&amp;y=%222%22"></script>',
    '<script async src="https://x&quot;onerror=&quot;alert(1)&quot;x.example/w.js"></script>',
  ]
  const end = `${tags.join('\n')}\n</body>\n</html>\n`
  const page = readFileSync(jam, 'utf8')
  assert.equal(page.slice(-end.length), end)
  assert.equal(remote(jam).length, tags.length)
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

// A game that can't start, so a check of --record that came after the game's first tick, or never came, fails at once with GAME_ERROR.
const UNSTARTABLE = 'export default {}\n'

test("run checks --record before it runs anything, so the playtest goes to a .ts file and never takes the place of a folder or of a file run didn't record, like the game's own game.ts", () => {
  const dir = folder({ 'game.ts': UNSTARTABLE }).replaceAll(sep, '/')
  mkdirSync(join(ROOT, dir, 'saved.ts'))
  const record = (path: string) => threejam('run', dir, '--serve-only', '--record', path)
  const named = (path: string) => `${path} (${join(ROOT, path).replaceAll(sep, '/')})`
  assert.deepEqual([record(`${dir}/playtest.json`), record(`${dir}/saved.ts`), record(`${dir}/game.ts`)], [
    { code: 1, out: `Error (USAGE): --record "${dir}/playtest.json" should be a .ts file, like playtest.ts\n` },
    { code: 1, out: `Error (USAGE): --record ${named(`${dir}/saved.ts`)} is a folder; name a new file, or a playtest to replace\n` },
    { code: 1, out: `Error (USAGE): --record ${named(`${dir}/game.ts`)} is a file run didn't record; name a new file, or a playtest to replace\n` },
  ])
})

test('run refuses a link or a FIFO at --record before it runs anything, even a link to a playtest it saved, so it never writes through a link or waits on a FIFO', { skip: process.platform === 'win32' && 'the links and the FIFO are made with POSIX tools' }, () => {
  const dir = folder({ 'game.ts': UNSTARTABLE, 'earlier.ts': playtestSource({ seed: 1, ticks: 2, changes: [[1, ['Space']]] }) }).replaceAll(sep, '/')
  symlinkSync('earlier.ts', join(ROOT, dir, 'linked.ts'))
  symlinkSync('missing.ts', join(ROOT, dir, 'dangling.ts'))
  assert.equal(spawnSync('mkfifo', [join(ROOT, dir, 'fifo.ts')]).status, 0)
  const refused = (name: string, why: string) => {
    const path = `${dir}/${name}`
    return { code: 1, out: `Error (USAGE): --record ${path} (${join(ROOT, path)}) ${why}; name a new file, or a playtest to replace\n` }
  }
  assert.deepEqual(
    ['linked.ts', 'dangling.ts', 'fifo.ts'].map((name) => threejam('run', dir, '--serve-only', '--record', `${dir}/${name}`)),
    [refused('linked.ts', 'is a link'), refused('dangling.ts', 'is a link'), refused('fifo.ts', "isn't a regular file")],
  )
})

test("run checks that it can write the --record file before it runs anything, in its folder too, which the save renames a new file into, so a playtest is never lost as run stops", { skip: (process.platform === 'win32' && "a folder's mode doesn't stop Windows writing in it") || (process.getuid?.() === 0 && 'root writes anywhere') }, () => {
  const dir = folder({ 'game.ts': UNSTARTABLE }).replaceAll(sep, '/')
  const locked = join(ROOT, dir, 'locked')
  mkdirSync(locked)
  // A playtest that can be written, in a folder that can't.
  writeFileSync(join(locked, 'earlier.ts'), playtestSource({ seed: 1, ticks: 2, changes: [[1, ['Space']]] }))
  chmodSync(locked, 0o555)
  try {
    const refused = (file: string) => ({ code: 1, out: `Error (IO_ERROR): couldn't write ${file} (${join(ROOT, file)}): permission denied\n` })
    const files = [`${dir}/locked/tests/playtest.ts`, `${dir}/locked/earlier.ts`]
    assert.deepEqual(
      files.map((file) => threejam('run', dir, '--serve-only', '--record', file)),
      files.map(refused),
    )
  } finally {
    chmodSync(locked, 0o755)
  }
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

test('with --every, sim keeps only the entities --only names in each snapshot as it takes it, so a wrong --only fails at tick 0, before a game error at tick 2', () => {
  const dir = folder({ 'game.ts': game({ update: "world.ball.x = ctx.tick\n    if (ctx.tick === 2) throw new Error('boom')" }) })
  const { code, out } = threejam('sim', dir, '--ticks', '5', '--every', '1', '--only', 'nope', '--format', 'json')
  assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message: '--only "nope" matches no entity' } })
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

// The first bytes of a PNG and an MP3, which is all check reads of a file.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])

test("check reads the start of every image and sound file in the folder, which the page loads, and names each one that doesn't start like a type the page takes, while a raster image passes under any raster name, since browsers read its own type", () => {
  const good = {
    'game.ts': game({ update: 'world.ball.x += 1' }),
    'tile.jpg': PNG,
    'art.gif': 'GIF89a\x01\x00\x01\x00',
    'pic.webp': 'RIFF\x1a\x00\x00\x00WEBPVP8L',
    'logo.svg': '\uFEFF\n  <svg xmlns="http://www.w3.org/2000/svg"/>',
    'beep.wav': 'RIFF\x24\x00\x00\x00WAVEfmt ',
    'tune.mp3': MP3,
    'loop.ogg': 'OggS\x00\x02',
  }
  assert.deepEqual(threejam('check', folder(good)), { code: 0, out: 'ok: true\nentities: 1\n' })
  const bad = {
    'game.ts': good['game.ts'],
    'tile.png': 'version https://git-lfs.github.com/spec/v1\n',
    'photo.png': '\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic',
    'logo.svg': PNG,
    'beep.wav': '',
    'drum.ogg': 'FORM\x00\x00\x00\x1eAIFFCOMM',
    'tune.mp3': '<!doctype html>',
  }
  const { code, out } = threejam('check', folder(bad), '--format', 'json')
  const message = [
    `sound "beep.wav" in the game's folder is empty, so the page can't play it`,
    `sound "drum.ogg" in the game's folder doesn't start like a WAV, MP3, Ogg, FLAC, MP4, or WebM sound`,
    `image "logo.svg" in the game's folder isn't an SVG image, which starts with "<", so the page can't draw it`,
    `image "photo.png" in the game's folder doesn't start like a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or CUR image`,
    `image "tile.png" in the game's folder doesn't start like a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or CUR image`,
    `sound "tune.mp3" in the game's folder doesn't start like a WAV, MP3, Ogg, FLAC, MP4, or WebM sound`,
  ].join('; ')
  assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'GAME_ERROR', message } })
})

test("check fails with IO_ERROR on an image or sound file in the folder it can't read, which the page couldn't load either", { skip: (process.platform === 'win32' && "a file's mode doesn't stop Windows reading it") || (process.getuid?.() === 0 && 'root reads any file') }, () => {
  const dir = folder({ 'game.ts': game({ update: 'world.ball.x += 1' }), 'tune.mp3': MP3 })
  chmodSync(join(ROOT, dir, 'tune.mp3'), 0)
  const { code, out } = threejam('check', dir, '--format', 'json')
  assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'IO_ERROR', message: `couldn't read sound "tune.mp3" in the game's folder: permission denied` } })
})

test("check names a sprite with ragged rows, or sprites with more pixels than a game's may have, as it names a missing image, and a misspelled field of a sprite as a type error", () => {
  const sprite = (fields: string) =>
    [
      "import { defineGame, type Sprites } from 'threejam'",
      '',
      `const sprites = { ship: { ${fields} } } satisfies Sprites`,
      '',
      "export default defineGame({ sprites, entities: { ship: { w: 0.3, h: 0.2, image: 'ship' } }, update() {} })",
      '',
    ].join('\n')
  const ragged = threejam('check', folder({ 'game.ts': sprite("rows: ['.#.', '##']") }), '--format', 'json')
  const message = 'sprite "ship": rows[1] has 2 pixels, but rows[0] has 3, and every row must have the same number'
  assert.deepEqual({ code: ragged.code, failure: JSON.parse(ragged.out) }, { code: 1, failure: { code: 'GAME_ERROR', message } })
  const crowded = [
    "import { defineGame, type Sprites } from 'threejam'",
    '',
    "const wall = { rows: Array.from({ length: 256 }, () => '#'.repeat(256)) }",
    "const sprites = { ...Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`wall_${i}`, wall])), ship: { rows: ['#'] } } satisfies Sprites",
    '',
    "export default defineGame({ sprites, entities: { ship: { w: 0.3, h: 0.2, image: 'ship' } }, update() {} })",
    '',
  ].join('\n')
  const over = threejam('check', folder({ 'game.ts': crowded }), '--format', 'json')
  const most = 'sprite "ship" brings the game\'s sprites to 4194305 pixels, but a game\'s sprites may have 4194304 in all, as many as 64 sprites of 256 by 256'
  assert.deepEqual({ code: over.code, failure: JSON.parse(over.out) }, { code: 1, failure: { code: 'GAME_ERROR', message: most } })
  const typo = threejam('check', folder({ 'game.ts': sprite("rows: ['.#.', '###'], pallete: { '#': 'red' }") }))
  assert.equal(typo.code, 1)
  assert.match(typo.out, /code: TYPE_ERROR\nmessage: "?test\/\.tmp\/game-\w+\/game\.ts:3: Object literal may only specify known properties, but 'pallete' does not exist in type 'Sprite'/)
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

test("mcp add registers the Node running it with this CLI from a clone or an install, or node when that Node's path has a space, and npx for a copy in npx's cache or an install on a path with a space", () => {
  const command = (cli: string, node = '/opt/homebrew/bin/node') => mcpCommand({ cli, version: '1.2.3', node })
  assert.equal(command('/work/threejam/src/cli.ts'), '/opt/homebrew/bin/node /work/threejam/src/cli.ts --mcp')
  assert.equal(command('/work/my games/threejam/src/cli.ts'), '/opt/homebrew/bin/node "/work/my games/threejam/src/cli.ts" --mcp')
  assert.equal(command('/usr/local/lib/node_modules/threejam/lib/cli.js'), '/opt/homebrew/bin/node /usr/local/lib/node_modules/threejam/lib/cli.js --mcp')
  assert.equal(command('C:\\games\\node_modules\\threejam\\lib\\cli.js', 'C:\\Program Files\\nodejs\\node.exe'), 'node C:\\games\\node_modules\\threejam\\lib\\cli.js --mcp')
  assert.equal(command('C:\\Users\\Ada Byron\\game\\node_modules\\threejam\\lib\\cli.js'), 'npx -y threejam@1.2.3 --mcp')
  assert.equal(command('/home/ada/.npm/_npx/2c3b1a/node_modules/threejam/lib/cli.js'), 'npx -y threejam@1.2.3 --mcp')
  assert.equal(command('C:\\Users\\Ada Byron\\AppData\\Local\\npm-cache\\_npx\\2c3b1a\\node_modules\\threejam\\lib\\cli.js'), 'npx -y threejam@1.2.3 --mcp')
  assert.equal(mcpCommand(), mcpCommand({ cli: CLI, version: VERSION, node: runningNode() }))
})

// runningNode passes over links in the temporary folder, so a checkout there can't hold a link it would take.
const linksTaken = (process.platform === 'win32' && 'making a link takes an administrator on Windows') || (!relative(realpathSync(tmpdir()), realpathSync(TMP)).startsWith('..') && 'the checkout is in the temporary folder')

test("the Node mcp add registers is a name on the PATH that leads to the running Node, which an upgrade keeps, or else the running Node's own path, and never a name a relative PATH entry gives", { skip: linksTaken }, () => {
  const [linked, other] = [mkdtempSync(join(TMP, 'bin-')), mkdtempSync(join(TMP, 'bin-'))]
  made.push(linked, other)
  symlinkSync(process.execPath, join(linked, 'node'))
  writeFileSync(join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 })
  assert.deepEqual(
    { found: runningNode([join(TMP, 'missing'), other, linked].join(delimiter)), none: runningNode(other), empty: runningNode(''), relative: runningNode(relative(process.cwd(), linked)) },
    { found: join(linked, 'node'), none: process.execPath, empty: process.execPath, relative: process.execPath },
  )
})

test("mcp add never registers a link to the running Node that lasts one shell or session, like fnm's in fnm_multishells, or one in the temporary folder or XDG_RUNTIME_DIR, which logout clears, but the running Node's own path", { skip: linksTaken }, () => {
  const base = mkdtempSync(join(TMP, 'fnm-'))
  const runtime = mkdtempSync(join(TMP, 'runtime-'))
  const temporary = mkdtempSync(join(tmpdir(), 'threejam-bin-'))
  made.push(base, runtime, temporary)
  // fnm links a folder for each shell to the version's folder, and puts that link's bin first on the PATH.
  mkdirSync(join(base, 'installation', 'bin'), { recursive: true })
  symlinkSync(process.execPath, join(base, 'installation', 'bin', 'node'))
  mkdirSync(join(base, 'fnm_multishells'))
  symlinkSync(join(base, 'installation'), join(base, 'fnm_multishells', '12345_1696000000000'))
  for (const folder of [runtime, temporary]) symlinkSync(process.execPath, join(folder, 'node'))
  const shell = join(base, 'fnm_multishells', '12345_1696000000000', 'bin')
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = runtime
  try {
    assert.deepEqual(
      { fnm: runningNode(shell), runtime: runningNode(runtime), temporary: runningNode(temporary), lasting: runningNode([shell, join(base, 'installation', 'bin')].join(delimiter)) },
      { fnm: process.execPath, runtime: process.execPath, temporary: process.execPath, lasting: join(base, 'installation', 'bin', 'node') },
    )
  } finally {
    if (runtimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = runtimeDir
  }
})

test("mcp add registers plain node for a snap's Node, whose folder is one revision's, which snapd removes a few refreshes later, while node on the PATH starts the snap's launcher", () => {
  assert.equal(runningNode('/snap/bin', '/snap/node/123/bin/node'), 'node')
  assert.equal(mcpCommand({ cli: '/work/threejam/src/cli.ts', version: '1.2.3', node: runningNode('/snap/bin', '/snap/node/123/bin/node') }), 'node /work/threejam/src/cli.ts --mcp')
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

test('sim ends quietly when its reader closes the pipe', async (t) => {
  const child = spawnCli(['sim', 'games/pong', '--ticks', '600', '--every', '1'], t.signal)
  let errors = ''
  child.stderr.on('data', (chunk) => (errors += chunk))
  child.stdout.once('data', () => child.stdout.destroy())
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.deepEqual({ code, errors }, { code: 0, errors: '' })
})

// A Node option that fails a write to stdout with code, once there are as many listeners for that as ThreeJam adds: one in a command, two in the MCP server, whose SDK adds its own.
function failingStdout(code: string, listeners: number): string {
  const dir = mkdtempSync(join(TMP, 'stdout-'))
  made.push(dir)
  const file = join(dir, 'fail.mjs')
  const error = `Object.assign(new Error('write ${code}'), { code: '${code}', syscall: 'write' })`
  writeFileSync(file, `const fail = () => process.stdout.listenerCount('error') < ${listeners} ? setImmediate(fail) : process.stdout.emit('error', ${error})\nsetImmediate(fail)\n`)
  return `--import=${pathToFileURL(file).href}`
}

test('a command and the MCP server end quietly when stdout fails as it does once its reader has closed the pipe, with EPIPE, or with the ENOTCONN macOS or the ECONNRESET Linux gives when the reader closes during the write, and still fail on any other write error', async (t) => {
  // The esbuild that sim starts holds the command's stderr for a moment after the command exits, so its stdout and how it ended tell what happened.
  const command = (code: string) => {
    const env = { ...process.env, NODE_OPTIONS: failingStdout(code, 1) }
    const result = spawnSync(process.execPath, [CLI, 'sim', 'games/pong', '--ticks', '600', '--every', '1'], { cwd: ROOT, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000, killSignal: 'SIGKILL' })
    return { code: result.status, out: result.stdout }
  }
  // The server's stdin stays open, so only the failed write can end it.
  const server = async (code: string) => {
    const child = spawnCli(['--mcp'], t.signal, ROOT, { ...process.env, NODE_OPTIONS: failingStdout(code, 2) })
    let out = ''
    child.stderr.on('data', (chunk) => (out += chunk))
    const closed = new Promise((done) => child.once('close', done))
    return { code: await Promise.race([closed, new Promise((done) => setTimeout(done, 10_000, 'still running').unref())]), out }
  }
  const [serverEPIPE, serverENOTCONN, serverECONNRESET, serverEIO] = await Promise.all([server('EPIPE'), server('ENOTCONN'), server('ECONNRESET'), server('EIO')])
  const quiet = { code: 0, out: '' }
  assert.deepEqual(
    { EPIPE: command('EPIPE'), ENOTCONN: command('ENOTCONN'), ECONNRESET: command('ECONNRESET'), serverEPIPE, serverENOTCONN, serverECONNRESET },
    { EPIPE: quiet, ENOTCONN: quiet, ECONNRESET: quiet, serverEPIPE: quiet, serverENOTCONN: quiet, serverECONNRESET: quiet },
  )
  assert.deepEqual(command('EIO'), { code: 1, out: '' })
  assert.equal(serverEIO.code, 1)
  assert.match(serverEIO.out, /Error: write EIO/)
})
