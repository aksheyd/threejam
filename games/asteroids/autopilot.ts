// A bot that plays Asteroids with the mouse, for tests and sim --driver: it holds the button with the pointer on the nearest rock.
import type { Driver, EntitiesOf } from '@aksheyd/fourjs'
import type asteroids from './game.ts'

const autopilot: Driver<EntitiesOf<typeof asteroids>> = ({ world: { game, ship, rocks }, keys }) => {
  // A click starts a game, and the button has to come up before the next click counts.
  if (game.state === 'ready' || game.state === 'over') return keys.includes('Mouse') ? [] : ['Mouse']
  const away = (rock: { x: number; y: number }) => (rock.x - ship.x) * (rock.x - ship.x) + (rock.y - ship.y) * (rock.y - ship.y)
  const nearest = rocks.filter((rock) => rock.visible).sort((a, b) => away(a) - away(b))[0]
  if (game.state === 'dead' || nearest === undefined) return []
  return { keys: ['Mouse'], pointer: { x: Math.max(-2, Math.min(2, nearest.x)), y: Math.max(-1.5, Math.min(1.5, nearest.y)) } }
}
export default autopilot
