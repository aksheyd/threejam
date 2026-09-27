import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RunError, UsageError } from './errors.ts'
import type { Game } from './types.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function gameFile(dir: string): string {
  const folder = resolve(dir)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new UsageError(`${dir} isn't a folder`)
  const file = ['game.ts', 'game.js'].map((name) => join(folder, name)).find((path) => existsSync(path))
  if (!file) throw new UsageError(`${dir} has no game.ts`)
  return file
}

export async function loadGame(dir: string): Promise<Game> {
  const module = await import(pathToFileURL(gameFile(dir)).href)
  return module.default
}

export function typecheck(file: string): string[] {
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc')
  if (!existsSync(tsc)) return []
  const flags = ['--ignoreConfig', '--noEmit', '--pretty', 'false', '--strict', '--target', 'es2023', '--lib', 'es2023']
  const modules = ['--module', 'nodenext', '--moduleResolution', 'nodenext', '--allowImportingTsExtensions']
  const syntax = ['--erasableSyntaxOnly', '--verbatimModuleSyntax', '--skipLibCheck']
  const result = spawnSync(tsc, [...flags, ...modules, ...syntax, file], { cwd: ROOT, encoding: 'utf8' })
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
      errors[errors.length - 1] += `\n${line}`
    }
  }
  if (result.status !== 0 && !/error TS\d+/.test(result.stdout)) {
    errors.push(`the TypeScript check failed: ${`${result.stdout}${result.stderr}`.trim() || `exit ${result.status}`}`)
  }
  return errors
}

// Game logic sees only the language, so these names fail with the fix attached.
const HINTS: Array<[RegExp, string]> = [
  [/'console'/, 'use ctx.print(...), which sim shows with the tick'],
  [/'(setTimeout|setInterval|performance|requestAnimationFrame)'/, 'count ticks with ctx.tick instead'],
  [/'(document|window|HTMLCanvasElement)'/, 'game logic has no page; draw in view.ts'],
]

function hinted(message: string): string {
  const hint = HINTS.find(([pattern]) => message.startsWith('Cannot find name') && pattern.test(message))
  return hint ? `${message.replace(/ Do you need.*$/, '')} Here, ${hint[1]}.` : message
}

export function describe(error: unknown, gameDir?: string): string {
  if (error instanceof UsageError) return error.message
  const inner = error instanceof RunError ? error.cause : error
  const where = gameDir === undefined ? undefined : locate(inner, gameDir)
  const text = !(inner instanceof Error)
    ? String(inner)
    : inner.name === 'GameError' || inner.name === 'Error'
      ? inner.message
      : `${inner.name}: ${inner.message}`
  const line = where ? `${where}: ${text}` : text
  if (!(error instanceof RunError)) return line
  return `${line}\n  in ${error.phase}${error.phase === 'update' ? ` at tick ${error.tick}` : ''}`
}

function locate(error: unknown, gameDir: string): string | undefined {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  for (const match of stack.matchAll(/(file:\/\/[^\s)]+?|\/[^\s():]+):(\d+)(?::\d+)?/g)) {
    const file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1]
    if (file.startsWith(gameDir + sep)) return `${relative(process.cwd(), file)}:${match[2]}`
  }
  return undefined
}
