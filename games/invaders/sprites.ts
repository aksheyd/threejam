// The sprites game.ts draws, one string per row of pixels; the cannon's pixels are also its hitbox.
import type { Sprites } from 'threejam'

export type Box = { x: number; y: number; w: number; h: number }

export const sprites = {
  cannon: {
    rows: [
      '......#......',
      '.....###.....',
      '.....###.....',
      '.###########.',
      '#############',
      '#############',
      '#############',
      '#############',
    ],
  },
  squid_0: {
    rows: [
      '...##...',
      '..####..',
      '.######.',
      '##.##.##',
      '########',
      '..#..#..',
      '.#.##.#.',
      '#.#..#.#',
    ],
  },
  squid_1: {
    rows: [
      '...##...',
      '..####..',
      '.######.',
      '##.##.##',
      '########',
      '.#.##.#.',
      '#......#',
      '.#....#.',
    ],
  },
  crab_0: {
    rows: [
      '..#.....#..',
      '...#...#...',
      '..#######..',
      '.##.###.##.',
      '###########',
      '#.#######.#',
      '#.#.....#.#',
      '...##.##...',
    ],
  },
  crab_1: {
    rows: [
      '..#.....#..',
      '#..#...#..#',
      '#.#######.#',
      '###.###.###',
      '###########',
      '.#########.',
      '..#.....#..',
      '.#.......#.',
    ],
  },
  octopus_0: {
    rows: [
      '....####....',
      '.##########.',
      '############',
      '###..##..###',
      '############',
      '...##..##...',
      '..##.##.##..',
      '##........##',
    ],
  },
  octopus_1: {
    rows: [
      '....####....',
      '.##########.',
      '############',
      '###..##..###',
      '############',
      '..###..###..',
      '.##..##..##.',
      '..##....##..',
    ],
  },
  ufo: {
    rows: [
      '.....######.....',
      '...##########...',
      '..############..',
      '.##.##.##.##.##.',
      '################',
      '..###..##..###..',
      '...#........#...',
    ],
  },
  boom: {
    rows: [
      '....#...#....',
      '.#...#.#...#.',
      '..#.......#..',
      '##.........##',
      '..#.......#..',
      '.#...#.#...#.',
      '....#...#....',
    ],
  },
  bomb_0: { rows: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.'] },
  bomb_1: { rows: ['.#.', '.#.', '###', '.#.', '.#.', '.#.', '.#.'] },
  bomb_2: { rows: ['.#.', '.#.', '.#.', '.#.', '.#.', '###', '.#.'] },
} satisfies Sprites

type Name = keyof typeof sprites

// The two poses of each row of the fleet, top to bottom; the fleet switches pose on every step.
export const POSES: readonly (readonly [Name, Name])[] = [
  ['squid_0', 'squid_1'],
  ['crab_0', 'crab_1'],
  ['crab_0', 'crab_1'],
  ['octopus_0', 'octopus_1'],
  ['octopus_0', 'octopus_1'],
]

// A falling bomb's frames, its crossbar sliding down its stem.
export const BOMB_FRAMES: readonly Name[] = ['bomb_0', 'bomb_1', 'bomb_2']

// The lit runs of each row as boxes in a unit square centered on the sprite, so an entity's w and h scale them.
export function boxes(art: readonly string[]): Box[] {
  const w = 1 / art[0].length
  const h = 1 / art.length
  return art.flatMap((row, r) =>
    [...row.matchAll(/#+/g)].map((run) => ({ x: (run.index + run[0].length / 2) * w - 0.5, y: 0.5 - (r + 0.5) * h, w: run[0].length * w, h })),
  )
}
