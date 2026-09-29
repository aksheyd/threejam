import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { isImageFile, isSoundFile } from './assets.ts'
import { parseGame } from './engine.ts'
import { RunError, UsageError, type Phase } from './errors.ts'
import { ENGINE, NAME, ROOT, TYPES, engineFile, manifestsAbove } from './package.ts'
import { isDrive, type Drive, type Game } from './types.ts'

const INDEX = pathToFileURL(engineFile('index')).href
const MODULES = join(tmpdir(), 'threejam-modules')
let loads = 0

process.setSourceMapsEnabled(true)

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

export async function loadGame(dir: string): Promise<Game> {
  const module = await importFresh(gameFiles(dir).game)
  return parseGame(module.default)
}

export async function loadDriver(path: string): Promise<Drive> {
  const file = resolve(path)
  if (!existsSync(file)) throw new UsageError(`--driver ${path} doesn't exist`)
  const { default: drive } = await importFresh(file)
  if (!isDrive(drive)) {
    throw new UsageError(`--driver ${path} must export default a function ({ world, tick, keys, pointer, random }) => keys or { keys, pointer }, or defineDriver(...)`)
  }
  return drive
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
    }
  }
  if (result.status !== 0 && !/error TS\d+/.test(result.stdout)) {
    errors.push(`the TypeScript check failed: ${`${result.stdout}${result.stderr}`.trim() || `exit ${result.status}`}`)
  }
  return errors
}

// paths is only a tsconfig.json setting, so each check writes one for its file.
function runTsc({ compilerOptions, file }: { compilerOptions: object; file: string }): SpawnSyncReturns<string> {
  const config = mkdtempSync(join(tmpdir(), 'threejam-check-'))
  try {
    const project = join(config, 'tsconfig.json')
    writeFileSync(project, JSON.stringify({ compilerOptions, files: [file] }))
    return spawnSync(process.execPath, [typescriptEntry(), '-p', project, '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' })
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
  if (error instanceof UsageError) return error.message
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

// Each load bundles the file again, so a long-running process such as the MCP server runs the code on disk.
async function importFresh(file: string): Promise<Record<string, unknown>> {
  const result = await esbuild
    .build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      sourcemap: 'inline',
      // Sources are relative to ROOT and resolve from there wherever the bundle is written, even on another drive.
      outfile: join(ROOT, 'threejam-module.mjs'),
      sourceRoot: pathToFileURL(ROOT + sep).href,
      logLevel: 'silent',
      plugins: [{ name: 'threejam', setup: (build) => void build.onResolve({ filter: new RegExp(`^${NAME}$`) }, () => ({ path: INDEX, external: true })) }],
    })
    .catch((failure: unknown) => {
      throw new UsageError(buildMessage(failure))
    })
  const [output] = result.outputFiles
  mkdirSync(MODULES, { recursive: true })
  const path = join(MODULES, `${createHash('sha1').update(output.text).digest('hex')}.mjs`)
  if (!existsSync(path)) writeFileSync(path, output.text)
  loads += 1
  const module: unknown = await import(`${pathToFileURL(path).href}?load=${loads}`)
  return isRecord(module) ? module : {}
}

function buildMessage(failure: unknown): string {
  if (!isRecord(failure) || !Array.isArray(failure.errors)) return String(failure)
  return failure.errors
    .map((error: unknown) => {
      if (!isRecord(error) || typeof error.text !== 'string') return String(error)
      const location = error.location
      return isRecord(location) && typeof location.file === 'string' ? `${location.file}:${location.line}: ${error.text}` : error.text
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
