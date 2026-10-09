import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../src/package.ts'

export const CLI = join(ROOT, 'src', 'cli.ts')

// The processes the tests start share one compile cache, so each CLI they start loads its modules faster.
process.env.NODE_COMPILE_CACHE ??= join(ROOT, 'test', '.tmp', 'compile-cache')

// The groups still running: Ctrl-C reaches only the terminal's own group, and a test file it stops never aborts its tests' signals, so an interrupt passes SIGTERM on to each.
const running = new Set<number>()
if (process.platform !== 'win32') {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(name, () => {
      for (const pid of running) reached(-pid, 'SIGTERM')
      process.kill(process.pid, name)
    })
  }
}

// The CLI run to its end, with what it printed. spawnSync holds up the test's own timeout, so a run that never ends, like a run that starts serving, is killed here.
export function threejamWith(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000, killSignal: 'SIGKILL' })
  return { code: result.status, out: result.stdout + result.stderr }
}

export function threejam(...args: string[]) {
  return threejamWith({}, ...args)
}

// The CLI in a child process, stopped with every process it started once signal aborts, as a test's does when the test ends or times out.
export function spawnCli(args: readonly string[], signal: AbortSignal, cwd = ROOT, env = process.env): ChildProcessWithoutNullStreams {
  // On macOS and Linux the child leads a process group of its own, which every process it starts joins, apart from a sandbox or a type check, which end with the CLI by themselves.
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env, detached: process.platform !== 'win32' })
  const { pid } = child
  if (pid !== undefined && process.platform !== 'win32') {
    running.add(pid)
    child.once('exit', () => running.delete(pid))
  }
  signal.addEventListener('abort', () => stopTree(child), { once: true })
  return child
}

// On macOS and Linux, SIGTERM lets run remove its page as it stops, and SIGKILL 2 s later ends any process that didn't.
export function stopTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  const group = -child.pid
  if (!reached(group, 'SIGTERM')) return
  const deadline = Date.now() + 2000
  const waiting = setInterval(() => {
    if (reached(group, 0) && Date.now() < deadline) return
    reached(group, 'SIGKILL')
    clearInterval(waiting)
  }, 50)
}

// Whether the signal reached a process in the group, which none is left in once all have exited.
export function reached(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(group, signal)
    return true
  } catch {
    return false
  }
}

export interface Reply {
  readonly id?: number
  readonly result?: {
    readonly serverInfo?: { readonly version: string }
    readonly instructions?: string
    readonly tools?: ReadonlyArray<{ readonly name: string; readonly inputSchema?: { readonly properties?: Record<string, { readonly description?: string }> } }>
    readonly content?: ReadonlyArray<{ readonly text: string }>
    readonly isError?: boolean
  }
}

// The CLI as an MCP server, started like spawnCli, which a test sends requests to and reads the replies of by their ids.
export function mcp(signal: AbortSignal, cwd = ROOT, env?: NodeJS.ProcessEnv) {
  const server = spawnCli(['--mcp'], signal, cwd, env)
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((done) => server.once('exit', (code, by) => done([code, by])))
  const waiting = new Map<number, (reply: Reply) => void>()
  let buffered = ''
  let next = 1
  server.stdout.setEncoding('utf8')
  server.stdout.on('data', (chunk: string) => {
    const lines = (buffered + chunk).split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines.filter((l) => l.trim())) {
      const reply: Reply = JSON.parse(line)
      if (reply.id !== undefined) waiting.get(reply.id)?.(reply)
    }
  })
  const send = (message: object) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (method: string, params: object) =>
    new Promise<Reply>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      send({ id, method, params })
    })
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }).then((reply) => {
    send({ method: 'notifications/initialized' })
    return reply
  })
  return { ready, request, notify: (method: string, params: object) => send({ method, params }), close: () => stopTree(server), kill: (signal: NodeJS.Signals) => server.kill(signal), end: () => server.stdin.end(), exited, pid: server.pid }
}
