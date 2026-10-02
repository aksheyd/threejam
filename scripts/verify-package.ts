// Proves the package the ways people get it: builds and packs it, installs the tarball in a project outside the repo, and runs it once through npx with nothing installed.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM = npmCli()
const NPX = join(dirname(NPM), 'npx-cli.js')
const { name, version } = manifest(join(ROOT, 'package.json'))
const PACKAGE = join('node_modules', name)
// Node names modules by their real paths, and macOS reaches its temporary folder through a link.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'threejam-package-')))
const npxCache = join(node([NPM, 'config', 'get', 'cache'], ROOT).trim(), '_npx')
const cached = new Set(existsSync(npxCache) ? readdirSync(npxCache) : [])

try {
  node([join(ROOT, 'scripts', 'build.ts')], ROOT)
  const packed: unknown = JSON.parse(node([NPM, 'pack', join(ROOT, 'dist'), '--json', '--pack-destination', work], ROOT))
  const filename = Array.isArray(packed) && isRecord(packed[0]) ? packed[0].filename : undefined
  if (typeof filename !== 'string') throw new Error(`npm pack printed no tarball name: ${JSON.stringify(packed)}`)
  const tarball = join(work, filename)
  done(`packed ${filename}`)

  // A project that installs the package, in a folder whose path has a space, with install scripts off as npm 12 has them; the npx and solo installs below run them.
  const project = join(work, 'my project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'my-project', private: true, type: 'module' }, null, 2)}\n`)
  node([NPM, 'install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], project)
  // esbuild's postinstall replaces this JavaScript launcher with its binary everywhere but Windows.
  same(readFileSync(join(project, 'node_modules', 'esbuild', 'bin', 'esbuild'), 'latin1').startsWith('#!'), true)
  done('installed it in a project with install scripts off')
  same(threejam(project, ['new', 'catch']).files, ['game.ts', 'game.test.ts'])
  same(threejam(project, ['check', 'catch']), { ok: true, entities: 6 })
  const input = ['--press', 'Space@1', '--hold', 'Right@2-40']
  same(threejam(project, ['sim', 'catch', '--ticks', '120', ...input, '--only', 'game', '--fields', 'points']).entities, [{ name: 'game', points: 1 }])
  same(threejam(project, ['shot', 'catch', '--at', '1,98', ...input, '-o', 'frames/catch.png']).files, ['frames/catch-001.png', 'frames/catch-098.png'])
  for (const frame of ['catch-001.png', 'catch-098.png']) same(readFileSync(join(project, 'frames', frame)).toString('latin1', 1, 4), 'PNG')
  same(threejam(project, ['export', 'catch', '-o', 'catch.html']).file, 'catch.html')
  same(/<script type="module">/.test(readFileSync(join(project, 'catch.html'), 'utf8')), true)
  node(['--test', join('catch', 'game.test.ts')], project)
  await serveOnly(project)
  same(await mcpCommand(join(project, PACKAGE)), `npx -y ${name}@${version} --mcp`)
  mkdirSync(join(project, 'broken'))
  const random = ["import { defineGame } from 'threejam'", '', 'export default defineGame({', '  entities: { ball: { w: 0.1 } },', '  update(world) {', '    world.ball.x = Math.random()', '  },', '})', '']
  writeFileSync(join(project, 'broken', 'game.ts'), random.join('\n'))
  const clock = failure(project, ['sim', 'broken', '--ticks', '1'])
  same([clock.status, clock.message.startsWith('broken/game.ts:6: Math.random() would make runs differ')], [1, true])
  // The declarations import three, which ships no types, so without @types/three beside the package check would pass this view.ts with scene as any.
  mkdirSync(join(project, 'viewed'))
  copyFileSync(join(project, 'catch', 'game.ts'), join(project, 'viewed', 'game.ts'))
  const view = ["import type { ViewSetup } from 'threejam'", "import type game from './game.ts'", '', 'export function init({ scene }: ViewSetup<typeof game>): void {', '  scene.add(42)', '}', '']
  writeFileSync(join(project, 'viewed', 'view.ts'), view.join('\n'))
  const typed = failure(project, ['check', 'viewed'])
  same([typed.status, typed.message.startsWith("viewed/view.ts:5: Argument of type 'number' is not assignable to parameter of type 'Object3D")], [1, true])
  done('new, check, sim, shot, export, run, the starter test, a runtime error and a Three.js type error naming their lines, and the MCP command in the project')

  // Once through npx, outside any project, where new writes a project of its own.
  const once = (args: string[]) => threejam(work, args, ['--yes', `--package=${tarball}`, '--'])
  const created = once(['new', 'solo'])
  same(created.files, ['game.ts', 'game.test.ts', 'package.json', 'tsconfig.json'])
  same(isRecord(created.cta) && typeof created.cta.description === 'string' && created.cta.description.startsWith('Run npm install in solo first'), true)
  same(once(['check', 'solo']), { ok: true, entities: 6 })
  same(once(['sim', 'solo', '--ticks', '110', '--press', 'Space@1', '--only', 'game', '--fields', 'misses']).entities, [{ name: 'game', misses: 1 }])
  same(once(['export', 'solo', '-o', 'solo.html']).file, 'solo.html')
  const copy = (existsSync(npxCache) ? readdirSync(npxCache) : []).filter((entry) => !cached.has(entry)).map((entry) => join(npxCache, entry, PACKAGE))
  const inCache = copy.find((folder) => existsSync(join(folder, 'package.json')))
  if (inCache === undefined) throw new Error(`npx left no copy of ${name} in ${npxCache}`)
  same(await mcpCommand(inCache), `npx -y ${name}@${version} --mcp`)
  done('new, check, sim, export, and the MCP command through npx without installing')

  // The project new wrote, once it has the package; --no-save keeps its dependency on the version to be published.
  const solo = join(work, 'solo')
  node([NPM, 'install', '--no-save', '--no-audit', '--no-fund', tarball], solo)
  node(['--test'], solo)
  node([join(solo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], solo)
  done("the new project's own test and its tsconfig.json")
  console.log(`\n${name}@${version} works from its tarball.`)
} finally {
  rmSync(work, { recursive: true, force: true })
  for (const entry of existsSync(npxCache) ? readdirSync(npxCache) : []) if (!cached.has(entry)) rmSync(join(npxCache, entry), { recursive: true, force: true })
}

function done(what: string): void {
  console.log(`ok - ${what}`)
}

function node(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} failed in ${cwd}:\n${result.stdout}${result.stderr}`)
  return result.stdout
}

// Runs npx threejam as people do, which finds the project's copy, or with --package, a copy in npx's cache.
function threejam(cwd: string, args: string[], npx: string[] = []): Record<string, unknown> {
  const parsed: unknown = JSON.parse(node([NPX, ...npx, 'threejam', ...args, '--format', 'json'], cwd))
  if (!isRecord(parsed)) throw new Error(`threejam ${args.join(' ')} printed ${JSON.stringify(parsed)}`)
  return parsed
}

// Runs npx threejam in a project where the command should fail, for its exit code and message.
function failure(cwd: string, args: string[]): { status: number | null; message: string } {
  const result = spawnSync(process.execPath, [NPX, 'threejam', ...args, '--format', 'json'], { cwd, encoding: 'utf8' })
  const parsed: unknown = JSON.parse(result.stdout || '{}')
  return { status: result.status, message: isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message : '' }
}

function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// The installed CLI itself, so stopping it stops the server with nothing left running.
async function serveOnly(project: string): Promise<void> {
  const server = spawn(process.execPath, [join(project, PACKAGE, 'lib', 'cli.js'), 'run', 'catch', '--serve-only'], { cwd: project })
  try {
    const url = await new Promise<string>((found, fail) => {
      let out = ''
      server.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)
        if (match) found(match[0])
      })
      server.once('exit', (code) => fail(new Error(`run --serve-only exited with ${code}: ${out}`)))
    })
    for (const path of ['', 'bundle.js']) {
      const response = await fetch(`${url}${path}`)
      same([path, response.status], [path, 200])
    }
  } finally {
    const exited = new Promise((stopped) => server.once('exit', stopped))
    server.kill()
    await exited
  }
}

// What mcp add would register for the copy of the package in folder.
async function mcpCommand(folder: string): Promise<unknown> {
  const module: unknown = await import(pathToFileURL(join(folder, 'lib', 'package.js')).href)
  return isRecord(module) && typeof module.mcpCommand === 'function' ? module.mcpCommand() : undefined
}

// npm and npx are .cmd shims on Windows, so this Node runs npm's own script: the one npm run names, or the npm beside a folder on the PATH.
function npmCli(): string {
  const folders = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
  const candidates = [
    process.env.npm_execpath ?? '',
    ...folders.flatMap((folder) => [join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(folder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]),
  ]
  const found = candidates.find((path) => path.endsWith('npm-cli.js') && existsSync(path))
  if (found === undefined) throw new Error("can't find npm's npm-cli.js; run this with npm run test:package")
  return found
}

function manifest(path: string): { name: string; version: string } {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') throw new Error(`${path} needs a name and a version`)
  return { name: parsed.name, version: parsed.version }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
