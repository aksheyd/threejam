# FourJS

A game engine on Three.js for coding agents. A game is a `game.ts` of plain entity data and an `update` function. The engine owns the loop, time, input, and random numbers, so a run with the same files, flags, and seed always repeats exactly, and an agent can prove what a game does without watching it. One set of command definitions gives you a CLI, MCP tools, and agent skills.

## Try it

```bash
git clone https://github.com/aksheyd/fourjs
cd fourjs
npm install
npx four run games/pong
```

FourJS needs Node 22.18 or later, and `shot` and `run` need Chrome or Chromium. It's a prototype: games live in this repo's `games/` folder, and it isn't on npm yet.

## Commands

```bash
npx four check games/pong                                        # types, entities, start, and the first tick
npx four sim games/pong --ticks 120 --press Space@1 --only ball  # run with no window and print the state
npx four shot games/pong --at 1,120,600 -o frame.png             # PNGs at exact ticks, drawn like the real page
npx four run games/pong                                          # play in a browser window; Esc quits, saving reloads
```

## For coding agents

- The manual is [`AGENTS.md`](AGENTS.md): how games are written and tested, and the known problems.
- `npx four --mcp` serves `check`, `sim`, and `shot` as MCP tools, and `npx four mcp add` registers them with your agent.
- `npx four skills add` generates a skill for each command, and `npx four --llms` prints a manifest.
- The FourJS skill teaches the working loop:

```bash
npx skills add aksheyd/fourjs
gh skill install aksheyd/fourjs fourjs
```

## Games

Play any of these with `npx four run games/<name>`. Esc quits.

- **pong**: two players. W and S move the left paddle, and Up and Down move the right one. Space starts a match, and the first to 7 wins.
- **breakout**: Left and Right (or A and D) move the paddle, and Space serves. Clear every brick to win; you have three lives.
- **snake**: an arrow key starts the snake, and the arrow keys turn it. Eat apples to grow; a wall or your own body ends the game, and Space plays again.
- **flappy**: Space starts a run, and each press flaps. Fly through the gaps; after a crash, press Space once PRESS SPACE appears.
- **invaders**: Space starts the invasion. Left and Right move the cannon, and Space fires; hold it to keep firing.
- **tetris**: Space starts. Left and Right move the falling piece, Up rotates it, and Down drops it faster. Full rows clear, and after a game over Space plays again.

## License

[MIT](LICENSE)
