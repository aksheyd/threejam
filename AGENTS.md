# FourJS

FourJS is a game engine on Three.js for coding agents. A game is a folder with a `game.ts`: plain data for the entities and an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run. The same commands work as a CLI, as MCP tools, and as generated agent skills.

It's a prototype: games live in this repo's `games/` folder so their `import 'fourjs'` resolves, and it isn't on npm yet.

## Commands

Run these from the repo root after `npm install`. They need Node 22.18 or later, and `shot` and `run` need Chrome or Chromium (`CHROME_PATH` points to another one).

```bash
npx four check games/pong        # types, entities, start, and the first tick
npx four sim games/pong --ticks 120 --press Space@1 --hold W@1-60 --only ball
npx four shot games/pong --at 1,120,600 -o frame.png
npx four run games/pong          # play it: Esc quits, and saving a file reloads it
```

Output is TOON by default; `--format json` switches it, and `--filter-output log` prints only the log. Every command also takes `--help` and `--schema`. A failure prints a `code` and a `message` and exits 1; the message starts with `path:line:` when the problem is in a game file, and says which tick failed.

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
- Every entity has `x` and `y` (default 0) and `visible` (default true). Shapes have `w` and `h` (default 1), `shape` (`"square"`, `"circle"`, or `"triangle"`), `color` (a CSS color name, `#rgb`, or `#rrggbb`; default white), and `opacity` (default 1). Text has `text`, `size` (the font size, default 0.14), `align` (`"center"`, `"left"`, or `"right"`), `color`, and `opacity`.
- Other fields are yours, but give each one a starting value in `entities`: assigning a field that wasn't declared is an error. Values can be numbers, strings, booleans, null, arrays, and plain objects, and a number, string, or boolean field keeps its type.
- Assignments are checked where they happen, and the error names the file and line: undeclared fields, `NaN` and `Infinity`, sizes of 0 or less, unknown colors, unknown key names, and missing entities like `world.bal`.
- Declare `entities` with `satisfies Entities` and type helper functions with `World<typeof entities>`, so `check` catches typos before anything runs. Pong shows both.
- Keep every value that changes during play on an entity. Variables at the top of `game.ts` survive from one run to the next in the same process, which breaks repeatable runs.

`ctx` gives `start` and `update` everything they may use:

- `ctx.tick` is 1 on the first update, and `ctx.dt` is always 1/60.
- `ctx.input.held(key)`, `ctx.input.pressed(key)` for the first tick a key is down, and `ctx.input.released(key)` for the first tick it's up. Keys are A-Z, 0-9, Space, Enter, Tab, Backspace, Shift, Ctrl, Alt, Up, Down, Left, and Right.
- `ctx.random()` returns a seeded number from 0 up to 1.
- `ctx.print(...values)` adds a `[tick N] ...` line to `sim`'s `log`.
- `ctx.all(prefix)` lists the entities whose names start with `prefix`, in order.

While `start` or `update` runs, `Math.random()`, `Date.now()`, `new Date()`, `performance.now()`, timers, and `async` functions are errors, because they would make runs differ. `check` type-checks game files without browser or Node types, so `console` and `document` fail there with the fix in the message.

## view.ts

A game can add a `view.ts` for extras drawn with Three.js that the game logic never sees, like Pong's dashed net or Snake's grid:

```ts
import type { ViewFrame, ViewSetup } from 'fourjs'

export function init({ THREE, scene, camera }: ViewSetup) {}
export function draw({ entities, tick, objects }: ViewFrame) {}
```

- `entities` has every field of every entity, and `objects` maps entity names to the meshes the default view draws; `objects` is empty during `init`. The default view resets each mesh's geometry, size, color, and visibility right before `draw`, so a change to one has to be made again every frame.
- `draw` must depend only on what it's given, not on earlier frames, so `shot` shows exactly what players see.
- Entity meshes are transparent, so Three.js draws them after every opaque mesh. A view mesh with an opaque material always ends up under the entities; to draw above one, give its material `transparent: true` and a `renderOrder` higher than that entity's position in `entities`.

## Testing

- `sim --ticks N` runs N updates and prints the entities. `--press KEY@T[,T...]` presses a key on those ticks, and presses on neighboring ticks join into one; `--hold KEY` holds it on every tick and `--hold KEY@SPANS` on spans like `30-90,120-`; `--set NAME.FIELD=VALUE` changes a starting value, reading VALUE as JSON (like `[1,2]` or `true`) and otherwise as a string; `--seed N` picks the random numbers; `--only a,b_*` and `--every N` choose what to print. Tick 1 is the first update, and `start` sees every key up.
- `shot --at T[,T...]` renders the page players see, in headless Chrome with software rendering, at those ticks of one run. Several ticks turn `frame.png` into `frame-001.png`, `frame-120.png`, and so on. Each call starts Chrome, which takes about 2.5 s, so ask for several ticks at once.
- The page runs the same engine code as `sim`, so for the same inputs they reach exactly the same state; a test checks it.

Tests use the library, as in `games/*/game.test.ts`:

- `simulate(game, { ticks, press, hold, set, seed, every })` returns `{ snapshots, logs }`, and `pick(entities, 'ball,cell_*')` filters a snapshot's entities.
- Build a variant of a game by spreading it: `simulate({ ...game, entities: { ...game.entities, ball: { ...game.entities.ball, vx: 3 } } }, { ticks: 60 })`.
- For a bot that reacts to the game, step a `Session` yourself: `const s = new Session(game, { seed: 0 }); s.start(); s.step(['Space'])`, then read `s.state()`.

## Known problems

- Under `satisfies Entities`, a field declared `false`, `'square'`, or `'right'` gets that literal type, so `ball.visible = true` fails `check`. Declare it as `false as boolean` (or `'ready' as Phase` for your own string unions) until the types widen them.
- Entities generated in a loop and spread into `entities` drop out of `World<typeof entities>`. Type them with `Record<\`cell_${number}\`, Cell>` joined in with `Object.assign`, or read them with `ctx.all(prefix)` and a cast. `ctx.all` entities have no `name` field, and a prefix like `shield` also matches `shields`.
- Text comes out smaller than `size`: capitals are about 0.72 of it, sitting a little above `y`, in the system's monospace font, so frames with text differ between machines. Invaders draws a pixel font in its `view.ts` instead.
- Changing an array or object field in place, like `list.push(NaN)`, isn't checked; assign a new value instead. `sim` prints `NaN` as 0.
- `check` doesn't type-check `view.ts`; run `npx tsc -p .` for that.
- The MCP server keeps running the code it first loaded, so restart it after editing a game.
- The command `sim` suggests next drops the run's `--press`, `--hold`, `--set`, and `--seed`.

## Not in FourJS yet

`four new`, a web export, games outside this repo, adding or removing entities during a run, sound, mouse input, images, input drivers, and a limit on endless loops, so a stuck `update` hangs `sim`. Command-line mistakes exit 1 like other failures, because incur sets the exit codes.

## Working on FourJS

- `src/types.ts`, `entities.ts`, `engine.ts`, `input.ts`, `random.ts`, `guard.ts`, `colors.ts`, `errors.ts`: the engine, shared by `sim` and the page.
- `src/browser/client.ts` and `src/browser/view.ts`: the page's loop, keyboard, and `window.engine`, and the default Three.js view.
- `src/cli.ts`: the incur command definitions. The CLI, the MCP tools, the generated skills, and `--llms` all come from these, so descriptions and examples change here.
- `src/load.ts`: loading a game, the type check, and turning errors into `path:line`. `src/serve.ts` and `src/shot.ts`: bundling, the local server, the Chrome window, and headless frames.
- `games/`: the example games and their tests. `test/`: engine, CLI, MCP, and page-versus-sim tests.
- `skills/fourjs/SKILL.md`: the agent skill published from this repo.

```bash
npm test        # every test, including the games'; the page check needs Chrome
npx tsc -p .    # typecheck
npx four check games/pong
```

Rules:

- `npm test` and `npx tsc -p .` stay clean, and every game in `games/` passes `check`.
- `sim` and the page reach the same state for the same files, flags, and seed.
- Failures print a code and a message and exit 1; problems in game files start with `path:line:`.
- `check` and `sim` never open a browser. The engine has no game-specific code.
- A change agents can see goes into this file in the same change, and into the skill if it changes the skill's steps.
- Comments are single lines and only say what the code can't. No emojis. Each test covers something no other test does.
- Don't leave a `run` window open: start `run --serve-only` in the background, check it, and stop it.
