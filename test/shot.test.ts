import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { ROOT } from '../src/package.ts'
import { shoot } from '../src/shot.ts'
import { CHROME as chrome } from './chrome.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

test('shot repeats a frame byte for byte on one machine, text included, from a view that draws the game in 3D with lights and shadows', { skip: !chrome && 'needs Chrome' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejam-shot-'))
  try {
    // A slow macOS runner took about 26 s for two shots of Racer's lit, shadowed page at once, near the 30 s shot gives a page by default; this test is about frames that repeat, not how fast they draw.
    const driver = join('games', 'racer', 'autopilot.ts')
    const shots = await Promise.all(['one', 'two'].map((name) => shoot({ dir: 'games/racer', at: [600], driver, out: join(dir, name, 'frame.png'), timeout: 90 })))
    const [first, second] = shots.map(([file]) => readFileSync(file))
    assert.ok(first.equals(second), 'two shots of one run of Racer differ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

type Rgb = readonly [number, number, number]

// An RGBA PNG with a pixel for each character of rows, in the color colors gives it, or clear for any other.
function png(rows: readonly string[], colors: Readonly<Record<string, Rgb>>): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const framed = Buffer.alloc(body.length + 8)
    framed.writeUInt32BE(data.length, 0)
    body.copy(framed, 4)
    framed.writeUInt32BE(crc32(body), body.length + 4)
    return framed
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(rows[0].length, 0)
  header.writeUInt32BE(rows.length, 4)
  header.set([8, 6], 8)
  const lines = rows.map((row) => Buffer.from([0, ...[...row].flatMap((pixel) => (Object.hasOwn(colors, pixel) ? [...colors[pixel], 255] : [0, 0, 0, 0]))]))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(lines))), chunk('IEND', Buffer.alloc(0))])
}

// A rock as an SVG, a stroked polygon with a crater, whose edges the page smooths as it draws the SVG on a canvas.
const ROCK = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><polygon points="96,50 73,9 32,19 2,50 28,88 73,91" fill="#3b3b46" stroke="#d0d0dc" stroke-width="4" stroke-linejoin="round"/><circle cx="62" cy="64" r="9" fill="#2a2a33" stroke="#7d7d8c" stroke-width="3"/></svg>'

// Four entities draw the image first, plainly, tinted, cut to a circle, and turned and faded, and from tick 1 the plain one draws the image then, beside the rock turned a little; head is code that comes before the game.
function pictures({ head = [], sprites, first, then }: { head?: readonly string[]; sprites: string; first: string; then: string }): string {
  return [
    "import { defineGame } from 'threejam'",
    '',
    ...head,
    'export default defineGame({',
    "  background: '#336699',",
    `  sprites: ${sprites},`,
    '  entities: {',
    `    plain: { x: -1.2, y: 0.7, w: 0.8, h: 0.8, image: '${first}' },`,
    `    tinted: { x: 0, y: 0.7, w: 0.8, h: 0.8, image: '${first}', color: '#00ffff' },`,
    `    round: { x: 1.2, y: 0.7, w: 0.8, h: 0.8, image: '${first}', shape: 'circle' },`,
    `    turned: { x: 0, y: -0.7, w: 0.8, h: 0.8, image: '${first}', angle: 0.5, opacity: 0.5 },`,
    "    rock: { x: 1.2, y: -0.7, w: 0.8, h: 0.8, image: 'rock.svg', angle: 0.3 },",
    '  },',
    '  update({ plain }) {',
    `    plain.image = '${then}'`,
    '  },',
    '})',
    '',
  ].join('\n')
}

// Sprites named wall_0 and on, each 256 by 256 with every pixel lit, in two colors that take turns from one pixel to the next.
function walls(count: number): string[] {
  return [
    "const wall = { rows: Array.from({ length: 256 }, (_, row) => (row % 2 ? 'rb' : 'br').repeat(128)), palette: { r: '#ff0000', b: '#0000ff' } }",
    `const walls = Object.fromEntries(Array.from({ length: ${count} }, (_, i) => [\`wall_\${i}\`, wall]))`,
    '',
  ]
}

test("shot draws a sprite as it draws a PNG of the same pixels, and an SVG beside them, byte for byte on every run, paints nearly as many pixels as a game's sprites may have in a small part of a shot's time, and refuses one pixel more", { skip: !chrome && 'needs Chrome' }, async (t) => {
  const colors: Readonly<Record<string, Rgb>> = { r: [255, 0, 0], o: [255, 136, 0], g: [51, 255, 51], b: [0, 0, 255], w: [255, 255, 255] }
  const art = ['r.oo.b', '.r..b.', 'g.wb.g', 'g.bw.g', '.b..r.', 'b.oo.r']
  const changed = [art[0].replace('.', 'g'), ...art.slice(1)]
  const hex = (rgb: Rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  const palette = Object.fromEntries(Object.entries(colors).map(([pixel, rgb]) => [pixel, hex(rgb)]))
  const small = `art: ${JSON.stringify({ rows: art, palette })}, changed: ${JSON.stringify({ rows: changed, palette })}`
  // 63 walls, as many as fit in a game's sprites beside the two small ones.
  const sprites = folder({ 'game.ts': pictures({ head: walls(63), sprites: `{ ...walls, ${small} }`, first: 'art', then: 'changed' }), 'rock.svg': ROCK })
  const files = folder({ 'game.ts': pictures({ sprites: 'undefined', first: 'art.png', then: 'changed.png' }), 'art.png': png(art, colors), 'changed.png': png(changed, colors), 'rock.svg': ROCK })
  const over = folder({ 'game.ts': ["import { defineGame } from 'threejam'", '', ...walls(64), "export default defineGame({ sprites: { ...walls, dot: { rows: ['#'] } }, entities: { wall: { w: 2, h: 2, image: 'wall_63' } }, update() {} })", ''].join('\n') })
  const out = folder({})
  const message = 'the page failed: sprite "dot" brings the game\'s sprites to 4194305 pixels, but a game\'s sprites may have 4194304 in all, as many as 64 sprites of 256 by 256'
  const started = Date.now()
  const [paths] = await Promise.all([shoot({ dir: files, at: [0, 1], out: join(out, 'files', 'frame.png') }), assert.rejects(shoot({ dir: over, at: [0], out: join(out, 'over.png') }), { name: 'GameError', message })])
  const whole = Date.now() - started
  // Painting the walls a pixel at a time takes software rendering over 30 s, and in one ImageData a fraction of a second, so their page gets three times as long as the two shots above, which paint nothing, and at least 15 s, since load can start after those shots.
  const timeout = Math.max(15, Math.ceil((3 * whole) / 1000))
  t.diagnostic(`whole shots of the pictures from PNG files and of the sprites one pixel over took ${whole} ms, so the page that paints the walls gets a time limit of ${timeout} s`)
  const shots = await Promise.all(['one', 'two'].map((name) => shoot({ dir: sprites, at: [0, 1], out: join(out, name, 'frame.png'), timeout })))
  const [first, again, drawn] = [...shots, paths].map((frames) => frames.map((path) => readFileSync(path)))
  assert.ok(first[0].equals(again[0]) && first[1].equals(again[1]), 'two shots of one run differ')
  assert.ok(first[0].equals(drawn[0]) && first[1].equals(drawn[1]), 'a sprite draws otherwise than a PNG of its pixels')
  assert.ok(!first[0].equals(first[1]), 'a sprite with a pixel changed drew the same frame')
})

function folder(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(TMP, 'pictures-'))
  made.push(dir)
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data)
  return dir
}

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
