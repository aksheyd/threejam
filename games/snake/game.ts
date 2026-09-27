// Snake. An arrow key starts the snake and the arrow keys turn it. Eat apples to grow; a wall or your own body ends the game, and Space plays again.
import { defineGame, group, oneOf, type Context, type Entities, type Entity, type Key, type World } from 'fourjs'

const COLS = 20
const ROWS = 15
const RED = '#e51f1f'
const BODY = '#2eb838'
const HEAD = '#73f266'
const LIGHT = '#d9ffcc'
const HINT = 'PRESS AN ARROW KEY'
// The eyes sit this far ahead of the head's center and this far to each side.
const EYE = 0.045
const TURNS: ReadonlyArray<readonly [Key, number, number]> = [
  ['Up', 0, 1],
  ['Down', 0, -1],
  ['Left', -1, 0],
  ['Right', 1, 0],
]
const ENDINGS = {
  over: { title: 'GAME OVER', tint: '#730000', opacity: 0.4 },
  won: { title: 'YOU WIN', tint: '#007300', opacity: 0.3 },
}

// Cells are [x, y] from [1, 1] at the bottom left, and a direction is the [x, y] of one step.
type XY = [x: number, y: number]
const START: XY[] = [[6, 8], [5, 8], [4, 8]]
const none: XY[] = []

const entities = {
  // start_body lists cells head first, and body keeps the same order.
  game: {
    cols: COLS, rows: ROWS, cell: 0.2, step_ticks: 8, start_body: START,
    state: oneOf(['ready', 'playing', 'over', 'won']), score: 0, steps: 0, countdown: 0,
    body: none, dir: [1, 0], turns: none, food_x: 0, food_y: 0,
  },
  // The apple's parts start at their offsets from the center of its cell.
  food: { x: 0, y: 0, w: 0.15, h: 0.11, color: RED },
  food_b: { x: 0, y: 0, w: 0.11, h: 0.15, color: RED },
  shine: { x: -0.035, y: 0.025, w: 0.025, h: 0.025, color: '#ff8c80' },
  stem: { x: -0.005, y: 0.08, w: 0.02, h: 0.03, color: '#73471a' },
  leaf: { x: 0.035, y: 0.08, w: 0.05, h: 0.03, shape: 'triangle', color: '#4dd940' },
  // Entities can't be added while the game runs, so every cell but the head's gets a hidden segment.
  segments: group(COLS * ROWS - 1, () => ({ w: 0.17, h: 0.17, color: BODY, visible: false })),
  head: { w: 0.19, h: 0.19, color: HEAD },
  eye1: { w: 0.04, h: 0.04, color: '#050f05' },
  eye2: { w: 0.04, h: 0.04, color: '#050f05' },
  overlay: { w: 4, h: 3, color: '#730000', opacity: 0.4, visible: false },
  score: { x: 1.8, y: 1.2, text: '0', size: 0.28, align: 'right', color: '#336133' },
  message: { x: 0, y: 0.65, text: '', size: 0.28, color: LIGHT },
  hint: { x: 0, y: 0.35, text: HINT, color: LIGHT },
} satisfies Entities

const APPLE = ['food', 'food_b', 'shine', 'stem', 'leaf'] satisfies (keyof typeof entities)[]

type Snake = World<typeof entities>
type Board = Snake['game']
type Spot = Pick<Entity, 'x' | 'y'>

function place(e: Spot, game: Board, [x, y]: XY, offset: Spot = { x: 0, y: 0 }): void {
  e.x = (x - 0.5 - game.cols / 2) * game.cell + offset.x
  e.y = (y - 0.5 - game.rows / 2) * game.cell + offset.y
}

function checkStart(game: Board): void {
  const seen = new Set<string>()
  game.start_body.forEach(([x, y], i) => {
    if (!(x >= 1 && x <= game.cols && y >= 1 && y <= game.rows)) throw new Error(`start_body cell (${x},${y}) is off the board`)
    if (seen.has(`${x},${y}`)) throw new Error(`start_body lists cell (${x},${y}) twice`)
    seen.add(`${x},${y}`)
    const before = game.start_body[i - 1]
    if (before && Math.abs(x - before[0]) + Math.abs(y - before[1]) !== 1) {
      throw new Error(`start_body cell (${x},${y}) doesn't touch the cell before it`)
    }
  })
  if (seen.size === 0) throw new Error('start_body needs at least one cell, like [[6, 8], [5, 8]]')
}

function placeSnake(world: Snake): void {
  const { game, segments, head, eye1, eye2 } = world
  const [first, ...rest] = game.body
  if (rest.length > segments.length) throw new Error(`out of body segments: the snake needs ${rest.length}, and game.ts has ${segments.length}`)
  segments.forEach((seg, i) => {
    seg.visible = i < rest.length
    if (seg.visible) place(seg, game, rest[i])
  })
  place(head, game, first)
  const [dx, dy] = game.dir
  eye1.x = head.x + (dx - dy) * EYE
  eye1.y = head.y + (dy + dx) * EYE
  eye2.x = head.x + (dx + dy) * EYE
  eye2.y = head.y + (dy - dx) * EYE
}

function spawnFood(world: Snake, ctx: Context): boolean {
  const { game } = world
  const taken = new Set(game.body.map(([x, y]) => `${x},${y}`))
  const free: XY[] = []
  for (let y = 1; y <= game.rows; y++) {
    for (let x = 1; x <= game.cols; x++) if (!taken.has(`${x},${y}`)) free.push([x, y])
  }
  if (free.length === 0) return false
  const [x, y] = free[Math.floor(ctx.random() * free.length)]
  game.food_x = x
  game.food_y = y
  for (const part of APPLE) {
    place(world[part], game, [x, y], entities[part])
    world[part].visible = true
  }
  ctx.print(`food at (${x},${y}), picked from ${free.length} free cell${free.length === 1 ? '' : 's'}`)
  return true
}

function endGame(world: Snake, ending: keyof typeof ENDINGS): void {
  const { game, overlay } = world
  const { title, tint, opacity } = ENDINGS[ending]
  game.state = ending
  overlay.color = tint
  overlay.opacity = opacity
  overlay.visible = true
  world.message.text = title
  world.hint.text = 'PRESS SPACE TO PLAY AGAIN'
}

function gameOver(world: Snake, ctx: Context, why: string): void {
  world.head.color = '#f24d33'
  endGame(world, 'over')
  ctx.print(`game over: ${why}. final score ${world.game.score}`)
}

function readKeys(game: Board, ctx: Context): boolean {
  let any = false
  for (const [key, kx, ky] of TURNS) {
    if (!ctx.input.pressed(key)) continue
    any = true
    const [px, py] = game.turns.at(-1) ?? game.dir
    // Only quarter turns: reversing would drive the head straight into the neck.
    if (game.turns.length < 2 && kx * px + ky * py === 0) game.turns = [...game.turns, [kx, ky]]
  }
  return any
}

function step(world: Snake, ctx: Context): void {
  const { game } = world
  const [turn, ...later] = game.turns
  if (turn) {
    game.dir = turn
    game.turns = later
  }
  game.steps += 1
  const [[hx, hy]] = game.body
  const x = hx + game.dir[0]
  const y = hy + game.dir[1]
  if (x < 1 || x > game.cols || y < 1 || y > game.rows) return gameOver(world, ctx, `hit the wall at (${x},${y})`)
  const grows = x === game.food_x && y === game.food_y
  // The tail leaves its cell this step unless the snake grows, so the head may take it.
  const kept = grows ? game.body : game.body.slice(0, -1)
  if (kept.some(([bx, by]) => bx === x && by === y)) return gameOver(world, ctx, `ran into itself at (${x},${y})`)
  game.body = [[x, y], ...kept]
  placeSnake(world)
  if (!grows) return
  game.score += 1
  world.score.text = String(game.score)
  ctx.print(`ate food at (${x},${y}): score ${game.score}, length ${game.body.length}`)
  if (spawnFood(world, ctx)) return
  for (const part of APPLE) world[part].visible = false
  endGame(world, 'won')
  ctx.print(`you win! the snake fills the board. final score ${game.score}`)
}

function newGame(world: Snake, ctx: Context): void {
  const { game } = world
  const [head, neck] = game.start_body
  game.body = game.start_body
  game.dir = neck ? [head[0] - neck[0], head[1] - neck[1]] : [1, 0]
  game.turns = []
  game.state = 'ready'
  game.score = 0
  game.steps = 0
  world.head.color = HEAD
  world.overlay.visible = false
  world.score.text = '0'
  world.message.text = ''
  world.hint.text = HINT
  placeSnake(world)
  spawnFood(world, ctx)
}

export default defineGame({
  title: 'Snake',
  background: '#0d170d',
  entities,
  start(world, ctx) {
    checkStart(world.game)
    newGame(world, ctx)
  },
  update(world, ctx) {
    const { game } = world
    if (game.state === 'over' || game.state === 'won') {
      if (!ctx.input.pressed('Space')) return
      ctx.print('new game')
      newGame(world, ctx)
    }
    const pressed = readKeys(game, ctx)
    if (game.state === 'ready') {
      if (!pressed) return
      game.state = 'playing'
      world.hint.text = ''
      game.countdown = game.step_ticks
      ctx.print('the snake starts moving')
      return
    }
    game.countdown -= 1
    if (game.countdown > 0) return
    game.countdown = game.step_ticks
    step(world, ctx)
  },
})
