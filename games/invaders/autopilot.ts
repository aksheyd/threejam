// A bot that plays Invaders; FourJS has no input drivers yet, so tests step a Session with it.
import type { Value } from 'fourjs'
import type { Invader, Invaders } from './game.ts'

type Fields = Readonly<Record<string, Record<string, Value>>>

// Dodge a bomb about to land on the cannon; otherwise line up under the nearest column's lowest invader and fire.
function steer(world: Invaders, invaders: Invader[]): { move: number; fire: boolean } {
  const { cannon, fleet, shot } = world
  const half = cannon.w / 2
  for (const bomb of [world.bomb1, world.bomb2, world.bomb3]) {
    const dx = bomb.x - cannon.x
    if (bomb.visible && bomb.y - cannon.y < 0.5 && Math.abs(dx) < half + bomb.w / 2 + 0.05) {
      const away = dx > 0 ? -1 : 1
      const x = cannon.x + away * 0.2
      return { move: x < cannon.left + half || x > cannon.right - half ? -away : away, fire: false }
    }
  }

  const drift = (fleet.dir * fleet.step_x) / fleet.interval
  const lowest: Invader[] = []
  for (const inv of invaders) if (inv.visible) lowest[inv.col - 1] = inv
  let best: { x: number; w: number } | undefined
  for (const inv of lowest.filter(Boolean)) {
    const x = inv.x + drift * ((inv.y - cannon.y) / (shot.speed / 60))
    if (!best || Math.abs(x - cannon.x) < Math.abs(best.x - cannon.x)) best = { x, w: inv.w }
  }
  if (!best) return { move: 0, fire: false }
  const dx = best.x - cannon.x
  return { move: Math.abs(dx) > 0.01 ? Math.sign(dx) : 0, fire: Math.abs(dx) < best.w / 2 - 0.01 }
}

// Picks the keys for one tick from the state the previous tick left; hintSeen is when the play-again hint appeared.
export function autopilot(fields: Fields, tick: number, hintSeen: number | undefined): { keys: string[]; hintSeen: number | undefined } {
  const world = fields as unknown as Invaders
  const { state } = world.game
  if (state === 'ready') return { keys: ['Space'], hintSeen }
  if (state === 'won' || state === 'over') {
    if (world.hint.text === '') return { keys: [], hintSeen: undefined }
    const seen = hintSeen ?? tick
    return { keys: tick - seen >= 30 ? ['Space'] : [], hintSeen: seen }
  }
  if (state !== 'play') return { keys: [], hintSeen }

  const invaders = Object.keys(fields)
    .filter((name) => name.startsWith('inv_'))
    .map((name) => fields[name] as unknown as Invader)
  const { move, fire } = steer(world, invaders)
  const keys: string[] = []
  if (move < 0) keys.push('Left')
  if (move > 0) keys.push('Right')
  // The cannon ignores Space until it has been let go after the press that started the game.
  if (fire && world.cannon.armed) keys.push('Space')
  return { keys, hintSeen }
}
