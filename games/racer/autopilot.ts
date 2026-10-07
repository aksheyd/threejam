// A bot that plays Racer, for tests and sim --driver: it steers for the lane whose next car is furthest ahead, crossing only lanes with no car alongside, and takes a coin when that lane is about as clear. It leans to the middle lane, from which either side is one move away.
import type { Driver, DriverFrame, EntitiesOf, Key } from 'threejam'
import type racer from './game.ts'
import { LANES } from './road.ts'

type Racer = DriverFrame<EntitiesOf<typeof racer>>['world']

// How far ahead of the car's front the bot looks, and how far behind it a car still counts as alongside; traffic is slower, so one behind never comes back.
const LOOK = 4
const BESIDE = 0.05

// How far the car's front is from the back of the next car in a lane, which is negative when a car is alongside; a wreck off the road is in no lane.
function clearance({ car, race, traffic }: Racer, lane: number): number {
  let nearest = LOOK
  for (const other of traffic) {
    const parked = other.crashed && Math.abs(other.x) >= race.verge
    if (!other.visible || parked || Math.abs(other.x - LANES[lane]) >= (other.w + car.w) / 2) continue
    if (other.y + other.h / 2 > car.y - car.h / 2 - BESIDE) nearest = Math.min(nearest, other.y - other.h / 2 - (car.y + car.h / 2))
  }
  return nearest
}

function coinAhead({ car, coins }: Racer, lane: number, within: number): boolean {
  return coins.some((coin) => coin.visible && coin.x === LANES[lane] && coin.y > car.y && coin.y - car.y < within)
}

function bestLane(world: Racer): number {
  const { car, race } = world
  const now = LANES.reduce((best, x, i) => (Math.abs(x - car.x) < Math.abs(LANES[best] - car.x) ? i : best), 0)
  const clear = LANES.map((_, lane) => clearance(world, lane))
  // A lane can be crossed or taken when its next car will still be ahead once the car has moved over to it.
  const closing = Math.max(0, car.speed - race.traffic_speed)
  const open = (lane: number) => clear[lane] > (closing * (Math.abs(LANES[lane] - car.x) + car.w)) / car.steer_speed + 0.15
  const reachable = (to: number) => {
    for (let lane = Math.min(now, to); lane <= Math.max(now, to); lane++) if (lane !== now && !open(lane)) return false
    return true
  }
  const worth = (lane: number) => clear[lane] + (clear[lane] > 1.5 && coinAhead(world, lane, clear[lane]) ? 0.6 : 0) + (lane === 1 ? 0.4 : 0)
  let best = now
  for (const lane of [0, 1, 2]) if (lane !== now && reachable(lane) && worth(lane) > worth(best) + 0.3) best = lane
  return best
}

const autopilot: Driver<EntitiesOf<typeof racer>> = ({ world, keys }) => {
  const { car, race } = world
  // Space starts a race and, once one is over, races again, and has to come up before the next press counts.
  const space: Key[] = race.state !== 'play' && !keys.includes('Space') ? ['Space'] : []
  if (race.state === 'ready') return space
  // It steers after the finish too, since the car still overtakes the traffic as it slows down.
  // Letting go turns the wheel back to straight ahead, which carries the car this much further.
  const coast = (car.steer * Math.abs(car.steer) * car.steer_speed) / (2 * car.turn_rate)
  const off = LANES[bestLane(world)] - car.x - coast
  const held: Key[] = off > 0.02 ? ['Right'] : off < -0.02 ? ['Left'] : []
  return [...held, ...space]
}
export default autopilot
