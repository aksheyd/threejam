// Pixel art for the sprites, one string per row. game.ts uses the cannon's pixels as its hitbox; view.ts draws them all.

export type Box = { x: number; y: number; w: number; h: number }

export const CANNON = [
  '......#......',
  '.....###.....',
  '.....###.....',
  '.###########.',
  '#############',
  '#############',
  '#############',
  '#############',
]

const SQUID = [
  ['...##...', '..####..', '.######.', '##.##.##', '########', '..#..#..', '.#.##.#.', '#.#..#.#'],
  ['...##...', '..####..', '.######.', '##.##.##', '########', '.#.##.#.', '#......#', '.#....#.'],
]

const CRAB = [
  ['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...##.##...'],
  ['..#.....#..', '#..#...#..#', '#.#######.#', '###.###.###', '###########', '.#########.', '..#.....#..', '.#.......#.'],
]

const OCTOPUS = [
  ['....####....', '.##########.', '############', '###..##..###', '############', '...##..##...', '..##.##.##..', '##........##'],
  ['....####....', '.##########.', '############', '###..##..###', '############', '..###..###..', '.##..##..##.', '..##....##..'],
]

// Two poses per row, top to bottom; the fleet switches pose on every step.
export const INVADERS = [SQUID, CRAB, CRAB, OCTOPUS, OCTOPUS]

export const UFO = [
  '.....######.....',
  '...##########...',
  '..############..',
  '.##.##.##.##.##.',
  '################',
  '..###..##..###..',
  '...#........#...',
]

export const BOOM = [
  '....#...#....',
  '.#...#.#...#.',
  '..#.......#..',
  '##.........##',
  '..#.......#..',
  '.#...#.#...#.',
  '....#...#....',
]

// The lit runs of each row as boxes in a unit square centered on the sprite, so an entity's w and h scale them.
export function boxes(art: readonly string[]): Box[] {
  const w = 1 / art[0].length
  const h = 1 / art.length
  return art.flatMap((row, r) =>
    [...row.matchAll(/#+/g)].map((run) => ({ x: (run.index + run[0].length / 2) * w - 0.5, y: 0.5 - (r + 0.5) * h, w: run[0].length * w, h })),
  )
}
