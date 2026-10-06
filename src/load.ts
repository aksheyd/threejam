import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { constants as osConstants, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSystemErrorMap } from 'node:util'
import * as esbuild from 'esbuild'
import { isImageFile, isSoundFile } from './assets.ts'
import { confinePlugin, confineRoots, real, within } from './confine.ts'
import { BrowserError, BuildError, GameError, IoError, RunError, UsageError, type Phase } from './errors.ts'
import { ENGINE, NAME, ROOT, TYPES, engineFile, manifestsAbove } from './package.ts'
import { SANDBOX, type Failure, type Place, type Reply, type Request, type Stage, type Thrown } from './sandbox.ts'
import type { LogEntry, Snapshot, SoundEntry } from './types.ts'

// What a game's code may do in the child process that runs it: Node's permission model grants nothing, so it can't read or write files, start processes or workers, load addons, or, from Node 25, reach the network.
export const SANDBOX_FLAGS = ['--permission', '--disallow-code-generation-from-strings', '--input-type=commonjs'] as const
export const DEFAULT_TIMEOUT = 30
// A day: Node's timers can't wait past about 24.8 days, and a longer one fires at once.
export const MAX_TIMEOUT = 86_400

export function timeLimit(seconds = DEFAULT_TIMEOUT): number {
  if (!(seconds > 0 && seconds <= MAX_TIMEOUT)) throw new UsageError(`--timeout must be a number of seconds above 0, up to ${MAX_TIMEOUT}, got ${seconds}`)
  return seconds
}
// The child stops a run at its time limit and reports where it was; this much later, the parent kills a child that didn't.
const GRACE_MS = 10_000
const MAX_REPLY_BYTES = 64 * 1024 * 1024
const BUNDLE = 'threejam-sandbox.js'
const ENTRY = 'threejam:entry'

export interface GameFiles {
  readonly folder: string
  readonly game: string
  readonly view: string | undefined
  // The names of the image and sound files next to game.ts, which the engine checks names against.
  readonly assets: readonly string[]
}

export function gameFiles(dir: string): GameFiles {
  const folder = resolve(dir)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new UsageError(`${named(dir)} isn't a folder`)
  const game = typescript(dir, 'game')
  if (game === undefined) throw new UsageError(`${named(dir)} has no game.ts`)
  return { folder, game, view: typescript(dir, 'view'), assets: assetsIn(folder) }
}

// check can only type-check TypeScript, so a game.js or view.js without its .ts is refused instead of run unchecked or left out.
function typescript(dir: string, stem: string): string | undefined {
  const file = join(resolve(dir), `${stem}.ts`)
  if (existsSync(file)) return file
  if (existsSync(join(resolve(dir), `${stem}.js`))) throw new UsageError(`${named(dir)} has ${stem}.js, but ThreeJam reads only ${stem}.ts; rename it to ${stem}.ts`)
  return undefined
}

// A path as given and, when it's relative, where it led, since an MCP server resolves one from wherever its client started it.
export function named(path: string): string {
  const absolute = resolve(path).replaceAll(sep, '/')
  return isAbsolute(path) ? absolute : `${path === '' ? '""' : path.replaceAll(sep, '/')} (${absolute})`
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
  const seconds = timeLimit(options.timeout)
  const { code, map } = await bundle(files, driver)
  const { ticks, press, hold, pointer, set, seed, every, until, only, clip } = options
  const request: Request = { ticks, press, hold, pointer, set, seed, every, until, only, clip, assets: files.assets, driver: options.driver }
  const reply = parseReply(await inChild({ code, request: JSON.stringify(request), timeout: Math.min(Math.ceil(seconds * 1000), 2 ** 32 - 1) }))
  if (reply.ok) return reply
  throw failed(reply.failure, map, seconds)
}

function driverFile(path: string): string {
  const file = resolve(path)
  const found = statSync(file, { throwIfNoEntry: false })
  if (found === undefined) throw new UsageError(`--driver ${named(path)} doesn't exist`)
  if (!found.isFile()) throw new UsageError(`--driver ${named(path)} isn't a file; give the driver's file, like bot.ts`)
  return file
}

// One script with the engine, the game, and the driver, whose modules load only when the sandbox runs them, after it has fixed the realm's globals.
async function bundle(files: GameFiles, driver: string | undefined): Promise<{ code: string; map: SourceMap }> {
  const roots = confineRoots({ game: files.folder, driver: driver === undefined ? undefined : dirname(driver) })
  const seeds = [files.game, ...(driver === undefined ? [] : [driver])]
  const load = (file: string) => `() => require(${JSON.stringify(file)})`
  const entry = [
    `import { sandbox } from ${JSON.stringify(engineFile('sandbox'))}`,
    `sandbox({ game: ${load(files.game)}, driver: ${driver === undefined ? 'undefined' : load(driver)} })`,
  ].join('\n')
  const plugins = [entryPlugin(entry), confinePlugin({ roots, seeds })]
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
      plugins,
    })
    .catch((failure: unknown) => {
      throw new BuildError(buildMessage(failure))
    })
  const script = result.outputFiles.find((file) => file.path.endsWith('.js'))
  const map = result.outputFiles.find((file) => file.path.endsWith('.map'))
  if (script === undefined || map === undefined) throw new Error(`esbuild made no script and source map for ${files.game}`)
  return { code: script.text, map: new SourceMap(JSON.parse(map.text)) }
}

// The one entry point: the generated glue, loaded from a namespace so it isn't a file on disk. confinePlugin confines everything it pulls in.
function entryPlugin(entry: string): esbuild.Plugin {
  return {
    name: 'threejam-entry',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${ENTRY}$`) }, () => ({ path: 'entry', namespace: 'threejam' }))
      build.onLoad({ filter: /.*/, namespace: 'threejam' }, () => ({ contents: entry, loader: 'ts', resolveDir: ROOT }))
    },
  }
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

const SHELL = '/bin/sh'
// The shell forks a watcher into the child's new process group, then becomes the child. Only this process holds the other end of the watcher's pipe, so it closes when this process ends, however it ends, and the watcher then kills its group, which lasts as long as the watcher does, so the kill can't reach another process.
// kill 0 is safe only because detached gives the shell a session and process group of its own; without it, the watcher would kill whoever started this process.
// A shell also exports PWD, which the child isn't given; bash's exec adds SHLVL=0, which tells it nothing. fd 3 closes on a line of its own, since bash 3.2, macOS's sh, keeps a copy of it at fd 10 through exec "$@" 3<&-.
const TIED = '(read -r _ <&3; kill -KILL 0) </dev/null >/dev/null 2>&1 &\nunset PWD\nexec 3<&-\nexec "$@"'

// bash, macOS's sh, takes exported functions, options, and a timeout for read from its environment, so a function named kill or read, SHELLOPTS=noexec, or TMOUT could change what the watcher does, or keep the child from running at all; the child needs none of them.
const BASH_IMPORTS = /^(BASH_FUNC_.*|SHELLOPTS|BASHOPTS|TMOUT)$/

// A child that ends when this process does, even by SIGKILL, which on macOS and Linux would otherwise leave it running. Windows does this already: libuv puts every child in a job object that ends with this process. A system with no /bin/sh still starts the child, untied.
function spawnTied(command: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string }): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32' || !existsSync(SHELL)) return spawn(command, args, { ...options, stdio: 'pipe', windowsHide: true })
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([name]) => !BASH_IMPORTS.test(name)))
  const tied = spawn(SHELL, ['-c', TIED, 'sh', command, ...args], { ...options, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true })
  // Once the child has exited, closing the watcher's pipe ends the watcher, alone in the group by then.
  const release = () => void tied.stdio[3]?.destroy()
  tied.once('exit', release).once('error', release)
  return tied
}

function inChild({ code, request, timeout }: { code: string; request: string; timeout: number }): Promise<string> {
  return new Promise((done, fail) => {
    const runner = spawnTied(process.execPath, [...SANDBOX_FLAGS, '-e', CHILD], { env: sandboxEnv() })
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
      else fail(crashed(Buffer.concat(errors).toString('utf8'), signal ?? `exit code ${status}`))
    })
    runner.stdin.end(JSON.stringify({ code, request, timeout }))
  })
}

// V8 says why it stopped a process before printing its native stack, whose lines mean nothing to a game's author.
export function crashed(stderr: string, how: string): Error {
  if (stderr.includes('JavaScript heap out of memory')) return gameFailure('the game ran out of memory; look for a list or a loop that keeps growing')
  const last = stderr.split('----- Native stack trace -----', 1)[0].split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  return new Error(`the sandbox running the game stopped with ${how}${last ? `: ${last.slice(0, 300)}` : ''}`)
}

// A failure the game caused that ThreeJam noticed outside the game's code, so no line in the game's files is to blame.
export function gameFailure(message: string): GameError {
  return Object.assign(new GameError(message), { stack: '' })
}

// The child gets none of our environment, and runs in UTC and en-US, which the guard gives game code anyway, so sim reads no machine's time zone or language even where the guard might miss one.
export function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
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
      return gameFailure("the sandbox couldn't send the run back: the game changed built-in objects that ThreeJam's engine uses")
    default: {
      const _exhaustive: never = failure
      return _exhaustive
    }
  }
}

// An error as the game threw it, a GameError under the name it had, with its stack pointed at the files it came from.
function rebuilt(thrown: Thrown, map: SourceMap): GameError {
  if (thrown.kind === 'value') return gameFailure(thrown.text)
  const error = new GameError(thrown.message)
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
  throw gameFailure("the sandbox sent back a reply ThreeJam can't read: the game may have changed built-in objects, like JSON, that ThreeJam's engine uses")
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

export async function typecheck({ file, dom, timeout = DEFAULT_TIMEOUT }: { file: string; dom: boolean; timeout?: number }): Promise<string[]> {
  const folder = dirname(file)
  const three = packageFolder('@types/three', ROOT)
  const compilerOptions = {
    ...COMPILER_OPTIONS,
    // TypeScript reads a .ts file as CommonJS unless the nearest package.json says "type": "module", but the engine bundles every game as an ES module.
    ...(isModuleScope(folder) ? {} : { module: 'preserve', moduleResolution: 'bundler' }),
    lib: dom ? ['es2023', 'dom', 'dom.iterable'] : ['es2023'],
    types: [],
    // The engine that's running, as in sim and the page, so a game checks without the package installed beside it, and Three.js's types as that engine has them, which describe the THREE a view receives.
    paths: { [NAME]: [TYPES], ...(three === undefined ? {} : { three: [join(three, 'index.d.ts')] }) },
  }
  const result = await runTsc({ compilerOptions, file, timeout })
  const errors: string[] = []
  const read: string[] = []
  const other: string[] = []
  const game = real(folder)
  let keep = false
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),\d+\): error TS\d+: (.*)$/.exec(line)
    const general = /^error TS\d+: (.*)$/.exec(line)
    if (match) {
      const path = resolve(ROOT, match[1])
      keep = within(game, real(path))
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
  // A type error can quote what a file holds, so a game that imports past its folder, the engine's files, and the declarations check needs fails the check instead of leaking the file's text. The real path is what counts, so a link out of the folder doesn't exempt it.
  const roots = [game, real(ENGINE)]
  const declarations = declarationFolders()
  const exempt = (path: string) => roots.some((root) => within(root, path)) || (/\.d\.[cm]?ts$/.test(path) && declarations.some((root) => within(root, path)))
  const stray = read.map(real).find((path) => !exempt(path))
  if (stray !== undefined) throw new BuildError(`${shownPath(stray)} is outside the folder; an import must come from the game's folder or ThreeJam's own files`)
  if (result.status !== 0 && !/error TS\d+/.test(result.stdout)) {
    errors.push(`the TypeScript check failed: ${`${other.join('\n')}${result.stderr}`.trim() || `exit ${result.status}`}`)
  }
  return errors
}

// The folders whose declaration files check may read outside the game's and the engine's: TypeScript's libs, and ThreeJam's own type packages (@types/three and the type packages it needs), as this ThreeJam finds them. The code packages those types name, like fflate, and any other node_modules, even one above the game or beside ThreeJam, are outside.
function declarationFolders(): string[] {
  const folders: string[] = []
  const typescript = packageFolder('typescript', ROOT)
  if (typescript !== undefined) {
    folders.push(join(typescript, 'lib'))
    // TypeScript 7 keeps its libs beside its compiler, in the package built for this platform.
    const native = packageFolder(`@typescript/typescript-${process.platform}-${process.arch}`, typescript)
    if (native !== undefined) folders.push(join(native, 'lib'))
  }
  const visit = (name: string, from: string): void => {
    const found = packageFolder(name, from)
    if (found === undefined || folders.includes(found)) return
    folders.push(found)
    for (const dependency of dependenciesOf(found)) if (dependency.startsWith('@types/')) visit(dependency, found)
  }
  for (const name of dependenciesOf(ROOT)) if (name.startsWith('@types/')) visit(name, ROOT)
  return folders.map(real)
}

// Where Node finds a package from a folder: in the nearest node_modules above it that has one.
function packageFolder(name: string, from: string): string | undefined {
  for (let folder = from; ; folder = dirname(folder)) {
    const found = join(folder, 'node_modules', name)
    if (basename(folder) !== 'node_modules' && existsSync(join(found, 'package.json'))) return found
    if (dirname(folder) === folder) return undefined
  }
}

function dependenciesOf(folder: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  return isRecord(parsed) && isRecord(parsed.dependencies) ? Object.keys(parsed.dependencies) : []
}

interface Tsc {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

// spawnSync's bound. tsc lists the files it read after its errors, so output cut short couldn't be checked for an import from outside the folder, and none of it is shown.
const MAX_TSC_BYTES = 1024 * 1024

// Ctrl-C, SIGTERM, and the SIGHUP of a closed terminal, which can come twice.
export const STOPS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Ends this process as the signal would have, once what else listens for it, like shots cleaning up after it, is done and calls this again. On macOS and Linux the signal this process sends itself does that. On Windows a process can't send itself SIGHUP, and SIGINT or SIGTERM end it at once with 1, so there what else listens hears the signal from here, and once nothing does, the process exits with the code a shell gives a process the signal ended.
export function endBy(signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') process.kill(process.pid, signal)
  else if (process.listenerCount(signal) > 0) process.emit(signal, signal)
  else process.exit(128 + osConstants.signals[signal])
}

// The folders of the type checks still running, which this process removes if it ends first: as it exits, as an MCP server does when its client closes stdin, or on Ctrl-C, SIGTERM, or the SIGHUP of a closed terminal, which then end it as they would have. SIGKILL leaves them.
const checking = new Set<string>()

function removeChecking(): void {
  for (const config of checking) {
    try {
      rmSync(config, { recursive: true, force: true })
    } catch {
      // An end can't wait for a file Windows still holds a moment; the system's temporary folder keeps it.
    }
  }
}

process.on('exit', removeChecking)

function interrupted(signal: NodeJS.Signals): void {
  removeChecking()
  for (const name of STOPS) process.off(name, interrupted)
  endBy(signal)
}

// A listener changes what a signal does for the whole process, and run stops gently on its own, so these listen only while a type check runs.
function startChecking(config: string): void {
  if (checking.size === 0) for (const name of STOPS) process.on(name, interrupted)
  checking.add(config)
}

function stopChecking(config: string): void {
  checking.delete(config)
  if (checking.size === 0) for (const name of STOPS) process.off(name, interrupted)
}

// paths is only a tsconfig.json setting, so each check writes one for its file, where only this user can read it; a type that never terminates is stopped at the time limit.
async function runTsc({ compilerOptions, file, timeout }: { compilerOptions: object; file: string; timeout: number }): Promise<Tsc> {
  const config = mkdtempSync(join(tmpdir(), 'threejam-check-'))
  startChecking(config)
  try {
    const project = join(config, 'tsconfig.json')
    writeFileSync(project, JSON.stringify({ compilerOptions, files: [file] }), { mode: 0o600, flag: 'wx' })
    return await new Promise((done, fail) => {
      const tsc = spawnTied(process.execPath, [typescriptEntry(), '-p', project, '--pretty', 'false', '--listFiles'], { cwd: ROOT })
      const out: Buffer[] = []
      const errors: Buffer[] = []
      let bytes = 0
      let stopped: LimitError | undefined
      const stop = (error: LimitError) => {
        stopped ??= error
        tsc.kill('SIGKILL')
      }
      const late = new LimitError('TIMEOUT', `the type check ran past the ${timeout} s time limit; a type in the game may not terminate, or allow more time with --timeout`)
      const timer = setTimeout(() => stop(late), Math.min(Math.ceil(timeout * 1000), 2 ** 31 - 1))
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= MAX_TSC_BYTES) into.push(chunk)
        else stop(new LimitError('OUTPUT_TOO_LARGE', `the type check printed more than ${MAX_TSC_BYTES / 1024 / 1024} MB, as thousands of type errors do, so it shows none; look for code that repeats one mistake, like a long list of data`))
      }
      tsc.stdout.on('data', collect(out))
      tsc.stderr.on('data', collect(errors))
      tsc.once('error', (error) => {
        clearTimeout(timer)
        fail(new Error(`the TypeScript check couldn't run: ${error.message}`))
      })
      // A stopped check settles as tsc exits: on Windows, the tsc.exe that tsc.js's job object ends can hold the pipes a moment longer, and what's left in them isn't needed.
      tsc.once('exit', () => {
        clearTimeout(timer)
        if (stopped === undefined) return
        tsc.stdout.destroy()
        tsc.stderr.destroy()
        fail(stopped)
      })
      tsc.once('close', (status) => {
        if (stopped !== undefined) fail(stopped)
        else done({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') })
      })
      tsc.stdin.end()
    })
  } finally {
    stopChecking(config)
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
    throw new Error(`check needs the typescript package, which ${NAME} depends on; run npm install again`)
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const tsc = isRecord(parsed) && isRecord(parsed.bin) ? parsed.bin.tsc : undefined
  if (typeof tsc !== 'string') throw new Error(`${manifest} names no tsc to run`)
  return join(dirname(manifest), tsc)
}

export function describe(error: unknown): string {
  if (error instanceof UsageError || error instanceof LimitError || error instanceof BuildError || error instanceof BrowserError || error instanceof IoError) {
    return error.message
  }
  if (isSystemError(error)) return systemMessage(error)
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

interface SystemError extends Error {
  readonly code: string
  readonly syscall: string
  readonly errno?: unknown
  readonly path?: unknown
}

// What Node's fs and child_process throw when the OS refuses, which names the system call and usually the path.
export function isSystemError(error: unknown): error is SystemError {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string' && typeof Reflect.get(error, 'syscall') === 'string'
}

function systemMessage(error: SystemError): string {
  return `couldn't ${error.syscall}${typeof error.path === 'string' ? ` ${error.path.replaceAll(sep, '/')}` : ''}: ${reasonOf(error)}`
}

// What the OS said, like "permission denied", without the code and path Node puts around it.
export function reasonOf(error: unknown): string {
  if (!isSystemError(error)) return error instanceof Error ? error.message : String(error)
  return (typeof error.errno === 'number' ? getSystemErrorMap().get(error.errno)?.[1] : undefined) ?? error.code
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
