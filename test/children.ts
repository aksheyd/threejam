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

// The CLI in a child process, stopped with every process it started once signal aborts, as a test's does when the test ends or times out; the sandbox running a game would otherwise outlive the CLI until its own time limit.
export function spawnCli(args: readonly string[], signal: AbortSignal, cwd = ROOT, env = process.env): ChildProcessWithoutNullStreams {
  // On macOS and Linux the child leads a process group of its own, which every process it starts joins.
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
