import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { sep } from 'node:path'
import { test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { SEEDS_AT_ONCE, Slots, poolSize, usableMemory } from '../src/load.ts'
import { ROOT } from '../src/package.ts'
import { MAX_SEEDS, parseSeeds, summarize, type SeedRow } from '../src/seeds.ts'
import { CLI, mcp } from './children.ts'
import { folder, game } from './games.ts'

// The CLI's JSON reply. stderr is left out, since the esbuild that sim starts holds it a moment after the CLI exits.
async function threejam(signal: AbortSignal, ...args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args, '--format', 'json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], signal, killSignal: 'SIGKILL' })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
  const code = await new Promise<number | null>((done, fail) => child.once('error', fail).once('close', done))
  return { code, json: JSON.parse(out) }
}

// The row --seeds should print for a seed, from what sim --seed printed for it.
function rowFrom(seed: number, { code, json }: Awaited<ReturnType<typeof threejam>>): SeedRow {
  return code === 0 ? { seed, tick: json.tick, reached: json.reached, code: null, message: null } : { seed, tick: null, reached: null, code: json.code, message: json.message }
}

// A driver that moves the left paddle by random numbers of its own, which follow the seed as the game's do.
const JITTER = [
  "import type { Driver } from 'threejam'",
  '',
  "const jitter: Driver = ({ tick, random }) => (tick === 1 ? ['Space'] : random() < 0.5 ? ['W'] : ['S'])",
  'export default jitter',
  '',
].join('\n')

// A game whose first random number decides how a seed goes: below 0.3 it throws at tick 3, with a line break in its message, above 0.9 it loops at tick 4, below 0.65 it reaches x 5 at a tick that depends on that number, and otherwise it's too slow to.
const FATES = [
  "import { defineGame } from 'threejam'",
  '',
  'export default defineGame({',
  '  entities: { ball: { x: 0, y: 0, w: 0.1, h: 0.1, roll: 0 } },',
  '  start(world, ctx) {',
  '    world.ball.roll = ctx.random()',
  '  },',
  '  update(world, ctx) {',
  '    const { roll } = world.ball',
  '    world.ball.x += roll < 0.65 ? roll * 2 : 0.1',
  "    if (ctx.tick === 3 && roll < 0.3) throw new Error('unlucky\\nroll')",
  '    if (ctx.tick === 4 && roll > 0.9) for (;;) {}',
  '  },',
  '})',
  '',
].join('\n')

test('--seeds takes seeds and spans like 0-99 or -10--8, separated by commas, and runs each seed once, in order, up to 10000 of them', () => {
  assert.deepEqual(parseSeeds('0-3'), [0, 1, 2, 3])
  assert.deepEqual(parseSeeds('9, 1,5'), [1, 5, 9])
  assert.deepEqual(parseSeeds('-10--8,-1-1'), [-10, -9, -8, -1, 0, 1])
  assert.deepEqual(parseSeeds('3-6,0-4,6,2'), [0, 1, 2, 3, 4, 5, 6])
  assert.ok(Object.is(parseSeeds('-0')[0], 0))
  assert.equal(parseSeeds(`1-${MAX_SEEDS}`).length, MAX_SEEDS)
  assert.equal(parseSeeds(`5,0-${MAX_SEEDS - 1},0-9`).length, MAX_SEEDS)
  const shape = (part: string) => `"${part}" should be a seed like 7 or a span like 0-99`
  const refused = [
    ['', `--seeds "": ${shape('')}`],
    ['1,,2', `--seeds "1,,2": ${shape('')}`],
    ['30-', `--seeds "30-": ${shape('30-')}`],
    ['1.5', `--seeds "1.5": ${shape('1.5')}`],
    ['0x5', `--seeds "0x5": ${shape('0x5')}`],
    ['1e2', `--seeds "1e2": ${shape('1e2')}`],
    ['99999999999999999999', `--seeds "99999999999999999999": ${shape('99999999999999999999')}`],
    ['0-3,9-4', '--seeds "0-3,9-4": span 9-4 ends before it starts'],
    [`0-${MAX_SEEDS}`, `--seeds "0-${MAX_SEEDS}" names ${MAX_SEEDS + 1} seeds, and one run takes at most ${MAX_SEEDS}; split them into several`],
  ]
  for (const [text, message] of refused) assert.throws(() => parseSeeds(text), new UsageError(message), text)
  // A span is counted before it's spelled out, so the widest one is refused at once.
  assert.throws(() => parseSeeds(`${Number.MIN_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`), /names \d+ seeds, and one run takes at most 10000/)
})

test('the summary counts the seeds, those that reached --until, and those that failed, and gives the min, median, and max of the ticks where it held', () => {
  const ran = (seed: number, tick: number, reached: boolean): SeedRow => ({ seed, tick, reached, code: null, message: null })
  const failed = (seed: number): SeedRow => ({ seed, tick: null, reached: null, code: 'GAME_ERROR', message: 'boom' })
  // The ticks are compared as numbers, and a seed that ran out of ticks or failed has no tick where it held.
  assert.deepEqual(summarize([ran(0, 100, true), failed(1), ran(2, 9, true), ran(3, 600, false), ran(4, 10, true)]), { seeds: 5, reached: 3, failed: 1, min: 9, median: 10, max: 100 })
  // An even count's median is halfway between the two middle ticks.
  assert.deepEqual(summarize([ran(0, 40, true), ran(1, 25, true), ran(2, 31, true), ran(3, 10, true)]), { seeds: 4, reached: 4, failed: 0, min: 10, median: 28, max: 40 })
  assert.equal(summarize([ran(0, 2, true), ran(1, 1, true)]).median, 1.5)
  assert.deepEqual(summarize([ran(0, 600, false), failed(1), failed(2)]), { seeds: 3, reached: 0, failed: 2, min: null, median: null, max: null })
})

test('seeds run as many at once as the machine has threads and as fit in half its memory at 1 GB each, or its cgroup limit when that is lower, and one at least', () => {
  const GB = 2 ** 30
  assert.deepEqual(
    [
      poolSize({ threads: 8, memory: 16 * GB, heap: GB }),
      poolSize({ threads: 8, memory: 6 * GB, heap: GB }),
      poolSize({ threads: 4, memory: 64 * GB, heap: GB }),
      poolSize({ threads: 8, memory: GB, heap: GB }),
    ],
    [8, 3, 4, 1],
  )
  // Node gives 0, or a number past any machine's memory, when the process has no cgroup limit.
  assert.deepEqual([usableMemory(47 * GB, 2 ** 64), usableMemory(47 * GB, 0), usableMemory(47 * GB, 6 * GB)], [47 * GB, 47 * GB, 6 * GB])
})

test("a pool gives a freed place to the runner that has waited longest, and a runner whose call stops leaves the queue", async () => {
  const slots = new Slots(1)
  const going = new AbortController().signal
  const stopping = new AbortController()
  const order: string[] = []
  assert.equal(await slots.take(going), true)
  const waits = [slots.take(going).then((got) => order.push(`first ${got}`)), slots.take(stopping.signal).then((got) => order.push(`stopped ${got}`)), slots.take(going).then((got) => order.push(`last ${got}`))]
  stopping.abort()
  slots.give()
  slots.give()
  // A place given to the wrong runner leaves another waiting for good, so the order is read after a second at most.
  await Promise.race([Promise.all(waits), new Promise((done) => setTimeout(done, 1000).unref())])
  assert.deepEqual(order, ['stopped false', 'first true', 'last true'])
  slots.give()
  assert.equal(await slots.take(going), true)
})

test("each seed's row is what sim --seed prints for that seed, with a driver whose random numbers follow the seed too, and sim suggests rerunning the first seed that didn't reach --until", async (t) => {
  const driver = `${folder({ 'bot.ts': JITTER }).replaceAll(sep, '/')}/bot.ts`
  const args = ['sim', 'games/pong', '--ticks', '600', '--driver', driver, '--until', 'match.right=1']
  const seeds = [-3, -2, -1, 0, 1, 2, 3, 4]
  const [all, ...each] = await Promise.all([threejam(t.signal, ...args, '--seeds', '-3-4'), ...seeds.map((seed) => threejam(t.signal, ...args, '--seed', String(seed)))])
  assert.equal(all.code, 0)
  assert.deepEqual(all.json.seeds, seeds.map((seed, i) => rowFrom(seed, each[i])))
  assert.deepEqual(all.json.summary, { seeds: 8, reached: 4, failed: 0, min: 253, median: 272, max: 503 })
  const rerun = `threejam ${args.join(' ')} --seed -3`
  assert.deepEqual(all.json.cta.commands, [{ command: rerun, description: "Rerun seed -3 alone, the first that didn't reach --until, to print its entities" }])
})

test('a seed whose game throws or runs past --timeout is a row with the code and message sim --seed gives it, while the other seeds run on, each with a time limit of its own, and sim exits 0', async (t) => {
  const dir = folder({ 'game.ts': FATES }).replaceAll(sep, '/')
  const args = ['sim', dir, '--ticks', '10', '--until', 'ball.x>=5', '--timeout', '1']
  const seeds = [0, 1, 2, 3, 4, 5, 6, 7]
  const [all, ...each] = await Promise.all([threejam(t.signal, ...args, '--seeds', '0-7'), ...seeds.map((seed) => threejam(t.signal, ...args, '--seed', String(seed)))])
  const rows = seeds.map((seed, i) => rowFrom(seed, each[i]))
  assert.deepEqual({ code: all.code, rows: all.json.seeds }, { code: 0, rows })
  assert.deepEqual(rows.map((row) => row.code ?? row.reached), ['TIMEOUT', 'TIMEOUT', 'GAME_ERROR', false, true, true, 'GAME_ERROR', false])
  assert.equal(rows[2].message, `${dir}/game.ts:11: unlucky roll (in update at tick 3)`)
  assert.deepEqual(all.json.summary, { seeds: 8, reached: 2, failed: 4, min: 5, median: 5.5, max: 6 })
  const rerun = `threejam sim ${dir} --ticks 10 --until 'ball.x>=5' --timeout 1 --seed 0`
  assert.deepEqual(all.json.cta.commands, [{ command: rerun, description: 'Rerun seed 0 alone, the first that failed' }])
})

test("the suggested command reruns the first seed that failed, or else the first that didn't reach --until, even when that isn't the first seed", async (t) => {
  const dir = folder({ 'game.ts': FATES }).replaceAll(sep, '/')
  const args = ['sim', dir, '--ticks', '10', '--until', 'ball.x>=5']
  // Seeds 3 and 7 don't reach, 4 and 5 do, and 6 throws.
  const [failing, missing] = await Promise.all([threejam(t.signal, ...args, '--seeds', '3-7'), threejam(t.signal, ...args, '--seeds', '4,5,7')])
  assert.deepEqual([failing.json.cta.commands, missing.json.cta.commands], [
    [{ command: `threejam sim ${dir} --ticks 10 --until 'ball.x>=5' --seed 6`, description: 'Rerun seed 6 alone, the first that failed' }],
    [{ command: `threejam sim ${dir} --ticks 10 --until 'ball.x>=5' --seed 7`, description: "Rerun seed 7 alone, the first that didn't reach --until, to print its entities" }],
  ])
})

test("a seed whose one run would print past the sandbox's 64 MB cap still gets its row, since a row prints no entities, log, or sounds", async (t) => {
  const dir = folder({ 'game.ts': game({ update: "world.ball.x += 1\n    ctx.print('x'.repeat(1_000_000))" }) })
  const args = ['sim', dir, '--ticks', '80', '--until', 'ball.x>=70']
  const [one, all] = await Promise.all([threejam(t.signal, ...args, '--seed', '2'), threejam(t.signal, ...args, '--seeds', '2')])
  assert.deepEqual([one.json.code, all.json.seeds], ['OUTPUT_TOO_LARGE', [{ seed: 2, tick: 70, reached: true, code: null, message: null }]])
})

test("a game that breaks what the sandbox sends its run back with fails that seed's row, not the whole call", async (t) => {
  // Seeds 2, 4, and 6 first roll below 0.5, and replace JSON.stringify in their first tick.
  const dir = folder({ 'game.ts': game({ update: "world.ball.x += 1\n    if (ctx.tick === 1 && ctx.random() < 0.5) JSON.stringify = () => { throw new Error('no') }" }) })
  const all = await threejam(t.signal, 'sim', dir, '--ticks', '3', '--seeds', '0-7')
  const lost = "the sandbox couldn't send the run back: the game changed built-in objects that ThreeJam's engine uses"
  assert.equal(all.code, 0)
  assert.deepEqual(all.json.seeds.map((row: SeedRow) => row.message), [null, null, lost, null, lost, null, lost, null])
})

test('a seed whose game keeps more than the 1 GB a sandbox may grow to gets the GAME_ERROR that one run gives, since each seed has the same heap limit', async (t) => {
  // 8 MB more every tick: 1.6 GB by tick 200, which V8's own limit would allow on a machine with 16 GB.
  const leak = game({ update: 'world.ball.x = ctx.tick\n    kept.push(new Array(1_000_000).fill(ctx.tick + 0.5))' })
  const dir = folder({ 'game.ts': leak.replace("from 'threejam'\n", "from 'threejam'\n\nconst kept: number[][] = []\n") })
  const all = await threejam(t.signal, 'sim', dir, '--ticks', '200', '--seeds', '3')
  const message = 'the game ran out of memory; look for a list or a loop that keeps growing'
  assert.deepEqual(all.json.seeds, [{ seed: 3, tick: null, reached: null, code: 'GAME_ERROR', message }])
})

test('flags that are wrong for every seed fail the whole call with USAGE once a seed finds them, ending the seeds still looping instead of waiting out their time limits', async (t) => {
  // Seeds 3, 5, and 7 loop in their first tick, so only seeds 2, 4, and 6 get to check --until, which names a field the ball lacks.
  const dir = folder({ 'game.ts': game({ update: 'if (ctx.random() > 0.5) for (;;) {}' }) })
  const limit = AbortSignal.any([t.signal, AbortSignal.timeout(30_000)])
  const { code, json } = await threejam(limit, 'sim', dir, '--ticks', '10', '--until', 'ball.nope=1', '--timeout', '600', '--seeds', '2-7')
  assert.deepEqual({ code, json }, { code: 1, json: { code: 'USAGE', message: '--until "ball.nope=1": entity "ball" has no field "nope"' } })
})

test('sim refuses --seed, --only, --fields, --every, and --exact beside --seeds, and a malformed --seeds, before it builds the game', async (t) => {
  const broken = folder({ 'game.ts': game({ update: 'world.ball.x += ;' }) })
  const printing = 'chooses what one run prints, and --seeds prints a row for each seed instead; rerun one seed with --seed to print its entities'
  const cases: Array<[string[], string]> = [
    [['--seeds', '0-3', '--seed', '1'], 'use --seed for one run or --seeds for several, not both'],
    [['--seeds', '0-3', '--only', 'ball'], `--only ${printing}`],
    [['--seeds', '0-3', '--fields', 'x'], `--fields ${printing}`],
    [['--seeds', '0-3', '--every', '2'], `--every ${printing}`],
    [['--seeds', '0-3', '--exact'], `--exact ${printing}`],
    [['--seeds', '3-1'], '--seeds "3-1": span 3-1 ends before it starts'],
  ]
  const replies = await Promise.all(cases.map(([flags]) => threejam(t.signal, 'sim', broken, '--ticks', '5', ...flags)))
  assert.deepEqual(replies, cases.map(([, message]) => ({ code: 1, json: { code: 'USAGE', message } })))
})

test('as an MCP tool, sim takes seeds and replies with the same rows and summary, and refuses at once seeds whose rows could never fit in a reply', async (t) => {
  const driver = `${folder({ 'bot.ts': JITTER }).replaceAll(sep, '/')}/bot.ts`
  const loop = folder({ 'game.ts': game({ update: 'for (;;) {}' }) })
  const server = mcp(t.signal)
  try {
    await server.ready
    const call = (args: object) => server.request('tools/call', { name: 'sim', arguments: args })
    const reply = await call({ dir: 'games/pong', ticks: 600, driver, until: 'match.right=1', seeds: '-3-4' })
    const [data, suggested] = (reply.result?.content?.[0]?.text ?? '').split('\n\n')
    const { seeds, summary } = JSON.parse(data)
    assert.deepEqual(seeds.map((row: SeedRow) => [row.seed, row.reached]), [[-3, false], [-2, true], [-1, true], [0, false], [1, true], [2, false], [3, false], [4, true]])
    assert.deepEqual(summary, { seeds: 8, reached: 4, failed: 0, min: 253, median: 272, max: 503 })
    assert.match(suggested, / --seed -3 - Rerun seed -3 alone/)
    // Every seed of this game would loop for 600 s, so a reply in time means none ran.
    const blocked = new Promise<'blocked'>((done) => setTimeout(done, 30_000, 'blocked').unref())
    const big = await Promise.race([call({ dir: loop, ticks: 1, timeout: 600, seeds: '0-1999' }), blocked])
    const text = 'OUTPUT_TOO_LARGE: --seeds "0-1999" names 2000 seeds, whose rows make a reply of at least 128901 characters, and an MCP reply holds at most 100000; run fewer seeds at a time'
    assert.deepEqual(big === 'blocked' ? big : big.result, { content: [{ type: 'text', text }], isError: true })
  } finally {
    server.close()
  }
})

test("as an MCP tool, calls at once share one pool of seeds, so two calls that each fill it end no sooner than their seeds can one after the other", async (t) => {
  const loop = folder({ 'game.ts': game({ update: 'for (;;) {}' }) })
  const server = mcp(t.signal)
  try {
    await server.ready
    // Every seed loops until its 0.5 s time limit, so with one pool the later call's last seed can't end before 1 s, where pools of their own would end both in about 0.6 s.
    const args = { dir: loop, ticks: 1, timeout: 0.5, seeds: `0-${SEEDS_AT_ONCE - 1}` }
    const started = Date.now()
    const ended = await Promise.all([1, 2].map(() => server.request('tools/call', { name: 'sim', arguments: args }).then((reply) => [JSON.parse(reply.result?.content?.[0]?.text.split('\n\n')[0] ?? '{}').summary?.failed, Date.now() - started])))
    assert.deepEqual(ended.map(([failed]) => failed), [SEEDS_AT_ONCE, SEEDS_AT_ONCE])
    assert.ok(Math.max(...ended.map(([, ms]) => ms)) >= 900, `the calls ended ${ended.map(([, ms]) => ms).join(' and ')} ms in`)
  } finally {
    server.close()
  }
})

test('as an MCP tool, sim stops a call once its rows pass the reply limit, whether one long row does or many short ones, ending the seeds still looping, and the server answers the next call', async (t) => {
  // Seed 0 throws a message longer than a reply holds, and seeds 1 to 7 loop for 600 s in their first tick.
  const long = folder({ 'game.ts': game({ update: "if (ctx.random() > 0.93) throw new Error('x'.repeat(150_000))\n    for (;;) {}" }) })
  const short = folder({ 'game.ts': game({ update: "throw new Error('e'.repeat(20_000))" }) })
  const server = mcp(t.signal)
  try {
    await server.ready
    const call = (args: object) => server.request('tools/call', { name: 'sim', arguments: args })
    const blocked = new Promise<'blocked'>((done) => setTimeout(done, 30_000, 'blocked').unref())
    const stopped = (seeds: string) => ({
      content: [{ type: 'text', text: `OUTPUT_TOO_LARGE: the rows of --seeds "${seeds}" pass the 100000 characters an MCP reply holds, so sim stopped the seeds still running; run fewer seeds at a time` }],
      isError: true,
    })
    const one = await Promise.race([call({ dir: long, ticks: 1, timeout: 600, seeds: '0-7' }), blocked])
    assert.deepEqual(one === 'blocked' ? one : one.result, stopped('0-7'))
    const many = await call({ dir: short, ticks: 3, seeds: '0-99' })
    assert.deepEqual(many.result, stopped('0-99'))
    // The CLI never cuts its output, so the same rows all print there.
    const printed = await threejam(t.signal, 'sim', short, '--ticks', '3', '--seeds', '0-9')
    assert.deepEqual([printed.code, printed.json.seeds.length, printed.json.summary.failed], [0, 10, 10])
    const next = await call({ dir: 'games/pong', ticks: 1, only: 'match', fields: 'state' })
    assert.equal(next.result?.content?.[0]?.text.split('\n\n')[0], JSON.stringify({ tick: 1, entities: [{ name: 'match', state: 'ready' }] }))
  } finally {
    server.close()
  }
})
