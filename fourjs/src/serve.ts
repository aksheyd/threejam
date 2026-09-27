import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import { UsageError } from './errors.ts'
import { ROOT, gameFile } from './load.ts'
import type { Config } from './browser/client.ts'

export interface Page {
  outdir: string
  dispose(): Promise<void>
}

export async function buildPage(dir: string, config: Config, onRebuild?: (errors: string[]) => void): Promise<Page> {
  const file = gameFile(dir)
  const folder = dirname(file)
  const view = ['view.ts', 'view.js'].map((name) => join(folder, name)).find((path) => existsSync(path))
  const outdir = mkdtempSync(join(tmpdir(), 'fourjs-'))
  writeFileSync(join(outdir, 'index.html'), html(basename(folder), config))
  const entry = [
    `import game from ${JSON.stringify(file)}`,
    view ? `import * as view from ${JSON.stringify(view)}` : 'const view = {}',
    `import { play } from ${JSON.stringify(join(ROOT, 'src', 'browser', 'client.ts'))}`,
    'play(game, view, window.FOUR)',
  ].join('\n')
  let first = true
  const context = await esbuild.context({
    stdin: { contents: entry, resolveDir: folder, sourcefile: 'four-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(outdir, 'bundle.js'),
    sourcemap: config.mode === 'run' ? 'inline' : false,
    alias: { fourjs: join(ROOT, 'src', 'index.ts') },
    logLevel: 'silent',
    plugins: [
      {
        name: 'four-rebuild',
        setup(build) {
          build.onEnd((result) => {
            if (first) return
            onRebuild?.(result.errors.map(formatMessage))
          })
        },
      },
    ],
  })
  const result = await context.rebuild().catch((failure: esbuild.BuildFailure) => failure)
  if (result.errors.length > 0) {
    await context.dispose()
    rmSync(outdir, { recursive: true, force: true })
    throw new UsageError(result.errors.map(formatMessage).join('\n'))
  }
  first = false
  if (onRebuild) await context.watch()
  return {
    outdir,
    async dispose() {
      await context.dispose()
      rmSync(outdir, { recursive: true, force: true })
    },
  }
}

function formatMessage(message: esbuild.Message): string {
  const at = message.location ? `${message.location.file}:${message.location.line}: ` : ''
  return `${at}${message.text}`
}

function html(title: string, config: Config): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title.replace(/[<&]/g, '')}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{position:absolute;inset:0;margin:auto;display:block}</style>
</head>
<body>
<canvas></canvas>
<script>window.FOUR = ${JSON.stringify(config)}</script>
<script type="module" src="/bundle.js"></script>
</body>
</html>
`
}

export interface Server {
  url: string
  reload(): void
  close(): void
}

export function serve(outdir: string, onQuit: () => void = () => {}): Promise<Server> {
  const listeners = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (request.method === 'POST' && path === '/quit') {
      response.end()
      onQuit()
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
    response.end(readFileSync(join(outdir, name)))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/`,
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

export function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(mac)) return mac
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim()
    if (found) return found
  }
  return undefined
}

interface Window {
  exited: Promise<void>
  close(): void
}

function openWindow(url: string): Window | undefined {
  const chrome = findChrome()
  if (!chrome) {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    return undefined
  }
  const profile = mkdtempSync(join(tmpdir(), 'fourjs-profile-'))
  const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=800,628']
  const child: ChildProcess = spawn(chrome, args, { stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  exited.then(() => rmSync(profile, { recursive: true, force: true }))
  return { exited, close: () => void child.kill() }
}

export async function* play(dir: string, options: { seed?: number; window: boolean }): AsyncGenerator<string> {
  let quit = () => {}
  const done = new Promise<void>((resolve) => (quit = resolve))
  let server: Server | undefined
  const page = await buildPage(dir, { mode: 'run', seed: options.seed }, (errors) => {
    if (errors.length > 0) process.stderr.write(`${errors.join('\n')}\n`)
    else server?.reload()
  })
  server = await serve(page.outdir, () => quit())
  const window = options.window ? openWindow(server.url) : undefined
  window?.exited.then(() => quit())
  process.once('SIGINT', () => quit())
  process.once('SIGTERM', () => quit())
  yield `Playing ${dir} at ${server.url}${options.window ? '. Esc quits, and saving a file reloads the game.' : ''}`
  await done
  window?.close()
  server.close()
  await page.dispose()
  yield 'Stopped.'
}
