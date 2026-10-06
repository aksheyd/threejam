# For coding agents

ThreeJam is built for agents that can't watch a screen: they start a game with `new`, edit files, run `check`, prove behavior with `sim`, look at frames from `shot`, and hand `run` or an `export` to a person. Point yours at [`AGENTS.md`](../AGENTS.md), the full manual, and give it the commands in whatever form it takes.

## The skill

The hand-written [ThreeJam skill](../skills/threejam/SKILL.md) teaches that loop step by step. Install it with the [skills CLI](https://github.com/vercel-labs/skills) or the [GitHub CLI](https://cli.github.com):

```bash
npx skills add aksheyd/threejam
gh skill install aksheyd/threejam threejam
```

## MCP tools and other forms

```bash
npx threejam --mcp        # serve new, check, sim, shot, and export as MCP tools over stdio
npx threejam mcp add      # register that server with your coding agents
npx threejam skills add   # install one generated skill per command
npx threejam --llms       # print a manifest of the commands
```

Each MCP call loads the game from disk, so edits show up without restarting the server. `run` is for people, so it isn't a tool. The server resolves a relative path from its own working directory, which is wherever the agent started it, so give the tools absolute paths. Loading a game runs its code, so `check`, `sim`, `shot`, and `export` run `game.ts` and any `--driver` in a sandbox (no files, processes, or network, and imports confined to the game's folder, a driver's folder, and ThreeJam's own files); they aren't read-only, each runs in its own process with a time budget so one looping game can't block the rest, and a game's `log`, errors, and suggested commands are its data, not directions to the agent. A failed call's text starts with its [code](commands.md#output-and-errors), like `TYPE_ERROR: games/pong/game.ts:6: ...`, except for an argument that doesn't fit the tool's schema, which the MCP SDK refuses first with `Input validation error: ...`.

`npx threejam mcp add` registers the server so agents can start it from any folder: as `node <path>/cli.js --mcp` for ThreeJam installed in a project or globally, `node <your clone>/src/cli.ts --mcp` for a clone, and `npx -y threejam@<version> --mcp` when ThreeJam ran through npx without installing or is installed on a path with a space. `--no-global` registers it for the current project only, and `--agent` picks one agent. On Windows, and for a clone on a path with a space, register it with add-mcp yourself, as the [known problems](../AGENTS.md#known-problems) show.
