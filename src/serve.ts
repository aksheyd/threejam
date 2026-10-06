import { spawn } from 'node:child_process'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, rmdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { constants as vmConstants, createContext } from 'node:vm'
import * as esbuild from 'esbuild'
import { mediaType } from './assets.ts'
import { confinePlugin, confineRoots } from './confine.ts'
import { BuildError } from './errors.ts'
import { STAND_INS } from './guard.ts'
import { assetsIn, gameFiles, type GameFiles } from './load.ts'
import { NAME, engineFile } from './package.ts'
import type { Config } from './browser/client.ts'

export interface Page {
  // The game's folder, which the page's images and sounds come from.
  readonly folder: string
  // The page, and the script of the last build that didn't fail.
  readonly index: string
  readonly bundle: Uint8Array
  dispose(): Promise<void>
}

export interface PageOptions {
  readonly dir: string
  readonly config: Config
  readonly driver?: string
  readonly onRebuild?: (errors: string[]) => void
}

export async function buildPage({ dir, config, driver, onRebuild }: PageOptions): Promise<Page> {
  const files = gameFiles(dir)
  const page = pageBuild({ files, driver, address: (name) => `assets/${encodeURIComponent(name)}` })
  let bundle: Uint8Array = new Uint8Array()
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
            if (result.errors.length === 0 && result.outputFiles) bundle = result.outputFiles[0].contents
            if (firstEnded === undefined) onRebuild?.(result.errors.map(formatMessage))
            else firstEnded(result.errors)
            firstEnded = undefined
          }),
      },
    ],
  })
  // A page that follows saves takes its first build from watch mode, since a build before it would leave watch mode a first build of its own, whose end would read as a save.
  const errors = onRebuild ? await context.watch().then(() => first) : (await context.rebuild().catch((failure: esbuild.BuildFailure) => failure)).errors
  if (errors.length > 0) {
    await context.dispose()
    throw new BuildError(errors.map(formatMessage).join('; '))
  }
  return {
    folder: files.folder,
    index: html({ title: basename(files.folder), config, script: { kind: 'file', src: '/bundle.js' } }),
    get bundle() {
      return bundle
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
          watchFiles: names.map((name) => join(files.folder, name)),
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

export function html({ title, config, script }: { title: string; config: Config; script: Script }): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title.replace(/[<&]/g, '')}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{position:absolute;inset:0;margin:auto;display:block}</style>
</head>
<body>
<canvas></canvas>
<script>window.THREEJAM = ${JSON.stringify(config)}</script>
${scriptTag(script)}
</body>
</html>
`
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

// The server answers only the page itself, and /events and /quit only with the token that run gives its page; without one, as for shot, it refuses them.
export function serve({ page, token, onQuit = () => {} }: { page: Page; token?: string; onQuit?: () => void }): Promise<Server> {
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
    if (!fromPage(request, hosts) || ((path === '/quit' || path === '/events') && !granted(query.get('token')))) {
      response.writeHead(403, HEADERS).end()
      return
    }
    if (request.method === 'POST' && path === '/quit') {
      response.end()
      onQuit()
      return
    }
    if (path.startsWith('/assets/')) {
      const name = decodedName(path.slice('/assets/'.length))
      const type = name === undefined ? undefined : mediaType(name)
      if (name === undefined || type === undefined || !assetsIn(page.folder).includes(name)) {
        response.writeHead(404).end()
        return
      }
      // An SVG can hold script, so opening one downloads it instead.
      const download = type === 'image/svg+xml' ? { 'content-disposition': 'attachment' } : {}
      response.writeHead(200, { ...HEADERS, 'content-type': type, 'content-security-policy': ASSET_POLICY, ...download })
      response.end(readFileSync(join(page.folder, name)))
      return
    }
    if (path === '/events') {
      response.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream' })
      response.write(':\n\n')
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
const LONGEST_TMPDIR = 107 - '/org.chromium.Chromium.XXXXXX/SingletonSocket'.length

// Why a Chrome that exited as it started did, and what to do, when its TMPDIR leaves its socket no room.
export function tmpdirHint(tmpdir: string | undefined): string | undefined {
  if (process.platform !== 'linux' || tmpdir === undefined) return undefined
  const bytes = Buffer.byteLength(tmpdir.replace(/\/+$/, ''))
  if (bytes <= LONGEST_TMPDIR) return undefined
  return `as Chrome on Linux does in a TMPDIR over ${LONGEST_TMPDIR} bytes, where its socket goes, and ${tmpdir} is ${bytes}; set TMPDIR to a shorter folder, like /tmp`
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
  close(): void
}

export function openWindow(url: string): AppWindow | undefined {
  const chrome = findChrome()
  if (!chrome) {
    openBrowser(url)
    return undefined
  }
  const profile = mkdtempSync(join(tmpdir(), 'threejam-profile-'))
  const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=800,628', NO_DEVTOOLS_PORT]
  const env = chromeEnv()
  // Every process Chrome starts shares its stderr, so close comes once none is left to write to the profile.
  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], env })
  child.stderr?.resume()
  let closing = false
  child.once('exit', (code, signal) => {
    const hint = closing || (code === 0 && signal === null) ? undefined : tmpdirHint(env.TMPDIR)
    if (hint !== undefined) process.stderr.write(`Chrome at ${chrome} exited as soon as it started, ${hint}.\n`)
  })
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.once('error', (error) => {
    process.stderr.write(`Couldn't start ${chrome} (${error.message}), so the default browser opens the game.\n`)
    openBrowser(url)
  })
  child.once('close', () => removeProfile(profile))
  return {
    exited,
    close: () => {
      closing = true
      child.kill()
    },
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

export async function* play({ dir, seed = randomInt(2 ** 31), window }: { dir: string; seed?: number; window: boolean }): AsyncGenerator<string> {
  let quit = () => {}
  const done = new Promise<void>((resolve) => (quit = resolve))
  let server: Server | undefined
  // The page sends it with /events and /quit, so no other page can follow its reloads or end the session.
  const token = randomBytes(32).toString('base64url')
  const page = await buildPage({
    dir,
    config: { mode: 'run', seed, token },
    onRebuild: (errors) => (errors.length > 0 ? void process.stderr.write(`${errors.join('\n')}\n`) : server?.reload()),
  })
  server = await serve({ page, token, onQuit: () => quit() })
  const app = window ? openWindow(server.url) : undefined
  void app?.exited.then(() => quit())
  process.once('SIGINT', () => quit())
  process.once('SIGTERM', () => quit())
  yield `Playing ${dir} with seed ${seed} at ${server.url}${window ? '. Esc quits, and saving a file replays the game with the same seed.' : ''}`
  await done
  app?.close()
  server.close()
  await page.dispose()
  yield 'Stopped.'
}
