import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../src/package.ts'

export const CLI = join(ROOT, 'src', 'cli.ts')

// The CLI in a child process, stopped with every process it started once signal aborts, as a test's does when the test ends or times out; the sandbox running a game would otherwise outlive the CLI until its own time limit.
export function spawnCli(args: readonly string[], signal: AbortSignal, cwd = ROOT): ChildProcessWithoutNullStreams {
  // On macOS and Linux the child leads a process group of its own, which every process it starts joins.
  const child = spawn(process.execPath, [CLI, ...args], { cwd, detached: process.platform !== 'win32' })
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
function reached(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(group, signal)
    return true
  } catch {
    return false
  }
}
