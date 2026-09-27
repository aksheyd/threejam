# FourJS

FourJS is a game engine on Three.js for coding agents. A game is a folder with a `game.ts`: plain data for the entities and an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run. The same commands work as a CLI, as MCP tools, and as generated agent skills.

It's a prototype: games live in this repo's `games/` folder so their `import 'fourjs'` resolves, and it isn't on npm yet.

## Commands

Run these from the repo root after `npm install`, since the name `four` on npm belongs to an unrelated package. They need Node 22.18 or later; `shot` needs Chrome or Chromium (`CHROME_PATH` points to another one), and `run` opens a plain Chrome window when it finds one and your default browser otherwise.

```bash
npx four check games/pong        # types of game.ts and view.ts, entities, start, and the first tick
npx four sim games/pong --ticks 120 --press Space@1 --hold W@1-60 --only ball --fields x,y
npx four shot games/pong --at 1,120,600 --press Space@1 -o frame.png
npx four run games/pong          # play it: Esc quits, and saving a file replays it with the same seed
```

Output is TOON by default; `--format json` switches it, and `--filter-output log` prints only the log and the suggested next command. Every command also takes `--help` and `--schema`. A failure prints a `code` and a one-line `message` and exits 1; the message starts with `path:line:` when the problem is in a game or driver file, and ends with when it happened, like `(in update at tick 61)`.

For agents:

- `npx four --mcp` serves `check`, `sim`, and `shot` as MCP tools. `run` is for people, so it isn't one. `npx four mcp add` registers the server with Claude Code, Cursor, and others, as `node <this repo>/src/cli.ts --mcp`, so it starts from any folder. Each call loads the game from disk, so edits show up without restarting the server.
- `npx four skills add` writes one skill per command, generated from the same definitions as the CLI. `npx four --llms` prints a manifest.

## The screen

The 800x600 window shows x from -2 to 2 and y from -1.5 to 1.5, with (0, 0) at the center. An entity's `x, y` is its center and `w, h` its size. Entities are drawn in the order they're declared, group members in order at their group's place.

## game.ts

```ts
import { KEYS, defineGame, grid, group, oneOf, type Context, type Entities, type World } from 'fourjs'

const entities = {
  paddle: { x: -1.8, y: 0, w: 0.1, h: 0.5, color: 'white', speed: 2, up: oneOf(KEYS, 'W') },
  ball: { x: 0, y: 0, w: 0.08, h: 0.08, shape: 'circle', vx: 1.2, stuck: false },
  bricks: grid(4, 10, ({ row, col }) => ({ x: col * 0.4 - 1.8, y: 1.2 - row * 0.15, w: 0.36, h: 0.1, hits: 0 })),
  sparks: group(8, () => ({ x: 0, y: 0, w: 0.02, h: 0.02, visible: false })),
  score: { x: 0, y: 1.4, text: '0' },
  match: { state: oneOf(['ready', 'play', 'over']), points: 0 },
} satisfies Entities

type Breakout = World<typeof entities>

function move(paddle: Breakout['paddle'], ctx: Context): void {
  if (ctx.input.held(paddle.up)) paddle.y += paddle.speed * ctx.dt
}

export default defineGame({
  title: 'Example',
  background: '#08080d',
  entities,
  start(world, ctx) {},
  update(world, ctx) {
    move(world.paddle, ctx)
    world.ball.x += world.ball.vx * ctx.dt
    for (const row of world.bricks) for (const brick of row) if (brick.hits > 0) brick.visible = false
  },
})
```

- An entity with `text` is text. One with any of `w`, `h`, `shape`, `color`, or `opacity` is a shape. Any other entity, like `match`, holds data and isn't drawn.
- Every entity has `x` and `y` (default 0), `visible` (default true), and a read-only `name`. Shapes have `w` and `h` (default 1), `shape` (`"square"`, `"circle"`, or `"triangle"`), `color` (a CSS color name, `#rgb`, or `#rrggbb`; default white), and `opacity` (default 1). Text has `text`, `size` (the letter height, default 0.14), `align` (`"center"`, `"left"`, or `"right"`), `color`, and `opacity`.
- Text uses a 5x7 pixel font with A-Z, 0-9, space, and `. , : ; ! ? - + / ( ) % ' "`; lowercase draws as capitals, and any other character is an error. Each character is `size * 6 / 7` wide, and `y` is the middle of the letters.
- Other fields are yours, but give each one a starting value in `entities`: assigning a field that wasn't declared is an error. Values can be numbers, strings, booleans, null, arrays, and plain objects, and a field keeps the kind it started with, so a number stays a number and an array stays an array.
- `group(count, (index) => fields)` declares a list of entities and `grid(rows, cols, ({ row, col }) => fields)` a grid; `world.sparks[3]` and `world.bricks[row][col]` are typed, and members are named `sparks[3]` and `bricks[2][5]`. Neither can grow or shrink during a run, so park unused members with `visible = false`.
- `oneOf(['ready', 'play', 'over'])` declares a field that only takes those strings, starting with the first; `oneOf(KEYS, 'W')` holds a key name for `ctx.input`.
- Assignments are checked where they happen, and the error names the file and line: undeclared fields, `NaN` and `Infinity` anywhere, including inside arrays (`list.push(NaN)`), sizes of 0 or less, unknown colors, characters the font lacks, values outside `oneOf`, and missing entities like `world.bal`.
- Declare `entities` with `satisfies Entities` and type helper functions with `World<typeof entities>`, so `check` catches typos before anything runs.
- Keep every value that changes during play on an entity. Variables at the top of `game.ts` survive from one run to the next when tests run the game repeatedly in one process.
- Reading an array field goes through the engine's checks, so in a loop over a big array, like a board of rows, read it into a local once per tick.

`ctx` gives `start` and `update` everything they may use:

- `ctx.tick` is 1 on the first update, and `ctx.dt` is always 1/60.
- `ctx.input.held(key)`, `ctx.input.pressed(key)` for the first tick a key is down, and `ctx.input.released(key)` for the first tick it's up. Keys are A-Z, 0-9, Space, Enter, Tab, Backspace, Shift, Ctrl, Alt, Up, Down, Left, and Right, and a misspelled name fails `check`.
- `ctx.random()` returns a seeded number from 0 up to 1.
- `ctx.print(...values)` adds `{ tick, text }` to `sim`'s `log`.

While `start` or `update` runs, `Math.random()`, `Date.now()`, `new Date()`, `performance.now()`, timers, and `async` functions are errors, because they would make runs differ. JavaScript engines also disagree in the last bit of functions like `Math.sin`, so during those calls `Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `cbrt`, and the hyperbolic functions are the engine's own portable versions, and `sim` and every browser agree exactly. `check` type-checks game files without browser or Node types, so `console` and `document` fail there with the fix in the message.

## view.ts

A game can add a `view.ts` for extras drawn with Three.js that the game logic never sees, like Pong's dashed net or Snake's grid:

```ts
import type { ViewFrame, ViewSetup } from 'fourjs'
import type game from './game.ts'

export function init({ THREE, scene, world, objects }: ViewSetup<typeof game>) {}
export function draw({ world, tick, objects }: ViewFrame<typeof game>) {}
```

- `world` is the game's world, typed and read-only. `objects` maps entity names to the meshes the default view draws, each with a `MeshBasicMaterial`.
- `init` runs once per page, before the first frame, when `objects` is full. Use it to build meshes, and read entities from `draw`'s `world`: an entity kept from `init` goes stale when a test calls `engine.reset()`.
- The default view resets each mesh's geometry, size, color, and visibility right before `draw`, so a change to one has to be made again every frame.
- `draw` must depend only on what it's given, not on earlier frames, so `shot` shows exactly what players see.
- `renderOrder` places a mesh among the entities: the entity declared Nth (counting group members) draws at `renderOrder` N, so a view mesh at 2.5 draws between the third and fourth, and faded entities keep their places too. To fade a view mesh in place, give its material `blending: THREE.CustomBlending`; `transparent: true` moves a mesh after everything.
- `check` type-checks `view.ts` with browser types, and an error thrown in it names `view.ts` and the frame.

## Testing

- `sim --ticks N` runs N updates and prints the entities. `--press KEY@T[,T...]` presses a key on those ticks, and presses on neighboring ticks join into one; `--hold KEY` holds it on every tick and `--hold KEY@SPANS` on spans like `30-90,120-`. Tick 1 is the first update, and `start` sees every key up.
- `--driver FILE` picks the keys with code instead of `--press` and `--hold`. The file's default export gets `{ world, tick, random }` before each tick, where `world` is read-only and `random` is a seeded stream of its own, and returns the keys held during that tick:

```ts
import type { Driver, EntitiesOf } from 'fourjs'
import type pong from './game.ts'

const follow: Driver<EntitiesOf<typeof pong>> = ({ world, tick }) =>
  tick === 1 ? ['Space'] : world.ball.y > world.left_paddle.y ? ['W'] : ['S']
export default follow
```

  A driver that has to remember something between ticks exports `defineDriver(() => { let waited = 0; return (frame) => keys })` instead; every run, including each `engine.reset()` in the page, gets a fresh copy.

- `--set NAME.FIELD=VALUE` changes a starting value, reading VALUE as JSON (like `[1,2]` or `true`) and otherwise as a string, and NAME can be a pattern: `--set paddle.w=1 --set 'bricks[*].points=5'`. It applies before `start` runs, so a field that `start` sets again, like a ball it serves, ends up with `start`'s value.
- `--seed N` picks the random numbers. `--only a,b_*` chooses entities (`*` matches anything, and a group name matches its members), `--fields x,y` chooses fields, and `--every N` also prints every N ticks.
- `shot --at T[,T...]` renders the page players see, in headless Chrome with software rendering, at those ticks of one run, and ignores keys scheduled after the last one, so the key flags from a `sim` run work unchanged. Several ticks turn `frame.png` into `frame-001.png`, `frame-120.png`, and so on, and the folder is created if needed. Each call starts Chrome, which takes about 2.5 s, so ask for several ticks at once.
- The page runs the same engine code as `sim`, so for the same inputs or driver they reach exactly the same state; a test checks it.

Tests use the library, as in `games/*/game.test.ts`:

- `simulate(game, { ticks, press, hold, drive, set, seed, every })` returns `{ snapshots, logs, world }`: `world` is the final state, typed and read-only, and `pick(entities, 'ball,cells')` filters a snapshot's entities.
- Build a variant of a game by spreading it: `simulate({ ...game, entities: { ...game.entities, ball: { ...game.entities.ball, vx: 3 } } }, { ticks: 60 })`. A grid's cells are in `game.entities.bricks.rows` and a group's in `.members`, so `grid(1, 1, () => game.entities.bricks.rows[7][2])` keeps one brick.
- Pass a bot as `drive`, or step a `Session` yourself: `const s = new Session(game, { seed: 0 }); s.start(); s.step(['Space'])`, then read `s.world` (typed and read-only) or `s.state()`.

## Known problems

- `Math.pow`, `Math.hypot`, and `**` come from the JavaScript engine; engines agree on them today, but nothing guarantees it.
- Nothing stops an endless loop, so a stuck `update` hangs `sim`.
- Command-line mistakes exit 1 like other failures, because incur sets the exit codes.

## Not in FourJS yet

`four new`, a web export, games outside this repo, adding or removing entities during a run, sound, mouse input, and images.

## Working on FourJS

- `src/types.ts`, `entities.ts`, `engine.ts`, `input.ts`, `random.ts`, `guard.ts`, `math.ts`, `font.ts`, `colors.ts`, `errors.ts`: the engine, shared by `sim` and the page.
- `src/browser/client.ts` and `src/browser/view.ts`: the page's loop, keyboard, and `window.engine`, and the default Three.js view.
- `src/cli.ts`: the incur command definitions. The CLI, the MCP tools, the generated skills, and `--llms` all come from these, so descriptions and examples change here.
- `src/load.ts`: loading games and drivers fresh, the type checks, and turning errors into `path:line`. `src/serve.ts` and `src/shot.ts`: bundling, the local server, the Chrome window, and headless frames.
- `games/`: the example games and their tests. `test/`: engine, CLI, MCP, and page-versus-sim tests.
- `skills/fourjs/SKILL.md`: the agent skill published from this repo.

```bash
npm test        # every test, including the games'; the page tests need Chrome
npx tsc -p .    # typecheck
npx four check games/pong
```

Rules:

- `npm test` and `npx tsc -p .` stay clean, and every game in `games/` passes `check`.
- `sim` and the page reach the same state for the same files, flags, and seed.
- Failures print a code and a one-line message and exit 1; problems in game files start with `path:line:`.
- `check` and `sim` never open a browser. The engine has no game-specific code.
- Follow the TypeScript rules in the repo's style: model variants as discriminated unions, parse `unknown` input at the boundary, avoid `as` casts except right after validation, and make switches exhaustive with `never`.
- A change agents can see goes into this file in the same change, and into the skill if it changes the skill's steps.
- Comments are single lines and only say what the code can't. No emojis. Each test covers something no other test does.
- Don't leave a `run` window open: start `run --serve-only` in the background, check it, and stop it.
