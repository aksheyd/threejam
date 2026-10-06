import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ROOT } from '../src/package.ts'
import { shoot } from '../src/shot.ts'
import { CHROME as chrome } from './chrome.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

test('shot repeats a frame byte for byte on one machine, images and text included', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-shot-'))
  try {
    const driver = join('games', 'asteroids', 'autopilot.ts')
    const shots = await Promise.all(['one', 'two'].map((name) => shoot({ dir: 'games/asteroids', at: [120], driver, out: join(dir, name, 'frame.png') })))
    const [first, second] = shots.map(([file]) => readFileSync(file))
    assert.ok(first.equals(second), 'two shots of one run differ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a page that fails in shot is the game's failure, told in one line without the page's stack or the server's address", { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(TMP, 'broken-'))
  made.push(dir)
  writeFileSync(join(dir, 'game.ts'), "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { rock: { w: 1, h: 1, image: 'rock.png' } }, update() {} })\n")
  writeFileSync(join(dir, 'rock.png'), 'not a png')
  await assert.rejects(shoot({ dir, at: [1], out: join(dir, 'frame.png') }), {
    name: 'GameError',
    message: "the page failed: the image rock.png couldn't be loaded; check that the file is a whole image of its type",
  })
})

test("shot's page gets --timeout too, from the moment it loads, so a view.ts that never returns fails with TIMEOUT and Chrome is killed", { skip: !chrome && 'needs Chrome' }, async () => {
  const stuck = async (view: string, timeout: number, when: string) => {
    const dir = mkdtempSync(join(TMP, 'stuck-'))
    made.push(dir)
    writeFileSync(join(dir, 'game.ts'), "import { defineGame } from 'threejam'\n\nexport default defineGame({ entities: { dot: { w: 0.1, h: 0.1 } }, update() {} })\n")
    writeFileSync(join(dir, 'view.ts'), view)
    const started = Date.now()
    await assert.rejects(shoot({ dir, at: [1, 2], out: join(dir, 'frame.png'), timeout }), {
      name: 'LimitError',
      message: `the page ran past the ${timeout} s time limit ${when}; look for a loop that never ends in view.ts, or allow more time with --timeout`,
    })
    // The page uses up the whole limit first, so a graceful close, which waits up to 10 s on a stuck page, can't finish under this on any machine.
    const took = Date.now() - started
    assert.ok(took < (timeout + 10) * 1000, `shot took ${took} ms with a page stuck ${when}`)
  }
  // The page never finishes loading, so the limit runs out as it loads however fast the machine is.
  await stuck('for (;;) {}\n', 2, 'as it loaded')
  // Loading and drawing tick 1 take well under this even on a slow machine, so the limit runs out at tick 2.
  await stuck("import type { ViewFrame } from 'threejam'\n\nexport function draw({ tick }: ViewFrame): void {\n  if (tick === 2) for (;;) {}\n}\n", 15, 'drawing tick 2')
})

test('shot writes one PNG per tick into a folder it creates', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-shot-'))
  try {
    const files = await shoot({ dir: 'games/pong', at: [1, 30], out: join(dir, 'new', 'frame.png') })
    assert.deepEqual(files, [join(dir, 'new', 'frame-001.png'), join(dir, 'new', 'frame-030.png')])
    for (const file of files) assert.equal(readFileSync(file).toString('latin1', 1, 4), 'PNG')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
