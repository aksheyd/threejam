# Game engine

A simple Rust game engine. A game is a folder with a `scene.toml` and Lua scripts, and the `game-engine` command checks, simulates, screenshots, and runs it.

```bash
cargo install --path .
game-engine run games/demo
game-engine run games/pong
game-engine new my-game
```

`game-engine new` puts an `AGENTS.md` in each new game that explains the scene format, the script API, and the commands, for people and coding agents.
