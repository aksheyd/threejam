import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { isImageFile, isSoundFile } from './assets.ts'
import { RunError, UsageError, type Phase } from './errors.ts'
import { ENGINE, NAME, ROOT, TYPES, engineFile, manifestsAbove } from './package.ts'
import { SANDBOX, type Failure, type Place, type Reply, type Request, type Stage, type Thrown } from './sandbox.ts'
import type { LogEntry, Snapshot, SoundEntry } from './types.ts'

// What a game's code may do in the child process that runs it: Node's permission model grants nothing, so it can't read or write files, start processes or workers, load addons, or, from Node 25, reach the network.
export const SANDBOX_FLAGS = ['--permission', '--disallow-code-generation-from-strings', '--input-type=commonjs'] as const
export const DEFAULT_TIMEOUT = 30
// The child stops a run at its time limit and reports where it was; this much later, the parent kills a child that didn't.
const GRACE_MS = 10_000
const MAX_REPLY_BYTES = 64 * 1024 * 1024
const BUNDLE = 'threejam-sandbox.js'
const ENTRY = 'threejam:entry'
const RESOLVING = Symbol('resolving')
const LOOSE_CASE = process.platform === 'darwin' || process.platform === 'win32'

export interface GameFiles {
  readonly folder: string
  readonly game: string
  readonly view: string | undefined
  // The names of the image and sound files next to game.ts, which the engine checks names against.
  readonly assets: readonly string[]
}

export function gameFiles(dir: string): GameFiles {
  const folder = resolve(dir)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new UsageError(`${dir} isn't a folder`)
  const game = firstFile(folder, 'game')
  if (game === undefined) throw new UsageError(`${dir} has no game.ts`)
  return { folder, game, view: firstFile(folder, 'view'), assets: assetsIn(folder) }
}

// Sorted, since folders list their files in a different order on each OS.
export function assetsIn(folder: string): string[] {
  const files = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && (isImageFile(entry.name) || isSoundFile(entry.name)))
  return files.map((entry) => entry.name).sort()
}

// TIMEOUT and OUTPUT_TOO_LARGE: limits the sandbox put on a run, whatever the game does.
export class LimitError extends Error {
  readonly code: 'TIMEOUT' | 'OUTPUT_TOO_LARGE'

  constructor(code: 'TIMEOUT' | 'OUTPUT_TOO_LARGE', message: string) {
    super(message)
    this.name = 'LimitError'
    this.code = code
  }
}

export interface RunOptions {
  readonly ticks: number
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly pointer?: readonly string[]
  readonly driver?: string
  readonly set?: readonly string[]
  readonly seed?: number
  readonly every?: number
  readonly until?: string
  readonly only?: string
  readonly clip?: boolean
  // Seconds the game's code may run, DEFAULT_TIMEOUT unless given.
  readonly timeout?: number
}

export interface Run {
  readonly snapshots: readonly Snapshot[]
  readonly logs: readonly LogEntry[]
  readonly sounds: readonly SoundEntry[]
  readonly tick: number
  readonly reached: boolean
}

// Runs a game and its driver, read fresh from disk, in a sandbox: a realm of their own that has only the language and the engine, in a child process that Node's permission model allows nothing.
export async function runGame(dir: string, options: RunOptions): Promise<Run> {
  const files = gameFiles(dir)
  const driver = options.driver === undefined ? undefined : driverFile(options.driver)
  const seconds = options.timeout ?? DEFAULT_TIMEOUT
  if (!(seconds > 0 && Number.isFinite(seconds))) throw new UsageError(`--timeout must be a number of seconds above 0, got ${seconds}`)
  const { code, map } = await bundle(files, driver)
  const { ticks, press, hold, pointer, set, seed, every, until, only, clip } = options
  const request: Request = { ticks, press, hold, pointer, set, seed, every, until, only, clip, assets: files.assets, driver: options.driver }
  const reply = parseReply(await inChild({ code, request: JSON.stringify(request), timeout: Math.min(Math.ceil(seconds * 1000), 2 ** 32 - 1) }))
  if (reply.ok) return reply
  throw failed(reply.failure, map, seconds)
}

function driverFile(path: string): string {
  const file = resolve(path)
  if (!existsSync(file)) throw new UsageError(`--driver ${path} doesn't exist`)
  return file
}

// One script with the engine, the game, and the driver, whose modules load only when the sandbox runs them, after it has fixed the realm's globals.
async function bundle(files: GameFiles, driver: string | undefined): Promise<{ code: string; map: SourceMap }> {
  const load = (file: string) => `() => require(${JSON.stringify(file)})`
  const entry = [
    `import { sandbox } from ${JSON.stringify(engineFile('sandbox'))}`,
    `sandbox({ game: ${load(files.game)}, driver: ${driver === undefined ? 'undefined' : load(driver)} })`,
  ].join('\n')
  const result = await esbuild
    .build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'neutral',
      target: 'es2023',
      banner: { js: '"use strict";' },
      sourcemap: 'external',
      sourcesContent: false,
      // Sources are relative to ROOT, where the bundle would be if it were written.
      outfile: join(ROOT, BUNDLE),
      logLevel: 'silent',
      plugins: [confine({ entry, game: files.folder, driver: driver === undefined ? undefined : dirname(driver) })],
    })
    .catch((failure: unknown) => {
      throw new UsageError(buildMessage(failure))
    })
  const script = result.outputFiles.find((file) => file.path.endsWith('.js'))
  const map = result.outputFiles.find((file) => file.path.endsWith('.map'))
  if (script === undefined || map === undefined) throw new Error(`esbuild made no script and source map for ${files.game}`)
  return { code: script.text, map: new SourceMap(JSON.parse(map.text)) }
}

// Keeps the bundle to the engine's own files, the game's folder, and the driver's: a game file imports only from the game's folder, and a driver file from either folder.
function confine({ entry, game, driver }: { entry: string; game: string; driver: string | undefined }): esbuild.Plugin {
  const engine = realpathSync(ENGINE)
  const games = realpathSync(game)
  const drivers = driver === undefined ? undefined : realpathSync(driver)
  const rule = (importer: string, namespace: string) =>
    namespace === 'threejam'
      ? { roots: [engine, games, ...(drivers === undefined ? [] : [drivers])], what: 'game.ts and a driver must be files in their folders, not links to files elsewhere' }
      : within(games, importer)
        ? { roots: [games], what: 'a game can import only threejam and files in its folder' }
        : drivers !== undefined && within(drivers, importer)
          ? { roots: [drivers, games], what: "a driver can import only threejam and files in its folder or the game's" }
          : { roots: within(engine, importer) ? [engine] : [], what: "ThreeJam's files import only each other" }
  return {
    name: 'threejam-confine',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === RESOLVING) return undefined
        if (args.kind === 'entry-point') return { path: 'entry', namespace: 'threejam' }
        if (args.path === NAME) return { path: engineFile('index') }
        const { roots, what } = rule(args.importer, args.namespace)
        if (!/^(\.{1,2}([\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(args.path)) return { errors: [{ text: `${args.path} isn't a file in the folder; ${what}` }] }
        const found = await build.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, pluginData: RESOLVING })
        if (found.errors.length > 0) return { errors: found.errors }
        if (found.namespace !== 'file' || found.external || !roots.some((root) => within(root, found.path))) {
          return { errors: [{ text: `${args.path} is outside the folder; ${what}` }] }
        }
        return { path: found.path }
      })
      build.onLoad({ filter: /.*/, namespace: 'threejam' }, () => ({ contents: entry, loader: 'ts', resolveDir: ROOT }))
    },
  }
}

function within(root: string, path: string): boolean {
  const rest = LOOSE_CASE ? relative(root.toLowerCase(), path.toLowerCase()) : relative(root, path)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

// The child process that runs the bundle. It starts as Node's -e script, so it uses nothing outside its own body: it makes a realm with the language and nothing else, runs the bundle in it, then the run with a time limit, and writes the reply.
function child(settings: { key: string; bundle: string }): void {
  'use strict'
  const vm = require('node:vm')
  const { types } = require('node:util')
  process.on('unhandledRejection', () => {})
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  process.stdin.on('end', () => {
    const { code, request, timeout } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const realm = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
    // import() would hand game code an error made in this realm, whose constructors reach the process; the realm's own Error reaches nothing.
    const RealmError = realm.Error
    const importModuleDynamically = () => {
      throw new RealmError('import() is not available to game code')
    }
    new vm.Script(code, { filename: settings.bundle, importModuleDynamically }).runInContext(realm)
    const { where } = realm[settings.key]
    const call = `globalThis[${JSON.stringify(settings.key)}].run(${JSON.stringify(request)})`
    let reply: unknown
    try {
      reply = new vm.Script(call, { filename: 'threejam-run', importModuleDynamically }).runInContext(realm, { timeout })
    } catch (error) {
      // Only the descriptor is read, since a getter on a value the game threw would run its code outside the time limit.
      const timedOut = types.isNativeError(error) && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      reply = timedOut ? `{"ok":false,"failure":{"kind":"timeout","at":${where()}}}` : undefined
    }
    process.stdout.on('error', () => {})
    process.stdout.write(typeof reply === 'string' ? reply : '{"ok":false,"failure":{"kind":"lost"}}')
  })
}

const CHILD = `(${child.toString()})(${JSON.stringify({ key: SANDBOX, bundle: BUNDLE })})`

function inChild({ code, request, timeout }: { code: string; request: string; timeout: number }): Promise<string> {
  return new Promise((done, fail) => {
    const runner = spawn(process.execPath, [...SANDBOX_FLAGS, '-e', CHILD], { env: sandboxEnv(), stdio: 'pipe', windowsHide: true })
    const out: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let stopped: LimitError | undefined
    const stop = (error: LimitError) => {
      stopped ??= error
      runner.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop(new LimitError('TIMEOUT', `the game ran past the ${timeout / 1000} s time limit and had to be stopped; ${MORE_TIME}`)), timeout + GRACE_MS)
    runner.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= MAX_REPLY_BYTES) out.push(chunk)
      else stop(new LimitError('OUTPUT_TOO_LARGE', `the run's output passed ${MAX_REPLY_BYTES / 1024 / 1024} MB; print less with --only, a larger --every, or --until`))
    })
    runner.stderr.on('data', (chunk: Buffer) => void (errors.length < 64 && errors.push(chunk)))
    runner.stdin.on('error', () => {})
    runner.once('error', (error) => {
      clearTimeout(timer)
      fail(new Error(`couldn't start the sandbox: ${error.message}`))
    })
    runner.once('close', (status, signal) => {
      clearTimeout(timer)
      if (stopped !== undefined) fail(stopped)
      else if (status === 0 && bytes > 0) done(Buffer.concat(out).toString('utf8'))
      else {
        const last = Buffer.concat(errors).toString('utf8').trim().split(/\r?\n/).filter(Boolean).at(-1)
        fail(new Error(`the sandbox running the game stopped with ${signal ?? `exit code ${status}`}${last ? `: ${last.slice(0, 300)}` : ''}`))
      }
    })
    runner.stdin.end(JSON.stringify({ code, request, timeout }))
  })
}

// The child gets no secrets from the environment, only what sets its locale and time zone, which games could already read through Intl and Date.
function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(TZ|LANG|LANGUAGE|LC_[A-Z]+)$/.test(name)) env[name] = value
  }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
  return env
}

const MORE_TIME = 'look for a loop that never ends, or allow more time with --timeout'

function failed(failure: Failure, map: SourceMap, seconds: number): Error {
  switch (failure.kind) {
    case 'usage':
      return new UsageError(failure.message)
    case 'run':
      return new RunError({ phase: failure.phase, tick: failure.tick, cause: rebuilt(failure.thrown, map) })
    case 'thrown':
      return rebuilt(failure.thrown, map)
    case 'timeout':
      return new LimitError('TIMEOUT', `the game ran past the ${seconds} s time limit; ${MORE_TIME} (${placed(failure.at)})`)
    case 'lost':
      return new Error("the sandbox couldn't send the run back: the game changed built-in objects that ThreeJam's engine uses")
    default: {
      const _exhaustive: never = failure
      return _exhaustive
    }
  }
}

// An error as the game threw it, with its stack pointed at the files it came from.
function rebuilt(thrown: Thrown, map: SourceMap): Error {
  if (thrown.kind === 'value') return Object.assign(new Error(thrown.text), { stack: '' })
  const error = new Error(thrown.message)
  error.name = thrown.name
  const frames = new RegExp(`${BUNDLE.replaceAll('.', '\\.')}:(\\d+):(\\d+)`, 'g')
  error.stack = thrown.stack.replace(frames, (frame, line: string, column: string) => {
    const origin = map.findOrigin(Number(line), Number(column))
    return 'fileName' in origin ? `${resolve(ROOT, origin.fileName)}:${origin.lineNumber}:${origin.columnNumber}` : frame
  })
  return error
}

function parseReply(text: string): Reply {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (isRecord(value) && value.ok === true) {
    const { snapshots, logs, sounds, tick, reached } = value
    if (listOf(snapshots, isSnapshot) && listOf(logs, isLog) && listOf(sounds, isSound) && typeof tick === 'number' && typeof reached === 'boolean') {
      return { ok: true, snapshots, logs, sounds, tick, reached }
    }
  }
  if (isRecord(value) && value.ok === false && isFailure(value.failure)) return { ok: false, failure: value.failure }
  throw new Error("the sandbox sent back a reply ThreeJam can't read")
}

function listOf<T>(value: unknown, item: (each: unknown) => each is T): value is T[] {
  return Array.isArray(value) && value.every(item)
}

function isSnapshot(value: unknown): value is Snapshot {
  return isRecord(value) && typeof value.tick === 'number' && Array.isArray(value.entities) && value.entities.every((entity) => isRecord(entity) && typeof entity.name === 'string')
}

function isLog(value: unknown): value is LogEntry {
  return isRecord(value) && typeof value.tick === 'number' && typeof value.text === 'string'
}

function isSound(value: unknown): value is SoundEntry {
  return isRecord(value) && typeof value.tick === 'number' && typeof value.name === 'string' && typeof value.volume === 'number' && typeof value.pitch === 'number'
}

function isFailure(value: unknown): value is Failure {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'usage':
      return typeof value.message === 'string'
    case 'run':
      return (value.phase === 'start' || value.phase === 'update' || value.phase === 'driver') && typeof value.tick === 'number' && isThrown(value.thrown)
    case 'thrown':
      return isThrown(value.thrown)
    case 'timeout':
      return isPlace(value.at)
    case 'lost':
      return true
    default:
      return false
  }
}

function isThrown(value: unknown): value is Thrown {
  if (!isRecord(value)) return false
  if (value.kind === 'value') return typeof value.text === 'string'
  return value.kind === 'error' && typeof value.name === 'string' && typeof value.message === 'string' && typeof value.stack === 'string'
}

const STAGES: readonly Stage[] = ['load', 'start', 'update', 'driver', 'end']

function isPlace(value: unknown): value is Place {
  return isRecord(value) && STAGES.some((stage) => stage === value.stage) && typeof value.tick === 'number'
}

function placed({ stage, tick }: Place): string {
  switch (stage) {
    case 'load':
      return 'while its modules load'
    case 'end':
      return 'after the last tick'
    default:
      return during(stage, tick)
  }
}

// The settings check uses, which threejam new also writes into a new project's tsconfig.json.
export const COMPILER_OPTIONS = {
  strict: true,
  target: 'es2023',
  module: 'nodenext',
  moduleResolution: 'nodenext',
  allowImportingTsExtensions: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  noEmit: true,
} as const

export function typecheck({ file, dom }: { file: string; dom: boolean }): string[] {
  const folder = dirname(file)
  const compilerOptions = {
    ...COMPILER_OPTIONS,
    // TypeScript reads a .ts file as CommonJS unless the nearest package.json says "type": "module", but the engine bundles every game as an ES module.
    ...(isModuleScope(folder) ? {} : { module: 'preserve', moduleResolution: 'bundler' }),
    lib: dom ? ['es2023', 'dom', 'dom.iterable'] : ['es2023'],
    types: [],
    // The engine that's running, as in sim and the page, so a game checks without the package installed beside it.
    paths: { [NAME]: [TYPES] },
  }
  const result = runTsc({ compilerOptions, file })
  if (result.error) return [`the TypeScript check failed: ${result.error.message}`]
  const errors: string[] = []
  const read: string[] = []
  const other: string[] = []
  let keep = false
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),\d+\): error TS\d+: (.*)$/.exec(line)
    const general = /^error TS\d+: (.*)$/.exec(line)
    if (match) {
      const path = resolve(ROOT, match[1])
      keep = path.startsWith(folder + sep)
      if (keep) errors.push(`${shownPath(path)}:${match[2]}: ${hinted(match[3])}`)
    } else if (general) {
      keep = false
      errors.push(`the TypeScript check failed: ${general[1]}`)
    } else if (keep && line.startsWith('  ')) {
      errors[errors.length - 1] += ` ${line.trim()}`
    } else if (isAbsolute(line)) {
      read.push(resolve(line))
    } else if (line.trim()) {
      other.push(line)
    }
  }
  // Type errors can quote what a file holds, so a game that reaches past its folder, the engine's types, and packages like TypeScript's and Three.js's hears only that.
  const roots = [folder, realpathSync(folder), ENGINE, realpathSync(ENGINE)]
  const stray = read.find((path) => !roots.some((root) => within(root, path)) && !path.split(sep).includes('node_modules'))
  if (stray !== undefined) throw new UsageError(`${shownPath(stray)} is outside the game's folder; a game can import only threejam and files in its folder`)
  if (result.status !== 0 && !/error TS\d+/.test(result.stdout)) {
    errors.push(`the TypeScript check failed: ${`${other.join('\n')}${result.stderr}`.trim() || `exit ${result.status}`}`)
  }
  return errors
}

// paths is only a tsconfig.json setting, so each check writes one for its file, where only this user can read it.
function runTsc({ compilerOptions, file }: { compilerOptions: object; file: string }): SpawnSyncReturns<string> {
  const config = mkdtempSync(join(tmpdir(), 'threejam-check-'))
  try {
    const project = join(config, 'tsconfig.json')
    writeFileSync(project, JSON.stringify({ compilerOptions, files: [file] }), { mode: 0o600, flag: 'wx' })
    return spawnSync(process.execPath, [typescriptEntry(), '-p', project, '--pretty', 'false', '--listFiles'], { cwd: ROOT, encoding: 'utf8' })
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

function isModuleScope(folder: string): boolean {
  for (const { json } of manifestsAbove(folder)) return json.type === 'module'
  return false
}

// npm's shims in node_modules/.bin are .cmd files on Windows, so this Node runs the script the package names.
function typescriptEntry(): string {
  let manifest: string
  try {
    manifest = fileURLToPath(import.meta.resolve('typescript/package.json'))
  } catch {
    throw new UsageError(`check needs the typescript package, which ${NAME} depends on; run npm install again`)
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const tsc = isRecord(parsed) && isRecord(parsed.bin) ? parsed.bin.tsc : undefined
  if (typeof tsc !== 'string') throw new UsageError(`${manifest} names no tsc to run`)
  return join(dirname(manifest), tsc)
}

export function describe(error: unknown): string {
  if (error instanceof UsageError || error instanceof LimitError) return error.message
  const inner = error instanceof RunError ? error.cause : error
  const where = locate(inner)
  const text = !(inner instanceof Error)
    ? String(inner)
    : inner.name === 'GameError' || inner.name === 'Error'
      ? inner.message
      : `${inner.name}: ${inner.message}`
  const line = where === undefined ? text : `${where}: ${text}`
  return error instanceof RunError ? `${line} (${during(error.phase, error.tick)})` : line
}

function during(phase: Phase, tick: number): string {
  switch (phase) {
    case 'start':
      return 'in start'
    case 'update':
      return `in update at tick ${tick}`
    case 'driver':
      return `in the driver before tick ${tick}`
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

function buildMessage(failure: unknown): string {
  if (!isRecord(failure) || !Array.isArray(failure.errors)) return String(failure)
  return failure.errors
    .map((error: unknown) => {
      if (!isRecord(error) || typeof error.text !== 'string') return String(error)
      const location = error.location
      return isRecord(location) && typeof location.file === 'string' && location.namespace !== 'threejam' ? `${location.file}:${location.line}: ${error.text}` : error.text
    })
    .join('; ')
}

// A frame reads "at name (place)" or "at place", where the place is a file URL or a path, which may hold spaces or a drive letter, then :line:column.
function locate(error: unknown): string | undefined {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?$/.exec(line)
    if (!match) continue
    const file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1]
    if (!isAbsolute(file) || file.startsWith(ENGINE + sep) || file.includes(`${sep}node_modules${sep}`)) continue
    return `${shownPath(file)}:${match[2]}`
  }
  return undefined
}

// Forward slashes on every OS keep messages the same for agents and tests.
function shownPath(file: string): string {
  return relative(process.cwd(), file).replaceAll(sep, '/')
}

// Game logic sees only the language, so these names fail with the fix attached.
const HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/'console'/, 'use ctx.print(...), which sim shows with the tick'],
  [/'(setTimeout|setInterval|performance|requestAnimationFrame)'/, 'count ticks with ctx.tick instead'],
  [/'(document|window|HTMLCanvasElement)'/, 'game logic has no page; draw in view.ts'],
]

function hinted(message: string): string {
  const hint = HINTS.find(([pattern]) => message.startsWith('Cannot find name') && pattern.test(message))
  return hint ? `${message.replace(/ Do you need.*$/, '')} Here, ${hint[1]}.` : message
}

function firstFile(folder: string, stem: string): string | undefined {
  return [`${stem}.ts`, `${stem}.js`].map((name) => join(folder, name)).find((path) => existsSync(path))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
