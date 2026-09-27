---
name: game-engine
description: Builds, tests, and screenshots 2D games with the game-engine CLI, where a game is a folder with a scene.toml and Lua scripts. Use when the user asks to make, change, test, or debug a game with game-engine, or when a folder has a scene.toml next to a scripts/ folder of .lua files.
license: MIT
compatibility: Needs the game-engine CLI (cargo install --git https://github.com/aksheyd/Game-Engine), which builds with Rust 1.88+ and a C compiler. check and sim run anywhere; shot and run need OpenGL 3.3 and a display.
---

# Making games with game-engine

A game is a folder. `scene.toml` lists the entities and their components, and `scripts/*.lua` makes them move. The `game-engine` command checks, simulates, screenshots, and runs that folder. You build a game by editing files and checking your work with the command, not by driving a window.

## Setup

1. Check for the CLI with `game-engine help`. If it's missing, install it:

   ```bash
   cargo install --git https://github.com/aksheyd/Game-Engine
   ```

2. Start a game with `game-engine new <dir>`, then read `<dir>/AGENTS.md` in full before writing code. It's the complete manual for the installed version: the scene format, every script function, the testing flags, and the limits. If a game folder has no `AGENTS.md`, run `game-engine new /tmp/manual` and read `/tmp/manual/AGENTS.md`.

## Working loop

Run these from the game folder, where `.` is the game and paths like `tests/bot.lua` resolve.

1. Edit `scene.toml` and the files in `scripts/`.
2. Run `game-engine check .` until it prints `ok`. `check` only loads files, so also run `game-engine sim . --ticks 1` to catch errors in `start` and `update`.
3. Prove each behavior with numbers from `game-engine sim . --ticks N`:
   - `--press Space@60` presses a key on one tick, and `--hold Left@30-90` holds it on a range of ticks.
   - `--driver tests/bot.lua` picks keys each tick in Lua, for input that has to react to the game.
   - `--set ball.x=1.5` or `--scene tests/setup.toml` changes the starting state for one run.
   - `--every 10 --only ball,paddle` prints those entities every 10 ticks. `print(...)` in a script writes `[tick N] ...` to stderr.
4. Look at it: `game-engine shot . --at 1,120,600 -o frame.png` saves one PNG per tick from a single run. Open the PNGs.
5. Ask a person to play it with `game-engine run .`. Numbers and single frames can't show whether motion feels right. They can leave it open while you edit and press Cmd+R (or F5) to play your latest files. Don't leave a `run` window open yourself.

## Facts to plan with

- The 800x600 window shows x from -2 to 2 and y from -1.5 to 1.5, with (0, 0) at the center. An entity's `x, y` is its center and `w, h` its size.
- Components in `scene.toml`: `transform` (position and scale), `mesh` (square or triangle, with a color), `text` (a 5x7 pixel font), and `script` (a Lua file, plus values that become fields on the entity).
- A script defines `start(self)`, which runs once, and `update(self, dt)`, which runs 60 times a second with `dt = 1/60`. It can call `get(name)`, `find_all(prefix)`, `input.held(key)`, `input.pressed(key)`, `input.released(key)`, `print(...)`, and `require("util")` for `scripts/util.lua`.
- Runs are deterministic: the same files, flags, and `--seed` give the same output, so `sim` results can be compared exactly.
- Not supported yet: images, sound, mouse input, rotation, and adding or removing entities while a game runs. Keep a pool of entities parked off screen and move them in when needed.

## Conventions

- Wait for the player's first key press before the action starts, and offer a restart after a win or game over. If Space both plays and restarts, ignore it for about a second after the game ends.
- Keep test drivers and test scenes in `tests/`, never in `scripts/`, and leave nothing test-only active in the finished game.
