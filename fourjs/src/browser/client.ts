import { Session, pick } from '../engine.ts'
import { keyFromCode, schedule, type Key } from '../input.ts'
import type { Game } from '../types.ts'
import { View, type ViewModule } from './view.ts'

export interface Config {
  mode: 'run' | 'shot'
  seed?: number
}

export interface ResetOptions {
  seed?: number
  ticks?: number
  press?: string[]
  hold?: string[]
  set?: string[]
}

declare global {
  interface Window {
    FOUR: Config
    engine: unknown
  }
}

const TICK_MS = 1000 / 60

export function play(game: Game, custom: ViewModule, config: Config): void {
  const canvas = document.querySelector('canvas')
  if (!canvas) throw new Error('the page needs a <canvas>')
  if (game.title) document.title = game.title
  const view = new View(canvas, game, custom)
  const down = new Set<Key>()
  // A tap shorter than a tick still counts as held for one tick.
  const tapped = new Set<Key>()
  let session: Session | undefined
  let keysAt: ((tick: number) => Set<Key>) | undefined
  let paused = false
  let stopped = false

  const current = () => {
    if (!session) throw new Error('call engine.reset() first')
    return session
  }
  const draw = () => {
    const s = current()
    view.draw(s.drawables(), s.fields(), s.tick)
  }
  const stepOnce = () => {
    const s = current()
    if (keysAt) {
      s.step(keysAt(s.tick + 1))
      return
    }
    s.step(new Set([...down, ...tapped]))
    tapped.clear()
  }

  function reset(options: ResetOptions = {}): number {
    session = new Session(game, { seed: options.seed ?? randomSeed(), set: options.set })
    keysAt = options.ticks === undefined ? undefined : schedule(options.press ?? [], options.hold ?? [], options.ticks)
    session.start()
    draw()
    return session.seed
  }

  window.engine = {
    reset,
    step(count = 1) {
      for (let i = 0; i < count; i++) stepOnce()
      draw()
      return current().tick
    },
    advanceTo(tick: number) {
      while (current().tick < tick) stepOnce()
      draw()
      return current().tick
    },
    state(only?: string) {
      return pick(current().state(), only)
    },
    logs() {
      return [...current().logs]
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
    get paused() {
      return paused
    },
    get tick() {
      return current().tick
    },
    get seed() {
      return current().seed
    },
  }

  if (config.mode === 'shot') {
    view.resize(800, 600, 1)
    return
  }

  const fit = () => {
    const scale = Math.min(innerWidth / 800, innerHeight / 600)
    view.resize(Math.floor(800 * scale), Math.floor(600 * scale))
  }
  fit()
  addEventListener('resize', fit)
  new EventSource('/events').onmessage = () => location.reload()

  const fail = (error: unknown) => {
    stopped = true
    console.error(error)
    notice(`${error instanceof Error ? error.message : String(error)}\n\nFix the game and save; the page reloads.`)
  }

  try {
    reset({ seed: config.seed })
    console.log(`seed ${current().seed}`)
  } catch (error) {
    fail(error)
    return
  }

  addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      stopped = true
      fetch('/quit', { method: 'POST' }).catch(() => {})
      notice('Session ended.')
      window.close()
      return
    }
    if (event.metaKey) return
    const key = keyFromCode(event.code)
    if (key) {
      down.add(key)
      tapped.add(key)
      event.preventDefault()
    }
  })
  addEventListener('keyup', (event) => {
    const key = keyFromCode(event.code)
    if (key) down.delete(key)
  })
  addEventListener('blur', () => {
    down.clear()
    tapped.clear()
  })

  let last = performance.now()
  let owed = 0
  const frame = (now: number) => {
    if (stopped) return
    if (!paused && !document.hidden) {
      owed = Math.min(owed + (now - last), 250)
      try {
        while (owed >= TICK_MS) {
          stepOnce()
          owed -= TICK_MS
        }
      } catch (error) {
        fail(error)
        return
      }
    }
    last = now
    draw()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

function notice(message: string): void {
  const box = document.createElement('pre')
  box.textContent = message
  box.style.cssText =
    'position:fixed;inset:auto 16px 16px 16px;margin:0;padding:12px 16px;background:rgba(0,0,0,.8);color:#f2f2f2;' +
    'font:14px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;border-radius:6px'
  document.body.append(box)
}
