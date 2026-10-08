# Changelog

Every release of [`threejam`](https://www.npmjs.com/package/threejam), newest first. Until 1.0, a release can break a game or a script that worked with the one before, and each one that does says how under Breaking changes.

## Unreleased

### Docs

- The README's first screen and Quick start give the skill's install line, `npx skills add aksheyd/threejam`, which takes the skill from `main`. Quick start's note gives the tag command as the way to pin a release, and the others that name a GitHub address still name the latest release's tag.

### Fixed

- On macOS and Linux, when Chrome exits as it starts, `shot` kills the processes Chrome started before it removes Chrome's profile. Before, on a busy machine, one that was still starting could make the profile's folder again after `shot` removed it, and the folder stayed in the temporary folder.

## [0.0.5](https://github.com/aksheyd/threejam/compare/v0.0.4...v0.0.5) - 2026-10-07

Games play on phones and in a gallery in the browser, and a game can draw pixel art written as text, or its whole world in 3D. `sim --seeds` checks a game's balance over many seeds, `run --record` turns a playtest into a driver that `sim` replays, and `run`, `shot`, `check`, and the MCP server leave less behind when they're stopped or killed. From [#4](https://github.com/aksheyd/threejam/pull/4) through [#25](https://github.com/aksheyd/threejam/pull/25).

### Breaking changes

- Game code may grow its heap to 1 GB, the same on every machine, in `check`, `sim`, and the runs behind `shot`, `run`, and `export`, and past that it fails with `GAME_ERROR`, saying the game ran out of memory. Before, the limit followed the machine's memory, about 4 GB on a machine with 16 GB or more, so a game that kept more than 1 GB could pass on one machine and fail on another. The example games need less than 8 MB to play for 10 minutes.

### Phones and the gallery

- The example games play in the browser at https://aksheyd.github.io/threejam/, each with a frame `shot` draws, on a page that links ThreeJam's docs, and the README and the guides link to them.
- Exported games and `run`'s page lay out at a phone's own width, so the page's messages are readable and the game draws only the pixels the screen has. Before, a phone laid the page out 980 pixels wide and shrank it.
- On a touch screen, `run`'s page and exported games show a key beside or below the game, never on it, for each keyboard key the game reads, so a keyboard game plays on a phone. A finger on a key holds it as the keyboard would, so a playtest records it and `sim` replays it. A `Session` lists the keys game code has read as `keysRead`.
- `export --script URL` adds a script for the page to load from the network, like the widget a game jam requires on every entry. It takes only `https://` addresses and repeats for more, and without it, an exported file still loads nothing from the network.

### Balance, playtests, and outside tools

- `sim --seeds 0-99` runs the same flags once for each seed and prints a row for each: the tick it stopped at and whether `--until` held, or the error of a seed whose game failed. A summary gives how many seeds reached the condition, how many failed, and the min, median, and max tick it held at. Each row is the run `sim --seed N` gives, and seeds run side by side, sharing one pool per process. The `sim` MCP tool takes `seeds` too.
- `run --record FILE` records a playtest, the keys and pointer of every tick a person plays. When `run` stops, it saves them as a driver that `sim`, `shot`, and `simulate` replay exactly, and prints the `sim` command that does. It never replaces a file it didn't record, and never writes through a link.
- `run`'s page and exported games answer `window.advanceTime(ms)` and `window.render_game_to_text()`, the hooks OpenAI's `develop-web-game` skill has a game add, so its Playwright client can play and read a ThreeJam game with nothing added to it.

### Pixel art and 3D

- A game can draw pixel art written as text. `sprites` in `defineGame` gives each sprite `rows` of characters, where `.` shows what's behind and every other character is a color from the sprite's `palette`, and `image` names a sprite as it names a file. `check`, `sim`, and the page refuse a sprite with rows of different lengths, a character its palette lacks, no rows, or more than 256 rows or pixels to a row, and a game whose sprites have more than 4,194,304 pixels in all. A sprite draws as a PNG of its pixels would, and Invaders now draws its art this way.
- A new example game, Racer, keeps 2D rules but draws them in 3D, with a perspective camera, lights, and shadows, so `sim` stays exact and `shot` frames repeat as for any game. `AGENTS.md` says how a `view.ts` draws its game in 3D with the `renderer` and the `camera` that `init` and `draw` receive.

### Docs

- The package ships the agent skill, as `node_modules/threejam/skills/threejam/SKILL.md`, and the docs' `npx skills add` installs it from the latest release's tag instead of from `main`, so the skill describes the version npm installs.
- The `AGENTS.md` the package ships leaves out working on ThreeJam itself, which moves to `CONTRIBUTING.md` in the repo.
- `AGENTS.md` says keys are places on the keyboard, so W, A, S, and D are the keys marked Z, Q, S, and D on a French AZERTY keyboard. With the commands guide, it names `run --serve-only`, which serves the page without opening a window, and `--out`, the long form of `-o`.

### Fixed

- `sim --every` keeps only the entities `--only` names in each snapshot, as it takes it, so a long run holds no more than it prints. Before, a 10-minute run of Snake with `--every 1 --only game` grew to 2 GB to print 31 MB. A wrong `--only` with `--every` now fails at tick 0, and `simulate` takes `only` too.
- `run` reloads the page only when a file is saved. Before, it could reload once by itself just after it started, restarting a game a player had just begun.
- `run` keeps serving after a save that doesn't build, and its page says why until a save that builds reloads the game. Esc quits `run` from a page that says why the game didn't load.
- `run` and `shot` keep the page in memory, so they leave no folder of it in the temporary folder, even when they're killed. They also refuse a game that imports a CSS file, as `check` and `export` already did.
- `run`'s page ends on the newest save, even one that builds while the page is still reloading for the save before.
- An image or sound that `run` or `shot` can't read gets an error the page reports, and `run` goes on serving. When the page keeps failing to build the same way, `run` prints the failure once, rather than several times a second.
- On a touch screen, a finger dragged on the game moves the pointer until it lifts, and the page lets go of `Mouse` when the browser takes a touch over to pan the page.
- A mouse button pressed or let go while another is held now presses or lets go of its key, so in Asteroids the right button thrusts while the left aims and fires.
- On macOS, `run` stops promptly after Esc, Ctrl-C, or a closed terminal, where a busy Mac could take more than 10 s. On macOS and Linux, `run`'s window closes however `run` ends, even killed with SIGKILL, and closing the terminal `run` is in closes its window and removes its profile, as Ctrl-C does.
- `run` and `shot` remove the folder Chrome keeps its socket in, even after killing a Chrome that was slow to close, as on a busy Mac. When Chrome crashes during `shot`, `shot` waits for the processes Chrome started before it removes the profile, and on Windows, `shot`'s Chrome keeps its temporary files in its profile.
- On Linux, when Chrome exits as it starts because `TMPDIR` is too long for its socket, `shot` and `run` say to set a shorter one, like `/tmp`, and remove the empty folder Chrome made there.
- `shot` cleans up when it gets Ctrl-C, SIGTERM, or SIGHUP, even twice: it removes its folders and Chrome's, then ends by that signal, or on Windows exits with 128 plus its number. Before, Ctrl-C left those folders, and SIGTERM made it fail with `BROWSER_ERROR`.
- Killing an MCP server, or a command like `sim` or `check`, ends the sandbox running its game, and `check`'s type check, at once, even with SIGKILL. `check` also removes the folder its type check reads when a signal stops it.
- An MCP server whose client closes stdin, which is how MCP clients shut a server down, gives the calls still running 2 s to finish and reply, then exits. A `shot` still running first closes its Chrome and removes its folders, which takes at most 2 s more, or a moment longer on Windows.
- An MCP server answers other calls while `check` type-checks a game, and `check` of a game with thousands of type errors fails with `OUTPUT_TOO_LARGE` once its type check prints 1 MB, rather than `INTERNAL_ERROR`.
- A command like `sim`, or the MCP server, ends quietly when whatever reads its output closes the pipe during a write. Before, it could fail with `Error: write ENOTCONN` on macOS or `Error: write ECONNRESET` on Linux.

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
