# Commands

In a project that has ThreeJam installed, these run that copy; anywhere else, they run ThreeJam once without installing it.

| Command | What it does |
| --- | --- |
| `npx threejam new <dir>` | Writes a small playable game and its test into a new folder, plus a `package.json` and `tsconfig.json` outside a project |
| `npx threejam check <dir>` | Type-checks `game.ts` and `view.ts`, checks that the images entities name are in the folder, then runs `start` and the first tick |
| `npx threejam sim <dir> --ticks N` | Runs N ticks, 60 to a second, without a window and prints the entities |
| `npx threejam shot <dir> --at T,T,...` | Saves an 800x600 PNG at each tick, drawn by the same page players see |
| `npx threejam run <dir>` | Opens the game in a window for a person to play, with sound after the first key press or click; Esc quits |
| `npx threejam export <dir> -o <file>.html` | Writes one HTML file that plays the game offline, with its images and sounds inside; `--seed N` fixes the seed, which is otherwise new each time the page loads |

## Input

`sim` and `shot` share their input flags, and every `sim` run suggests the matching `shot` command:

- `--press KEY@T[,T...]` presses a key on those ticks, and `--hold KEY[@SPANS]` holds one on every tick or on spans like `30-90,120-`; the mouse buttons are the keys `Mouse` and `MouseRight`.
- `--pointer X,Y@T` moves the mouse pointer to X,Y in world units on tick T, where it stays until the next move.
- `--driver FILE` picks the input each tick with code that reads the world, like the Invaders [autopilot](../games/invaders/autopilot.ts), or the Asteroids [one](../games/asteroids/autopilot.ts) that plays with the mouse.
- `--set NAME.FIELD=VALUE` changes a starting value before `start` runs, like `--set paddle.w=1` for a wider Breakout paddle, and NAME can be a pattern such as `bricks[*]`.
- `--seed N` picks the random numbers; the default is 0.

## What sim prints

`sim` also takes `--until` to stop after the first tick a condition holds, like `--until 'match.state=over'` or `--until 'ball.x>1.9'`, `--only` and `--fields` to choose what it prints, and `--every N` to print every N ticks. Along with the entities it prints the game's log and the sounds it played, each with its tick.

## The page and Chrome

`shot` and `run` start Chrome with no DevTools port and only the environment variables a browser needs. ThreeJam's switches come last and override a wrapper script's, like the `google-chrome` launchers on Linux, but a wrapper can still add switches that have no opposite, like `--no-sandbox`.

## Output and errors

Output is [TOON](https://toonformat.dev) by default, `--format json` switches it, and every command takes `--help` and `--schema`. A failure prints a `code` and a one-line `message` and exits 1; for a problem in a game file, the message starts with `path:line:` and ends with when it happened, like `(in update at tick 61)`.

[`AGENTS.md`](../AGENTS.md#testing) has every flag in detail, and [For coding agents](agents.md) covers the same commands as MCP tools and skills.
