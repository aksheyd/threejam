import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { mediaType } from './assets.ts'
import { UsageError } from './errors.ts'
import { assetsIn, gameFiles, type GameFiles } from './load.ts'
import { NAME, engineFile } from './package.ts'
import type { Config } from './browser/client.ts'

export interface Page {
  readonly outdir: string
  // The game's folder, which the page's images and sounds come from.
  readonly folder: string
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
  const outdir = mkdtempSync(join(tmpdir(), 'threejam-'))
  writeFileSync(join(outdir, 'index.html'), html({ title: basename(files.folder), config, script: { kind: 'file', src: '/bundle.js' } }))
  let watching = false
  const page = pageBuild({ files, driver, address: (name) => `assets/${encodeURIComponent(name)}` })
  const context = await esbuild.context({
    ...page,
    outfile: join(outdir, 'bundle.js'),
    sourcemap: config.mode === 'run' ? 'inline' : false,
    plugins: [
      ...page.plugins,
      {
        name: 'threejam-rebuild',
        setup: (build) =>
          void build.onEnd((result) => {
            if (watching) onRebuild?.(result.errors.map(formatMessage))
          }),
      },
    ],
  })
  const result = await context.rebuild().catch((failure: esbuild.BuildFailure) => failure)
  if (result.errors.length > 0) {
    await context.dispose()
    rmSync(outdir, { recursive: true, force: true })
    throw new UsageError(result.errors.map(formatMessage).join('; '))
  }
  if (onRebuild) {
    watching = true
    await context.watch()
  }
  return {
    outdir,
    folder: files.folder,
    async dispose() {
      await context.dispose()
      rmSync(outdir, { recursive: true, force: true })
    },
  }
}

// What every page bundles: the game, its view, a driver if there is one, and the page code, which loads each image and sound from address(name).
export function pageBuild({ files, driver, address }: { files: GameFiles; driver?: string; address: (name: string) => string }) {
  const entry = [
    `import game from ${JSON.stringify(files.game)}`,
    files.view ? `import * as view from ${JSON.stringify(files.view)}` : 'const view = {}',
    driver ? `import driver from ${JSON.stringify(resolve(driver))}` : 'const driver = undefined',
    "import assets from 'threejam:assets'",
    `import { play } from ${JSON.stringify(engineFile(join('browser', 'client')))}`,
    'play({ game, view, driver, assets, config: window.THREEJAM })',
  ].join('\n')
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
    stdin: { contents: entry, resolveDir: files.folder, sourcefile: 'threejam-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: { [NAME]: engineFile('index') },
    logLevel: 'silent',
    plugins: [assets],
  } satisfies esbuild.BuildOptions
}

export function formatMessage(message: esbuild.Message): string {
  const at = message.location ? `${message.location.file}:${message.location.line}: ` : ''
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

export function serve({ page, onQuit = () => {} }: { page: Page; onQuit?: () => void }): Promise<Server> {
  const listeners = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
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
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      response.end(readFileSync(join(page.folder, name)))
      return
    }
    if (path === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
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
    const type = name.endsWith('.js') ? 'text/javascript' : 'text/html'
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
    response.end(readFileSync(join(page.outdir, name)))
  })
  return new Promise((ready, fail) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        fail(new Error(`the page server has no port: ${String(address)}`))
        return
      }
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

function decodedName(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

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

interface AppWindow {
  readonly exited: Promise<void>
  close(): void
}

function openWindow(url: string): AppWindow | undefined {
  const chrome = findChrome()
  if (!chrome) {
    openBrowser(url)
    return undefined
  }
  const profile = mkdtempSync(join(tmpdir(), 'threejam-profile-'))
  const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=800,628']
  const child = spawn(chrome, args, { stdio: 'ignore' })
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.once('error', (error) => {
    process.stderr.write(`Couldn't start ${chrome} (${error.message}), so the default browser opens the game.\n`)
    openBrowser(url)
  })
  // Chrome's helper processes can hold files in the profile for a moment after it exits, as on Windows.
  child.once('close', () => void rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}))
  return { exited, close: () => void child.kill() }
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
  const page = await buildPage({
    dir,
    config: { mode: 'run', seed },
    onRebuild: (errors) => (errors.length > 0 ? void process.stderr.write(`${errors.join('\n')}\n`) : server?.reload()),
  })
  server = await serve({ page, onQuit: () => quit() })
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
