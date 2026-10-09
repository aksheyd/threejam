import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import pong from '../games/pong/game.ts'
import { commandLineRefusal } from '../src/commandline.ts'
import { simulate } from '../src/engine.ts'
import { crashed, describe } from '../src/load.ts'
import { ENGINE, NAME, ROOT, VERSION } from '../src/package.ts'
import { playtestSource } from '../src/playtest.ts'
import { findChrome } from '../src/serve.ts'
import { callLimit, framePaths } from '../src/shot.ts'
import { CLI, spawnCli, threejam, threejamWith } from './children.ts'
import { TMP, folder, game, made } from './games.ts'

test('check passes Pong, and sim prints exact state as JSON with the chosen fields', () => {
  assert.deepEqual(threejam('check', 'games/pong'), { code: 0, out: 'ok: true\nentities: 10\n' })
  const args = ['--ticks', '60', '--press', 'Space@1', '--hold', 'W@1-30', '--only', 'left_paddle', '--fields', 'y', '--format', 'json']
  const { code, out } = threejam('sim', 'games/pong', ...args)
  assert.equal(code, 0, out)
  assert.deepEqual(JSON.parse(out).entities, [{ name: 'left_paddle', y: 1.1 }])
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

test("what incur would refuse with codes of its own, a misspelled command, a subcommand or shell incur lacks, a flag before the command, and a bad value for one of incur's flags, fails as USAGE in ThreeJam's words, while help, the version, and completions still print", () => {
  const commands = 'new, check, sim, shot, run, export, mcp, skills, and completions'
  const refused: ReadonlyArray<readonly [readonly string[], string]> = [
    [['siim', 'games/pong'], `threejam has no command "siim"; did you mean sim? Its commands are ${commands}`],
    [['nope'], `threejam has no command "nope"; its commands are ${commands}`],
    [['threejam', 'sim', 'games/pong'], `threejam has no command "threejam"; its commands are ${commands}`],
    [['--seed', '5', 'sim', 'games/pong'], `threejam takes its command first, before "--seed"; its commands are ${commands}`],
    [['mcp', 'ad'], 'mcp has no command "ad"; did you mean add? Its commands are add and doctor'],
    [['skills', 'nope'], 'skills has no command "nope"; its commands are add and list'],
    [['completions', 'powershell'], 'completions takes bash, fish, nushell, or zsh, not "powershell"'],
    [['sim', 'games/pong', '--ticks', '1', '--format', 'xml'], '--format: expected toon, json, yaml, md, or jsonl, got "xml"'],
    [['sim', 'games/pong', '--ticks', '1', '--token-limit', 'many'], '--token-limit: expected a number, got "many"'],
  ]
  for (const [args, message] of refused) {
    const { code, out } = threejam(...args, '--json')
    assert.deepEqual({ code, failure: JSON.parse(out) }, { code: 1, failure: { code: 'USAGE', message } }, args.join(' '))
  }
  assert.match(threejam('siim', '--help').out, /^threejam@\S+ — /)
  assert.deepEqual(threejam('siim', '--version'), { code: 0, out: `${VERSION}\n` })
  assert.match(threejam('completions', 'bash').out, /complete/)
})

test("a shell's tab completion, which calls back as COMPLETE=bash threejam -- threejam si, gets sim, as incur gives it", () => {
  const { code, out } = threejamWith({ COMPLETE: 'bash', _COMPLETE_INDEX: '1' }, '--', NAME, 'si')
  assert.deepEqual({ code, candidates: out.split('\v') }, { code: 0, candidates: ['sim'] })
})

test("every command, built-in, subcommand, alias, shell, and global flag that incur's own help and manifest list gets past the check ThreeJam makes before incur reads the command line", () => {
  // The rows of a help section, like Commands:, each a name, or flags, and a description.
  const rows = (help: string, title: string) => {
    const start = help.split('\n').indexOf(`${title}:`)
    assert.notEqual(start, -1, `help has no ${title} section: ${help}`)
    const lines = help.split('\n').slice(start + 1)
    return lines.slice(0, lines.indexOf('')).map((line) => line.trim().split(/ {2,}/)[0])
  }
  const passes = (...words: string[]) => assert.equal(commandLineRefusal(words), undefined, words.join(' '))
  const { commands } = JSON.parse(threejam('--llms-full', '--format', 'json').out)
  for (const { name, schema } of commands) {
    passes(name, 'games/pong')
    for (const option of Object.keys(schema.options?.properties ?? {})) passes(name, 'games/pong', `--${option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, '1')
  }
  const root = threejam('--help').out
  for (const row of rows(root, 'Integrations')) {
    const help = threejam(row, '--help').out
    const names = [row, ...(/^Aliases: (.+)$/m.exec(help)?.[1].split(', ') ?? [])]
    const usage = /^Usage: \S+ \S+ <([^>]+)>$/m.exec(help)?.[1] ?? ''
    const takes = usage === 'command' ? rows(help, 'Commands') : usage.split('|')
    for (const name of names) for (const next of [undefined, ...takes]) for (const words of [[name], [NAME, name]]) passes(...words, ...(next === undefined ? [] : [next]))
  }
  // Each global flag goes before the command, where the check would take one it doesn't know for the command, with a value for its placeholder, then a flag, which is how incur tells --version from a command's own.
  const values: Readonly<Record<string, string>> = { n: '5', keys: 'log' }
  for (const row of rows(root, 'Global Options')) {
    const placeholder = /<([^>]+)>$/.exec(row)?.[1]
    const value = placeholder === undefined ? [] : [values[placeholder] ?? placeholder.split('|')[0]]
    for (const flag of row.split(/, | <[^>]*>$/).filter((part) => part.startsWith('--'))) passes(flag, ...value, '--format', 'toon', 'sim', 'games/pong', '--ticks', '1')
  }
})

test("--help names the value of every number flag <number>, as the manifest's types say, and no flag's value <value>", () => {
  const { commands } = JSON.parse(threejam('--llms-full', '--format', 'json').out)
  for (const { name, schema } of commands) {
    const help = threejam(name, '--help').out
    assert.doesNotMatch(help, /<value>/, `${name} --help`)
    const properties: Record<string, { type?: string }> = schema.options?.properties ?? {}
    const numbers = Object.entries(properties).filter(([, { type }]) => type === 'number' || type === 'integer').map(([key]) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <number>`)
    assert.deepEqual([...help.matchAll(/^ {2}(--[a-z-]+ <number>)/gm)].map((match) => match[1]), numbers, `${name} --help`)
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
  const command = (code: string) => {
    const env = { ...process.env, NODE_OPTIONS: failingStdout(code, 1) }
    const result = spawnSync(process.execPath, [CLI, 'sim', 'games/pong', '--ticks', '600', '--every', '1'], { cwd: ROOT, encoding: 'utf8', env, timeout: 60_000, killSignal: 'SIGKILL' })
    return { code: result.status, out: result.stdout + result.stderr }
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
  const commandEIO = command('EIO')
  assert.equal(commandEIO.code, 1)
  assert.match(commandEIO.out, /Error: write EIO/)
  assert.equal(serverEIO.code, 1)
  assert.match(serverEIO.out, /Error: write EIO/)
})
