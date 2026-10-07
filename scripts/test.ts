// npm test: every test file under Node's test runner, as node --test runs them, with the files that take longest started first. node --test starts them in sorted order, so a long file that sorts late runs on alone while the runner's other lanes sit idle.
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

// The files that take longest on CI, longest first; the rest follow in sorted order.
const LONGEST = ['browser', 'cli', 'sandbox', 'shot', 'serve', 'exit', 'seeds'].map((name) => join('test', `${name}.test.ts`))
const found = globSync('**/*.test.ts', { exclude: (name) => name === 'node_modules' }).sort()
const files = [...LONGEST.filter((file) => found.includes(file)), ...found.filter((file) => !LONGEST.includes(file))]

run({ files, concurrency: true, timeout: 120_000 })
  .on('test:fail', (event) => {
    if (event.todo === undefined) process.exitCode = 1
  })
  .compose(spec)
  .pipe(process.stdout)
