import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { isImageFile, isSoundFile } from '../src/assets.ts'
import { parseGame, simulate } from '../src/engine.ts'
import type { Code } from '../src/errors.ts'
import { glyph } from '../src/font.ts'
import { PORTABLE } from '../src/math.ts'
import { ROOT, VERSION, manifestsAbove } from '../src/package.ts'
import { KEYS, SOUNDS, type Align, type Shape } from '../src/types.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

// The inline code a doc gives for shuffling a list, found by the step that makes it Fisher-Yates.
function shuffle(doc: string): string {
  const text = readFileSync(join(ROOT, doc), 'utf8')
  const found = /`(for \(let i = list\.length - 1;[^`]*ctx\.random\(\) \* \(i \+ 1\)[^`]*)`/.exec(text)
  assert.ok(found, `${doc} gives no Fisher-Yates shuffle`)
  assert.match(text, /sort\(\(\) => ctx\.random\(\) - 0\.5\)/, `${doc} doesn't warn against shuffling with sort`)
  return found[1]
}

test('AGENTS.md and the skill give one shuffle, Fisher-Yates on ctx.random(), which passes check and orders by the seed alone', async () => {
  const snippet = shuffle('AGENTS.md')
  assert.equal(shuffle(join('skills', 'threejam', 'SKILL.md')), snippet)
  const dir = mkdtempSync(join(TMP, 'shuffle-'))
  made.push(dir)
  const file = join(dir, 'game.ts')
  writeFileSync(
    file,
    [
      "import { defineGame, listOf } from 'threejam'",
      '',
      'export default defineGame({',
      '  entities: { deck: { cards: listOf(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) } },',
      '  update({ deck }, ctx) {',
      '    const list = [...deck.cards]',
      `    ${snippet}`,
      '    deck.cards = list',
      '  },',
      '})',
      '',
    ].join('\n'),
  )
  const checked = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'check', relative(ROOT, dir), '--format', 'json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  const game = parseGame(Reflect.get(await import(pathToFileURL(file).href), 'default'))
  const order = (seed: number) => simulate(game, { ticks: 1, seed }).snapshots[0].entities[0].cards
  const shuffled = order(1)
  assert.deepEqual(order(1), shuffled)
  assert.notDeepEqual(order(2), shuffled)
  assert.ok(Array.isArray(shuffled))
  assert.deepEqual([...shuffled].sort((a, b) => Number(a) - Number(b)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test("the docs install the skill from the newest release's tag, and CHANGELOG.md has an entry for the version in package.json", () => {
  const released = [...readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1])
  assert.ok(released.includes(VERSION), `CHANGELOG.md has no entry for ${VERSION}, the version in package.json`)
  const [root] = manifestsAbove(ROOT)
  const source = `${String(root.json.homepage)}/tree/v${released[0]}/skills/threejam`
  for (const doc of ['README.md', join('docs', 'agents.md')]) {
    const sources = [...readFileSync(join(ROOT, doc), 'utf8').matchAll(/npx skills add (https:\S+)/g)].map((match) => match[1])
    assert.deepEqual(sources, [source], `${doc} should install the skill from ${source}`)
  }
})

const MANUAL = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
const GUIDE = readFileSync(join(ROOT, 'docs', 'commands.md'), 'utf8')

// The text between a phrase a doc has once and the first given phrase after it.
function between(text: string, before: string, after: string): string {
  assert.equal(text.split(before).length, 2, `the doc should have "${before}" once`)
  const start = text.indexOf(before) + before.length
  const end = text.indexOf(after, start)
  assert.notEqual(end, -1, `the doc has no "${after}" after "${before}"`)
  return text.slice(start, end)
}

// The items of a list in prose, like "A-Z, 0-9, Space, and Right, plus `Mouse`", with a range of characters spelled out.
function items(list: string): string[] {
  return list
    .split(/,\s+(?:and |or |plus )?|\s+(?:and|or|plus)\s+/)
    .map((item) => item.replace(/^an? /, '').replace(/[`"]/g, ''))
    .flatMap((item) => {
      if (!/^.-.$/.test(item)) return [item]
      const [first, last] = [item.charCodeAt(0), item.charCodeAt(2)]
      return Array.from({ length: last - first + 1 }, (_, i) => String.fromCharCode(first + i))
    })
}

function same(named: readonly string[], code: readonly string[], what: string, doc = 'AGENTS.md'): void {
  assert.deepEqual(named.toSorted(), code.toSorted(), `${doc} should name exactly the ${what} in the code`)
}

// Every extension of up to four letters and digits, which takes in every common image and sound type, since assets.ts keeps its tables to itself.
function extensionsTaken(): { images: string[]; sounds: string[] } {
  const found = { images: new Array<string>(), sounds: new Array<string>() }
  const grow = (extension: string): void => {
    if (isImageFile(`file.${extension}`)) found.images.push(`.${extension}`)
    if (isSoundFile(`file.${extension}`)) found.sounds.push(`.${extension}`)
    if (extension.length < 4) for (const char of 'abcdefghijklmnopqrstuvwxyz0123456789') grow(extension + char)
  }
  grow('')
  return found
}

// How a file's name spells each image type the manual names.
const IMAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = { PNG: ['.png'], JPEG: ['.jpg', '.jpeg'], WebP: ['.webp'], GIF: ['.gif'], SVG: ['.svg'] }

test('AGENTS.md names exactly the keys, the built-in sounds, and the image and sound files the engine takes', () => {
  same(items(between(MANUAL, 'Keys are ', ' for the mouse buttons')), KEYS, 'keys')
  same(items(between(MANUAL, 'one of the built-in sounds, ', ', which the page makes itself')), SOUNDS, 'built-in sounds')
  const taken = extensionsTaken()
  const images = items(between(MANUAL, "like `'logo.png'`: a ", ', named exactly as the file is')).flatMap((type) => {
    assert.ok(Object.hasOwn(IMAGE_EXTENSIONS, type), `AGENTS.md names ${type} images, which this test can't spell as extensions`)
    return IMAGE_EXTENSIONS[type]
  })
  same(images, taken.images, 'image file extensions')
  same(items(between(MANUAL, 'so a game needs no files, or a ', ' file next to `game.ts`, by its file name')), taken.sounds, 'sound file extensions')
})

// A Record over a type fails the typecheck once the type gains or loses a member, so these lists change with the code.
const SHAPES = Object.keys({ square: 0, circle: 0, triangle: 0 } satisfies Record<Shape, 0>)
const ALIGNS = Object.keys({ left: 0, center: 0, right: 0 } satisfies Record<Align, 0>)
const CODES = Object.keys({ USAGE: 0, BUILD_ERROR: 0, TYPE_ERROR: 0, GAME_ERROR: 0, TIMEOUT: 0, OUTPUT_TOO_LARGE: 0, BROWSER_ERROR: 0, IO_ERROR: 0, INTERNAL_ERROR: 0 } satisfies Record<Code, 0>)

test('AGENTS.md names exactly the shapes, the text alignments, the characters the font draws, and the Math functions the engine makes portable', () => {
  same(items(between(MANUAL, '`shape` (', '), `color`')), SHAPES, 'shapes')
  same(items(between(MANUAL, '`align` (', '), `color`')), ALIGNS, 'text alignments')
  const found = /^(.+), and `([^`]+)`$/.exec(between(MANUAL, 'Text uses a 5x7 pixel font with ', '; lowercase draws as capitals'))
  assert.ok(found, "AGENTS.md should list the font's letters and digits, then its marks in one code span")
  const font = new Set([...items(found[1]).map((item) => (item === 'space' ? ' ' : item)), ...found[2].split(' ')])
  assert.ok([...'abcdefghijklmnopqrstuvwxyz'].every((char) => glyph(char) === glyph(char.toUpperCase())))
  const drawn = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter((char) => glyph(char) !== undefined)
  same([...font], drawn.filter((char) => char === char.toUpperCase() || !font.has(char.toUpperCase())), 'font characters')
  const portable = items(between(MANUAL, 'in `start`, `update`, and drivers, ', " are the engine's own portable versions")).flatMap((name) =>
    name === 'the hyperbolic functions' ? ['sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh'] : [name.replace(/^Math\./, '')],
  )
  same(portable, Object.keys(PORTABLE), 'portable Math functions')
})

test('AGENTS.md and the commands guide list exactly the codes a failure can have', () => {
  same([...MANUAL.matchAll(/^- `([A-Z_]+)`: /gm)].map((match) => match[1]), CODES, 'error codes')
  same([...GUIDE.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1]), CODES, 'error codes', 'docs/commands.md')
})

// Each command and its flags, from the manifest incur builds from the same definitions as the CLI.
function commands(): { name: string; flags: string[] }[] {
  const run = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), '--llms-full', '--format', 'json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const parsed: unknown = JSON.parse(run.stdout)
  const listed: unknown[] = isRecord(parsed) && Array.isArray(parsed.commands) ? parsed.commands : []
  assert.notEqual(listed.length, 0, `the manifest lists no commands: ${run.stdout}`)
  return listed.map((command) => {
    const name = isRecord(command) ? command.name : undefined
    // A command without options, like new, has none in its schema.
    const options = isRecord(command) && isRecord(command.schema) && isRecord(command.schema.options) ? command.schema.options.properties : {}
    assert.ok(typeof name === 'string' && isRecord(options), `the manifest describes a command as ${JSON.stringify(command)}`)
    return { name, flags: Object.keys(options).map((option) => `--${option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`) }
  })
}

// The words a doc writes like flags: one or two dashes and a letter, not inside a word.
function flagsIn(text: string): Set<string> {
  return new Set(text.match(/(?<![\w-])--?[a-z][a-z-]*/g) ?? [])
}

// What the docs write like flags that no command defines: incur's own and mcp add's, -o for --out, flags of Chrome, add-mcp, node, and docker, and two mistakes mcp add refuses.
const NOT_OPTIONS = new Set(['--format', '--filter-output', '--help', '--schema', '--mcp', '--llms', '--agent', '--command', '-c', '--no-global', '-o', '--no-sandbox', '--args', '--name', '-g', '-y', '--test', '--init', '-a', '--agnet'])

test('AGENTS.md and the commands guide show every command and name each of its flags, and no flag that ThreeJam lacks', () => {
  const listed = commands()
  const options = new Set(listed.flatMap((command) => command.flags))
  for (const [doc, text] of [['AGENTS.md', MANUAL], ['docs/commands.md', GUIDE]]) {
    const named = flagsIn(text)
    for (const { name, flags } of listed) {
      assert.ok(text.includes(`npx threejam ${name} `), `${doc} should show npx threejam ${name}`)
      for (const flag of flags) assert.ok(named.has(flag), `${doc} should name ${name}'s ${flag}`)
    }
    for (const flag of named) assert.ok(options.has(flag) || NOT_OPTIONS.has(flag), `${doc} names ${flag}, which no command takes`)
  }
})

test('AGENTS.md, the agents guide, and the skill name the same MCP tools, which are every command but the one for people', () => {
  const tools = items(between(MANUAL, '`npx threejam --mcp` serves ', ' as MCP tools'))
  const forPeople = between(MANUAL, 'as MCP tools. `', '` is for people')
  same([...tools, forPeople], commands().map((command) => command.name), 'commands')
  assert.deepEqual(items(between(readFileSync(join(ROOT, 'docs', 'agents.md'), 'utf8'), '# serve ', ' as MCP tools')), tools, 'docs/agents.md should name the MCP tools AGENTS.md does')
  assert.deepEqual(items(between(readFileSync(join(ROOT, 'skills', 'threejam', 'SKILL.md'), 'utf8'), 'registers ', ' as tools')), tools, 'the skill should name the MCP tools AGENTS.md does')
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
