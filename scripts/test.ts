// npm test: every test file under Node's test runner, as node --test runs them, with the files that take longest started first. node --test starts them in sorted order, so a long file that sorts late runs on alone while the runner's other lanes sit idle.
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

// The files that take longest on CI, longest first; the rest follow in sorted order.
const LONGEST = ['browser', 'cli', 'sandbox', 'shot', 'serve', 'exit', 'check', 'seeds', 'mcp'].map((name) => join('test', `${name}.test.ts`))
const found = globSync('**/*.test.ts', { exclude: (name) => name === 'node_modules' }).sort()
const files = [...LONGEST.filter((file) => found.includes(file)), ...found.filter((file) => !LONGEST.includes(file))]

// Each test gets 2 minutes, but Node 22 gives run's limit to each file instead, so there a file gets 4, twice what the longest, browser.test.ts, takes on CI's Node 22.
const timeout = Number(process.versions.node.split('.')[0]) < 24 ? 240_000 : 120_000

run({ files, concurrency: true, timeout })
  .on('test:fail', (event) => {
    if (event.todo === undefined) process.exitCode = 1
  })
  .compose(spec)
  .pipe(process.stdout)
