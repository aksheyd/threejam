// Space Invaders. Space starts the invasion; Left / Right move the cannon; Space fires, and holding it keeps firing.
import { defineGame, type Context, type Entities, type Entity, type World } from 'fourjs'
import { CANNON, boxes, type Box } from './sprites.ts'

const WHITE = '#ffffff'
const GREEN = '#33ff33'
const RED = '#ff3333'

const ROWS = 5
const COLS = 11
const POINTS = [30, 20, 20, 10, 10]
const INVADER_W = [0.12, 0.165, 0.165, 0.18, 0.18]
const UFO_POINTS = [50, 100, 150, 300]
const BOMBS = ['bomb1', 'bomb2', 'bomb3'] as const
const CANNON_PARTS = boxes(CANNON)

// Every bunker is this grid of cells, laid out from its top-left cell.
const BUNKER = ['..#######..', '.#########.', '###########', '###########', '###########', '###########', '####...####', '###.....###']
const BUNKERS = 4
const CELL = 0.03
const SHIELD_Y = -0.695
const SHIELD_TOP = SHIELD_Y + CELL / 2
const SHIELD_BOTTOM = SHIELD_Y - (BUNKER.length - 0.5) * CELL

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
const bunkerX = (s: number) => -1.35 + (s - 1) * 0.8
const homeX = (col: number) => -1.2 + (col - 1) * 0.24
const homeY = (row: number) => 0.84 - (row - 1) * 0.24

function invader(row: number, col: number) {
  return { x: homeX(col), y: homeY(row), w: INVADER_W[row - 1], h: 0.12, row, col }
}

function cell(x: number, y: number) {
  return { x, y, w: CELL, h: CELL, color: GREEN }
}

function bomb(kind: 'aimed' | 'random') {
  return { x: 0, y: -2.5, w: 0.045, h: 0.105, visible: false, kind, speed: 0.9, ground: -1.24, age: 0 }
}

function invaderEntities() {
  const invaders: Record<string, ReturnType<typeof invader>> = {}
  for (const row of range(ROWS)) for (const col of range(COLS)) invaders[`inv_r${row}_c${col}`] = invader(row, col)
  return invaders
}

function shieldEntities() {
  const cells: Record<string, ReturnType<typeof cell>> = {}
  for (const s of range(BUNKERS)) {
    for (const [r, line] of BUNKER.entries()) {
      for (const [c, pixel] of [...line].entries()) {
        if (pixel === '#') cells[`shield${s}_${r + 1}_${c + 1}`] = cell(bunkerX(s) + c * CELL, SHIELD_Y - r * CELL)
      }
    }
  }
  return cells
}

type State = 'ready' | 'play' | 'dying' | 'won' | 'over'

// Written inline under `satisfies Entities`, false is typed as the literal false and could never become true, hence `as boolean`.
const entities = {
  score_label: { x: -1.58, y: 1.41, text: 'SCORE', size: 0.105, color: WHITE },
  score: { x: -1.58, y: 1.27, text: '0000', size: 0.105, color: WHITE },
  lives: { x: -1.78, y: -1.37, text: '3', size: 0.105, color: GREEN },
  message: { x: 0, y: 1.41, text: 'PRESS SPACE TO START', size: 0.105, color: WHITE },
  hint: { x: 0, y: 1.175, text: '', size: 0.07, color: WHITE },
  life1: { x: -1.6, y: -1.37, w: 0.156, h: 0.096, color: GREEN },
  life2: { x: -1.4, y: -1.37, w: 0.156, h: 0.096, color: GREEN },
  ground: { x: 0, y: -1.24, w: 4, h: 0.015, color: GREEN },
  ...shieldEntities(),
  // respawn_ticks and restart_ticks are pauses in ticks; start copies lives into start_lives for later games.
  game: { state: 'ready' as State, score: 0, lives: 3, timer: 0, start_lives: 3, respawn_ticks: 90, restart_ticks: 60 },
  shields: { destroyed: 0 },
  // rows and cols pick how much of the formation is in the wave; wait, interval, and the bomb gaps count ticks.
  fleet: {
    rows: ROWS, cols: COLS, step_x: 0.03, step_down: 0.12, tempo: 0.6, left: -1.9, right: 1.9, invade_below: -1.04,
    bomb_gap_min: 30, bomb_gap_max: 90, boom_ticks: 12,
    alive_count: ROWS * COLS, interval: 33, wait: 33, dir: 1, sx: 0, sy: 0, steps: 0, bomb_wait: 90, next_bomb: 0, boom_timer: 0,
  },
  ...invaderEntities(),
  boom: { x: 0, y: -2.5, w: 0.195, h: 0.105, visible: false as boolean },
  ufo: { x: -2.5, y: 1.08, w: 0.24, h: 0.105, color: RED, visible: false as boolean, speed: 0.9, edge: 2.3, first_wait: 900, every: 1500, wait: 900, dir: 1 },
  cannon: { x: 0, y: -1.1, w: 0.195, h: 0.12, color: GREEN, speed: 1.2, left: -1.9, right: 1.9, armed: false as boolean, home_x: 0 },
  shot: { x: 0, y: -2.5, w: 0.015, h: 0.06, color: WHITE, visible: false as boolean, speed: 3.6, top: 1.17 },
  bomb1: bomb('aimed'),
  bomb2: bomb('random'),
  bomb3: bomb('random'),
} satisfies Entities

export type Invaders = World<typeof entities>
export type Invader = Entity<ReturnType<typeof invader>>
type Cell = Entity<ReturnType<typeof cell>>
type BombName = (typeof BOMBS)[number]

// Generated entities aren't in the World type, so they're looked up by prefix.
const invaders = (ctx: Context) => ctx.all('inv_') as Invader[]
const bunker = (ctx: Context, s: number) => ctx.all(`shield${s}_`) as Cell[]

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
}

function randomInt(ctx: Context, min: number, max: number): number {
  return min + Math.floor(ctx.random() * (max - min + 1))
}

function livesPhrase(n: number): string {
  return n === 1 ? '1 life' : `${n} lives`
}

function drawHud(world: Invaders): void {
  const { game } = world
  world.score.text = String(game.score).padStart(4, '0')
  world.lives.text = String(game.lives)
  world.life1.visible = game.lives > 1
  world.life2.visible = game.lives > 2
}

function show(world: Invaders, message: string, color: string): void {
  world.message.text = message
  world.message.color = color
  world.hint.text = ''
}

function begin(world: Invaders, ctx: Context): void {
  world.game.state = 'play'
  show(world, '', WHITE)
  ctx.print(`the invasion begins with ${livesPhrase(world.game.lives)}`)
}

function finish(world: Invaders, ctx: Context, state: 'won' | 'over', message: string): void {
  const { game } = world
  game.state = state
  game.timer = game.restart_ticks
  ctx.print(`${message} (final score ${game.score})`)
  if (state === 'over') {
    world.ground.color = RED
    show(world, 'GAME OVER', RED)
  } else {
    show(world, 'YOU WIN', WHITE)
  }
}

function addScore(world: Invaders, ctx: Context, points: number, what: string): void {
  world.game.score += points
  ctx.print(`score +${points} for ${what} = ${world.game.score}`)
  drawHud(world)
}

function cannonHit(world: Invaders, ctx: Context, by: BombName): void {
  const { game } = world
  if (game.state !== 'play') return
  game.lives -= 1
  ctx.print(`cannon hit by ${by}: ${livesPhrase(game.lives)} left`)
  drawHud(world)
  if (game.lives <= 0) {
    finish(world, ctx, 'over', 'GAME OVER: the last life is lost')
  } else {
    game.state = 'dying'
    game.timer = game.respawn_ticks
  }
}

// Destroys every shield cell the box overlaps and returns how many.
function hitShields(world: Invaders, ctx: Context, box: Box): number {
  if (box.y - box.h / 2 >= SHIELD_TOP || box.y + box.h / 2 <= SHIELD_BOTTOM) return 0
  let count = 0
  for (const s of range(BUNKERS)) {
    const left = bunkerX(s) - CELL / 2
    const right = left + BUNKER[0].length * CELL
    if (box.x + box.w / 2 <= left || box.x - box.w / 2 >= right) continue
    for (const cell of bunker(ctx, s)) {
      if (cell.visible && overlaps(box, cell)) {
        cell.visible = false
        count += 1
      }
    }
  }
  world.shields.destroyed += count
  return count
}

function intervalFor(fleet: Invaders['fleet'], alive: number): number {
  return Math.max(1, Math.floor(alive * fleet.tempo + 0.5))
}

function extents(ctx: Context): { left: number; right: number; bottom: number } {
  let [left, right, bottom] = [Infinity, -Infinity, Infinity]
  for (const inv of invaders(ctx)) {
    if (!inv.visible) continue
    left = Math.min(left, inv.x - inv.w / 2)
    right = Math.max(right, inv.x + inv.w / 2)
    bottom = Math.min(bottom, inv.y - inv.h / 2)
  }
  return { left, right, bottom }
}

function place(world: Invaders, ctx: Context): void {
  const { fleet } = world
  for (const inv of invaders(ctx)) {
    if (!inv.visible) continue
    inv.x = homeX(inv.col) + fleet.sx * fleet.step_x
    inv.y = homeY(inv.row) - fleet.sy * fleet.step_down
  }
}

// One step sideways, or down and turning around when the next step would cross an edge.
function march(world: Invaders, ctx: Context): void {
  const { fleet } = world
  const { left, right } = extents(ctx)
  const edge = fleet.dir > 0 ? right + fleet.step_x > fleet.right + 1e-6 : left - fleet.step_x < fleet.left - 1e-6
  fleet.steps += 1
  if (edge) {
    fleet.sy += 1
    fleet.dir = -fleet.dir
  } else {
    fleet.sx += fleet.dir
  }
  place(world, ctx)

  const { bottom } = extents(ctx)
  if (bottom < SHIELD_TOP) {
    for (const inv of invaders(ctx)) if (inv.visible) hitShields(world, ctx, inv)
  }
  if (bottom < fleet.invade_below && world.game.state === 'play') {
    finish(world, ctx, 'over', `GAME OVER: the invaders reached the bottom (lowest edge y=${bottom.toFixed(2)})`)
  }
}

// Aimed bombs come from the column nearest the cannon, the others from a random column.
function pickShooter(world: Invaders, ctx: Context, kind: 'aimed' | 'random'): Invader | undefined {
  // Rows come top to bottom, so each column's slot ends up holding its lowest invader; filter drops empty columns.
  const lowest: Invader[] = []
  for (const inv of invaders(ctx)) if (inv.visible) lowest[inv.col - 1] = inv
  const shooters = lowest.filter(Boolean)
  if (shooters.length === 0) return undefined
  if (kind !== 'aimed') return shooters[Math.floor(ctx.random() * shooters.length)]
  const x = world.cannon.x
  return shooters.reduce((best, inv) => (Math.abs(inv.x - x) < Math.abs(best.x - x) ? inv : best))
}

function dropBomb(world: Invaders, ctx: Context): void {
  const { fleet } = world
  if (fleet.bomb_wait > 0) {
    fleet.bomb_wait -= 1
    return
  }
  for (let i = 0; i < BOMBS.length; i++) {
    fleet.next_bomb = (fleet.next_bomb % BOMBS.length) + 1
    const bomb = world[BOMBS[fleet.next_bomb - 1]]
    if (bomb.visible) continue
    const shooter = pickShooter(world, ctx, bomb.kind)
    if (shooter) {
      bomb.visible = true
      bomb.age = 0
      bomb.x = shooter.x
      bomb.y = shooter.y - shooter.h / 2 - bomb.h / 2
      fleet.bomb_wait = randomInt(ctx, fleet.bomb_gap_min, fleet.bomb_gap_max)
    }
    return
  }
}

function kill(world: Invaders, ctx: Context, inv: Invader): void {
  const { fleet, boom } = world
  inv.visible = false
  boom.x = inv.x
  boom.y = inv.y
  boom.visible = true
  fleet.boom_timer = fleet.boom_ticks
  fleet.alive_count -= 1
  fleet.interval = intervalFor(fleet, fleet.alive_count)
  fleet.wait = Math.min(fleet.wait, fleet.interval)
  addScore(world, ctx, POINTS[inv.row - 1], `inv_r${inv.row}_c${inv.col}`)
  if (fleet.alive_count === 0) finish(world, ctx, 'won', 'YOU WIN: the wave is cleared')
}

function updateGame(world: Invaders, ctx: Context): void {
  const { game, hint } = world
  if (game.state === 'ready') {
    if (ctx.input.pressed('Space')) begin(world, ctx)
  } else if (game.state === 'dying') {
    game.timer -= 1
    if (game.timer <= 0) game.state = 'play'
  } else if (game.state === 'won' || game.state === 'over') {
    if (game.timer > 0) {
      game.timer -= 1
    } else if (hint.text === '') {
      hint.text = 'PRESS SPACE TO PLAY AGAIN'
    } else if (ctx.input.pressed('Space')) {
      reset(world, ctx)
      begin(world, ctx)
    }
  }
}

function updateFleet(world: Invaders, ctx: Context): void {
  const { game, fleet } = world
  if (fleet.boom_timer > 0) {
    fleet.boom_timer -= 1
    if (fleet.boom_timer === 0) world.boom.visible = false
  }
  if (game.state !== 'play') return
  fleet.wait -= 1
  if (fleet.wait <= 0) {
    march(world, ctx)
    fleet.wait = fleet.interval
  }
  if (game.state === 'play') dropBomb(world, ctx)
}

// The mystery ship crosses the top every so often while at least 8 invaders are left.
function updateUfo(world: Invaders, ctx: Context): void {
  const { game, ufo } = world
  if (game.state !== 'play') return
  if (!ufo.visible) {
    ufo.wait -= 1
    if (ufo.wait <= 0) {
      ufo.wait = ufo.every
      if (world.fleet.alive_count >= 8) {
        ufo.visible = true
        ufo.x = -ufo.dir * ufo.edge
      }
    }
    return
  }
  ufo.x += ufo.dir * ufo.speed * ctx.dt
  if (ufo.x * ufo.dir > ufo.edge) {
    ufo.visible = false
    ufo.dir = -ufo.dir
  }
}

function updateCannon(world: Invaders, ctx: Context): void {
  const { game, cannon, shot } = world
  if (game.state === 'dying') {
    cannon.visible = Math.floor(game.timer / 6) % 2 === 1
    return
  }
  cannon.visible = game.lives > 0
  if (game.state !== 'play') return

  let move = 0
  if (ctx.input.held('Left')) move -= 1
  if (ctx.input.held('Right')) move += 1
  const half = cannon.w / 2
  cannon.x = Math.max(cannon.left + half, Math.min(cannon.right - half, cannon.x + move * cannon.speed * ctx.dt))

  // The press that starts a game doesn't fire: Space has to be let go first.
  if (!ctx.input.held('Space')) {
    cannon.armed = true
  } else if (cannon.armed && !shot.visible) {
    shot.visible = true
    shot.x = cannon.x
    shot.y = cannon.y + cannon.h / 2 + shot.h / 2
  }
}

function updateShot(world: Invaders, ctx: Context): void {
  const { game, shot, ufo } = world
  if (!shot.visible) return
  if (game.state === 'dying') {
    shot.visible = false
    return
  }
  if (game.state !== 'play') return

  shot.y += shot.speed * ctx.dt
  if (hitShields(world, ctx, shot) > 0) {
    shot.visible = false
    return
  }
  for (const name of BOMBS) {
    const bomb = world[name]
    if (bomb.visible && overlaps(shot, bomb)) {
      shot.visible = false
      bomb.visible = false
      return
    }
  }
  for (const inv of invaders(ctx)) {
    if (inv.visible && overlaps(shot, inv)) {
      shot.visible = false
      kill(world, ctx, inv)
      return
    }
  }
  if (ufo.visible && overlaps(shot, ufo)) {
    shot.visible = false
    ufo.visible = false
    ufo.x = -ufo.edge - 0.2
    ufo.dir = -ufo.dir
    addScore(world, ctx, UFO_POINTS[Math.floor(ctx.random() * UFO_POINTS.length)], 'the UFO')
    return
  }
  if (shot.y - shot.h / 2 > shot.top) shot.visible = false
}

function updateBomb(world: Invaders, ctx: Context, name: BombName): void {
  const { game, cannon } = world
  const bomb = world[name]
  if (!bomb.visible) return
  if (game.state === 'dying') {
    bomb.visible = false
    return
  }
  if (game.state !== 'play') return

  bomb.y -= bomb.speed * ctx.dt
  bomb.age += 1
  const hit = CANNON_PARTS.some((part) =>
    overlaps(bomb, { x: cannon.x + part.x * cannon.w, y: cannon.y + part.y * cannon.h, w: part.w * cannon.w, h: part.h * cannon.h }),
  )
  if (hit) {
    bomb.visible = false
    cannonHit(world, ctx, name)
  } else if (hitShields(world, ctx, bomb) > 0 || bomb.y - bomb.h / 2 < bomb.ground) {
    bomb.visible = false
  }
}

// Puts everything back for a new game: once from start, and again when Space plays again.
function reset(world: Invaders, ctx: Context): void {
  const { game, fleet, ufo, cannon } = world
  game.state = 'ready'
  game.score = 0
  game.lives = game.start_lives
  game.timer = 0
  world.ground.color = GREEN
  show(world, 'PRESS SPACE TO START', WHITE)
  drawHud(world)

  for (const s of range(BUNKERS)) for (const cell of bunker(ctx, s)) cell.visible = true
  world.shields.destroyed = 0

  const wave = invaders(ctx)
  for (const inv of wave) inv.visible = inv.row <= fleet.rows && inv.col <= fleet.cols
  fleet.alive_count = wave.filter((inv) => inv.visible).length
  fleet.interval = intervalFor(fleet, fleet.alive_count)
  fleet.wait = fleet.interval
  fleet.dir = 1
  fleet.sx = 0
  fleet.sy = 0
  fleet.steps = 0
  fleet.bomb_wait = fleet.bomb_gap_max
  fleet.next_bomb = 0
  fleet.boom_timer = 0
  world.boom.visible = false
  place(world, ctx)

  ufo.visible = false
  ufo.wait = ufo.first_wait
  ufo.dir = 1
  cannon.x = cannon.home_x
  cannon.visible = true
  cannon.armed = false
  world.shot.visible = false
  for (const name of BOMBS) {
    world[name].visible = false
    world[name].age = 0
  }
}

export default defineGame({
  title: 'Invaders',
  background: '#000000',
  entities,
  start(world, ctx) {
    world.game.start_lives = world.game.lives
    world.cannon.home_x = world.cannon.x
    reset(world, ctx)
  },
  update(world, ctx) {
    updateGame(world, ctx)
    updateFleet(world, ctx)
    updateUfo(world, ctx)
    updateCannon(world, ctx)
    updateShot(world, ctx)
    for (const name of BOMBS) updateBomb(world, ctx, name)
  },
})
