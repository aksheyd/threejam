// The road and the vehicles' sizes, which game.ts plays by and view.ts draws: the road runs up the screen from x -0.9 to 0.9, in three lanes with these middles.
export const LANES = [-0.6, 0, 0.6]
export const ROAD_EDGE = 0.9
export const KINDS = ['car', 'van', 'truck'] as const
export const LENGTHS: Record<(typeof KINDS)[number], number> = { car: 0.46, van: 0.56, truck: 0.92 }
// Two vehicles touch when they're closer than half their widths together, 0.32 here: more than half the 0.6 between lanes, so traffic can reach the car anywhere on the road, and little enough more that the car can still move to the next lane between two rows.
export const RACER = { w: 0.3, h: 0.46 }
export const TRAFFIC_WIDTH = 0.34
