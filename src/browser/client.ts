import { Session, parseGame, pick } from '../engine.ts'
import { guarded, loading, throughout } from '../guard.ts'
import { CENTER, keyFromCode, pointerMoves, schedule } from '../input.ts'
import { driverFor, isDrive, type Drive, type Driver, type EntityState, type Game, type Key, type Point, type SoundEntry } from '../types.ts'
import { loadImages, parseAssets, type Assets } from './assets.ts'
import { barePage } from './bare.ts'
import { Speaker } from './sound.ts'
import { View, parseView, type ViewModule } from './view.ts'

// run is served by threejam run, whose server takes the token with /events and /quit, and the build the page comes from with /events, and gives the failure when the latest save didn't build, shot by threejam shot, and export is one file opened from disk, with no server behind it.
export type Config =
  | { readonly mode: 'run'; readonly seed: number; readonly token: string; readonly build: number; readonly failure?: string }
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

// The game's, view's, and driver's modules, each loaded when called.
export interface PageModules {
  readonly game: () => unknown
  readonly view: () => unknown
  readonly driver: (() => unknown) | undefined
}

const FIX_GAME = 'Fix the game and save; the page reloads.'

// realm names the globals sim's realm has, which game code keeps while the page around it is bared.
export async function play(page: PageModules & { assets: unknown; config: unknown; realm: readonly string[] }): Promise<void> {
  const bare = barePage(page.realm)
  const config = parseConfig(page.config)
  const reloads = config.mode === 'run'
  let stopped = false
  // First, so the page of a game that fails below still reloads when a fix is saved, and still quits with Esc.
  if (config.mode === 'run') {
    new EventSource(`/events?token=${encodeURIComponent(config.token)}&build=${config.build}`).onmessage = () => location.reload()
    addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') return
      stopped = true
      fetch(`/quit?token=${encodeURIComponent(config.token)}`, { method: 'POST' }).catch(() => {})
      notice('Session ended.')
      window.close()
    })
  }
  // Before the game runs, a failure shows on the page too, except in shot, which reads the page's error instead.
  const reported = (error: unknown, fix?: string): unknown => {
    if (config.mode !== 'shot') notice(`${error instanceof Error ? error.message : String(error)}${reloads && fix ? `\n\n${fix}` : ''}`)
    return error
  }
  const settingUp = <T>(step: () => T, fix?: string): T => {
    try {
      return step()
    } catch (error) {
      throw reported(error, fix)
    }
  }
  // After a save that doesn't build, the page comes with the last script that did, so it says why instead of playing that game.
  if (config.mode === 'run' && config.failure !== undefined) throw reported(new Error(config.failure), FIX_GAME)
  const { game, drive, assets } = settingUp(() => partsOf(page, bare), FIX_GAME)
  const canvas = document.querySelector('canvas')
  if (!canvas) throw new Error('the page needs a <canvas>')
  if (game.title) document.title = game.title
  // Every image is ready before the first frame, so no frame shows one half loaded.
  const images = await loadImages(assets).catch((error: unknown) => {
    throw reported(error, 'Fix the file and save; the page reloads.')
  })
  const custom = settingUp(() => viewOf(page.view), FIX_GAME)
  const view = settingUp(() => new View({ canvas, game, custom, images }))
  const speaker = config.mode === 'shot' ? undefined : new Speaker(assets)
  const seed = config.mode === 'shot' ? 0 : (config.seed ?? Math.floor(Math.random() * 2 ** 31))
  const down = new Set<Key>()
  // A tap shorter than a tick still counts as held for one tick.
  const tapped = new Set<Key>()
  let pointer = CENTER
  let session: Session | undefined
  let source: Source = { kind: 'keyboard' }
  let paused = false
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
  // Runs of ticks happen in a bared page with the guard held up throughout, since doing either on each tick costs more than the tick.
  const ticking = (run: () => void) => bare(() => throughout(run))
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
    const next = new Session(game, { seed: options.seed ?? seed, set: options.set, assets: Object.keys(assets) })
    session = next
    heard = 0
    ticking(() => {
      source = inputSource(options, drive)
      next.start()
    })
    draw()
    return next.seed
  }

  window.engine = {
    reset,
    step(count = 1) {
      ticking(() => {
        for (let i = 0; i < count; i++) stepOnce()
      })
      draw()
      return current().tick
    },
    advanceTo(tick) {
      ticking(() => {
        while (current().tick < tick) stepOnce()
      })
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
        if (owed >= TICK_MS) {
          ticking(() => {
            for (; owed >= TICK_MS; owed -= TICK_MS) stepOnce()
          })
        }
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

interface Parts {
  readonly game: Game
  readonly drive: Drive | undefined
  readonly assets: Assets
}

function partsOf(page: PageModules & { assets: unknown }, bare: <T>(run: () => T) => T): Parts {
  // The game's and driver's modules load with the guard up, as in the sandbox, so what their top level keeps is guarded too.
  const game = parseGame(defaultOf(bare(() => loading(page.game))))
  const driver = page.driver
  const drive = driver === undefined ? undefined : parseDrive(defaultOf(bare(() => loading(driver))))
  return { game, drive, assets: parseAssets(page.assets) }
}

// view.ts names itself in what its init or draw throws, but not in what its top level throws as it loads.
function viewOf(load: () => unknown): ViewModule {
  let module: unknown
  try {
    module = load()
  } catch (error) {
    throw new Error(`view.ts: ${error instanceof Error ? error.message : String(error)} (as it loaded)`, { cause: error })
  }
  return parseView(module)
}

function inputSource(options: ResetOptions, drive: Drive | undefined): Source {
  if (options.drive) {
    if (!drive) throw new Error('this page was built without a driver')
    return { kind: 'driver', driver: guarded(() => driverFor(drive)) }
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
      const build = 'build' in value && typeof value.build === 'number' ? value.build : undefined
      if (seed === undefined || token === undefined || build === undefined) throw new Error('the run page has no seed, token, or build')
      const failure = 'failure' in value && typeof value.failure === 'string' ? value.failure : undefined
      return { mode: 'run', seed, token, build, failure }
    }
    case 'shot':
      return { mode: 'shot' }
    case 'export':
      return { mode: 'export', seed }
    default:
      throw new Error(`unknown page mode ${String(value.mode)}`)
  }
}

function parseDrive(value: unknown): Drive {
  if (isDrive(value)) return value
  throw new Error('the driver file must export default a driver function or defineDriver(...)')
}

function defaultOf(module: unknown): unknown {
  return typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined
}

function notice(message: string): void {
  const box = document.createElement('pre')
  box.textContent = message
  box.style.cssText =
    'position:fixed;inset:auto 16px 16px 16px;margin:0;padding:12px 16px;background:rgba(0,0,0,.8);color:#f2f2f2;' +
    'font:14px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;border-radius:6px'
  document.body.append(box)
}
