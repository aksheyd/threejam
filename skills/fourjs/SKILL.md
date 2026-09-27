---
name: fourjs
description: Builds, tests, and screenshots 2D games with FourJS, a TypeScript game engine on Three.js, through its `four` CLI or MCP tools. Use when the user asks to make, change, test, or debug a FourJS game, or when a folder has a game.ts that calls defineGame from 'fourjs'.
license: MIT
compatibility: Needs Node 22.18+ and a clone of github.com/aksheyd/fourjs with npm install; run four from inside the clone. shot needs Chrome or Chromium; check and sim run anywhere.
---

# Making games with FourJS

A FourJS game is a folder with a `game.ts`: entity data plus an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run. You build a game by editing files and proving what it does with `four`, not by watching a window.

## Setup

1. Work in a clone of the FourJS repo, since games live in its `games/` folder for now:

   ```bash
   git clone https://github.com/aksheyd/fourjs && cd fourjs && npm install
   ```

2. Read `AGENTS.md` at the repo root in full before writing code. It's the manual: entity fields, groups and grids, `oneOf`, `ctx`, `view.ts`, drivers, and testing. Start from the shape of a game in `games/`; Pong is the smallest.

## Working loop

Run these from the repo root, with the game in `games/<name>`.

1. Edit `games/<name>/game.ts`, and `view.ts` for decoration only.
2. Run `npx four check games/<name>` until it prints `ok: true`. It type-checks `game.ts` and `view.ts`, then runs `start` and the first tick.
3. Prove each behavior with numbers from `npx four sim games/<name> --ticks N`:
   - `--press Space@60` presses a key on one tick, and `--hold Left@30-90` holds it on a range of ticks.
   - `--driver bot.ts` picks keys each tick with code that reads the game, for input that has to react.
   - `--set paddle.w=1` or `--set 'bricks[*].points=5'` changes starting values for one run; `start` runs after them and can set a field again.
   - `--only ball,bricks --fields x,y --every 10` prints those entities and fields every 10 ticks. `ctx.print(...)` lines appear in `log`, and `--filter-output log` prints only them.
   - Pin the rules in `games/<name>/game.test.ts` with `simulate`, `pick`, and `drive`, like the other games.
4. Look at it: `npx four shot games/<name> --at 1,120,600 --press Space@1 -o /tmp/<name>/frame.png` saves one PNG per tick from a single run, with the same key flags as `sim`. Open the PNGs.
5. Ask a person to play it with `npx four run games/<name>`. Numbers and frames can't show whether it feels right. Don't leave a `run` window open yourself.

## Facts to plan with

- The screen shows x from -2 to 2 and y from -1.5 to 1.5; an entity's `x, y` is its center and `w, h` its size.
- Entities with `text` are text, entities with `w`, `h`, `shape`, `color`, or `opacity` are shapes, and the rest are data. Declare every field you'll use with a starting value; each keeps the kind it starts with.
- Use `group(n, (i) => fields)` and `grid(rows, cols, ({ row, col }) => fields)` for many similar entities, and `oneOf([...])` for fields that take a fixed set of strings, including key names with `oneOf(KEYS, 'W')`.
- `update(world, ctx)` runs 60 times a second with `ctx.dt` of 1/60. Use `ctx.input`, `ctx.random()`, `ctx.print()`, and `ctx.tick`; the clock, `Math.random()`, timers, and `async` are errors.
- Text uses a 5x7 pixel font with capitals, digits, and a little punctuation; `size` is the letter height.
- Keep all changing state on entities, never in variables at the top of `game.ts`.
- Not supported yet: creating or removing entities during a run (keep a hidden group and show members with `visible`), sound, mouse input, and images.
- For MCP clients, `npx four mcp add` registers `check`, `sim`, and `shot` as tools; each call reads the game from disk.

## Conventions

- Wait for the player's first key press before the action starts, and offer a restart after a win or game over.
- Put decoration that never affects play in `view.ts`, and keep everything collisions depend on in `game.ts`.
