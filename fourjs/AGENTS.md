# FourJS

FourJS is a game engine on Three.js for coding agents. A game is a folder with a `game.ts`: plain data for the entities and an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run. The same commands work as a CLI, as MCP tools, and as generated agent skills.

This is a prototype inside the game-engine repo. Games live in `games/` here so their `import 'fourjs'` resolves.

## Commands

Run these from `fourjs/` after `npm install`. They need Node 22.18 or later, and `shot` and `run` need Chrome or Chromium (`CHROME_PATH` points to another one).

```bash
npx four check games/pong        # types, entities, start, and the first tick
npx four sim games/pong --ticks 120 --press Space@1 --hold W@1-60 --only ball
npx four shot games/pong --at 1,120,600 -o frame.png
npx four run games/pong          # play it: Esc quits, and saving a file reloads it
```

Output is TOON by default; `--format json` switches it. Every command also takes `--help` and `--schema`. A failure prints a `code` and a `message` and exits 1; the message starts with `path:line:` when the problem is in a game file, and says which tick failed.

For agents:

- `npx four --mcp` serves `check`, `sim`, and `shot` as MCP tools. `run` is for people, so it isn't one. `npx four mcp add` registers the server with Claude Code, Cursor, and others.
- `npx four skills add` writes one skill per command, generated from the same definitions as the CLI. `npx four --llms` prints a manifest.

## The screen

The 800x600 window shows x from -2 to 2 and y from -1.5 to 1.5, with (0, 0) at the center. An entity's `x, y` is its center and `w, h` its size. Entities are drawn in the order they're declared.

## game.ts

```ts
import { defineGame, type Entities } from 'fourjs'

const entities = {
  paddle: { x: -1.8, y: 0, w: 0.1, h: 0.5, color: 'white', speed: 2 },
  ball: { x: 0, y: 0, w: 0.08, h: 0.08, shape: 'circle', vx: 1.2 },
  score: { x: 0, y: 1.3, text: '0' },
  match: { state: 'ready', points: 0 },
} satisfies Entities

export default defineGame({
  title: 'Example',
  background: '#08080d',
  entities,
  start(world, ctx) {},
  update(world, ctx) {
    const { paddle, ball } = world
    if (ctx.input.held('W')) paddle.y += paddle.speed * ctx.dt
    ball.x += ball.vx * ctx.dt
  },
})
```

- An entity with `text` is text. One with any of `w`, `h`, `shape`, `color`, or `opacity` is a shape. Any other entity, like `match`, holds data and isn't drawn.
- Every entity has `x` and `y` (default 0) and `visible` (default true). Shapes have `w` and `h` (default 1), `shape` (`"square"`, `"circle"`, or `"triangle"`), `color` (a CSS color name, `#rgb`, or `#rrggbb`; default white), and `opacity` (default 1). Text has `text`, `size` (the letter height, default 0.14), `align` (`"center"`, `"left"`, or `"right"`), `color`, and `opacity`.
- Other fields are yours, but give each one a starting value in `entities`: assigning a field that wasn't declared is an error. Values can be numbers, strings, booleans, null, arrays, and plain objects, and a number, string, or boolean field keeps its type.
- Assignments are checked where they happen, and the error names the file and line: undeclared fields, `NaN` and `Infinity`, sizes of 0 or less, unknown colors, unknown key names, and missing entities like `world.bal`.
- Declare `entities` with `satisfies Entities` and type helper functions with `World<typeof entities>`, so `check` catches typos before anything runs. Pong shows both.

`ctx` gives `start` and `update` everything they may use:

- `ctx.tick` is 1 on the first update, and `ctx.dt` is always 1/60.
- `ctx.input.held(key)`, `ctx.input.pressed(key)` for the first tick a key is down, and `ctx.input.released(key)` for the first tick it's up. Keys are A-Z, 0-9, Space, Enter, Tab, Backspace, Shift, Ctrl, Alt, Up, Down, Left, and Right.
- `ctx.random()` returns a seeded number from 0 up to 1.
- `ctx.print(...values)` adds a `[tick N] ...` line to `sim`'s `log`.
- `ctx.all(prefix)` lists the entities whose names start with `prefix`, in order.

While `start` or `update` runs, `Math.random()`, `Date.now()`, `new Date()`, `performance.now()`, timers, and `async` functions are errors, because they would make runs differ. `check` type-checks game files without browser or Node types, so `console` and `document` fail there with the fix in the message.

## view.ts

A game can add a `view.ts` for extras drawn with Three.js that the game logic never sees, like Pong's dashed net:

```ts
import type { ViewFrame, ViewSetup } from 'fourjs'

export function init({ THREE, scene, camera }: ViewSetup) {}
export function draw({ entities, tick, objects }: ViewFrame) {}
```

`entities` has every field of every entity, and `objects` maps entity names to the meshes the default view draws. `draw` must depend only on what it's given, not on earlier frames, so `shot` shows exactly what players see.

## Testing

- `sim --ticks N` runs N updates and prints the entities. `--press KEY@T[,T...]` presses a key on those ticks; `--hold KEY` holds it on every tick and `--hold KEY@SPANS` on spans like `30-90,120-`; `--set NAME.FIELD=VALUE` changes a starting value; `--seed N` picks the random numbers; `--only a,b_*` and `--every N` choose what to print. Tick 1 is the first update, and `start` sees every key up.
- `shot --at T[,T...]` renders the page players see, in headless Chrome with software rendering, at those ticks of one run. Several ticks turn `frame.png` into `frame-001.png`, `frame-120.png`, and so on.
- The page runs the same engine code as `sim`, so for the same inputs they reach exactly the same state; a test checks it.

## Not in the prototype yet

`four new`, a web export, games outside this folder, adding or removing entities during a run, sound, mouse input, images, input drivers, and a limit on endless loops, so a stuck `update` hangs `sim`. Command-line mistakes exit 1 like other failures, because incur sets the exit codes.

## Working on FourJS

```bash
npm test        # engine, CLI, and MCP tests, plus a page-versus-sim check that needs Chrome
npx tsc -p .    # typecheck
```
