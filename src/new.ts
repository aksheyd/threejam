import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { UsageError } from './errors.ts'
import { COMPILER_OPTIONS, named } from './load.ts'
import { NAME, VERSION, manifestsAbove } from './package.ts'

export interface Created {
  readonly folder: string
  readonly files: readonly string[]
  // Whether the folder is a project of its own, with a package.json and tsconfig.json, because nothing above it depends on the package.
  readonly standalone: boolean
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

export function createGame(dir: string): Created {
  const folder = resolve(dir)
  if (existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length > 0)) {
    throw new UsageError(`${named(dir)} already exists and isn't an empty folder; new writes a game into a new or empty folder`)
  }
  const standalone = !inProject(dirname(folder))
  const name = basename(folder)
  const files: Record<string, string> = {
    'game.ts': starterGame(name),
    'game.test.ts': STARTER_TEST,
    ...(standalone ? { 'package.json': manifest(name), 'tsconfig.json': tsconfig() } : {}),
  }
  mkdirSync(folder, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text)
  return { folder, files: Object.keys(files), standalone }
}

// This repo, which the package's name resolves to by self-reference, or a project that installs the package.
function inProject(folder: string): boolean {
  return [...manifestsAbove(folder)].some(
    ({ json }) => json.name === NAME || DEPENDENCY_FIELDS.some((field) => typeof json[field] === 'object' && json[field] !== null && NAME in json[field]),
  )
}

function manifest(name: string): string {
  const json = {
    name: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|-+$/g, '') || 'threejam-game',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
    // Node's own types are for game.test.ts; check reads game.ts without them.
    devDependencies: { [NAME]: `^${VERSION}`, '@types/node': '^22.18.0' },
  }
  return `${JSON.stringify(json, null, 2)}\n`
}

// Editors see the DOM for view.ts and Node for tests, while check reads game.ts with neither.
function tsconfig(): string {
  const json = { compilerOptions: { ...COMPILER_OPTIONS, lib: ['es2023', 'dom', 'dom.iterable'], types: ['node'] } }
  return `${JSON.stringify(json, null, 2)}\n`
}

function starterGame(name: string): string {
  return `// Catch. Left and Right (or A and D) move the paddle under the falling ball. Space starts, and three misses end the game.
import { defineGame, oneOf, type Context, type Entities, type World } from '${NAME}'

const entities = {
  paddle: { x: 0, y: -1.3, w: 0.6, h: 0.08, color: 'deepskyblue', speed: 3 },
  ball: { x: 0, y: 1.2, w: 0.12, h: 0.12, shape: 'circle', color: 'orange', visible: false, speed: 1.5 },
  score: { x: -1.9, y: 1.38, text: 'SCORE 0', align: 'left' },
  missed: { x: 1.9, y: 1.38, text: 'MISSES 0', align: 'right' },
  message: { x: 0, y: 0.2, text: 'PRESS SPACE TO START' },
  game: { state: oneOf(['ready', 'play', 'over']), points: 0, misses: 0, most_misses: 3 },
} satisfies Entities

type Catch = World<typeof entities>

// Each ball starts at the top, somewhere across the screen.
function drop(ball: Catch['ball'], ctx: Context): void {
  ball.x = ctx.random() * 3.6 - 1.8
  ball.y = 1.2
}

function begin(world: Catch, ctx: Context): void {
  const { ball, game, message } = world
  game.state = 'play'
  game.points = 0
  game.misses = 0
  message.visible = false
  ball.visible = true
  drop(ball, ctx)
}

function play(world: Catch, ctx: Context): void {
  const { paddle, ball, game, message } = world
  const move = (ctx.input.held('Right') || ctx.input.held('D') ? 1 : 0) - (ctx.input.held('Left') || ctx.input.held('A') ? 1 : 0)
  const edge = 2 - paddle.w / 2
  paddle.x = Math.max(-edge, Math.min(edge, paddle.x + move * paddle.speed * ctx.dt))
  ball.y -= ball.speed * ctx.dt
  const caught = Math.abs(ball.y - paddle.y) < (ball.h + paddle.h) / 2 && Math.abs(ball.x - paddle.x) < (ball.w + paddle.w) / 2
  if (caught) {
    game.points += 1
    ctx.print(\`caught, score \${game.points}\`)
    ctx.play('coin')
    drop(ball, ctx)
  } else if (ball.y < -1.5) {
    game.misses += 1
    ctx.print(\`missed, \${game.misses} of \${game.most_misses}\`)
    if (game.misses < game.most_misses) {
      ctx.play('hit')
      drop(ball, ctx)
      return
    }
    game.state = 'over'
    ball.visible = false
    message.text = 'GAME OVER - PRESS SPACE'
    message.visible = true
    ctx.play('lose')
  }
}

export default defineGame({
  title: ${literal(name)},
  entities,
  update(world, ctx) {
    const { game } = world
    if (game.state === 'play') play(world, ctx)
    else if (ctx.input.pressed('Space')) begin(world, ctx)
    world.score.text = \`SCORE \${game.points}\`
    world.missed.text = \`MISSES \${game.misses}\`
  },
})
`
}

// A single-quoted string, like the rest of the file, with JSON's escapes for anything else a folder name can hold.
function literal(text: string): string {
  return `'${JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`
}

const STARTER_TEST = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { simulate } from '${NAME}'
import game from './game.ts'

test('nothing falls until Space starts a game', () => {
  const { world } = simulate(game, { ticks: 60 })
  assert.deepEqual([world.game.state, world.ball.visible, world.ball.y], ['ready', false, 1.2])
})

test('holding Right catches the first ball with a sound, and a paddle that stays put misses it', () => {
  const still = simulate(game, { ticks: 110, press: ['Space@1'] })
  assert.deepEqual(still.logs, [{ tick: 110, text: 'missed, 1 of 3' }])
  const moved = simulate(game, { ticks: 110, press: ['Space@1'], hold: ['Right@2-40'] })
  assert.deepEqual(moved.logs, [{ tick: 98, text: 'caught, score 1' }])
  assert.deepEqual(moved.sounds, [{ tick: 98, name: 'coin', volume: 1, pitch: 1 }])
  assert.equal(moved.world.score.text, 'SCORE 1')
})

test('the third miss ends the game, and Space starts a new one', () => {
  const over = simulate(game, { ticks: 328, press: ['Space@1'] })
  assert.deepEqual([over.world.game.state, over.world.message.text], ['over', 'GAME OVER - PRESS SPACE'])
  const again = simulate(game, { ticks: 329, press: ['Space@1,329'] })
  assert.deepEqual([again.world.game.state, again.world.game.misses, again.world.message.visible], ['play', 0, false])
})
`
