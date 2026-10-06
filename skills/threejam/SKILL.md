---
name: threejam
description: Builds, tests, and screenshots 2D games with ThreeJam, a TypeScript game engine on Three.js, through its `threejam` CLI or MCP tools. Use when the user asks to make, change, test, or debug a ThreeJam game, or when a folder has a game.ts that calls defineGame from 'threejam'.
license: MIT
compatibility: Needs Node 22.18+ and ThreeJam from npm, installed in the project with npm install -D threejam, or run once without installing as npx threejam. shot needs Chrome or Chromium; check and sim run anywhere.
---

# Making games with ThreeJam

A ThreeJam game is a folder with a `game.ts`: entity data plus an `update` function, next to any images and sounds it uses. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run. You build a game by editing files and proving what it does with `threejam`, not by watching a window.

## Setup

1. Get ThreeJam into the project, so `npx threejam` runs the copy installed there; anywhere else, `npx threejam` runs it once without installing it.
   - In a project, install it with `npm install -D threejam`.
   - With no project yet, start one: `npx threejam new my-game`, then run `npm install` in `my-game`. `new` writes a small playable game, its test, a `package.json`, and a `tsconfig.json`.

2. Read the manual in full before writing code: `node_modules/threejam/AGENTS.md` in the project, or `AGENTS.md` at github.com/aksheyd/threejam. It covers entity fields, groups and grids, `oneOf`, images, `ctx` with its input, pointer, and sounds, `view.ts`, drivers, and testing. Start from the game `new` writes, or from the shape of a game in the repo's `games/` folder; Pong is the smallest, and Asteroids uses images, sounds, the mouse, and `spawn`.

## Working loop

Run these from the project's root, with the game in `<dir>`.

1. Start a game with `npx threejam new <dir>`, which refuses a folder that has anything in it, or edit `<dir>/game.ts`, and `view.ts` for decoration only.
2. Run `npx threejam check <dir>` until it prints `ok: true`. It type-checks `game.ts` and `view.ts`, bundles the page to check their imports, checks that the images entities name are in the folder, then runs `start` and the first tick.
3. Prove each behavior with numbers from `npx threejam sim <dir> --ticks N`:
   - `--press Space@60` presses a key on one tick, and `--hold Left@30-90` holds it on a range of ticks. The mouse buttons are the keys `Mouse` and `MouseRight`, and `--pointer 0.5,-0.2@30` moves the pointer on tick 30, where it stays until the next move.
   - `--driver bot.ts` picks the input each tick with code that reads the game, for input that has to react. It also gets the keys it held and the pointer from the tick before, so it can tap a key, and it can return `{ keys, pointer }` to move the pointer.
   - The output lists the sounds the game played with their ticks, so a test can check that a hit made a sound.
   - `--until 'match.state=over'` or `--until 'ball.x>1.9'` stops on the first tick the condition holds, with `--ticks` as the limit, so you learn when something happens instead of guessing a tick. The output's `tick` and `reached` say where it stopped and whether the condition held.
   - `--set paddle.w=1` or `--set 'bricks[*].points=5'` changes starting values for one run; `start` runs after them and can set a field again.
   - `--only ball,bricks --fields x,y --every 10` prints those entities and fields every 10 ticks. `ctx.print(...)` lines appear in `log`, and `--filter-output log` prints only them.
   - Pin the rules in `<dir>/game.test.ts` with `simulate`, `pick`, and `drive`, like the test `new` writes, and run it with `node --test <dir>/game.test.ts`.
4. Look at it: `npx threejam shot <dir> --at 1,120,600 --press Space@1 -o /tmp/<name>/frame.png` saves one PNG per tick from a single run, with the same input flags as `sim`. Open the PNGs.
5. Ask a person to play it with `npx threejam run <dir>`. Numbers and frames can't show whether it feels right. Don't leave a `run` window open yourself.
6. To hand the game to someone, `npx threejam export <dir> -o <name>.html` writes one HTML file that plays it offline, images and sounds included.

## Facts to plan with

- The screen shows x from -2 to 2 and y from -1.5 to 1.5; an entity's `x, y` is its center, `w, h` its size, and `angle` its turn counterclockwise in radians.
- Entities with `text` are text, entities with `w`, `h`, `shape`, `color`, `opacity`, or `image` are shapes, and the rest are data. Declare every field you'll use with a starting value; each keeps the kind it starts with.
- Use `group(n, (i) => fields)` and `grid(rows, cols, ({ row, col }) => fields)` for many similar entities, and `oneOf([...])` for fields that take a fixed set of strings, including key names with `oneOf(KEYS, 'W')`.
- Entities can't be created or removed during a run, so declare a group of hidden members as a pool: `spawn(world.bullets, { x, y })` resets the first hidden one to its starting values, shows it, and returns it, and `visible = false` puts it back.
- Declare lists with `listOf(example)`, and values that start as `null` with `maybe(example)`, instead of `[]` and `null`, so what they hold is typed and checked.
- Give an entity `parts` when it's made of several shapes or text that move and turn together, like a pipe pair or a ship and its flame. A part's `x` and `y` are offsets from its entity, turned by its `angle`, and it hides with it.
- `image: 'rock.png'` draws a PNG, JPEG, WebP, GIF, or SVG file from the game's folder over a shape's `w` by `h`; a name the folder lacks is an error.
- `update(world, ctx)` runs 60 times a second with `ctx.dt` of 1/60. Use `ctx.input` (keys, `Mouse`, and `ctx.input.pointer`), `ctx.random()`, `ctx.print()`, `ctx.play('explode')` for a built-in sound or a sound file in the folder, and `ctx.tick`, all read-only; the clock, `Math.random()`, `crypto`, timers, and `async` are errors, even through a function kept at a file's top level or taken from `Date.prototype`, and text and dates format as in `en-US` and UTC whatever the machine's settings.
- Shuffle with Fisher–Yates on `ctx.random()`, as in `for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(ctx.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]] }`, never with `sort(() => ctx.random() - 0.5)`, whose order differs between browsers, and keep promises out of game code, since their callbacks run after the tick.
- Text uses a 5x7 pixel font with capitals, digits, and a little punctuation; `size` is the letter height.
- Keep all changing state on entities, never in variables at the top of `game.ts`.
- `check`, `sim`, `shot`, and `export` run the game (and any `--driver`) in a sandbox with no files, processes, or network: a game can `import` only `threejam` and files next to it, the clock and `Math.random()` are errors, and a run that passes `--timeout` seconds (default 30) stops with a `TIMEOUT` error, so an endless loop fails instead of hanging.
- For MCP clients, `npx threejam mcp add` registers `new`, `check`, `sim`, `shot`, and `export` as tools; each call reads the game from disk.

## Conventions

- Wait for the player's first key press before the action starts, and offer a restart after a win or game over.
- Put decoration that never affects play in `view.ts`, and keep everything collisions depend on in `game.ts`.
