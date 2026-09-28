import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME = '@aksheyd/fourjs'

const HERE = fileURLToPath(import.meta.url)
// The engine's folder: src in a clone, which runs the TypeScript sources, and lib in the published package, which runs compiled JavaScript.
export const ENGINE = dirname(HERE)
export const ROOT = dirname(ENGINE)
const EXTENSION = extname(HERE)

export function engineFile(name: string): string {
  return join(ENGINE, `${name}${EXTENSION}`)
}

// What check maps imports of the package to: the sources in a clone, and the declarations next to the compiled JavaScript.
export const TYPES = EXTENSION === '.ts' ? engineFile('index') : join(ENGINE, 'index.d.ts')

export const VERSION = version(join(ROOT, 'package.json'))

function version(path: string): string {
  const json = readManifest(path)
  if (typeof json?.version === 'string') return json.version
  throw new Error(`${path} has no version`)
}

// How agents start the MCP server: node with this CLI from a clone or an install, and npx for a copy in npx's cache, which npm cleans out.
export function mcpCommand({ cli = engineFile('cli'), version = VERSION }: { cli?: string; version?: string } = {}): string {
  const folders = cli.split(/[\\/]/)
  // add-mcp splits a command at every space, so an install on a path with one starts the same version through npx.
  if (folders.includes('_npx') || (cli.includes(' ') && folders.includes('node_modules'))) return `npx -y ${NAME}@${version} --mcp`
  return `node ${cli.includes(' ') ? `"${cli}"` : cli} --mcp`
}

export interface Manifest {
  readonly path: string
  readonly json: Readonly<Record<string, unknown>>
}

// Each readable package.json from folder up to the top of its drive, nearest first.
export function* manifestsAbove(folder: string): Generator<Manifest> {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    const json = existsSync(path) ? readManifest(path) : undefined
    if (json !== undefined) yield { path, json }
    if (dirname(dir) === dir) return
  }
}

function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : undefined
  } catch {
    return undefined
  }
}
