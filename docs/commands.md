# Commands

In a project that has ThreeJam installed, these run that copy; anywhere else, they run ThreeJam once without installing it.

| Command | What it does |
| --- | --- |
| `npx threejam new <dir>` | Writes a small playable game and its test into a new folder, plus a `package.json` and `tsconfig.json` outside a project |
| `npx threejam check <dir>` | Type-checks `game.ts` and `view.ts`, bundles the page to check their imports, checks that the images entities name are in the folder, then runs `start` and the first tick |
| `npx threejam sim <dir> --ticks N` | Runs N ticks, 60 to a second, without a window and prints the entities |
| `npx threejam shot <dir> --at T,T,...` | Saves an 800x600 PNG at each tick, drawn by the same page players see, to the `.png` file `-o` or `--out` names |
| `npx threejam run <dir>` | Checks that the game starts, then opens it in a window for a person to play, with sound after the first key press or click; Esc quits, `--serve-only` serves the page and prints its address without opening a window, and `--record FILE` saves what the person plays, as a driver that replays it exactly |
| `npx threejam export <dir> -o <file>.html` | Writes one HTML file that plays the game offline, with its images and sounds inside; `--seed N` fixes the seed, which is otherwise new each time the page loads, and `--script URL` adds a script for the page to load from the network, like the widget a game jam requires on every entry, while without one the page loads nothing from the network |

## Input

`sim` and `shot` share their input flags, and every `sim` run suggests the matching `shot` command:

- `--press KEY@T[,T...]` presses a key on those ticks, and `--hold KEY[@SPANS]` holds one on every tick or on spans like `30-90,120-`; the mouse buttons are the keys `Mouse` and `MouseRight`.
- `--pointer X,Y@T` moves the mouse pointer to X,Y in world units on tick T, where it stays until the next move.
- `--driver FILE` picks the input each tick with code that reads the world, like the Invaders [autopilot](../games/invaders/autopilot.ts), or the Asteroids [one](../games/asteroids/autopilot.ts) that plays with the mouse. A playtest that `run --record` saved is a driver too, which replays a person's play with the seed `run` printed.
- `--set NAME.FIELD=VALUE` changes a starting value before `start` runs, like `--set paddle.w=1` for a wider Breakout paddle, and NAME can be a pattern such as `bricks[*]`.
- `--seed N` picks the random numbers, from any whole number; the default is 0.
- `--timeout N` caps how many seconds the game's code may run before the command stops it with the `TIMEOUT` code; the default is 30 and the most 86400, a day, and `check`, `shot`, and `export` take it too, `shot` for its page's `view.ts` as well.

Ticks and other whole numbers in flags are plain digits, so `--ticks 1e2` or `--press Space@0x5` fails with `USAGE` instead of meaning 100 or 5.

## What sim prints

`sim` also takes `--until` to stop after the first tick a condition holds, like `--until 'match.state=over'` or `--until 'ball.x>1.9'`, `--only` and `--fields` to choose what it prints, and `--every N` to print every N ticks. Along with the entities it prints the game's log and the sounds it played, each with its tick.

It rounds numbers to 4 decimal places, while `--until` compares exact values, so stop on a moving number with `<` or `>`, or copy the value from `--exact`, which prints numbers as they are.

## The page and Chrome

Every command that loads a game bundles it first, for the sandbox described below and, in `run`, `shot`, and `export`, for the page, and both follow one rule: the game's files may import only `threejam` and files in the game's folder, and a `--driver` file may also import files in its own folder. An import of anything else, even through a link, fails with its `path:line`.

`run` serves that page on `127.0.0.1` to the page alone: another page, even one on another local port or opened from a file, gets 403, and an SVG opened directly downloads instead of running its script.

`shot` and `run` start Chrome with no DevTools port and only the environment variables a browser needs. ThreeJam's switches come last and override a wrapper script's, like the `google-chrome` launchers on Linux, but a wrapper can still add switches that have no opposite, like `--no-sandbox`.

On Linux, Chrome can't start in a `TMPDIR` over 62 bytes, or 66 for Google Chrome, since the socket it makes there would pass the 107 bytes Linux allows; `shot` and `run` then say to set `TMPDIR` to a shorter folder, like `/tmp`.

## Output and errors

Output is [TOON](https://toonformat.dev) by default, `--format json` switches it, and every command takes `--help` and `--schema`. A failure prints a `code` and a one-line `message` and exits 1, though `run`, whose output is a stream, prints one it meets once it has started, like a game that doesn't build, as `Error (CODE): message`; for a problem in a game file, the message starts with `path:line:` and ends with when it happened, like `(in update at tick 61)`. The code says what went wrong:

| Code | What went wrong |
| --- | --- |
| `USAGE` | The command was called wrong: a missing or malformed flag, a value out of range, or a folder or file that isn't there |
| `BUILD_ERROR` | The game's files couldn't be bundled: a syntax error, or an import that doesn't resolve or comes from outside the folder |
| `TYPE_ERROR` | `check` found type errors |
| `GAME_ERROR` | The game's or driver's code threw or broke an engine rule, in the sandbox or in the page, or ran out of memory |
| `TIMEOUT` | The game's code, its page in `shot`, or the type check ran past `--timeout` |
| `OUTPUT_TOO_LARGE` | A run printed more than its reply can hold, or `check`'s type check more than 1 MB |
| `BROWSER_ERROR` | Chrome is missing, didn't start, or failed while drawing |
| `IO_ERROR` | A file or folder couldn't be read, made, or written |
| `INTERNAL_ERROR` | ThreeJam itself failed, which is a bug to report |

Because loading a game runs its code, `check`, `sim`, `shot`, and `export` run `game.ts` and any `--driver` in a sandbox with no files, processes, or network. A run that passes `--timeout` seconds stops with the `TIMEOUT` code, a run whose heap grows past 1 GB, the same on every machine, fails with `GAME_ERROR`, and an MCP `sim` reply too large for a client is refused with `OUTPUT_TOO_LARGE` and how to narrow it. A run and `check`'s type check also stop as soon as the command or MCP server that started them ends, even by SIGKILL.

[`AGENTS.md`](../AGENTS.md#testing) has every flag in detail, and [For coding agents](agents.md) covers the same commands as MCP tools and skills.
