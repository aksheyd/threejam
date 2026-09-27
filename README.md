<div align="center">

# FourJS

*A game engine on Three.js for coding agents*

[![Node.js 22.18 or later](https://img.shields.io/badge/Node.js-%3E%3D22.18-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Three.js](https://img.shields.io/badge/Three.js-black?style=flat-square&logo=threedotjs&logoColor=white)](https://threejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[Features](#features) • [Getting started](#getting-started) • [Make a game](#make-a-game) • [Commands](#commands) • [For coding agents](#for-coding-agents) • [Example games](#example-games)

<a href="games/invaders"><img src="docs/images/invaders.png" alt="Space Invaders, played by its autopilot driver" width="32%"></a>
<a href="games/flappy"><img src="docs/images/flappy.png" alt="Flappy flying through the first gap" width="32%"></a>
<a href="games/tetris"><img src="docs/images/tetris.png" alt="Tetris just before a row clears" width="32%"></a>

</div>

FourJS is a 2D game engine on [Three.js](https://threejs.org) made for coding agents. A game is a folder with a `game.ts`: plain data for the entities and an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run, and an agent can prove what a game does from exact numbers and frames instead of watching it. One set of command definitions gives you a CLI, MCP tools, agent skills, and an LLM manifest.

> [!NOTE]
> FourJS is a prototype and isn't on npm yet: clone this repo and keep your games in its `games/` folder, where `import 'fourjs'` resolves. It has no sound, mouse input, or images yet, and entities can't be added during a run; see the [full list](AGENTS.md#not-in-fourjs-yet).

## Features

- **Games are plain TypeScript.** `game.ts` declares entities as data and changes them in `update(world, ctx)`. An optional `view.ts` adds decoration with raw Three.js that the game logic never sees.
- **Runs repeat exactly.** The engine owns the clock, input, and seeded random numbers, and swaps `Math.sin` and similar functions for portable versions, so `sim` and the page in the browser reach exactly the same state.
- **Tests without a window.** `sim` runs exact ticks with scripted keys or a bot and prints the state, and `simulate()` does the same inside a test.
- **Frames on demand.** `shot` renders the page players see in headless Chrome, at the ticks you pick.
- **Mistakes point at the line.** `check` type-checks the game and runs its first tick, and bad assignments, like an undeclared field, `NaN`, or an unknown color, fail where they happen with the file, line, and tick.
- **One definition, every interface.** The CLI, the MCP tools, the generated skills, and `--llms` all come from [`src/cli.ts`](src/cli.ts), built with [incur](https://github.com/wevm/incur).

## Getting started

You need:

- [Node.js](https://nodejs.org) 22.18 or later
- [Git](https://git-scm.com)
- Chrome or Chromium for `shot` (set `CHROME_PATH` if yours isn't found); `run` uses it for a plain window, or your default browser without it

```bash
git clone https://github.com/aksheyd/fourjs
cd fourjs
npm install
npx four run games/pong
```

`run` opens Pong in a window: W and S move the left paddle, Up and Down move the right one, and Space starts a match. Esc quits, and saving a game file replays it with the same seed.

> [!IMPORTANT]
> Run `npx four` from inside your clone. Anywhere else, npx looks up `four` on the npm registry, which is an unrelated package.

## Make a game

A game is a folder in `games/` with a `game.ts`. Save this as `games/catch/game.ts`:

```ts
import { defineGame, type Entities } from 'fourjs'

const entities = {
  paddle: { x: 0, y: -1.3, w: 0.6, h: 0.08, color: 'deepskyblue', speed: 3 },
  ball: { x: 0, y: 1.2, w: 0.12, h: 0.12, shape: 'circle', color: 'orange', vy: -1.5 },
  score: { x: 0, y: 1.35, text: '0', points: 0 },
} satisfies Entities

export default defineGame({
  title: 'Catch',
  entities,
  update({ paddle, ball, score }, ctx) {
    if (ctx.input.held('Left')) paddle.x -= paddle.speed * ctx.dt
    if (ctx.input.held('Right')) paddle.x += paddle.speed * ctx.dt
    ball.y += ball.vy * ctx.dt
    const caught = Math.abs(ball.y - paddle.y) < 0.1 && Math.abs(ball.x - paddle.x) < paddle.w / 2
    if (!caught && ball.y > -1.5) return
    if (caught) score.points += 1
    score.text = String(score.points)
    ctx.print(caught ? 'caught' : 'missed')
    ball.x = ctx.random() * 3.6 - 1.8
    ball.y = 1.2
  },
})
```

The screen spans x from -2 to 2 and y from -1.5 to 1.5, an entity's `x, y` is its center, and `ctx.dt` is always 1/60 of a second.

Check it, then prove what it does. With the default seed, the second ball falls at x 1.61, where a paddle that stays put misses it at tick 206; holding Right for half a second catches it:

```console
$ npx four check games/catch
ok: true
entities: 3

$ npx four sim games/catch --ticks 300 --hold Right@100-130 --filter-output log
log[2]{tick,text}:
  97,caught
  194,caught
cta:
  description: "Suggested command:"
  commands[1]{command,description}:
    four shot games/catch --at 300 --hold Right@100-130,See this tick as a PNG
```

Then look at it and play it. This `shot` writes `frames/catch-001.png` and `frames/catch-150.png` from one run:

```bash
npx four shot games/catch --at 1,150 --hold Right@100-130 -o frames/catch.png
npx four run games/catch
```

To keep the behavior pinned, save a test as `games/catch/game.test.ts`, and `npm test` runs it with the rest:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { simulate } from 'fourjs'
import game from './game.ts'

test('holding Right reaches the second ball, which a still paddle misses', () => {
  const still = simulate(game, { ticks: 300 })
  const moved = simulate(game, { ticks: 300, hold: ['Right@100-130'] })
  assert.deepEqual(still.logs.at(-1), { tick: 206, text: 'missed' })
  assert.deepEqual(moved.logs.at(-1), { tick: 194, text: 'caught' })
  assert.equal(moved.world.score.text, '2')
})
```

[`AGENTS.md`](AGENTS.md) covers the rest: groups and grids, `oneOf`, text, `view.ts`, drivers, and every rule the engine checks.

## Commands

| Command | What it does |
| --- | --- |
| `npx four check <dir>` | Type-checks `game.ts` and `view.ts`, then runs `start` and the first tick |
| `npx four sim <dir> --ticks N` | Runs N ticks, 60 to a second, without a window and prints the entities |
| `npx four shot <dir> --at T,T,...` | Saves an 800x600 PNG at each tick, drawn by the same page players see |
| `npx four run <dir>` | Opens the game in a window for a person to play; Esc quits |

`sim` and `shot` share their input flags, and every `sim` run suggests the matching `shot` command:

- `--press KEY@T[,T...]` presses a key on those ticks, and `--hold KEY[@SPANS]` holds one on every tick or on spans like `30-90,120-`.
- `--driver FILE` picks the keys each tick with code that reads the world, like the Invaders [autopilot](games/invaders/autopilot.ts).
- `--set NAME.FIELD=VALUE` changes a starting value before `start` runs, like `--set paddle.w=1` for a wider Breakout paddle, and NAME can be a pattern such as `bricks[*]`.
- `--seed N` picks the random numbers; the default is 0.

`sim` also takes `--only` and `--fields` to choose what it prints, and `--every N` to print every N ticks. Output is [TOON](https://toonformat.dev) by default, `--format json` switches it, and every command takes `--help` and `--schema`. A failure prints a `code` and a one-line `message` and exits 1; for a problem in a game file, the message starts with `path:line:` and ends with when it happened, like `(in update at tick 61)`.

## For coding agents

FourJS is built for agents that can't watch a screen: they edit files, run `check`, prove behavior with `sim`, look at frames from `shot`, and hand `run` to a person. Point yours at [`AGENTS.md`](AGENTS.md), the full manual, and give it the commands in whatever form it takes:

```bash
npx four --mcp        # serve check, sim, and shot as MCP tools over stdio
npx four mcp add      # register that server with your coding agents
npx four skills add   # install one generated skill per command
npx four --llms       # print a manifest of the commands
```

Each MCP call loads the game from disk, so edits show up without restarting the server. `run` is for people, so it isn't a tool.

The hand-written [FourJS skill](skills/fourjs/SKILL.md) teaches that loop step by step. Install it with the [skills CLI](https://github.com/vercel-labs/skills) or the [GitHub CLI](https://cli.github.com):

```bash
npx skills add aksheyd/fourjs
gh skill install aksheyd/fourjs fourjs
```

> [!NOTE]
> `npx four mcp add` registers the server as `node <your clone>/src/cli.ts --mcp`, so agents can start it from any folder. `--no-global` registers it for the clone only, and `--agent` picks one agent.

## Example games

| Game | How to play | Worth reading for |
| --- | --- | --- |
| [Pong](games/pong) | W and S move the left paddle, Up and Down the right. Space starts; first to 7 wins. | The smallest game; `view.ts` draws the net |
| [Breakout](games/breakout) | Left and Right (or A and D) move the paddle, and Space serves. Three lives to clear every brick. | A `grid` of bricks, and tests that play single-brick variants |
| [Snake](games/snake) | An arrow key starts the snake, and the arrow keys turn it. Space plays again after a crash. | A `group` of hidden segments, since entities can't be added during a run |
| [Flappy](games/flappy) | Space starts a run, and each press flaps through the gaps. | A `view.ts` that paints the skyline, pipes, ground, and bird over plain boxes |
| [Invaders](games/invaders) | Space starts; Left and Right move the cannon, and Space fires (hold it to keep firing). | Pixel-art sprites, and an [autopilot](games/invaders/autopilot.ts) driver |
| [Tetris](games/tetris) | Space starts; Left and Right move the piece, Up rotates it, and Down drops it faster. | A [driver](games/tetris/plan.ts) that plays seed 0's first seven pieces into two cleared rows |

Play any of them with `npx four run games/<name>`. The frames at the top of this page come from `shot`, two of them played by those drivers:

```bash
npx four shot games/invaders --driver games/invaders/autopilot.ts --at 1075 -o docs/images/invaders.png
npx four shot games/flappy --press Space@1,35,69,103,137,171 --at 200 -o docs/images/flappy.png
npx four shot games/tetris --driver games/tetris/plan.ts --at 285 -o docs/images/tetris.png
```

## Learn more

- [`AGENTS.md`](AGENTS.md): the full manual, including the [known problems](AGENTS.md#known-problems) and how to [work on FourJS](AGENTS.md#working-on-fourjs) itself
- [`skills/fourjs/SKILL.md`](skills/fourjs/SKILL.md): the agent skill
- [Three.js](https://threejs.org), which draws the games
- [incur](https://github.com/wevm/incur), which turns the command definitions into the CLI, the MCP tools, and the skills
- [TOON](https://toonformat.dev), the default output format
- [Model Context Protocol](https://modelcontextprotocol.io) and [Agent Skills](https://agentskills.io)
