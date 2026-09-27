import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { parseGame } from './engine.ts'
import { RunError, UsageError, type Phase } from './errors.ts'
import { isDrive, type Drive, type Game } from './types.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = join(ROOT, 'src') + sep
const INDEX = pathToFileURL(join(ROOT, 'src', 'index.ts')).href
// The real path keeps source maps from resolving through a symlinked temp folder, as on macOS.
const MODULES = join(realpathSync(tmpdir()), 'fourjs-modules')
let loads = 0

process.setSourceMapsEnabled(true)

export interface GameFiles {
  readonly folder: string
  readonly game: string
  readonly view: string | undefined
}

export function gameFiles(dir: string): GameFiles {
  const folder = resolve(dir)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new UsageError(`${dir} isn't a folder`)
  const game = firstFile(folder, 'game')
  if (game === undefined) throw new UsageError(`${dir} has no game.ts`)
  return { folder, game, view: firstFile(folder, 'view') }
}

export async function loadGame(dir: string): Promise<Game> {
  const module = await importFresh(gameFiles(dir).game)
  return parseGame(module.default)
}

export async function loadDriver(path: string): Promise<Drive> {
  const file = resolve(path)
  if (!existsSync(file)) throw new UsageError(`--driver ${path} doesn't exist`)
  const { default: drive } = await importFresh(file)
  if (!isDrive(drive)) throw new UsageError(`--driver ${path} must export default a function ({ world, tick, random }) => keys, or defineDriver(...)`)
  return drive
}

export function typecheck({ file, dom }: { file: string; dom: boolean }): string[] {
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc')
  if (!existsSync(tsc)) return []
  const flags = ['--ignoreConfig', '--noEmit', '--pretty', 'false', '--strict', '--target', 'es2023']
  const lib = ['--lib', dom ? 'es2023,dom,dom.iterable' : 'es2023']
  const modules = ['--module', 'nodenext', '--moduleResolution', 'nodenext', '--allowImportingTsExtensions']
  const syntax = ['--erasableSyntaxOnly', '--verbatimModuleSyntax', '--skipLibCheck']
  const result = spawnSync(tsc, [...flags, ...lib, ...modules, ...syntax, file], { cwd: ROOT, encoding: 'utf8' })
  const folder = dirname(file) + sep
  const errors: string[] = []
  let keep = false
  for (const line of result.stdout.split('\n')) {
    const match = /^(.+?)\((\d+),\d+\): error TS\d+: (.*)$/.exec(line)
    if (match) {
      const path = resolve(ROOT, match[1])
      keep = path.startsWith(folder)
      if (keep) errors.push(`${relative(process.cwd(), path)}:${match[2]}: ${hinted(match[3])}`)
    } else if (keep && line.startsWith('  ')) {
      errors[errors.length - 1] += ` ${line.trim()}`
    }
  }
  if (result.status !== 0 && !/error TS\d+/.test(result.stdout)) {
    errors.push(`the TypeScript check failed: ${`${result.stdout}${result.stderr}`.trim() || `exit ${result.status}`}`)
  }
  return errors
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
      outfile: join(MODULES, 'module.mjs'),
      logLevel: 'silent',
      plugins: [{ name: 'fourjs', setup: (build) => void build.onResolve({ filter: /^fourjs$/ }, () => ({ path: INDEX, external: true })) }],
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

function locate(error: unknown): string | undefined {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  for (const match of stack.matchAll(/(file:\/\/[^\s)]+?|\/[^\s():]+):(\d+)(?::\d+)?/g)) {
    const file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1]
    if (file.startsWith(ENGINE) || file.includes(`${sep}node_modules${sep}`)) continue
    return `${relative(process.cwd(), file)}:${match[2]}`
  }
  return undefined
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
