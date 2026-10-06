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
