import { Session, parseGame, pick } from '../engine.ts'
import { CENTER, keyFromCode, pointerMoves, schedule } from '../input.ts'
import { driverFor, isDrive, type Drive, type Driver, type EntityState, type Key, type Point, type SoundEntry } from '../types.ts'
import { loadImages, parseAssets } from './assets.ts'
import { Speaker } from './sound.ts'
import { View, parseView } from './view.ts'

// run is served by threejam run, whose server takes the token with /events and /quit, shot by threejam shot, and export is one file opened from disk, with no server behind it.
export type Config =
  | { readonly mode: 'run'; readonly seed: number; readonly token: string }
  | { readonly mode: 'shot' }
  | { readonly mode: 'export'; readonly seed?: number }

export interface ResetOptions {
  readonly seed?: number
  readonly ticks?: number
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly pointer?: readonly string[]
  readonly set?: readonly string[]
  readonly drive?: boolean
}

export interface PageEngine {
  reset(options?: ResetOptions): number
  step(count?: number): number
  advanceTo(tick: number): number
  state(only?: string): EntityState[]
  sounds(): SoundEntry[]
  pause(): void
  resume(): void
  readonly paused: boolean
  readonly tick: number
  readonly seed: number
}

declare global {
  interface Window {
    THREEJAM: unknown
    engine: PageEngine
  }
}

type Source =
  | { readonly kind: 'keyboard' }
  | { readonly kind: 'schedule'; readonly keysAt: (tick: number) => ReadonlySet<Key>; readonly pointerAt: (tick: number) => Point | undefined }
  | { readonly kind: 'driver'; readonly driver: Driver }

const TICK_MS = 1000 / 60
const BUTTONS: ReadonlyMap<number, Key> = new Map([
  [0, 'Mouse'],
  [2, 'MouseRight'],
])

export async function play(page: { game: unknown; view: unknown; driver: unknown; assets: unknown; config: unknown }): Promise<void> {
  const game = parseGame(page.game)
  const config = parseConfig(page.config)
  const drive = parseDrive(page.driver)
  const assets = parseAssets(page.assets)
  const canvas = document.querySelector('canvas')
  if (!canvas) throw new Error('the page needs a <canvas>')
  if (game.title) document.title = game.title
  const reloads = config.mode === 'run'
  if (config.mode === 'run') new EventSource(`/events?token=${encodeURIComponent(config.token)}`).onmessage = () => location.reload()
  // Every image is ready before the first frame, so no frame shows one half loaded.
  const images = await loadImages(assets).catch((error: unknown) => {
    const fix = reloads ? '\n\nFix the file and save; the page reloads.' : ''
    if (config.mode !== 'shot') notice(`${error instanceof Error ? error.message : String(error)}${fix}`)
    throw error
  })
  const view = new View({ canvas, game, custom: parseView(page.view), images })
  const speaker = config.mode === 'shot' ? undefined : new Speaker(assets)
  const seed = config.mode === 'shot' ? 0 : (config.seed ?? Math.floor(Math.random() * 2 ** 31))
  const down = new Set<Key>()
  // A tap shorter than a tick still counts as held for one tick.
  const tapped = new Set<Key>()
  let pointer = CENTER
  let session: Session | undefined
  let source: Source = { kind: 'keyboard' }
  let paused = false
  let stopped = false
  // How many of the session's sounds the speaker has had.
  let heard = 0

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
        s.step({ keys: [...down, ...tapped], pointer })
        tapped.clear()
        return
      case 'schedule':
        s.step({ keys: source.keysAt(s.tick + 1), pointer: source.pointerAt(s.tick + 1) })
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
    session = new Session(game, { seed: options.seed ?? seed, set: options.set, assets: Object.keys(assets) })
    source = inputSource(options, drive)
    heard = 0
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
    sounds: () => [...current().sounds],
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

  const fail = (error: unknown) => {
    stopped = true
    console.error(error)
    notice(`${error instanceof Error ? error.message : String(error)}${reloads ? '\n\nFix the game and save; the page reloads.' : ''}`)
  }

  try {
    reset()
  } catch (error) {
    fail(error)
    return
  }

  addEventListener('keydown', (event) => {
    speaker?.unlock()
    if (event.code === 'Escape' && config.mode === 'run') {
      stopped = true
      fetch(`/quit?token=${encodeURIComponent(config.token)}`, { method: 'POST' }).catch(() => {})
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
  // The pointer is in world units and stays on the screen, keeping its last place when the mouse leaves the page.
  const aim = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * 4 - 2
    const y = 1.5 - ((event.clientY - box.top) / box.height) * 3
    pointer = Object.freeze({ x: Math.min(2, Math.max(-2, x)), y: Math.min(1.5, Math.max(-1.5, y)) })
  }
  addEventListener('pointermove', aim)
  addEventListener('pointerdown', (event) => {
    speaker?.unlock()
    aim(event)
    const key = BUTTONS.get(event.button)
    if (key) {
      down.add(key)
      tapped.add(key)
    }
  })
  addEventListener('pointerup', (event) => {
    const key = BUTTONS.get(event.button)
    if (key) down.delete(key)
  })
  addEventListener('contextmenu', (event) => event.preventDefault())
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
      const { sounds } = current()
      for (; heard < sounds.length; heard++) speaker?.play(sounds[heard])
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
  const { ticks } = options
  if (ticks === undefined) return { kind: 'keyboard' }
  return {
    kind: 'schedule',
    keysAt: schedule({ press: options.press ?? [], hold: options.hold ?? [], ticks, clip: true }),
    pointerAt: pointerMoves({ pointer: options.pointer ?? [], ticks, clip: true }),
  }
}

function parseConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null || !('mode' in value)) throw new Error('the page has no ThreeJam config')
  const seed = 'seed' in value && typeof value.seed === 'number' ? value.seed : undefined
  switch (value.mode) {
    case 'run': {
      const token = 'token' in value && typeof value.token === 'string' ? value.token : undefined
      if (seed === undefined || token === undefined) throw new Error('the run page has no seed or token')
      return { mode: 'run', seed, token }
    }
    case 'shot':
      return { mode: 'shot' }
    case 'export':
      return { mode: 'export', seed }
    default:
      throw new Error(`unknown page mode ${String(value.mode)}`)
  }
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
