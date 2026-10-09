import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after } from 'node:test'
import { ROOT } from '../src/package.ts'

export const TMP = join(ROOT, 'test', '.tmp')
mkdirSync(TMP, { recursive: true })
export const made: string[] = []
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

// Inside the repo, so messages name the files by short relative paths.
export function folder(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(TMP, 'game-'))
  made.push(dir)
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return relative(ROOT, dir)
}

export function game({ fields = 'x: 0, y: 0, w: 0.1, h: 0.1, vx: 1', update }: { fields?: string; update: string }): string {
  return [
    "import { defineGame } from 'threejam'",
    '',
    'export default defineGame({',
    `  entities: { ball: { ${fields} } },`,
    '  update(world, ctx) {',
    `    ${update}`,
    '  },',
    '})',
    '',
  ].join('\n')
}

// A game whose type check takes TypeScript over a minute, in memory that stays flat: each call takes only the last of thousands of overloads, so TypeScript checks its arguments, variables rather than numbers, against every one.
export function slowCheck(): string {
  const last = 2999
  const overloads = Array.from({ length: last + 1 }, (_, i) => `declare function pick(a: 0, b: 0, c: 0, d: 0, n: ${i}): ${i}`)
  const calls = Array.from({ length: 8000 }, () => 'pick(z, z, z, z, l)').join(', ')
  return folder({ 'game.ts': [game({ update: 'world.ball.x += 1' }), `const z = 0, l = ${last}`, ...overloads, `export const picked = [${calls}]`, ''].join('\n') })
}
