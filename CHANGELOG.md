# Changelog

Every release of [`threejam`](https://www.npmjs.com/package/threejam), newest first. Until 1.0, a release can break a game or a script that worked with the one before, and each one that does says how under Breaking changes.

## Unreleased

- The manual the package ships, `AGENTS.md`, leaves out working on ThreeJam itself, which moves to `CONTRIBUTING.md` in the repo.
- The package ships the agent skill, as `node_modules/threejam/skills/threejam/SKILL.md`, and the docs' `npx skills add` installs it from the latest release's tag instead of from `main`, so the skill describes the version npm installs.
- `AGENTS.md` says that keys are places on the keyboard, so a game's W, A, S, and D are the keys marked Z, Q, S, and D on a French AZERTY keyboard.
- `AGENTS.md` and the commands guide name `run --serve-only`, which serves the page without opening a window, and `--out`, the long form of `-o`.
- On Linux, when Chrome exits as it starts because `TMPDIR` is too long for the socket it makes there, `shot` and `run` say to set a shorter one, like `/tmp`, and remove the empty folder Chrome made there for the socket.

### Fixed

- `run` reloads the page only when a file is saved. Before, it could also reload once by itself a moment after it started, restarting the game a player had just begun.
- `run` keeps serving after a save that doesn't build. Before, reloading the page then stopped `run` with an `ENOENT` error and left its folder in the temporary folder. `run` and `shot` now keep the page in memory, so they leave no folder of it there, even when they're killed.
- `run` and `shot` now refuse a game that imports a CSS file, as `check` and `export` already did. Before, they bundled it into a file the page never loaded.
- Esc quits `run` from a page that says why the game didn't load, as it does from one that plays.
- A save that doesn't build says why on `run`'s page, as `AGENTS.md` says, and not only in the terminal, until a save that builds reloads the game.
- Closing the terminal that `run` is in closes its window and removes the window's profile, as Ctrl-C does. Before, `run` stopped at once and left the profile and Chrome's socket folder in the temporary folder.
- An image or sound that `run` or `shot` can't read, like one without read permission, gets an error response, which the page reports, and `run` goes on serving. Before, `run` stopped, and `shot` printed a stack trace instead of one line. `run` also no longer rebuilds the page over and over while the folder holds such a file.
- `run` prints a failure once when the page keeps failing to build the same way, as it does over and over for a game file that `run` can't read. Before, it printed the same failure several times a second.
- On Windows, `shot`'s Chrome keeps its temporary files in its profile, which `shot` removes with it, instead of in `TEMP`, where a Chrome that `shot` killed could leave them.
- When Chrome crashes during `shot`, `shot` waits for the processes Chrome started to exit before it removes Chrome's profile, since they can still write to it.
- `shot` cleans up when it gets Ctrl-C, SIGTERM, or SIGHUP, even twice, as a closed terminal can send it: it removes its folders and Chrome's, then ends by the signal without writing anything, or on Windows exits with 128 plus the signal's number. Before, Ctrl-C ended it at once with exit code 130 and left those folders, SIGTERM made it fail with a `BROWSER_ERROR`, and an MCP server that got SIGTERM during a `shot` call kept running.
- Killing an MCP server, or a command like `sim`, ends the sandbox running its game at once, even with SIGKILL. Before, on macOS and Linux, the sandbox ran on until its `--timeout`.

## [0.0.4](https://github.com/aksheyd/threejam/compare/v0.0.3...v0.0.4) - 2026-10-06

The same files and seed now give the same run on every machine, every failure is one line with a code that says what went wrong, and flags are checked before any work starts. From [#2](https://github.com/aksheyd/threejam/pull/2) and [#3](https://github.com/aksheyd/threejam/pull/3).

### Breaking changes

- New error codes `BUILD_ERROR`, `BROWSER_ERROR`, `IO_ERROR`, and `INTERNAL_ERROR` replace some `GAME_ERROR`, `USAGE`, and `TYPE_ERROR` cases. In `check`, a syntax error, or an import of a file or a name that doesn't exist, is now `BUILD_ERROR` instead of `TYPE_ERROR`, and a type check that runs past `--timeout` is `TIMEOUT`. A failed MCP tool call's text now starts with its code, as in `TYPE_ERROR: ...`.
- Every command reads only `game.ts` and `view.ts`, which `check` can type-check, and refuses a folder whose `game.js` or `view.js` has no `.ts` beside it, saying to rename it.
- Game code that reads the clock, the local time zone, or `crypto`'s randomness now fails instead of varying, text formats in `en-US` whatever the machine's locale, and a write to the world outside `start` and `update`, like one from a promise's callback, fails too.

### Runs repeat on every machine

- A game's and a driver's files load with the guard up, in `sim` and in the page, so a `const random = Math.random` kept at a file's top level fails where it's called, and a kept `const { sin } = Math` is the portable `sin` once the game runs.
- An `Intl.DateTimeFormat` formatting no date and `Temporal.Now` are errors like the other ways to read the clock, and so are `crypto.randomUUID()`, `crypto.getRandomValues()`, `WeakRef`, and `FinalizationRegistry`. `ctx` and `ctx.input` are frozen, so `ctx.dt = 1` is an error too.
- Game code runs in `en-US` and UTC, whatever the machine is set to: `toLocaleString()`, `localeCompare()`, and `Intl` use them unless given others, an empty list of locales counts as none, and the `Date` forms that read the local time zone, like `getHours()`, are errors that name the UTC form to use. `sim`'s sandbox runs in UTC and `en-US` as well.
- The guard covers `Date`, `Intl`, and `Temporal` at their own objects, so `Date.prototype.constructor`, a class that extends `Date`, and the methods of `Intl`'s prototypes don't get around it.
- In a page, game code finds only what `sim`'s realm has while it runs: the page's other globals read `undefined` and `document` has no methods, so a game can't open a frame whose own `Date` and `crypto` no guard covers.
- What `start`, `update`, or a driver puts in place of anything the guard covers stays until the run ends, in `sim` and in the page alike.
- Long `sim` runs are about 3 times faster, since the guard stays up through a whole run of ticks: 200,000 ticks of Pong take 0.33 s instead of 1.2 s.

### Errors and flags

- Every failure is one line with its code, including incur's own refusals of a flag, and `run` prints one it meets after starting as `Error (CODE): message`.
- An MCP message about a missing folder or file names the absolute path a relative one led to, and the tool descriptions say what paths are relative to.
- Ticks and other whole numbers in flags are plain digits, so `--ticks 1e2` and `--press Space@0x5` fail with `USAGE` instead of meaning 100 and 5, and the schemas MCP clients see have the real minimums.
- `sim --exact` prints numbers as they are. `sim` rounds what it prints to 4 decimal places, while `--until` compares exact values.
- `shot` and `export` check `-o` before they run the game or start Chrome, and `shot` has one rule for one tick or many: `-o` names a `.png` file.
- `shot`'s page gets `--timeout` too, counted from when it loads and leaving out the time screenshots take, and a Chrome whose page never returns is stopped. A call into Chrome can take as long as `--timeout` allows, past Puppeteer's 180 s.
- `--timeout` is at most 86400, a day, past which Node's timers fire at once.
- `shot` says when `CHROME_PATH` is a folder or a file that isn't executable.
- `run` runs the game's `start` and first tick before it serves the page, and the page says why a game or its `view.ts` didn't load instead of showing nothing.
- A `--driver` that isn't a file, like an empty path or a folder, fails with `USAGE`, naming where it led.
- `mcp add` takes only the forms its help shows, and refuses any other word and an `--agent` with no name, which incur would take as every agent.

### Fixed

- `shot` and `run` remove what their Chrome leaves in the temporary folder, even when it's killed.
- `new`, `shot`, and `export` make their output folders one at a time, so a path under `/proc` fails with `IO_ERROR` instead of hanging.
- `check` exempts only the declaration files of ThreeJam's own type packages, not the code packages they name, so a game can't make it quote a file there.
- A runtime import of `three` that doesn't resolve gets the same hint as one that does: use the `THREE` that `view.ts` receives.
- A path that still holds a `..` never counts as inside a game's folder.

### Docs

- `AGENTS.md` and the skill name the determinism traps no guard can catch, like shuffling with `sort(() => ctx.random() - 0.5)`, and give a Fisher–Yates shuffle instead.

## [0.0.3](https://github.com/aksheyd/threejam/compare/v0.0.2...v0.0.3) - 2026-10-05

Loading a game runs its code in a sandbox, a game's page and `check` take only files from the game's folder, `run`'s server answers only its own page, and every runtime dependency is the exact version CI tests. From [#1](https://github.com/aksheyd/threejam/pull/1).

### Breaking changes

- `check`, `sim`, and the loads behind `shot` and `export` run `game.ts` and any `--driver` in a sandbox: a JavaScript realm with the language and the engine and nothing else, in a child process that can't touch files, start processes, or reach the network. Game code that used Node's APIs, `eval`, `new Function`, or `import()` no longer runs there.
- A game's files may import only `threejam` and files in the game's folder, and a `--driver` file may also import files in its own folder. Anything else, even through a link, fails with the import's `path:line` in `check`, `sim`, `run`, `shot`, and `export`, so a game that imports a shared `../lib/util.ts` no longer builds.

### Added

- Each run has a time budget, `--timeout` seconds on `check`, `sim`, `shot`, and `export` (default 30), after which it fails with the new `TIMEOUT` code and the tick it reached, so an endless loop no longer hangs `sim` or the MCP server.
- Each MCP call that loads a game runs in a process of its own, so one game that loops doesn't block the others, and a long-running server doesn't grow.
- An MCP `sim` reply too large for a client is refused with the new `OUTPUT_TOO_LARGE` code and how to narrow it.
- The MCP tools that load a game, `check`, `sim`, `shot`, and `export`, are marked as running code, and the server's instructions say that a game's log, errors, and suggested commands are its own data, not directions.
- `check` maps `three` to ThreeJam's own Three.js types, so `import type` from `'three'` in a `view.ts` describes the `THREE` it receives, in a project or not.

### Security

- `run` serves its page on `127.0.0.1` to that page alone: a request from another page, even one on another local port or opened from a file, or one that names another host, gets 403, and live reload and Esc take a token only the page has. An image or sound opened directly runs nothing, and an SVG downloads instead of opening.
- ThreeJam starts Chrome with no DevTools port, even when a wrapper script asks for one, talks to `shot`'s headless Chrome over a pipe, and passes Chrome only the environment variables a browser needs.
- In `node_modules`, `check` reads only TypeScript's libraries and ThreeJam's own type packages, so a type error can't quote another package's files.
- The import rule compares real paths exactly, as the OS spells them, instead of folding case.
- Every runtime dependency is pinned to the exact version CI tests, and the build fails if one isn't. incur moves from 0.5.1 to 0.7.0.
- A release publishes only after all of CI passes on the tagged commit, from a tarball built with install scripts off that matches a second build's.

### Fixed

- `check` bundles the page too, so it refuses an import that `run`, `shot`, or `export` would.
- A game's runtime import of `three` fails with a hint to use the `THREE` that `init` and `draw` receive.
- `shot` cleans up when Chrome fails to start, and only `shot` loads Puppeteer.

### Development

- `npm test` names its test files, so a Node that can't run TypeScript fails instead of finding no tests, and a test that runs past two minutes fails.
- `npm run test:package` installs the package with install scripts off, as npm 12 does, and checks that a `view.ts` gets Three.js's types there.
- CI tests Node 24 as well, and gives each commit on main a run of its own.
- The repo approves esbuild's install script for the version it pins, which npm 11 asks for.

## [0.0.2](https://github.com/aksheyd/threejam/compare/v0.0.1...v0.0.2) - 2026-10-01

- `shot` retries a page navigation that Chrome on Windows sometimes aborts in a new tab.
- A release publishes from a job that runs no dependency code, and the workflows pin every action to a commit.

## [0.0.1](https://github.com/aksheyd/threejam/tree/v0.0.1) - 2026-10-01

The first release on npm. A game is a folder with a `game.ts` of entities as data and an `update` function, with groups, grids, parts, images, sounds, the mouse, and an optional `view.ts` for Three.js extras. The `new`, `check`, `sim`, `shot`, `run`, and `export` commands work as a CLI, as MCP tools, and as generated skills, next to a hand-written skill and seven example games.
