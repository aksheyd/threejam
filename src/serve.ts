import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { constants as vmConstants, createContext } from 'node:vm'
import * as esbuild from 'esbuild'
import { mediaType } from './assets.ts'
import { confinePlugin, confineRoots } from './confine.ts'
import { BuildError } from './errors.ts'
import { STAND_INS } from './guard.ts'
import { assetsIn, gameFiles, spawnTied, type GameFiles } from './load.ts'
import { NAME, engineFile } from './package.ts'
import { Recording, savePlaytest, type Taken } from './playtest.ts'
import type { Config } from './browser/client.ts'

export interface Page {
  // The game's folder, which the page's images and sounds come from.
  readonly folder: string
  // The page as the latest build left it, which says why when that build failed, and the script of the last build that didn't.
  readonly index: string
  readonly bundle: Uint8Array
  // Counts the builds that changed the page; a run page gives the count it came with when it listens for reloads.
  readonly build: number
  dispose(): Promise<void>
}

export interface PageOptions {
  readonly dir: string
  // A run page's config also gets the build the page comes from, and why that build failed, if it did.
  readonly config: { readonly mode: 'run'; readonly seed: number; readonly token: string; readonly record?: boolean } | { readonly mode: 'shot' }
  readonly driver?: string
  readonly onRebuild?: (errors: string[]) => void
}

export async function buildPage({ dir, config, driver, onRebuild }: PageOptions): Promise<Page> {
  const files = gameFiles(dir)
  const page = pageBuild({ files, driver, address: (name) => `assets/${encodeURIComponent(name)}` })
  let bundle: Uint8Array = new Uint8Array()
  let failure: string | undefined
  let builds = 0
  let firstEnded: ((errors: esbuild.Message[]) => void) | undefined
  const first = new Promise<esbuild.Message[]>((ended) => (firstEnded = ended))
  const context = await esbuild.context({
    ...page,
    // Built in memory, since esbuild deletes a file it wrote when a later build fails, and a folder for one would outlive a run that's killed.
    write: false,
    sourcemap: config.mode === 'run' ? 'inline' : false,
    plugins: [
      ...page.plugins,
      {
        name: 'threejam-rebuild',
        setup: (build) =>
          void build.onEnd((result) => {
            const errors = result.errors.map(formatMessage)
            const why = errors.length === 0 ? undefined : errors.join('\n')
            // esbuild rebuilds over and over while a file it reads can't be, failing the same way each time, and a repeat leaves the page as it was.
            if (why !== undefined && why === failure) return
            if (why === undefined && result.outputFiles) bundle = result.outputFiles[0].contents
            failure = why
            builds += 1
            if (firstEnded !== undefined) firstEnded(result.errors)
            else onRebuild?.(errors)
            firstEnded = undefined
          }),
      },
    ],
  })
  // A page that follows saves takes its first build from watch mode, since a build before it would leave watch mode a first build of its own, whose end would read as a save.
  const errors = onRebuild ? await context.watch().then(() => first) : (await context.rebuild().catch((failed: esbuild.BuildFailure) => failed)).errors
  if (errors.length > 0) {
    await context.dispose()
    throw new BuildError(errors.map(formatMessage).join('; '))
  }
  return {
    folder: files.folder,
    get index() {
      return html({ title: basename(files.folder), config: config.mode === 'run' ? { ...config, build: builds, failure } : config, script: { kind: 'file', src: '/bundle.js' } })
    },
    get bundle() {
      return bundle
    },
    get build() {
      return builds
    },
    dispose: () => context.dispose(),
  }
}

// What every page bundles: the game, its view, a driver if there is one, and the page code, which loads each image and sound from address(name).
export function pageBuild({ files, driver, address }: { files: GameFiles; driver?: string; address: (name: string) => string }) {
  const driverFile = driver === undefined ? undefined : resolve(driver)
  const roots = confineRoots({ game: files.folder, driver: driverFile === undefined ? undefined : dirname(driverFile) })
  const seeds = [files.game, ...(files.view === undefined ? [] : [files.view]), ...(driverFile === undefined ? [] : [driverFile])]
  // The game's own modules load only when play runs them, as in the sandbox's bundle, so it can raise the guard first.
  const load = (file: string) => `() => require(${JSON.stringify(file)})`
  const entry = [
    "import assets from 'threejam:assets'",
    `import { play } from ${JSON.stringify(engineFile(join('browser', 'client')))}`,
    `const view = ${files.view ? load(files.view) : '() => ({})'}`,
    `const driver = ${driverFile ? load(driverFile) : 'undefined'}`,
    `play({ game: ${load(files.game)}, view, driver, assets, config: window.THREEJAM, realm: ${JSON.stringify(realmGlobals())} })`,
  ].join('\n')
  // A module in no folder, unlike stdin, which esbuild places in its resolveDir, so the import rule judges what the entry pulls in as the engine's.
  const page: esbuild.Plugin = {
    name: 'threejam-page',
    setup(build) {
      build.onResolve({ filter: /^threejam:page$/ }, () => ({ path: 'page', namespace: 'threejam' }))
      build.onLoad({ filter: /^page$/, namespace: 'threejam' }, () => ({ contents: entry, loader: 'ts', resolveDir: files.folder }))
    },
  }
  const assets: esbuild.Plugin = {
    // Listing the folder on each build picks up new files.
    name: 'threejam-assets',
    setup(build) {
      build.onResolve({ filter: /^threejam:assets$/ }, () => ({ path: 'assets', namespace: 'threejam' }))
      build.onLoad({ filter: /^assets$/, namespace: 'threejam' }, () => {
        const names = assetsIn(files.folder)
        return {
          contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, address(name)])))}`,
          loader: 'js',
          watchDirs: [files.folder],
          // esbuild rebuilds over and over while a file it watches can't be read, so one that can't be isn't watched.
          watchFiles: names.map((name) => join(files.folder, name)).filter(readable),
        }
      })
    },
  }
  return {
    entryPoints: ['threejam:page'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: { [NAME]: engineFile('index') },
    logLevel: 'silent',
    // The shared import rule claims every import the other plugins leave, so it comes last.
    plugins: [page, assets, confinePlugin({ roots, seeds })],
  } satisfies esbuild.BuildOptions
}

function readable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

// The globals game code finds in sim's realm, which a page keeps while it bares the rest: the language's, as this Node gives them to a realm of its own, and the guard's stand-ins.
function realmGlobals(): string[] {
  return [...Object.getOwnPropertyNames(createContext(vmConstants.DONT_CONTEXTIFY)), ...STAND_INS]
}

// The page that run, shot, and export build, bundled in memory only, so check refuses what they would.
export async function bundlePage(dir: string): Promise<void> {
  const built = await esbuild.build({ ...pageBuild({ files: gameFiles(dir), address: (name) => name }), write: false }).catch((failure: esbuild.BuildFailure) => failure)
  if (built instanceof Error) throw new BuildError(built.errors.map(formatMessage).join('; '))
}

export function formatMessage(message: esbuild.Message): string {
  const at = message.location && message.location.namespace !== 'threejam' ? `${message.location.file}:${message.location.line}: ` : ''
  return `${at}${message.text}`
}

type Script = { readonly kind: 'file'; readonly src: string } | { readonly kind: 'inline'; readonly code: string }

// With touch-action none, a finger dragged on the canvas stays the game's instead of the browser taking it over to pan or zoom the page.
export function html({ title, config, script }: { title: string; config: Config; script: Script }): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title.replace(/[<&]/g, '')}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{position:absolute;inset:0;margin:auto;display:block;touch-action:none}</style>
</head>
<body>
<canvas></canvas>
<script>window.THREEJAM = ${configJson(config)}</script>
${scriptTag(script)}
</body>
</html>
`
}

// A failure can quote the game's files, and a script element ends at the first </script, even one inside a string, so < goes in as \u003c, which means the same to JavaScript.
function configJson(config: Config): string {
  return JSON.stringify(config).replaceAll('<', '\\u003c')
}

function scriptTag(script: Script): string {
  switch (script.kind) {
    case 'file':
      return `<script type="module" src="${script.src}"></script>`
    case 'inline':
      // A script element ends at the first </script, even one inside a string, and <\/script means the same to JavaScript.
      return `<script type="module">\n${script.code.replace(/<\/(script)/gi, '<\\/$1')}</script>`
    default: {
      const _exhaustive: never = script
      return _exhaustive
    }
  }
}

export interface Server {
  readonly url: string
  reload(): void
  close(): void
}

// Every response: never cached or read as another type, and never loaded into a page from another origin.
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' }
// No page may frame the game or its files, and an image or sound opened as a page runs and loads nothing.
const PAGE_POLICY = "frame-ancestors 'none'"
const ASSET_POLICY = "sandbox; default-src 'none'; frame-ancestors 'none'"

// The most of a playtest one request may send; a page sends far less at a time.
const MOST_RECORD_BYTES = 1024 * 1024
const RECORDED: Readonly<Record<Taken, number>> = { taken: 204, stale: 409, invalid: 400 }

// The server answers only the page itself, and /events, /quit, and /record only with the token that run gives its page; without one, as for shot, it refuses them. /record is there only while run records the playtest.
export function serve({ page, token, onQuit = () => {}, recording }: { page: Page; token?: string; onQuit?: () => void; recording?: Recording }): Promise<Server> {
  const listeners = new Set<ServerResponse>()
  const secret = token === undefined ? undefined : Buffer.from(token)
  const granted = (given: string | null) => {
    const offered = Buffer.from(given ?? '')
    return secret !== undefined && offered.length === secret.length && timingSafeEqual(offered, secret)
  }
  let hosts: readonly string[] = []
  const server = createServer((request, response) => {
    const target = request.url ?? '/'
    const mark = target.indexOf('?')
    const path = mark < 0 ? target : target.slice(0, mark)
    const query = new URLSearchParams(mark < 0 ? '' : target.slice(mark + 1))
    if (!fromPage(request, hosts) || ((path === '/quit' || path === '/events' || path === '/record') && !granted(query.get('token')))) {
      response.writeHead(403, HEADERS).end()
      return
    }
    if (request.method === 'POST' && path === '/quit') {
      response.end()
      onQuit()
      return
    }
    if (request.method === 'POST' && path === '/record' && recording !== undefined) {
      void bodyOf(request, MOST_RECORD_BYTES).then((body) => response.writeHead(body === undefined ? 413 : RECORDED[recording.take(query, body, page.build)], HEADERS).end())
      return
    }
    if (path.startsWith('/assets/')) {
      const name = decodedName(path.slice('/assets/'.length))
      const type = name === undefined ? undefined : mediaType(name)
      let data: Buffer | undefined
      try {
        data = name !== undefined && type !== undefined && assetsIn(page.folder).includes(name) ? readFileSync(join(page.folder, name)) : undefined
      } catch {
        // A folder or file that can't be read, like an image without read permission, fails its own request rather than stopping run.
        response.writeHead(500).end()
        return
      }
      if (type === undefined || data === undefined) {
        response.writeHead(404).end()
        return
      }
      // An SVG can hold script, so opening one downloads it instead.
      const download = type === 'image/svg+xml' ? { 'content-disposition': 'attachment' } : {}
      response.writeHead(200, { ...HEADERS, 'content-type': type, 'content-security-policy': ASSET_POLICY, ...download })
      response.end(data)
      return
    }
    if (path === '/events') {
      response.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream' })
      // A page from before the latest build missed that build's reload while it loaded, so it reloads now.
      response.write(query.get('build') === String(page.build) ? ':\n\n' : 'data: reload\n\n')
      listeners.add(response)
      request.on('close', () => listeners.delete(response))
      return
    }
    if (path === '/favicon.ico') {
      response.writeHead(204).end()
      return
    }
    const name = path === '/' ? 'index.html' : path.slice(1)
    if (name !== 'index.html' && name !== 'bundle.js') {
      response.writeHead(404).end()
      return
    }
    const headers = name === 'bundle.js' ? { 'content-type': 'text/javascript; charset=utf-8' } : { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY }
    response.writeHead(200, { ...HEADERS, ...headers })
    response.end(name === 'bundle.js' ? page.bundle : page.index)
  })
  return new Promise((ready, fail) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        fail(new Error(`the page server has no port: ${String(address)}`))
        return
      }
      hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`]
      ready({
        url: `http://127.0.0.1:${address.port}/`,
        reload() {
          for (const listener of listeners) listener.write('data: reload\n\n')
        },
        close() {
          for (const listener of listeners) listener.end()
          server.close()
        },
      })
    })
  })
}

// Host stops DNS rebinding, and Origin and Sec-Fetch-Site stop every other page, even one on another port or opened from a file.
function fromPage({ headers }: IncomingMessage, hosts: readonly string[]): boolean {
  const { host, origin } = headers
  const site = headers['sec-fetch-site']
  return (
    host !== undefined &&
    hosts.includes(host) &&
    (origin === undefined || origin === `http://${host}`) &&
    (site === undefined || site === 'same-origin' || site === 'none')
  )
}

// What a request sends, or undefined once that passes most bytes or the request ends early.
function bodyOf(request: IncomingMessage, most: number): Promise<string | undefined> {
  return new Promise((done) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= most) chunks.push(chunk)
    })
    request.once('end', () => done(bytes <= most ? Buffer.concat(chunks).toString('utf8') : undefined))
    request.once('close', () => done(undefined))
  })
}

function decodedName(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

// What Chrome needs from our environment to start, find its files, open a window, and play sound, so it never sees the rest, like tokens.
const CHROME_ENV = [
  'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'PULSE_SERVER', 'CHROME_DEVEL_SANDBOX',
  'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
  'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
]

export function chromeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of CHROME_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

// Chrome on Linux binds its socket at TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket, or in com.google.Chrome.XXXXXX for Google Chrome, and exits as it starts when that path passes the 107 bytes Linux allows a socket's.
const LONGEST_SOCKET = 107
const LONGEST_TMPDIR = LONGEST_SOCKET - '/org.chromium.Chromium.XXXXXX/SingletonSocket'.length

// Why a Chrome that exited as it started did, and what to do, when its TMPDIR leaves its socket no room.
export function tmpdirHint(tmpdir: string | undefined): string | undefined {
  if (process.platform !== 'linux' || tmpdir === undefined) return undefined
  const bytes = Buffer.byteLength(tmpdir.replace(/\/+$/, ''))
  if (bytes <= LONGEST_TMPDIR) return undefined
  return `as Chrome on Linux does in a TMPDIR over ${LONGEST_TMPDIR} bytes, where its socket goes, and ${tmpdir} is ${bytes}; set TMPDIR to a shorter folder, like /tmp`
}

// Chromium names the temporary folders it makes org.chromium.Chromium.XXXXXX, or com.google.Chrome.XXXXXX in Google Chrome, and its socket's folder is one of them.
const CHROMIUM_FOLDER = /^(com\.google\.Chrome|org\.chromium\.Chromium)\.\w{6}$/

// The Chromium folders in a TMPDIR too long for Chrome's socket, listed before Chrome starts there, so that the socket's folder it leaves can be told from other programs' folders of the same name.
export function socketFolders(tmpdir: string | undefined): string[] {
  return tmpdirHint(tmpdir) === undefined ? [] : entries(tmpdir).filter((name) => CHROMIUM_FOLDER.test(name))
}

// Chrome makes its socket's folder before it finds the socket's path too long, and exits leaving the folder empty; of the empty Chromium folders, one that wasn't there before goes if its socket wouldn't fit, so another program's stays, and so does one a Chrome whose socket fits is about to use.
export function removeSocketFolders(tmpdir: string | undefined, before: readonly string[]): void {
  if (tmpdir === undefined) return
  for (const name of entries(tmpdir)) {
    const folder = join(tmpdir, name)
    if (before.includes(name) || !CHROMIUM_FOLDER.test(name) || Buffer.byteLength(join(folder, 'SingletonSocket')) <= LONGEST_SOCKET) continue
    try {
      rmdirSync(folder)
    } catch {
      // A folder that holds anything stays.
    }
  }
}

// What a folder holds, or nothing when it can't be read.
function entries(folder: string | undefined): string[] {
  if (folder === undefined) return []
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

// Chrome keeps the last of a switch it's given twice, and a wrapper script puts its own first, so this comes after them: Chrome opens no DevTools port at -1.
export const NO_DEVTOOLS_PORT = '--remote-debugging-port=-1'

export function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  return browserPaths().find((path) => existsSync(path))
}

// Chrome, then Chromium; every Windows has Edge, which is Chromium too.
function browserPaths(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  }
  if (process.platform === 'win32') {
    const { PROGRAMFILES, LOCALAPPDATA, 'PROGRAMFILES(X86)': PROGRAMFILES_X86 } = process.env
    const chrome = join('Google', 'Chrome', 'Application', 'chrome.exe')
    const edge = join('Microsoft', 'Edge', 'Application', 'msedge.exe')
    const places: ReadonlyArray<readonly [string | undefined, string]> = [
      [PROGRAMFILES, chrome],
      [PROGRAMFILES_X86, chrome],
      [LOCALAPPDATA, chrome],
      [LOCALAPPDATA, join('Chromium', 'Application', 'chrome.exe')],
      [PROGRAMFILES_X86, edge],
      [PROGRAMFILES, edge],
    ]
    return places.flatMap(([folder, file]) => (folder ? [join(folder, file)] : []))
  }
  const folders = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((name) => folders.map((folder) => join(folder, name)))
}

export interface AppWindow {
  readonly exited: Promise<void>
  // Settles once Chrome and every process it started that can write to its profile are gone, and its profile with them.
  readonly closed: Promise<void>
  close(): void
}

// macOS and Linux keep the processes a process starts in its process group unless they leave it; Windows has no process groups.
const GROUPS = process.platform !== 'win32'

// On macOS and Linux, a Chrome still running grace milliseconds after it's closed is killed.
export function openWindow(url: string, { grace = 2000 }: { grace?: number } = {}): AppWindow | undefined {
  const chrome = findChrome()
  if (!chrome) {
    openBrowser(url)
    return undefined
  }
  const profile = mkdtempSync(join(tmpdir(), 'threejam-profile-'))
  const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=800,628', NO_DEVTOOLS_PORT]
  const env = chromeEnv()
  const before = socketFolders(env.TMPDIR)
  // On macOS and Linux, Chrome leads a process group of its own, tied to this process so that the group ends however run does, even by SIGKILL. The group holds every process Chrome starts that can write to its profile, and Chrome's output goes nowhere: its crash handlers share that output from outside the group, keeping their reports elsewhere, and on macOS something has held it open for seconds after Chrome exited. On Windows, where libuv's job object already ends Chrome with run, close comes once nothing holds Chrome's stderr.
  const child = GROUPS ? spawnTied(chrome, args, { env, stdio: 'ignore' }) : spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], env })
  child.stderr?.resume()
  let closing = false
  child.once('exit', (code, signal) => {
    const hint = closing || (code === 0 && signal === null) ? undefined : tmpdirHint(env.TMPDIR)
    if (hint === undefined) return
    removeSocketFolders(env.TMPDIR, before)
    process.stderr.write(`Chrome at ${chrome} exited as soon as it started, ${hint}.\n`)
  })
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.once('error', (error) => {
    process.stderr.write(`Couldn't start ${chrome} (${error.message}), so the default browser opens the game.\n`)
    openBrowser(url)
  })
  const closed = new Promise<void>((done) =>
    child.once('close', async () => {
      await endGroup(child)
      removeProfile(profile)
      done()
    }),
  )
  return {
    exited,
    closed,
    close: () => {
      if (closing) return
      closing = true
      child.kill()
      if (!GROUPS || child.exitCode !== null || child.signalCode !== null) return
      const late = setTimeout(() => void endGroup(child), grace).unref()
      child.once('exit', () => clearTimeout(late))
    },
  }
}

// Kills what is left of the process group that Chrome leads, then waits for all of it to be gone, for at most 2 s, since a process that a busy disk holds up, or that no one reaps, can outlast the kill.
async function endGroup(chrome: ChildProcess): Promise<void> {
  const group = chrome.pid
  if (!GROUPS || group === undefined) return
  try {
    process.kill(-group, 'SIGKILL')
  } catch {
    return
  }
  for (const deadline = Date.now() + 2000; Date.now() < deadline; await new Promise((wait) => setTimeout(wait, 10))) {
    try {
      process.kill(-group, 0)
    } catch {
      return
    }
  }
}

// Chrome on macOS and Linux keeps its socket in a folder of its own in the temporary folder, linked from its profile, and removes it when it closes but not when it's killed or sent a signal; a TMPDIR of ours would lengthen the socket's path, and past 107 bytes Chrome on Linux won't start.
export function removeProfile(profile: string): void {
  try {
    const folder = dirname(resolve(profile, readlinkSync(join(profile, 'SingletonSocket'))))
    for (const name of ['SingletonSocket', 'SingletonCookie']) rmSync(join(folder, name), { force: true })
    rmdirSync(folder)
  } catch {
    // Without the link, Chrome removed its socket or made none, as on Windows; a folder that holds anything else stays.
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    // A file that Chrome's helpers still hold, as Windows can keep one a moment, is left for the OS.
  }
}

function openBrowser(url: string): void {
  // start is a cmd command whose first quoted argument is a title, and detached would give cmd a console window.
  const opener =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
  opener.once('error', (error) => process.stderr.write(`Couldn't open a browser (${error.message}); open ${url} in one.\n`))
  opener.unref()
}

// With record, the page sends what a person plays as they go, and run saves it there as a driver file once the window and the server are gone.
export async function* play({ dir, seed = randomInt(2 ** 31), window, record }: { dir: string; seed?: number; window: boolean; record?: string }): AsyncGenerator<string> {
  let quit = () => {}
  const done = new Promise<void>((resolve) => (quit = resolve))
  let server: Server | undefined
  // The page sends it with /events, /quit, and /record, so no other page can follow its reloads, end the session, or add to the playtest.
  const token = randomBytes(32).toString('base64url')
  const recording = record === undefined ? undefined : new Recording()
  const page = await buildPage({
    dir,
    config: { mode: 'run', seed, token, record: recording !== undefined },
    // Every save reloads the page, which says why when the save doesn't build.
    onRebuild: (errors) => {
      if (errors.length > 0) process.stderr.write(`${errors.join('\n')}\n`)
      server?.reload()
    },
  })
  server = await serve({ page, token, onQuit: () => quit(), recording })
  const app = window ? openWindow(server.url) : undefined
  void app?.exited.then(() => quit())
  process.once('SIGINT', () => quit())
  process.once('SIGTERM', () => quit())
  // A terminal that closes hangs up on run twice, from its shell and from the kernel, and the second must not end run before it has closed its window.
  process.on('SIGHUP', () => quit())
  const keys =
    record === undefined
      ? 'Esc quits, and saving a file replays the game with the same seed'
      : 'Esc quits and saves the playtest, and saving a file replays the game with the same seed and starts the playtest over'
  yield `Playing ${dir} with seed ${seed}${record === undefined ? '' : `, recording to ${record},`} at ${server.url}${window ? `. ${keys}.` : ''}`
  await done
  app?.close()
  server.close()
  await page.dispose()
  // Writing to a terminal that's gone fails and ends run, so the window and its profile go first.
  await app?.closed
  if (record !== undefined) yield savePlaytest({ file: record, dir, session: recording?.latest(page.build) })
  yield 'Stopped.'
}
