import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { parseGame, simulate } from '../src/engine.ts'
import { ROOT, VERSION, manifestsAbove } from '../src/package.ts'

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

test('audit 18: AGENTS.md and the skill give one shuffle, Fisher-Yates on ctx.random(), which passes check and orders by the seed alone', async () => {
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
