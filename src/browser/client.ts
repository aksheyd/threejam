import { Session, parseGame, pick } from '../engine.ts'
import { keyFromCode, schedule } from '../input.ts'
import { driverFor, isDrive, type Drive, type Driver, type EntityState, type Key } from '../types.ts'
import { View, parseView } from './view.ts'

export interface Config {
  readonly mode: 'run' | 'shot'
  readonly seed?: number
}

export interface ResetOptions {
  readonly seed?: number
  readonly ticks?: number
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly set?: readonly string[]
  readonly drive?: boolean
}

export interface PageEngine {
  reset(options?: ResetOptions): number
  step(count?: number): number
  advanceTo(tick: number): number
  state(only?: string): EntityState[]
  pause(): void
  resume(): void
  readonly paused: boolean
  readonly tick: number
  readonly seed: number
}

declare global {
  interface Window {
    FOUR: unknown
    engine: PageEngine
  }
}

type Source =
  | { readonly kind: 'keyboard' }
  | { readonly kind: 'schedule'; readonly keysAt: (tick: number) => ReadonlySet<Key> }
  | { readonly kind: 'driver'; readonly driver: Driver }

const TICK_MS = 1000 / 60

export function play(page: { game: unknown; view: unknown; driver: unknown; config: unknown }): void {
  const game = parseGame(page.game)
  const config = parseConfig(page.config)
  const drive = parseDrive(page.driver)
  const canvas = document.querySelector('canvas')
  if (!canvas) throw new Error('the page needs a <canvas>')
  if (game.title) document.title = game.title
  const view = new View({ canvas, game, custom: parseView(page.view) })
  const down = new Set<Key>()
  // A tap shorter than a tick still counts as held for one tick.
  const tapped = new Set<Key>()
  let session: Session | undefined
  let source: Source = { kind: 'keyboard' }
  let paused = false
  let stopped = false

  const current = (): Session => {
    if (!session) throw new Error('call engine.reset() first')
    return session
  }
  const draw = () => {
    const s = current()
    view.draw({ drawables: s.drawables(), world: s.world, tick: s.tick })
  }
  const stepOnce = () => {
    const s = current()
    switch (source.kind) {
      case 'keyboard':
        s.step([...down, ...tapped])
        tapped.clear()
        return
      case 'schedule':
        s.step(source.keysAt(s.tick + 1))
        return
      case 'driver':
        s.step(s.drive(source.driver))
        return
      default: {
        const _exhaustive: never = source
        void _exhaustive
      }
    }
  }

  const reset = (options: ResetOptions = {}): number => {
    session = new Session(game, { seed: options.seed ?? config.seed ?? 0, set: options.set })
    source = inputSource(options, drive)
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
    advanceTo(tick) {
      while (current().tick < tick) stepOnce()
      draw()
      return current().tick
    },
    state: (only) => pick(current().state(), only),
    pause: () => void (paused = true),
    resume: () => void (paused = false),
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
    reset()
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
    try {
      if (!paused && !document.hidden) {
        owed = Math.min(owed + (now - last), 250)
        for (; owed >= TICK_MS; owed -= TICK_MS) stepOnce()
      }
      last = now
      draw()
    } catch (error) {
      fail(error)
      return
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function inputSource(options: ResetOptions, drive: Drive | undefined): Source {
  if (options.drive) {
    if (!drive) throw new Error('this page was built without a driver')
    return { kind: 'driver', driver: driverFor(drive) }
  }
  if (options.ticks === undefined) return { kind: 'keyboard' }
  return { kind: 'schedule', keysAt: schedule({ press: options.press ?? [], hold: options.hold ?? [], ticks: options.ticks, clip: true }) }
}

function parseConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null || !('mode' in value)) throw new Error('the page has no FourJS config')
  const seed = 'seed' in value && typeof value.seed === 'number' ? value.seed : undefined
  if (value.mode === 'run' || value.mode === 'shot') return { mode: value.mode, seed }
  throw new Error(`unknown page mode ${String(value.mode)}`)
}

function parseDrive(value: unknown): Drive | undefined {
  if (value === undefined) return undefined
  if (isDrive(value)) return value
  throw new Error('the driver file must export default a driver function or defineDriver(...)')
}

function notice(message: string): void {
  const box = document.createElement('pre')
  box.textContent = message
  box.style.cssText =
    'position:fixed;inset:auto 16px 16px 16px;margin:0;padding:12px 16px;background:rgba(0,0,0,.8);color:#f2f2f2;' +
    'font:14px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;border-radius:6px'
  document.body.append(box)
}
