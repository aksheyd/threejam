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

export function stopTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Every process in the group has exited already.
  }
}
