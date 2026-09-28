<div align="center">

# FourJS

*A game engine on Three.js for coding agents*

[![npm](https://img.shields.io/npm/v/@aksheyd/fourjs?style=flat-square)](https://www.npmjs.com/package/@aksheyd/fourjs)
[![Node.js 22.18 or later](https://img.shields.io/badge/Node.js-%3E%3D22.18-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Three.js](https://img.shields.io/badge/Three.js-black?style=flat-square&logo=threedotjs&logoColor=white)](https://threejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[Features](#features) • [Getting started](#getting-started) • [Make a game](#make-a-game) • [Commands](#commands) • [For coding agents](#for-coding-agents) • [Example games](#example-games)

<a href="games/asteroids"><img src="docs/images/asteroids.png" alt="Asteroids, played with the mouse by its autopilot driver" width="24%"></a>
<a href="games/invaders"><img src="docs/images/invaders.png" alt="Space Invaders, played by its autopilot driver" width="24%"></a>
<a href="games/flappy"><img src="docs/images/flappy.png" alt="Flappy flying through the first gap" width="24%"></a>
<a href="games/tetris"><img src="docs/images/tetris.png" alt="Tetris just before a row clears" width="24%"></a>

</div>

FourJS is a 2D game engine on [Three.js](https://threejs.org) made for coding agents. A game is a folder with a `game.ts`: plain data for the entities and an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run, and an agent can prove what a game does from exact numbers and frames instead of watching it. One set of command definitions gives you a CLI, MCP tools, agent skills, and an LLM manifest.

> [!NOTE]
> FourJS is a prototype. Entities can't be added during a run, though a group works as a pool of them; see the [full list](AGENTS.md#not-in-fourjs-yet) of what's missing.

## Features

- **Games are plain TypeScript.** `game.ts` declares entities as data and changes them in `update(world, ctx)`, with typed lists, optional values, entities made of parts that move and turn together, and groups that work as pools with `spawn`. An optional `view.ts` adds decoration with raw Three.js that the game logic never sees.
- **Images, sound, and the mouse.** Shapes turn and can show PNG, JPEG, WebP, GIF, or SVG files, games play built-in synthesized sounds or their own sound files, and the mouse buttons work like keys next to a pointer in world units.
- **Runs repeat exactly.** The engine owns the clock, input, and seeded random numbers, and swaps `Math.sin` and similar functions for portable versions, so `sim` and the page in the browser reach exactly the same state and play the same sounds.
- **Tests without a window.** `sim` runs exact ticks with scripted keys, mouse, and pointer or a bot, and prints the state and the sounds played, and `simulate()` does the same inside a test.
- **Frames on demand.** `shot` renders the page players see in headless Chrome, at the ticks you pick.
- **One file to share.** `export` writes a game as a single HTML file, images and sounds included, that plays offline.
- **Mistakes point at the line.** `check` type-checks the game and runs its first tick, and bad assignments, like an undeclared field, `NaN`, an unknown color, an image the folder lacks, or an item that doesn't fit its list, fail where they happen with the file, line, and tick.
- **One definition, every interface.** The CLI, the MCP tools, the generated skills, and `--llms` all come from [`src/cli.ts`](src/cli.ts), built with [incur](https://github.com/wevm/incur).

## Getting started

You need:

- macOS, Linux, or Windows
- [Node.js](https://nodejs.org) 22.18 or later
- Chrome or Chromium for `shot`, or Edge on Windows (set `CHROME_PATH` if yours isn't found); `run` uses it for a plain window, or your default browser without it

Start a game in a folder of its own:

```bash
npx @aksheyd/fourjs new my-game
cd my-game
npm install
npx fourjs run .
```

`new` writes a small game of catch and its test, plus a `package.json` and a `tsconfig.json`, and `npm install` adds FourJS to the folder. `run` opens the game in a window: Left and Right move the paddle, Space starts, and the third miss ends the game. Esc quits, and saving a game file replays it with the same seed.

To add FourJS to a project you already have, install it there and start a game in a folder of the project, where `new` writes just the game:

```bash
npm install -D @aksheyd/fourjs
npx fourjs new games/catch
```

> [!IMPORTANT]
> `npx fourjs` runs the copy of FourJS installed in the project. Anywhere else, use `npx @aksheyd/fourjs`, since `npx fourjs` would ask npm for a different package.

The example games are in this repo. To play them, clone it:

```bash
git clone https://github.com/aksheyd/fourjs
cd fourjs
npm install
npx fourjs run games/pong
```

## Make a game

A game is a folder with a `game.ts`, and `fourjs new` writes one you can play and change right away. Its entities are plain data, and `update` changes them 60 times a second. Here's the heart of the game of catch that `npx fourjs new games/catch` writes:

```ts
const entities = {
  paddle: { x: 0, y: -1.3, w: 0.6, h: 0.08, color: 'deepskyblue', speed: 3 },
  ball: { x: 0, y: 1.2, w: 0.12, h: 0.12, shape: 'circle', color: 'orange', visible: false, speed: 1.5 },
  score: { x: -1.9, y: 1.38, text: 'SCORE 0', align: 'left' },
  missed: { x: 1.9, y: 1.38, text: 'MISSES 0', align: 'right' },
  message: { x: 0, y: 0.2, text: 'PRESS SPACE TO START' },
  game: { state: oneOf(['ready', 'play', 'over']), points: 0, misses: 0, most_misses: 3 },
} satisfies Entities

function play(world: Catch, ctx: Context): void {
  const { paddle, ball, game, message } = world
  const move = (ctx.input.held('Right') || ctx.input.held('D') ? 1 : 0) - (ctx.input.held('Left') || ctx.input.held('A') ? 1 : 0)
  const edge = 2 - paddle.w / 2
  paddle.x = Math.max(-edge, Math.min(edge, paddle.x + move * paddle.speed * ctx.dt))
  ball.y -= ball.speed * ctx.dt
  const caught = Math.abs(ball.y - paddle.y) < (ball.h + paddle.h) / 2 && Math.abs(ball.x - paddle.x) < (ball.w + paddle.w) / 2
  if (caught) {
    game.points += 1
    ctx.print(`caught, score ${game.points}`)
    ctx.play('coin')
    drop(ball, ctx)
  } else if (ball.y < -1.5) {
    game.misses += 1
    ctx.print(`missed, ${game.misses} of ${game.most_misses}`)
    if (game.misses < game.most_misses) {
      ctx.play('hit')
      drop(ball, ctx)
      return
    }
    game.state = 'over'
    ball.visible = false
    message.text = 'GAME OVER - PRESS SPACE'
    message.visible = true
    ctx.play('lose')
  }
}
```

The screen spans x from -2 to 2 and y from -1.5 to 1.5, an entity's `x, y` is its center, and `ctx.dt` is always 1/60 of a second.

Check it, then prove what it does. With the default seed, the first ball falls at x 1.61, where a paddle that stays put misses it; holding Right from tick 2 to tick 40 catches it:

```console
$ npx fourjs check games/catch
ok: true
entities: 6

$ npx fourjs sim games/catch --ticks 120 --press Space@1 --hold Right@2-40 --filter-output log
log[1]{tick,text}:
  98,"caught, score 1"
cta:
  description: "Suggested command:"
  commands[1]{command,description}:
    fourjs shot games/catch --at 120 --press Space@1 --hold Right@2-40,See this tick as a PNG
```

Then look at it, play it, and share it. This `shot` writes `frames/catch-001.png` and `frames/catch-098.png` from one run, and `export` writes one HTML file, images and sounds included, that plays the game offline for anyone you send it to:

```bash
npx fourjs shot games/catch --at 1,98 --press Space@1 --hold Right@2-40 -o frames/catch.png
npx fourjs run games/catch
npx fourjs export games/catch -o catch.html
```

`new` also wrote `game.test.ts`, which pins what the game does, and `node --test` runs it, or `npm test` in a project `new` made:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { simulate } from '@aksheyd/fourjs'
import game from './game.ts'

test('holding Right catches the first ball with a sound, and a paddle that stays put misses it', () => {
  const still = simulate(game, { ticks: 110, press: ['Space@1'] })
  assert.deepEqual(still.logs, [{ tick: 110, text: 'missed, 1 of 3' }])
  const moved = simulate(game, { ticks: 110, press: ['Space@1'], hold: ['Right@2-40'] })
  assert.deepEqual(moved.logs, [{ tick: 98, text: 'caught, score 1' }])
  assert.deepEqual(moved.sounds, [{ tick: 98, name: 'coin', volume: 1, pitch: 1 }])
  assert.equal(moved.world.score.text, 'SCORE 1')
})
```

[`AGENTS.md`](AGENTS.md) covers the rest: groups, grids, and `spawn`, parts, `oneOf`, `listOf`, and `maybe`, text, turning, images, sounds, the mouse, `view.ts`, drivers, and every rule the engine checks. It ships in the package too, as `node_modules/@aksheyd/fourjs/AGENTS.md`.

## Commands

Run these in a project that has FourJS installed, or with `npx @aksheyd/fourjs` in place of `npx fourjs` anywhere else.

| Command | What it does |
| --- | --- |
| `npx fourjs new <dir>` | Writes a small playable game and its test into a new folder, plus a `package.json` and `tsconfig.json` outside a project |
| `npx fourjs check <dir>` | Type-checks `game.ts` and `view.ts`, checks that the images entities name are in the folder, then runs `start` and the first tick |
| `npx fourjs sim <dir> --ticks N` | Runs N ticks, 60 to a second, without a window and prints the entities |
| `npx fourjs shot <dir> --at T,T,...` | Saves an 800x600 PNG at each tick, drawn by the same page players see |
| `npx fourjs run <dir>` | Opens the game in a window for a person to play, with sound after the first key press or click; Esc quits |
| `npx fourjs export <dir> -o <file>.html` | Writes one HTML file that plays the game offline, with its images and sounds inside; `--seed N` fixes the seed, which is otherwise new each time the page loads |

`sim` and `shot` share their input flags, and every `sim` run suggests the matching `shot` command:

- `--press KEY@T[,T...]` presses a key on those ticks, and `--hold KEY[@SPANS]` holds one on every tick or on spans like `30-90,120-`; the mouse buttons are the keys `Mouse` and `MouseRight`.
- `--pointer X,Y@T` moves the mouse pointer to X,Y in world units on tick T, where it stays until the next move.
- `--driver FILE` picks the input each tick with code that reads the world, like the Invaders [autopilot](games/invaders/autopilot.ts), or the Asteroids [one](games/asteroids/autopilot.ts) that plays with the mouse.
- `--set NAME.FIELD=VALUE` changes a starting value before `start` runs, like `--set paddle.w=1` for a wider Breakout paddle, and NAME can be a pattern such as `bricks[*]`.
- `--seed N` picks the random numbers; the default is 0.

`sim` also takes `--until` to stop after the first tick a condition holds, like `--until 'match.state=over'` or `--until 'ball.x>1.9'`, `--only` and `--fields` to choose what it prints, and `--every N` to print every N ticks. Along with the entities it prints the game's log and the sounds it played, each with its tick. Output is [TOON](https://toonformat.dev) by default, `--format json` switches it, and every command takes `--help` and `--schema`. A failure prints a `code` and a one-line `message` and exits 1; for a problem in a game file, the message starts with `path:line:` and ends with when it happened, like `(in update at tick 61)`.

## For coding agents

FourJS is built for agents that can't watch a screen: they start a game with `new`, edit files, run `check`, prove behavior with `sim`, look at frames from `shot`, and hand `run` or an `export` to a person. Point yours at [`AGENTS.md`](AGENTS.md), the full manual, and give it the commands in whatever form it takes:

```bash
npx fourjs --mcp        # serve new, check, sim, shot, and export as MCP tools over stdio
npx fourjs mcp add      # register that server with your coding agents
npx fourjs skills add   # install one generated skill per command
npx fourjs --llms       # print a manifest of the commands
```

Each MCP call loads the game from disk, so edits show up without restarting the server. `run` is for people, so it isn't a tool.

The hand-written [FourJS skill](skills/fourjs/SKILL.md) teaches that loop step by step. Install it with the [skills CLI](https://github.com/vercel-labs/skills) or the [GitHub CLI](https://cli.github.com):

```bash
npx skills add aksheyd/fourjs
gh skill install aksheyd/fourjs fourjs
```

> [!NOTE]
> `npx fourjs mcp add` registers the server so agents can start it from any folder: as `node <path>/cli.js --mcp` for FourJS installed in a project or globally, `node <your clone>/src/cli.ts --mcp` for a clone, and `npx -y @aksheyd/fourjs@<version> --mcp` when FourJS ran through npx without installing or is installed on a path with a space. `--no-global` registers it for the current project only, and `--agent` picks one agent. On Windows, and for a clone on a path with a space, register it with add-mcp yourself, as the [known problems](AGENTS.md#known-problems) show.

## Example games

| Game | How to play | Worth reading for |
| --- | --- | --- |
| [Pong](games/pong) | W and S move the left paddle, Up and Down the right. Space starts; first to 7 wins. | The smallest game; `view.ts` draws the net |
| [Breakout](games/breakout) | Left and Right (or A and D) move the paddle, and Space serves. Three lives to clear every brick. | A `grid` of bricks, and tests that play single-brick variants |
| [Snake](games/snake) | An arrow key starts the snake, and the arrow keys turn it. Space plays again after a crash. | A `group` of hidden segments, since entities can't be added during a run |
| [Flappy](games/flappy) | Space starts a run, and each press flaps through the gaps. | Pipe pairs and a beak made of parts, and a `view.ts` that paints the skyline, pipes, ground, and bird over plain boxes |
| [Invaders](games/invaders) | Space starts; Left and Right move the cannon, and Space fires (hold it to keep firing). | Pixel-art sprites, and an [autopilot](games/invaders/autopilot.ts) driver |
| [Tetris](games/tetris) | Space starts; Left and Right move the piece, Up rotates it, and Down drops it faster. | A [driver](games/tetris/plan.ts) that plays seed 0's first seven pieces into two cleared rows |
| [Asteroids](games/asteroids) | Space or a click starts; Left and Right (or A and D) turn, Up (or W) thrusts, and Space fires. Or hold the mouse to aim at the pointer and fire, and the right button to thrust. | SVG rocks that spin and split, bullets and rocks pooled with `spawn`, a ship of turned parts, sounds, and a [driver](games/asteroids/autopilot.ts) that plays with the mouse |

In a clone of this repo, play any of them with `npx fourjs run games/<name>`. The frames at the top of this page come from `shot`, three of them played by those drivers:

```bash
npx fourjs shot games/asteroids --driver games/asteroids/autopilot.ts --at 420 -o docs/images/asteroids.png
npx fourjs shot games/invaders --driver games/invaders/autopilot.ts --at 1075 -o docs/images/invaders.png
npx fourjs shot games/flappy --press Space@1,35,69,103,137,171 --at 200 -o docs/images/flappy.png
npx fourjs shot games/tetris --driver games/tetris/plan.ts --at 285 -o docs/images/tetris.png
```

## Learn more

- [`AGENTS.md`](AGENTS.md): the full manual, including the [known problems](AGENTS.md#known-problems) and how to [work on FourJS](AGENTS.md#working-on-fourjs) itself
- [`skills/fourjs/SKILL.md`](skills/fourjs/SKILL.md): the agent skill
- [Three.js](https://threejs.org), which draws the games
- [incur](https://github.com/wevm/incur), which turns the command definitions into the CLI, the MCP tools, and the skills
- [TOON](https://toonformat.dev), the default output format
- [Model Context Protocol](https://modelcontextprotocol.io) and [Agent Skills](https://agentskills.io)
