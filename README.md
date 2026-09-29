<div align="center">

# ThreeJam

*A game engine on Three.js for coding agents*

[![npm](https://img.shields.io/npm/v/threejam?style=flat-square)](https://www.npmjs.com/package/threejam)
[![Node.js 22.18 or later](https://img.shields.io/badge/Node.js-%3E%3D22.18-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Three.js](https://img.shields.io/badge/Three.js-black?style=flat-square&logo=threedotjs&logoColor=white)](https://threejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[Features](#features) • [Quick start](#quick-start) • [Docs](docs/README.md)

<a href="games/asteroids"><img src="docs/images/asteroids.png" alt="Asteroids, played with the mouse by its autopilot driver" width="24%"></a>
<a href="games/invaders"><img src="docs/images/invaders.png" alt="Space Invaders, played by its autopilot driver" width="24%"></a>
<a href="games/flappy"><img src="docs/images/flappy.png" alt="Flappy flying through the first gap" width="24%"></a>
<a href="games/tetris"><img src="docs/images/tetris.png" alt="Tetris just before a row clears" width="24%"></a>

</div>

ThreeJam is a 2D game engine on [Three.js](https://threejs.org) made for coding agents. A game is a folder with a `game.ts`: plain data for the entities and an `update` function. The engine owns the loop, time, input, and random numbers, so the same files, flags, and seed always give the same run, and an agent can prove what a game does from exact numbers and frames instead of watching it. One set of command definitions gives you a CLI, MCP tools, agent skills, and an LLM manifest.

> [!NOTE]
> ThreeJam is a prototype. Entities can't be added during a run, though a group works as a pool of them; see the [full list](AGENTS.md#not-in-threejam-yet) of what's missing.

## Features

- **Games are plain TypeScript.** `game.ts` declares entities as data and changes them in `update(world, ctx)`, with typed lists, optional values, entities made of parts that move and turn together, and groups that work as pools with `spawn`. An optional `view.ts` adds decoration with raw Three.js that the game logic never sees.
- **Images, sound, and the mouse.** Shapes turn and can show PNG, JPEG, WebP, GIF, or SVG files, games play built-in synthesized sounds or their own sound files, and the mouse buttons work like keys next to a pointer in world units.
- **Runs repeat exactly.** The engine owns the clock, input, and seeded random numbers, and swaps `Math.sin` and similar functions for portable versions, so `sim` and the page in the browser reach exactly the same state and play the same sounds.
- **Tests without a window.** `sim` runs exact ticks with scripted keys, mouse, and pointer or a bot, and prints the state and the sounds played, and `simulate()` does the same inside a test.
- **Frames on demand.** `shot` renders the page players see in headless Chrome, at the ticks you pick.
- **One file to share.** `export` writes a game as a single HTML file, images and sounds included, that plays offline.
- **Mistakes point at the line.** `check` type-checks the game and runs its first tick, and bad assignments, like an undeclared field, `NaN`, an unknown color, an image the folder lacks, or an item that doesn't fit its list, fail where they happen with the file, line, and tick.
- **One definition, every interface.** The CLI, the MCP tools, the generated skills, and `--llms` all come from [`src/cli.ts`](src/cli.ts), built with [incur](https://github.com/wevm/incur).

## Quick start

Install ThreeJam in your project, and give your coding agent the skill that teaches it to build and test games with it:

```bash
npm install -D threejam
npx skills add aksheyd/threejam
```

Then ask your agent for a game. Starting from an empty folder instead? `npx threejam new my-game` writes a project of its own; see [getting started](docs/getting-started.md).

## Docs

- [Getting started](docs/getting-started.md): what you need, and starting a game yourself
- [Making a game](docs/making-a-game.md): the game of catch `new` writes, from checking it to sharing it as one HTML file
- [Commands](docs/commands.md): every command and flag
- [For coding agents](docs/agents.md): the skill, the MCP tools, and the other forms the commands take
- [Example games](docs/examples.md): Pong, Breakout, Snake, Flappy, Invaders, Tetris, and Asteroids
- [`AGENTS.md`](AGENTS.md): the full manual, including the known problems and how to work on ThreeJam itself
