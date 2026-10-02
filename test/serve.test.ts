import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../src/package.ts'

const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

test('when Chrome fails to start, shot closes its server and esbuild and removes its temporary folder', () => {
  const temp = mkdtempSync(join(TMP, 'temp-'))
  made.push(temp)
  const shot = pathToFileURL(join(ROOT, 'src', 'shot.ts')).href
  const script = `import { shoot } from ${JSON.stringify(shot)}\nawait shoot({ dir: 'games/pong', at: [1], out: 'frame.png' }).catch((error) => console.log(error.message))`
  const env = { ...process.env, CHROME_PATH: join(temp, 'no-chrome'), TMPDIR: temp, TEMP: temp, TMP: temp }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 })
  assert.deepEqual({ status: result.status, named: result.stdout.includes('no-chrome'), left: readdirSync(temp) }, { status: 0, named: true, left: [] }, result.stderr)
})

test('commands other than shot start without loading Puppeteer', () => {
  const hook = "import { registerHooks } from 'node:module'\nregisterHooks({ resolve: (specifier, context, next) => { if (specifier.startsWith('puppeteer')) throw new Error(`loaded ${specifier}`); return next(specifier, context) } })"
  const cli = join(ROOT, 'src', 'cli.ts')
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, cli, 'sim', 'games/pong', '--ticks', '1'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
