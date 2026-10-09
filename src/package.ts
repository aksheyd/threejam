import { readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME = 'threejam'

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

// The Node running this process, which is the file a link to it leads to, so a name on the PATH that leads there comes first, since an upgrade keeps a name like Homebrew's /opt/homebrew/bin/node and removes the versioned file behind it. A snap's Node is in a folder of one revision, which snapd removes a few refreshes later, while its node on the PATH, /snap/bin/node, starts the snap's launcher, so it's plain node.
export function runningNode(path = process.env.PATH ?? '', running = realpathSync(process.execPath)): string {
  if (running.startsWith('/snap/')) return 'node'
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const folder of path.split(delimiter)) {
    if (!isAbsolute(folder)) continue
    const found = join(folder, name)
    try {
      if (realpathSync(found) === running && !fleeting(folder)) return found
    } catch {
      // A folder on the PATH without node, or one that can't be read.
    }
  }
  return process.execPath
}

// A PATH folder that lasts one shell or session: fnm's link for one shell, in a folder named fnm_multishells, or anything in the temporary folder or XDG_RUNTIME_DIR, which logout clears. fnm's link leads out of them, so the folder counts as the PATH names it too.
function fleeting(folder: string): boolean {
  if (folder.split(/[\\/]/).includes('fnm_multishells')) return true
  const roots = [tmpdir(), process.env.XDG_RUNTIME_DIR].flatMap((root) => (root !== undefined && isAbsolute(root) ? [root, resolved(root)] : []))
  return [folder, resolved(folder)].some((path) => roots.some((root) => inside(root, path)))
}

function resolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

// How agents start the MCP server: this Node with this CLI from a clone or an install, since an agent's PATH may find another Node or none, and npx for a copy in npx's cache, which npm cleans out.
export function mcpCommand({ cli = engineFile('cli'), version = VERSION, node = runningNode() }: { cli?: string; version?: string; node?: string } = {}): string {
  const folders = cli.split(/[\\/]/)
  // add-mcp splits a command at every space, so an install on a path with one starts the same version through npx, and a Node on a path with one is found on the PATH.
  if (folders.includes('_npx') || (cli.includes(' ') && folders.includes('node_modules'))) return `npx -y ${NAME}@${version} --mcp`
  return `${node.includes(' ') ? 'node' : node} ${cli.includes(' ') ? `"${cli}"` : cli} --mcp`
}

export interface Manifest {
  readonly path: string
  readonly json: Readonly<Record<string, unknown>>
}

// Each readable package.json from folder up to the top of its drive, nearest first.
export function* manifestsAbove(folder: string): Generator<Manifest> {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    // Reading a FIFO by that name would wait for good.
    const json = statSync(path, { throwIfNoEntry: false })?.isFile() ? readManifest(path) : undefined
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
