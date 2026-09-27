---
name: fourjs
description: Builds, tests, and screenshots 2D games with FourJS, a TypeScript game engine on Three.js, through its `four` CLI or MCP tools. Use when the user asks to make, change, test, or debug a FourJS game, or when a folder has a game.ts that calls defineGame from 'fourjs'.
license: MIT
compatibility: Needs Node 22.18+ and a clone of github.com/aksheyd/fourjs with npm install. shot and run need Chrome or Chromium; check and sim run anywhere.
---

# Making games with FourJS

A FourJS game is a folder with a `game.ts`: entity data plus an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run. You build a game by editing files and proving what it does with `four`, not by watching a window.

## Setup

1. Work in a clone of the FourJS repo, since games live in its `games/` folder for now:

   ```bash
   git clone https://github.com/aksheyd/fourjs && cd fourjs && npm install
   ```

2. Read `AGENTS.md` at the repo root in full before writing code. It's the manual: entity fields, `ctx`, `view.ts`, testing, and the known problems with their workarounds. Start from the shape of a game in `games/`; Pong is the smallest.

## Working loop

Run these from the repo root, with the game in `games/<name>`.

1. Edit `games/<name>/game.ts`, and `view.ts` for decoration only.
2. Run `npx four check games/<name>` until it prints `ok: true`. It type-checks the game and runs `start` and the first tick; `npx tsc -p .` also checks `view.ts`.
3. Prove each behavior with numbers from `npx four sim games/<name> --ticks N`:
   - `--press Space@60` presses a key on one tick, and `--hold Left@30-90` holds it on a range of ticks.
   - `--set ball.x=1.5` changes a starting value for one run.
   - `--only ball,paddle --every 10` prints those entities every 10 ticks. `ctx.print(...)` lines appear in `log`, and `--filter-output log` prints only them.
   - Pin the rules in `games/<name>/game.test.ts` with `simulate` and `pick`, like the other games.
4. Look at it: `npx four shot games/<name> --at 1,120,600 -o /tmp/<name>/frame.png` saves one PNG per tick from a single run. Open the PNGs.
5. Ask a person to play it with `npx four run games/<name>`. Numbers and frames can't show whether it feels right. Don't leave a `run` window open yourself.

## Facts to plan with

- The screen shows x from -2 to 2 and y from -1.5 to 1.5; an entity's `x, y` is its center and `w, h` its size.
- Entities with `text` are text, entities with `w`, `h`, `shape`, `color`, or `opacity` are shapes, and the rest are data. Declare every field you'll use with a starting value.
- `update(world, ctx)` runs 60 times a second with `ctx.dt` of 1/60. Use `ctx.input`, `ctx.random()`, `ctx.print()`, and `ctx.tick`; the clock, `Math.random()`, timers, and `async` are errors.
- Keep all changing state on entities, never in variables at the top of `game.ts`.
- Not supported yet: creating or removing entities during a run (keep a hidden pool and show members with `visible`), sound, mouse input, and images.
- For MCP clients, `npx four mcp add` registers `check`, `sim`, and `shot` as tools. Restart the server after editing a game.

## Conventions

- Wait for the player's first key press before the action starts, and offer a restart after a win or game over.
- Put decoration that never affects play in `view.ts`, and keep everything collisions depend on in `game.ts`.
