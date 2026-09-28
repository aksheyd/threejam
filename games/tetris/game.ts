// Tetris. Space starts; Left / Right move the falling piece, Up rotates it, and Down drops it faster.
// Full rows clear and score, and the game ends when a new piece has no room.
import { defineGame, grid, group, listOf, oneOf, type Context, type Entities, type World } from '@aksheyd/fourjs'

const COLS = 10
const ROWS = 20
const GRAVITY_TICKS = 30
const SOFT_DROP_TICKS = 2
// A held Left or Right moves again after DAS_TICKS, then every ARR_TICKS.
const DAS_TICKS = 10
const ARR_TICKS = 3
const POINTS = [100, 300, 500, 800]

// Column 1 is the left edge of the well and row 1 its floor.
const LEFT_X = -1.18
const BOTTOM_Y = -1.33
const PITCH = 0.14
const CELL = 0.13
const EMPTY_ROW = '.'.repeat(COLS)

const KINDS = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const
type Kind = (typeof KINDS)[number]
type Offset = readonly [col: number, row: number]

const COLORS: Record<Kind, string> = {
  I: '#00d9f2', O: '#f2d91a', T: '#a633d9', S: '#33d94d', Z: '#e62626', J: '#2659f2', L: '#f28c1a',
}
const EMPTY = '#17171f'
const GRAY = '#737373'
const RED = '#d92626'
const STEEL = '#8c94ad'
const BLACK = '#000000'
const PROMPT = 'PRESS SPACE'

// Offsets are [col, row] inside an n-by-n box with row 0 at the bottom, and each turn is a quarter clockwise.
function turns(n: number, spawn: Offset[]): Offset[][] {
  const all = [spawn]
  for (let turn = 1; turn < 4; turn++) all.push(all[turn - 1].map(([col, row]): Offset => [row, n - 1 - col]))
  return all
}

// TURNS[kind][turn]: the four offsets after that many turns from the spawn orientation.
const TURNS: Record<Kind, Offset[][]> = {
  I: turns(4, [[0, 2], [1, 2], [2, 2], [3, 2]]),
  O: turns(2, [[0, 0], [1, 0], [0, 1], [1, 1]]),
  T: turns(3, [[1, 2], [0, 1], [1, 1], [2, 1]]),
  S: turns(3, [[1, 2], [2, 2], [0, 1], [1, 1]]),
  Z: turns(3, [[0, 2], [1, 2], [1, 1], [2, 1]]),
  J: turns(3, [[0, 2], [0, 1], [1, 1], [2, 1]]),
  L: turns(3, [[2, 2], [0, 1], [1, 1], [2, 1]]),
}
// Bottom-left of the box at spawn; the I sits a row lower so it can turn upright under the ceiling.
const SPAWN: Record<Kind, Offset> = { I: [4, 17], O: [5, 19], T: [4, 18], S: [4, 18], Z: [4, 18], J: [4, 18], L: [4, 18] }

const cellX = (col: number) => LEFT_X + (col - 1) * PITCH
const cellY = (row: number) => BOTTOM_Y + (row - 1) * PITCH
const BLOCK = { x: 0, y: 0, w: CELL, h: CELL, color: '#ffffff' }

const entities = {
  // board lists rows from the floor up to the highest filled one, "." for empty, and pieces come off the end of bag.
  // col and row place the piece's rotation box; left, right, bottom, and top are the columns and rows it covers.
  // restart_delay is in ticks.
  game: {
    state: oneOf(['waiting', 'playing', 'over']), score: 0, lines: 0, spawned: 0,
    piece: oneOf(KINDS), turn: 0, left: 0, right: 0, bottom: 0, top: 0, next_piece: oneOf(KINDS),
    board: listOf(''), bag: listOf(oneOf(KINDS)), col: 0, row: 0,
    drop_timer: 0, das_dir: 0, das_timer: 0, restart_delay: 60, restart_wait: 0,
  },
  border: { x: -0.55, y: 0, w: 1.46, h: 2.86, color: STEEL },
  well: { x: -0.55, y: 0, w: 1.4, h: 2.8, color: BLACK },
  // cells[row][col] shows board[row][col], so row 0 is the floor.
  cells: grid(ROWS, COLS, ({ row, col }) => ({ ...BLOCK, x: cellX(col + 1), y: cellY(row + 1), color: EMPTY })),
  ghost: group(4, () => ({ ...BLOCK, opacity: 0.3 })),
  piece: group(4, () => BLOCK),
  next_border: { x: 1.05, y: 0.95, w: 0.86, h: 0.56, color: STEEL },
  next_bg: { x: 1.05, y: 0.95, w: 0.8, h: 0.5, color: BLACK },
  next: group(4, () => BLOCK),
  next_label: { x: 1.05, y: 1.32, text: 'NEXT', size: 0.07, color: STEEL },
  score_label: { x: 1.05, y: 0.47, text: 'SCORE', size: 0.07, color: STEEL },
  score: { x: 1.05, y: 0.25, text: '000000', size: 0.21, color: '#ffcc33' },
  lines_label: { x: 1.05, y: -0.09, text: 'LINES', size: 0.07, color: STEEL },
  lines: { x: 1.05, y: -0.28, text: '000', size: 0.14, color: '#4de6ff' },
  banner_border: { x: -0.55, y: 0, w: 1.26, h: 0.48, color: STEEL },
  banner_bg: { x: -0.55, y: 0, w: 1.2, h: 0.42, color: BLACK },
  banner_title: { x: -0.55, y: 0.075, text: 'TETRIS', size: 0.14, color: '#f2d91a' },
  banner_prompt: { x: -0.55, y: -0.105, text: PROMPT, size: 0.07, color: '#ffffff' },
} satisfies Entities

type Tetris = World<typeof entities>
type Game = Tetris['game']
type Block = Tetris['piece'][number]
type Span = Pick<Game, 'left' | 'right' | 'bottom' | 'top'>

function isKind(value: string): value is Kind {
  return KINDS.some((kind) => kind === value)
}

function isFree(board: readonly string[], col: number, row: number): boolean {
  return col >= 1 && col <= COLS && row >= 1 && row <= ROWS && (board[row - 1]?.[col - 1] ?? '.') === '.'
}

function fits(game: Game, turn: number, col: number, row: number): boolean {
  return TURNS[game.piece][turn].every(([c, r]) => isFree(game.board, col + c, row + r))
}

function span(offsets: readonly Offset[]): Span {
  const cols = offsets.map(([col]) => col)
  const rows = offsets.map(([, row]) => row)
  return { left: Math.min(...cols), right: Math.max(...cols), bottom: Math.min(...rows), top: Math.max(...rows) }
}

function shuffled(ctx: Context): Kind[] {
  const bag = [...KINDS]
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1))
    ;[bag[i], bag[j]] = [bag[j], bag[i]]
  }
  return bag
}

function take(game: Game, ctx: Context): Kind {
  const bag = game.bag.length > 0 ? game.bag : shuffled(ctx)
  game.bag = bag.slice(0, -1)
  return bag[bag.length - 1]
}

function showBanner(world: Tetris, shown: boolean): void {
  for (const part of [world.banner_border, world.banner_bg, world.banner_title, world.banner_prompt]) part.visible = shown
}

function gameOver(world: Tetris, ctx: Context): void {
  const { game } = world
  game.state = 'over'
  game.restart_wait = game.restart_delay
  world.border.color = RED
  world.banner_title.text = 'GAME OVER'
  world.banner_title.color = RED
  world.banner_prompt.text = game.restart_wait > 0 ? '' : PROMPT
  showBanner(world, true)
  ctx.print(`game over with ${game.score} points`)
}

function spawn(world: Tetris, ctx: Context): void {
  const { game } = world
  game.piece = game.next_piece
  game.next_piece = take(game, ctx)
  const [col, row] = SPAWN[game.piece]
  game.turn = 0
  game.col = col
  game.row = row
  game.drop_timer = 0
  game.spawned += 1
  if (!fits(game, 0, col, row)) gameOver(world, ctx)
}

function deal(world: Tetris, ctx: Context): void {
  world.game.next_piece = take(world.game, ctx)
  spawn(world, ctx)
}

function newGame(world: Tetris, ctx: Context): void {
  const { game } = world
  game.board = []
  game.bag = []
  game.score = 0
  game.lines = 0
  game.spawned = 0
  game.das_dir = 0
  world.border.color = STEEL
  deal(world, ctx)
}

function lock(world: Tetris, ctx: Context): void {
  const { game } = world
  const rows = [...game.board]
  for (const [c, r] of TURNS[game.piece][game.turn]) {
    const [col, row] = [game.col + c, game.row + r]
    while (rows.length < row) rows.push(EMPTY_ROW)
    rows[row - 1] = rows[row - 1].slice(0, col - 1) + game.piece + rows[row - 1].slice(col)
  }
  const kept = rows.filter((row) => row.includes('.'))
  const cleared = rows.length - kept.length
  game.board = kept
  if (cleared > 0) {
    game.lines += cleared
    game.score += POINTS[cleared - 1]
    ctx.print(`cleared ${cleared}, score ${game.score}`)
  }
  spawn(world, ctx)
}

function shift(game: Game, dir: number): void {
  if (fits(game, game.turn, game.col + dir, game.row)) game.col += dir
}

function rotate(game: Game): void {
  const turn = (game.turn + 1) % 4
  if (fits(game, turn, game.col, game.row)) game.turn = turn
}

function slide(game: Game, ctx: Context): void {
  const left = ctx.input.held('Left')
  const right = ctx.input.held('Right')
  const dir = left === right ? 0 : left ? -1 : 1
  if (dir === 0) {
    game.das_dir = 0
  } else if (dir !== game.das_dir) {
    game.das_dir = dir
    game.das_timer = DAS_TICKS
    shift(game, dir)
  } else {
    game.das_timer -= 1
    if (game.das_timer <= 0) {
      game.das_timer = ARR_TICKS
      shift(game, dir)
    }
  }
}

function fall(world: Tetris, ctx: Context): void {
  const { game } = world
  game.drop_timer += 1
  if (game.drop_timer < (ctx.input.held('Down') ? SOFT_DROP_TICKS : GRAVITY_TICKS)) return
  game.drop_timer = 0
  if (fits(game, game.turn, game.col, game.row - 1)) game.row -= 1
  else lock(world, ctx)
}

function paint(block: Block, { x, y, color, visible }: Pick<Block, 'x' | 'y' | 'color' | 'visible'>): void {
  block.x = x
  block.y = y
  block.color = color
  block.visible = visible
}

function colorOf(square: string, state: Game['state']): string {
  if (square === '.') return EMPTY
  if (!isKind(square)) throw new Error(`the board holds ${JSON.stringify(square)}, but rows hold only "." and ${KINDS.join('')}`)
  return state === 'over' ? GRAY : COLORS[square]
}

function drawBoard(world: Tetris): void {
  const { board, state } = world.game
  world.cells.forEach((cells, r) => {
    const row = board[r] ?? EMPTY_ROW
    cells.forEach((cell, c) => {
      cell.color = colorOf(row[c] ?? '.', state)
    })
  })
}

function drawPieces(world: Tetris): void {
  const { game, next_bg: box } = world
  const visible = game.state !== 'over'
  const color = COLORS[game.piece]
  const offsets = TURNS[game.piece][game.turn]
  let landing = game.row
  while (fits(game, game.turn, game.col, landing - 1)) landing -= 1
  offsets.forEach(([c, r], i) => {
    const x = cellX(game.col + c)
    paint(world.piece[i], { x, y: cellY(game.row + r), color, visible })
    paint(world.ghost[i], { x, y: cellY(landing + r), color, visible })
  })
  const next = TURNS[game.next_piece][0]
  const { left, right, bottom, top } = span(next)
  next.forEach(([c, r], i) => {
    const x = box.x + (c - (left + right) / 2) * PITCH
    const y = box.y + (r - (bottom + top) / 2) * PITCH
    paint(world.next[i], { x, y, color: COLORS[game.next_piece], visible })
  })
  Object.assign(game, span(offsets.map(([c, r]): Offset => [game.col + c, game.row + r])))
}

function draw(world: Tetris): void {
  drawBoard(world)
  drawPieces(world)
  world.score.text = String(world.game.score).padStart(6, '0')
  world.lines.text = String(world.game.lines).padStart(3, '0')
}

export default defineGame({
  title: 'Tetris',
  background: '#0d0d14',
  entities,
  start(world, ctx) {
    deal(world, ctx)
    draw(world)
  },
  update(world, ctx) {
    const { game } = world
    // Many players hard-drop with Space, so presses just after a game over mustn't skip its screen.
    if (game.restart_wait > 0) {
      game.restart_wait -= 1
      if (game.restart_wait === 0) world.banner_prompt.text = PROMPT
      return
    }
    if (game.state !== 'playing') {
      if (!ctx.input.pressed('Space')) return
      if (game.state === 'over') newGame(world, ctx)
      game.state = 'playing'
      showBanner(world, false)
    } else {
      if (ctx.input.pressed('Up')) rotate(game)
      slide(game, ctx)
      fall(world, ctx)
    }
    draw(world)
  },
})
