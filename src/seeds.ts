// sim --seeds: the seeds a run names, a row for each seed's run, and the summary of the rows.
import { UsageError, quote, type Code } from './errors.ts'

// Each seed's run starts a process of its own, so this many take minutes; more go in runs of their own.
export const MAX_SEEDS = 10_000

// A seed that ran has its last tick and whether --until held there, and one whose game failed has the code and message sim --seed prints for it.
export type SeedRow =
  | { readonly seed: number; readonly tick: number; readonly reached: boolean; readonly code: null; readonly message: null }
  | { readonly seed: number; readonly tick: null; readonly reached: null; readonly code: Code; readonly message: string }

export interface Summary {
  readonly seeds: number
  readonly reached: number
  readonly failed: number
  // The ticks where --until held, over the seeds that reached it.
  readonly min: number | null
  readonly median: number | null
  readonly max: number | null
}

interface Span {
  first: number
  last: number
}

// Seeds like 7 or -3 and spans like 0-99 or -10--1, separated by commas. The seeds come back in order, each once, counted from the merged spans so a huge span is refused before it's spelled out.
export function parseSeeds(text: string): number[] {
  const spans = text.split(',').map((part): Span => {
    const match = /^(-?\d+)(?:-(-?\d+))?$/.exec(part.trim())
    const first = match === null ? Number.NaN : Number(match[1])
    const last = match?.[2] === undefined ? first : Number(match[2])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw new UsageError(`--seeds ${quote(text)}: "${part.trim()}" should be a seed like 7 or a span like 0-99`)
    if (last < first) throw new UsageError(`--seeds ${quote(text)}: span ${part.trim()} ends before it starts`)
    return { first, last }
  })
  const merged: Span[] = []
  for (const span of spans.toSorted((a, b) => a.first - b.first)) {
    const before = merged.at(-1)
    if (before !== undefined && span.first <= before.last + 1) before.last = Math.max(before.last, span.last)
    else merged.push({ ...span })
  }
  const count = merged.reduce((sum, { first, last }) => sum + last - first + 1, 0)
  if (count > MAX_SEEDS) throw new UsageError(`--seeds ${quote(text)} names ${count} seeds, and one run takes at most ${MAX_SEEDS}; split them into several`)
  // Adding 0 to -0 gives 0, so a seed of -0 prints as the 0 it runs as.
  return merged.flatMap(({ first, last }) => Array.from({ length: last - first + 1 }, (_, i) => first + i))
}

// The median of an even count is halfway between the two middle ticks.
export function summarize(rows: readonly SeedRow[]): Summary {
  const ticks = rows.flatMap((row) => (row.reached === true ? [row.tick] : [])).sort((a, b) => a - b)
  const half = Math.floor(ticks.length / 2)
  const median = ticks.length === 0 ? null : ticks.length % 2 === 1 ? ticks[half] : (ticks[half - 1] + ticks[half]) / 2
  const failed = rows.filter((row) => row.code !== null).length
  return { seeds: rows.length, reached: ticks.length, failed, min: ticks.at(0) ?? null, median, max: ticks.at(-1) ?? null }
}
