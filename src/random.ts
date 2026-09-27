import { UsageError } from './errors.ts'

export function checkSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) throw new UsageError(`seed must be a whole number, got ${seed}`)
  return seed
}

export function createRandom({ seed, stream = 0 }: { seed: number; stream?: number }): () => number {
  let state = mix(checkSeed(seed)) ^ Math.imul(stream, 0x9e3779b9)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mix(seed: number): number {
  const low = seed >>> 0
  const high = Math.floor(seed / 4294967296) | 0
  let h = Math.imul(low ^ 0x9e3779b9, 0x85ebca6b) ^ high
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) | 0
}
