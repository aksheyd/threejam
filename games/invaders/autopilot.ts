// A bot that plays Invaders, for tests and for sim --driver.
import type { Driver, DriverFrame, EntitiesOf, Key } from 'threejam'
import game, { frontLine } from './game.ts'

type Invaders = DriverFrame<EntitiesOf<typeof game>>['world']

// Dodge a bomb about to land on the cannon; otherwise line up under the nearest column's lowest invader and fire.
function steer(world: Invaders): { move: number; fire: boolean } {
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
  let best: { x: number; w: number } | undefined
  for (const inv of frontLine(world.invaders)) {
    const x = inv.x + drift * ((inv.y - cannon.y) / (shot.speed / 60))
    if (!best || Math.abs(x - cannon.x) < Math.abs(best.x - cannon.x)) best = { x, w: inv.w }
  }
  if (!best) return { move: 0, fire: false }
  const dx = best.x - cannon.x
  return { move: Math.abs(dx) > 0.01 ? Math.sign(dx) : 0, fire: Math.abs(dx) < best.w / 2 - 0.01 }
}

// Presses Space 30 ticks after the play-again hint appears; the tick it remembers clears whenever the hint is hidden.
export function autopilot(): Driver<EntitiesOf<typeof game>> {
  let hintSince: number | undefined
  return ({ world, tick }) => {
    hintSince = world.hint.text === '' ? undefined : (hintSince ?? tick)
    switch (world.game.state) {
      case 'ready':
        return ['Space']
      case 'dying':
        return []
      case 'won':
      case 'over':
        return hintSince !== undefined && tick - hintSince >= 30 ? ['Space'] : []
      case 'play': {
        const { move, fire } = steer(world)
        const keys: Key[] = []
        if (move < 0) keys.push('Left')
        if (move > 0) keys.push('Right')
        // The cannon ignores Space until it has been let go after the press that started the game.
        if (fire && world.cannon.armed) keys.push('Space')
        return keys
      }
      default: {
        const _exhaustive: never = world.game.state
        return _exhaustive
      }
    }
  }
}

export default autopilot()
