# Getting started

You need:

- macOS, Linux, or Windows
- [Node.js](https://nodejs.org) 22.18 or later
- Chrome or Chromium for `shot`, or Edge on Windows (set `CHROME_PATH` if yours isn't found); `run` uses it for a plain window, or your default browser without it

## A game in a folder of its own

```bash
npx threejam new my-game
cd my-game
npm install
npx threejam run .
```

`new` writes a small game of catch and its test, plus a `package.json` and a `tsconfig.json`, and `npm install` adds ThreeJam to the folder. `run` opens the game in a window: Left and Right move the paddle, Space starts, and the third miss ends the game. Esc quits, and saving a game file replays it with the same seed, or says on the page why the save doesn't build.

## A game in a project you have

Install ThreeJam there and start a game in a folder of the project, where `new` writes just the game:

```bash
npm install -D threejam
npx threejam new games/catch
```

In a project that depends on ThreeJam, `npx threejam` runs the copy installed there. Anywhere else, it runs ThreeJam once without installing it, which is all a one-off command like `new` needs.

## The example games

Play the example games in your browser from the [gallery](https://aksheyd.github.io/threejam/), with a keyboard. They're in this repo, so to run them yourself and change them, clone it:

```bash
git clone https://github.com/aksheyd/threejam
cd threejam
npm install
npx threejam run games/pong
```

Next, [make a game](making-a-game.md), or give your [coding agent](agents.md) the commands.
