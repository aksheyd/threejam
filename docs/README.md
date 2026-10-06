# ThreeJam docs

- [Getting started](getting-started.md): what you need, starting a game in a folder of its own or in a project you have, and playing the example games.
- [Making a game](making-a-game.md): the game of catch that `new` writes, and how to check it, prove what it does, look at it, test it, and share it.
- [Commands](commands.md): every command, the input flags `sim` and `shot` share, and what the output and errors look like.
- [For coding agents](agents.md): the skill, the MCP server, and the other forms the commands take.
- [Example games](examples.md): the games in this repo, how to play them, and what each is worth reading for.

[`AGENTS.md`](../AGENTS.md) is the full manual: every part of `game.ts` and `view.ts`, the rules the engine checks, testing, and the [known problems](../AGENTS.md#known-problems). It ships in the package too, as `node_modules/threejam/AGENTS.md`. [`CONTRIBUTING.md`](../CONTRIBUTING.md) covers working on ThreeJam itself, and [`CHANGELOG.md`](../CHANGELOG.md) what changed in each release.

## Built with

- [Three.js](https://threejs.org), which draws the games
- [incur](https://github.com/wevm/incur), which turns the command definitions into the CLI, the MCP tools, and the skills
- [TOON](https://toonformat.dev), the default output format
- [Model Context Protocol](https://modelcontextprotocol.io) and [Agent Skills](https://agentskills.io)
