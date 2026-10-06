// What went wrong, which every failure prints as its code with a one-line message.
export type Code = 'USAGE' | 'BUILD_ERROR' | 'TYPE_ERROR' | 'GAME_ERROR' | 'TIMEOUT' | 'OUTPUT_TOO_LARGE' | 'BROWSER_ERROR' | 'IO_ERROR' | 'INTERNAL_ERROR'

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

// The game's files couldn't be bundled: a syntax error, or an import that doesn't resolve or that the import rule refuses.
export class BuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildError'
  }
}

// Chrome is missing, didn't start, or stopped answering, which no change to the game would fix.
export class BrowserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}

// A file or folder couldn't be read, made, or written.
export class IoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IoError'
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
