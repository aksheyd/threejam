import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { ROOT } from '../src/package.ts'
import { threejam, threejamWith } from './children.ts'
import { folder, game, slowCheck } from './games.ts'

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
