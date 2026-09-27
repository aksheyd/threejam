# AGENTS.md

This repo is `game-engine`: a Rust engine and CLI for 2D games made of a `scene.toml` and Lua scripts, plus the example games in `games/`.

- Building or changing a game? Follow [`games/demo/AGENTS.md`](games/demo/AGENTS.md), the game manual. `game-engine new` copies it into every new game.
- Changing the engine? Read on.

## Layout

- `src/main.rs`: the CLI, from argument parsing to exit codes.
- `src/game.rs`: parses and validates `scene.toml`.
- `src/world.rs` and `src/prelude.lua`: the Lua runtime, including entities, ticks, field validation, and drivers.
- `src/input.rs`, `src/font.rs`, `src/lint.rs`: key state and press edges, the text font, and the key-name check.
- `src/render.rs`, `src/window.rs`, `src/camera.rs`, `src/mesh.rs`, `src/shader.rs`: OpenGL drawing, the `run` window, and offscreen screenshots.
- `src/template.rs`: `new`, which copies `games/demo`.
- `tests/cli.rs` runs the built binary. `tests/shot.rs` holds the GPU tests, which are ignored by default.
- `games/`: the example games. Each keeps its test drivers and test scenes in `tests/`.
- `skills/game-engine/SKILL.md`: the agent skill published from this repo.
- `fourjs/`: FourJS, a TypeScript prototype of the engine on Three.js with an incur CLI and MCP server. It has its own manual and commands in [`fourjs/AGENTS.md`](fourjs/AGENTS.md); `npm test` and `npx tsc -p .` there stay clean.

## Commands

```bash
cargo build
cargo test                       # unit and CLI tests
cargo test -- --ignored          # GPU tests; need a display
cargo clippy --all-targets
cargo fmt
cargo run -- check games/pong    # any CLI command against a game
```

## Rules

- `cargo build`, `cargo test`, and `cargo clippy` stay free of warnings, and `cargo fmt` leaves nothing to change.
- `sim` and `shot` print the same output for the same files, flags, and seed.
- Errors read `path:line: message` on stderr and exit 1. Command-line mistakes exit 2.
- `check` and `sim` never open a window or touch OpenGL.
- The engine has no game-specific code, and every game in `games/` passes `check` with no warnings.
- A change agents can see goes into `games/demo/AGENTS.md` in the same change, and into the skill if it changes the skill's steps.
- Comments are single lines and only say what the code can't. No emojis. Each test covers something no other test does.
- Don't leave a `run` window open: start it in the background, check it, and kill it.
