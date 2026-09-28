// Plays seed 0's first seven pieces into two cleared rows: npx fourjs sim games/tetris --ticks 400 --driver games/tetris/plan.ts
import type { Driver, DriverFrame, EntitiesOf } from '@aksheyd/fourjs'
import type tetris from './game.ts'

type Game = DriverFrame<EntitiesOf<typeof tetris>>['world']['game']

// PLAN[spawned - 1] is where that piece goes: how many turns, and the column of its left edge.
const PLAN: ReadonlyArray<Pick<Game, 'piece' | 'turn' | 'left'>> = [
  { piece: 'L', turn: 0, left: 1 },
  { piece: 'I', turn: 0, left: 4 },
  { piece: 'S', turn: 0, left: 1 },
  { piece: 'J', turn: 0, left: 8 },
  { piece: 'Z', turn: 1, left: 7 },
  { piece: 'T', turn: 0, left: 4 },
  { piece: 'O', turn: 0, left: 9 },
]

// Up, Left, and Right go down on odd ticks and up on even ones, so each press turns or moves the piece once.
const plan: Driver<EntitiesOf<typeof tetris>> = ({ world: { game }, tick }) => {
  if (game.state === 'waiting') return ['Space']
  const target = PLAN[game.spawned - 1]
  if (game.state === 'over' || target === undefined) return []
  if (target.piece !== game.piece) throw new Error(`piece ${game.spawned} is ${game.piece}, but the plan expects ${target.piece}; it's written for seed 0`)
  const tap = tick % 2 === 1
  if (game.turn !== target.turn) return tap ? ['Up'] : []
  if (game.left !== target.left) return tap ? [game.left < target.left ? 'Right' : 'Left'] : []
  return ['Down']
}
export default plan
