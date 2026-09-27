export class GameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GameError'
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type Phase = 'start' | 'update' | 'driver'

export class RunError extends Error {
  readonly phase: Phase
  readonly tick: number

  constructor({ phase, tick, cause }: { phase: Phase; tick: number; cause: unknown }) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'RunError'
    this.phase = phase
    this.tick = tick
  }
}

export function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || value === undefined || typeof value === 'function') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function quote(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text)
}
