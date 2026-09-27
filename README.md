# Game engine

A simple Rust game engine. A game is a folder with a `scene.toml` and Lua scripts, and the `game-engine` command checks, simulates, screenshots, and runs it.

## Install and run

```bash
cargo install --path .
game-engine run games/pong
```

To install without cloning, use `cargo install --git https://github.com/aksheyd/Game-Engine`.

Building needs Rust 1.88 or later. `cargo install` puts `game-engine` in `~/.cargo/bin`. To run it without installing, use `cargo run --` from this folder, like `cargo run -- run games/pong`. `run` and `shot` need OpenGL 3.3 (`shot` draws in a hidden window); `check` and `sim` never open a window.

## Commands

```bash
game-engine new my-game                # create a game from the starter template
game-engine check my-game              # report errors in scene.toml and scripts
game-engine sim my-game --ticks 60     # run 60 ticks with no window, then print every entity
game-engine shot my-game --ticks 60    # the same run, then save the frame as shot.png in the current folder
game-engine run my-game                # play in a window; Esc quits, Cmd+R or F5 restarts
```

Options (`game-engine help` lists them all):

- `sim` and `shot`: `--ticks N`; `--hold KEY` or `--hold KEY@30-90` to hold a key, `--press KEY@60,75` to press one, or `--driver FILE` to pick keys with Lua.
- `sim`: `--only NAMES`, `--every N`, and `--no-dump` choose which entities and ticks to print.
- `shot`: `-o FILE` names the PNG, and `--at 30,60,90` saves several ticks of one run.
- `sim`, `shot`, and `run`: `--seed N` seeds `math.random`, and `--set NAME.FIELD=VALUE` changes one `scene.toml` value.
- `check`, `sim`, `shot`, and `run`: `--scene FILE` reads another scene file.

Every game made with `game-engine new` gets an `AGENTS.md`, a copy of [`games/demo/AGENTS.md`](games/demo/AGENTS.md). It's the manual for people and coding agents: the scene format, the script API, testing, and what isn't supported yet.

## For coding agents

Install the `game-engine` skill to teach an agent the working loop. It points the agent at the manual above.

```bash
npx skills add aksheyd/Game-Engine
gh skill install aksheyd/Game-Engine game-engine
```

Agents changing the engine itself should read [`AGENTS.md`](AGENTS.md).

## FourJS (prototype)

[`fourjs/`](fourjs/) is a prototype of where this engine is heading: the same idea on Three.js, with games written in TypeScript and one set of commands that works as a CLI, as MCP tools, and as generated agent skills. It plays in the browser and needs no OpenGL. Its manual is [`fourjs/AGENTS.md`](fourjs/AGENTS.md).

```bash
cd fourjs && npm install
npx four run games/pong
```

## Games

Play any of these with `game-engine run games/<name>`. Esc quits, and Cmd+R (on a Mac) or F5 starts over.

- **demo**: W, A, S, and D move the green square.
- **pong**: two players. W and S move the left paddle, and Up and Down move the right one. Space starts a match, and the first to 7 points wins; press Space to play again.
- **breakout**: Left and Right (or A and D) move the paddle, and Space serves the ball. Clear every brick to win; you have three lives. After a win or game over, Space starts a new game.
- **snake**: an arrow key starts the snake, and the arrow keys turn it. Eat apples to grow, and don't run into a wall or yourself; after a game over or a win, press Space to play again.
- **flappy**: Space starts a run, and each press flaps. Fly through the gaps between the pipes; after a crash, press Space once PRESS SPACE appears to get ready again.
- **invaders**: press Space to start the invasion; then Left and Right move the cannon, and Space fires (hold it to keep firing). Shoot every invader before they reach the bottom; you have three lives. After a win or game over, press Space to play again.
- **tetris**: Space starts the game. Left and Right move the falling piece, Up rotates it, and Down drops it faster. Full rows clear, and the game ends when a new piece has no room; press Space to play again.
