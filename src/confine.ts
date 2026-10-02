// The import rule shared by the Node sandbox bundle (load.ts) and the browser page bundle (serve.ts): what a file may import depends on which entry reached it, told apart by where the importer sits, not on where the imported file sits.
//
//   game    -> its own folder and ThreeJam's files
//   driver  -> its own folder, the game's folder, and ThreeJam's files
//   engine  -> ThreeJam's files and their dependencies (three for the page)
//
// A game or driver folder inside the engine folder is refused, so a game placed in src/ or lib/ gets no engine trust, and nesting one folder in another never widens a set, since the most specific root wins.
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type * as esbuild from 'esbuild'
import { UsageError, quote } from './errors.ts'
import { ENGINE, NAME, engineFile } from './package.ts'

export type Role = 'engine' | 'game' | 'driver'

export interface Roots {
  readonly engine: string
  readonly game: string
  readonly driver: string | undefined
}

export interface ConfineOptions {
  readonly roots: Roots
  // Absolute paths of the files the entry is allowed to pull in directly: the game.ts, a view.ts, and the --driver file.
  readonly seeds: readonly string[]
}

const RESOLVING = Symbol('threejam.resolving')

// The path the OS itself gives a file, with links resolved and, on a case-insensitive volume (macOS's and Windows' default), each name spelled as it is on disk, so two spellings of one file come out the same; an unresolvable path is compared as it is.
export function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

// Whether path is root or inside it. Both are real paths, so they compare exactly: folding case by hand could call two folders one, since lowercasing 'İ' adds a character, and path.relative folds case on Windows.
export function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

// Realpaths the engine, the game's folder, and a driver's, and refuses a game or driver that sits inside the engine, which would otherwise borrow the engine's trust.
export function confineRoots({ engine, game, driver }: { engine?: string; game: string; driver: string | undefined }): Roots {
  const roots: Roots = { engine: real(engine ?? ENGINE), game: real(game), driver: driver === undefined ? undefined : real(driver) }
  if (within(roots.engine, roots.game)) throw new UsageError("the game's folder can't be inside ThreeJam's own files")
  if (roots.driver !== undefined && within(roots.engine, roots.driver)) throw new UsageError("a --driver file can't be inside ThreeJam's own files")
  return roots
}

// Which entry a file belongs to, by where it sits. The engine is checked first and the game before the driver, so a file in an overlap takes the narrower role and nesting can't widen a set.
export function roleOf(path: string, roots: Roots): Role | undefined {
  if (within(roots.engine, path)) return 'engine'
  if (within(roots.game, path)) return 'game'
  if (roots.driver !== undefined && within(roots.driver, path)) return 'driver'
  return undefined
}

// The role to judge an import by: the importer's, or engine for the generated entry, which sits in no folder.
export function importerRole(importer: string, roots: Roots): Role {
  return (isAbsolute(importer) ? roleOf(real(importer), roots) : undefined) ?? 'engine'
}

export function allows(role: Role, target: string, roots: Roots): boolean {
  switch (role) {
    case 'engine':
      // ThreeJam's own files and their dependencies, which come from a node_modules folder, like three for the page.
      return within(roots.engine, target) || target.split(sep).includes('node_modules')
    case 'game':
      return within(roots.engine, target) || within(roots.game, target)
    case 'driver':
      return within(roots.engine, target) || within(roots.game, target) || (roots.driver !== undefined && within(roots.driver, target))
    default: {
      const _exhaustive: never = role
      return _exhaustive
    }
  }
}

function reason(path: string, target: string, role: Role): string {
  const may =
    role === 'game'
      ? "a game may import only its own folder and ThreeJam's files"
      : role === 'driver'
        ? "a driver may import only its folder, the game's folder, and ThreeJam's files"
        : "ThreeJam's files import only each other and their dependencies"
  const where = target === path ? '' : `, which is ${target.replaceAll(sep, '/')}`
  const three = role === 'game' && /^three(\/|$)/.test(path) ? "; use the THREE that init and draw receive in view.ts, and import type from 'three' for its types" : ''
  return `can't bundle ${quote(path)}${where}: ${may}${three}`
}

// The esbuild plugin that enforces the rule on every import. Register it last, after any plugin that serves a virtual module (like the page's assets), and handle the entry point in the caller; this plugin maps the threejam package to the engine and confines everything else.
export function confinePlugin({ roots, seeds }: ConfineOptions): esbuild.Plugin {
  const seedFiles = new Set<string>()
  for (const seed of seeds) {
    const resolved = real(seed)
    // A game.ts, view.ts, or --driver that is a link out of its folder would otherwise smuggle the whole target tree in as the game or driver.
    if (!within(roots.game, resolved) && !(roots.driver !== undefined && within(roots.driver, resolved))) {
      throw new UsageError(`can't bundle ${quote(shown(seed))}, which is ${resolved.replaceAll(sep, '/')}: a game.ts, view.ts, or --driver must be a file in its own folder, not a link elsewhere`)
    }
    seedFiles.add(resolved)
  }
  return {
    name: 'threejam-confine',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === RESOLVING) return undefined
        if (args.kind === 'entry-point') return undefined
        if (args.path === NAME) return { path: engineFile('index') }
        const found = await build.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, pluginData: RESOLVING })
        if (found.errors.length > 0) return { errors: found.errors }
        const target = real(found.path)
        const role = importerRole(args.importer, roots)
        // Only the generated entry, which belongs to no folder, pulls in the game, view, and driver files directly.
        if (role === 'engine' && seedFiles.has(target)) return { path: found.path }
        if (found.namespace !== 'file' || found.external || !allows(role, target, roots)) return { errors: [{ text: reason(args.path, target, role) }] }
        return { path: found.path }
      })
    },
  }
}

function shown(file: string): string {
  const rest = relative(process.cwd(), file)
  return (isAbsolute(rest) ? file : rest).replaceAll(sep, '/')
}
