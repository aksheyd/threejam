// Builds the published package in dist: the engine compiled to JavaScript with declarations in lib, a package.json that points at them, the docs, and the skill.
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const LIB = join(DIST, 'lib')

const root: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (!isRecord(root) || typeof root.name !== 'string' || typeof root.version !== 'string' || typeof root.homepage !== 'string') {
  throw new Error('package.json needs a name, a version, and a homepage on GitHub')
}
const repository = new URL(root.homepage).pathname.replace(/^\/|\/$/g, '')
// A user's install resolves the dependencies again, without the lockfile, so each one names the exact version CI installs from it.
const lock: unknown = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
const locked = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {}
if (!isRecord(root.dependencies)) throw new Error('package.json needs dependencies')
for (const [name, wanted] of Object.entries(root.dependencies)) {
  const entry = locked[`node_modules/${name}`]
  const tested = isRecord(entry) ? entry.version : undefined
  if (wanted !== tested) throw new Error(`package.json depends on ${name} ${String(wanted)}, but CI tests ${String(tested ?? 'no version')} from package-lock.json; depend on exactly that version`)
}

rmSync(DIST, { recursive: true, force: true })
const tsc = spawnSync(process.execPath, [typescript(), '-p', join(ROOT, 'tsconfig.build.json')], { cwd: ROOT, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

// TypeScript rewrites relative .ts imports in the JavaScript it emits but not in declarations.
for (const file of filesIn(LIB).filter((path) => path.endsWith('.d.ts'))) {
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2'))
}
// Declarations only matter where the package's one entry point reaches them.
const reached = new Set<string>()
for (const queue = [join(LIB, 'index.d.ts')]; queue.length > 0; ) {
  const file = queue.pop()
  if (file === undefined || reached.has(file)) continue
  reached.add(file)
  for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)\.js['"]/g)) {
    queue.push(resolve(dirname(file), `${specifier}.d.ts`))
  }
}
for (const file of filesIn(LIB)) if (file.endsWith('.d.ts') && !reached.has(file)) rmSync(file)

const manifest = {
  name: root.name,
  version: root.version,
  description: root.description,
  license: root.license,
  author: root.author,
  repository: root.repository,
  homepage: root.homepage,
  bugs: root.bugs,
  keywords: root.keywords,
  type: 'module',
  bin: { threejam: 'lib/cli.js' },
  exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
  files: ['lib', 'AGENTS.md', 'skills'],
  engines: root.engines,
  dependencies: root.dependencies,
}
writeFileSync(join(DIST, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(join(ROOT, 'LICENSE'), join(DIST, 'LICENSE'))
writeFileSync(join(DIST, 'AGENTS.md'), withoutSection(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'), 'Working on ThreeJam'))
// In skills/, where the skills CLI looks inside node_modules, so a project can install the skill that matches its version.
cpSync(join(ROOT, 'skills'), join(DIST, 'skills'), { recursive: true })
writeFileSync(join(DIST, 'README.md'), absoluteLinks(readFileSync(join(ROOT, 'README.md'), 'utf8')))
console.log(`Built ${root.name}@${root.version} in ${relative(process.cwd(), DIST).replaceAll(sep, '/') || '.'}; publish it with npm publish ./dist`)

// npmjs.com shows the README away from the repo, so relative links point at GitHub and images at their raw files, both on main.
function absoluteLinks(markdown: string): string {
  const absolute = (url: string): string => {
    if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('#')) return url
    const [path, fragment] = url.split('#', 2)
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return `https://raw.githubusercontent.com/${repository}/main/${path}`
    const kind = existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isDirectory() ? 'tree' : 'blob'
    return `https://github.com/${repository}/${kind}/main/${path}${fragment === undefined ? '' : `#${fragment}`}`
  }
  // Code blocks stay as they are, since ]( can be code there.
  return markdown
    .split(/(^```[^\n]*\n[\s\S]*?^```$)/m)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/\]\(([^)\s]+)\)/g, (_, url: string) => `](${absolute(url)})`).replace(/\b(src|href)="([^"]+)"/g, (_, name: string, url: string) => `${name}="${absolute(url)}"`),
    )
    .join('')
}

// The package's manual is for making games, so it leaves out the section that sends contributors to CONTRIBUTING.md.
function withoutSection(markdown: string, title: string): string {
  const heading = `\n## ${title}\n`
  const start = markdown.indexOf(heading)
  if (start === -1) throw new Error(`AGENTS.md has no "## ${title}" section to leave out of the package`)
  const next = markdown.indexOf('\n## ', start + heading.length)
  return `${markdown.slice(0, start).trimEnd()}\n${next === -1 ? '' : markdown.slice(next)}`
}

// npm's shims in node_modules/.bin are .cmd files on Windows, so this Node runs the script the package names.
function typescript(): string {
  const manifest = fileURLToPath(import.meta.resolve('typescript/package.json'))
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const tsc = isRecord(parsed) && isRecord(parsed.bin) ? parsed.bin.tsc : undefined
  if (typeof tsc !== 'string') throw new Error(`${manifest} names no tsc to run`)
  return join(dirname(manifest), tsc)
}

function filesIn(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(folder, entry.name)) : [join(folder, entry.name)],
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
