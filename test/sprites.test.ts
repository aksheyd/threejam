import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSprites } from '../src/assets.ts'
import { UsageError } from '../src/errors.ts'
import { Session, defineGame, simulate, type Entities, type Sprites } from '../src/index.ts'

test("a sprite is its rows, as wide as its first, and its palette, which colors # white unless the sprite gives one", () => {
  const sprites = parseSprites({
    heart: { rows: ['.#.#.', '#####', '.###.', '..#..'] },
    coin: { rows: ['.oo.', 'oyyo'], palette: { o: 'orange', y: '#ff0' } },
    clear: { rows: ['..'], palette: {} },
  })
  assert.deepEqual(
    [...sprites].map(([name, { width, rows, palette }]) => [name, width, rows, [...palette]]),
    [
      ['heart', 5, ['.#.#.', '#####', '.###.', '..#..'], [['#', '#ffffff']]],
      ['coin', 4, ['.oo.', 'oyyo'], [['o', 'orange'], ['y', '#ff0']]],
      ['clear', 2, ['..'], []],
    ],
  )
  assert.equal(parseSprites(undefined).size, 0)
  const largest = parseSprites({ wall: { rows: Array.from({ length: 256 }, () => '#'.repeat(256)) } }).get('wall')
  assert.deepEqual([largest?.width, largest?.rows.length], [256, 256])
})

test('a sprite with ragged rows, a character its palette lacks, a bad size, or a bad palette fails, naming the sprite, the row, and what it may hold', () => {
  const cases: Array<[string, unknown, string]> = [
    ['ragged rows', { rows: ['.#.', '##', '###'] }, 'sprite "ship": rows[1] has 2 pixels, but rows[0] has 3, and every row must have the same number'],
    ['a character the palette lacks', { rows: ['.#.', '#o#'] }, 'sprite "ship": rows[1][1] is "o", which isn\'t "." or in its palette, which has "#"'],
    ['a character an empty palette lacks', { rows: ['.#'], palette: {} }, 'sprite "ship": rows[0][1] is "#", which isn\'t "." or in its palette, which has none'],
    ['no rows', { rows: [] }, 'sprite "ship" has 0 rows; a sprite has 1 to 256'],
    ['too many rows', { rows: Array.from({ length: 257 }, () => '#') }, 'sprite "ship" has 257 rows; a sprite has 1 to 256'],
    ['an empty first row', { rows: ['', ''] }, 'sprite "ship": rows[0] has 0 pixels; a row has 1 to 256'],
    ['too long a row', { rows: ['#'.repeat(257)] }, 'sprite "ship": rows[0] has 257 pixels; a row has 1 to 256'],
    ['rows that are one string', { rows: '.#.' }, 'sprite "ship": rows must be an array of strings, one for each row of pixels, like [\'.#.\', \'###\'], got ".#."'],
    ['a row that is a number', { rows: ['#', 5, '#'] }, 'sprite "ship": rows[1] is 5, but each row is a string of pixels'],
    ['the rows alone', ['.#.', '###'], 'sprite "ship" must be an object with rows, like { rows: [\'.#.\', \'###\'] }, not the rows alone'],
    ['a palette that is one color', { rows: ['#'], palette: 'red' }, 'sprite "ship": palette must map characters to colors, like { \'#\': \'white\', o: \'orange\' }, got "red"'],
    ['a color the page has no name for', { rows: ['#'], palette: { '#': 'blurple' } }, 'sprite "ship": palette["#"] must be a CSS color like "#ff8800" or "orange", got "blurple"'],
    ['a palette key of two characters', { rows: ['#'], palette: { '#': 'red', ab: 'blue' } }, 'sprite "ship": palette has "ab", but each of its keys is one character from ! to ~'],
    ['a palette key that is a space', { rows: ['#'], palette: { ' ': 'blue' } }, 'sprite "ship": palette has " ", but each of its keys is one character from ! to ~'],
    ['a palette that colors the see-through pixel', { rows: ['#'], palette: { '.': 'black' } }, 'sprite "ship": palette can\'t give "." a color, since "." shows what\'s behind'],
    ['a misspelled field', { rows: ['#'], pallete: { '#': 'red' } }, 'sprite "ship" has no field "pallete"; a sprite\'s fields are rows and palette'],
  ]
  for (const [name, sprite, message] of cases) assert.throws(() => parseSprites({ ship: sprite }), { name: 'GameError', message }, name)
  assert.throws(() => parseSprites({ 'ship.png': { rows: ['#'] } }), { message: 'sprite "ship.png": name it without a dot, like "ship", since image reads a name with a dot as a file\'s' })
  assert.throws(() => parseSprites({ '': { rows: ['#'] } }), { message: 'sprites can\'t have one named "", which image takes for none' })
  assert.throws(() => parseSprites([{ rows: ['#'] }]), { message: "sprites must be an object that maps names to sprites, like { ship: { rows: ['.#.', '###'] } }, got an array" })
})

test("a game's sprites have at most 4194304 pixels in all, as many as 64 sprites of 256 by 256, and the sprite that passes that is named", () => {
  const wall = { rows: Array.from({ length: 256 }, () => '#'.repeat(256)) }
  const most = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`wall_${i}`, wall]))
  assert.equal(parseSprites(most).size, 64)
  const message = 'sprite "dot" brings the game\'s sprites to 4194305 pixels, but a game\'s sprites may have 4194304 in all, as many as 64 sprites of 256 by 256'
  assert.throws(() => parseSprites({ ...most, dot: { rows: ['#'] } }), { name: 'GameError', message })
  assert.throws(() => new Session(defineGame({ sprites: { ...most, dot: { rows: ['#'] } }, entities: {}, update() {} })), { message })
})

test("an image names a sprite the game declares as it names a file in the game's folder, checked where it's declared, assigned, or set", () => {
  const sprites = { ship: { rows: ['.#.', '###'] }, rock: { rows: ['##', '##'] } } satisfies Sprites
  const entities = { ship: { w: 0.5, h: 0.5, image: 'ship' }, tile: { image: 'tile.png' } } satisfies Entities
  const assets = ['tile.png']
  const game = defineGame({ sprites, entities, update: ({ ship }) => void (ship.image = 'rock') })
  const session = new Session(game, { assets })
  session.start()
  session.step([])
  assert.deepEqual(
    session.drawables().map((drawable) => (drawable.kind === 'shape' ? [drawable.name, drawable.image] : [])),
    [
      ['ship', 'rock'],
      ['tile', 'tile.png'],
    ],
  )
  const assigning = (image: string) => () => simulate(defineGame({ sprites, entities, update: ({ ship }) => void (ship.image = image) }), { ticks: 1, assets })
  assert.throws(assigning('boat'), /entity "ship": no sprite "boat" in the game's sprites, which are ship, rock$/)
  assert.throws(assigning('tile'), /no sprite "tile" in the game's sprites/)
  const declaring = (game: { sprites?: Sprites }) => () => new Session(defineGame({ ...game, entities: { ship: { image: 'ship' } }, update() {} }))
  assert.throws(declaring({ sprites: { boat: { rows: ['#'] } } }), /entity "ship": no sprite "ship" in the game's sprites, which are boat$/)
  assert.throws(declaring({}), /entity "ship": image "ship" isn't an image file or a sprite; images are \.png, \.jpg, \.jpeg, \.webp, \.gif, or \.svg files in the game's folder, or sprites the game declares$/)
  const named = (image: string) => () => new Session(defineGame({ sprites, entities: { ship: { image } }, update() {} }), { assets: ['tile.png', 'tile.wav'] })
  assert.throws(named('tile'), /entity "ship": no sprite "tile" in the game's sprites, which are ship, rock; the folder has tile\.png, which image names with its extension$/)
  assert.throws(() => simulate(game, { ticks: 0, set: ['ship.image=boat'], assets }), UsageError)
  assert.equal(simulate(game, { ticks: 0, set: ['ship.image=rock'], assets }).world.ship.image, 'rock')
})

test("a sprite's fields are typed, so check fails a misspelled or mistyped one, which sim refuses too", () => {
  const cases: Array<[string, Sprites, RegExp]> = [
    // @ts-expect-error a sprite's fields are rows and palette
    ['a misspelled field', { ship: { rows: ['#'], pallete: { '#': 'red' } } }, /sprite "ship" has no field "pallete"/],
    // @ts-expect-error rows has a string for each row
    ['rows as one string', { ship: { rows: '.#.' } }, /sprite "ship": rows must be an array of strings/],
    // @ts-expect-error a palette's colors are strings, like a color field's
    ['a color as a number', { ship: { rows: ['#'], palette: { '#': 0xff0000 } } }, /sprite "ship": palette\["#"\] must be a CSS color/],
    // @ts-expect-error a sprite has rows
    ['no rows', { ship: { palette: { '#': 'red' } } }, /sprite "ship": rows must be an array of strings/],
  ]
  for (const [name, sprites, message] of cases) assert.throws(() => new Session(defineGame({ sprites, entities: {}, update() {} })), message, name)
  // @ts-expect-error a game's sprites are in sprites
  const misnamed = defineGame({ sprite: { ship: { rows: ['#'] } }, entities: {}, update() {} })
  assert.equal(misnamed.sprites, undefined)
})
