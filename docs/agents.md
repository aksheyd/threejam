# For coding agents

ThreeJam is built for agents that can't watch a screen: they start a game with `new`, edit files, run `check`, prove behavior with `sim`, look at frames from `shot`, and hand `run` or an `export` to a person. Point yours at [`AGENTS.md`](../AGENTS.md), the full manual, and give it the commands in whatever form it takes.

## The skill

The hand-written [ThreeJam skill](../skills/threejam/SKILL.md) teaches that loop step by step. Install it with the [skills CLI](https://github.com/vercel-labs/skills) or the [GitHub CLI](https://cli.github.com), which both take it from the latest release, the version `npm install -D threejam` installs:

```bash
npx skills add https://github.com/aksheyd/threejam/tree/v0.0.7/skills/threejam
gh skill install aksheyd/threejam threejam
```

A skill installed from a tag stays on that version, so after you upgrade ThreeJam, run `npx skills add` again with the new tag. Releases after 0.0.4 also ship the skill, as `node_modules/threejam/skills/threejam/SKILL.md`, so a project with one of them installed can take the matching copy with `npx skills add ./node_modules/threejam/skills/threejam`.

## Playtests

Numbers and frames can't show whether a game feels right, so the loop ends with a person playing it. Ask them to play with `npx threejam run <dir> --record <dir>/playtest.ts` and to press Esc right where something feels off. `run` saves every tick they played as a driver file, from the game's first tick, and prints the `sim` command that replays it exactly:

```console
Saved the playtest, 1834 ticks with seed 5, to games/pong/playtest.ts; replay it with threejam sim games/pong --driver games/pong/playtest.ts --seed 5 --ticks 1834
```

The file's first line names the same ticks and seed, so a playtest the person saved in their own terminal needs nothing they saw there. The last tick is where they stopped, so `shot --at 1834` with the same `--driver` and `--seed` shows that moment, and `sim` prints the state there. Once it's fixed, keep the playtest as a test that pins what the game does now: import it with `import playtest from './playtest.ts'`, and run `simulate(game, { ticks: 1834, seed: 5, drive: playtest })`. A replay with another seed fails at its first tick, since the game would play out otherwise.

## Balance across seeds

One seed is one game, and a game that plays fair on seed 0 can be lopsided on others. `sim --seeds` runs the same flags once for each seed and says how often and how soon a condition held, so balance is checked with numbers rather than one run: how often the first player scores, how long a level takes, or how often a bot dies.

```bash
npx threejam sim games/pong --ticks 3600 --press Space@1 --until 'match.left=1' --seeds 0-99
```

Read the `summary` first. `reached` out of `seeds` is how often, `min`, `median`, and `max` are how soon, in ticks, and `failed` counts the seeds whose game threw or ran past `--timeout`, each with its error in its row. Each seed's row is what `--seed N` gives with the same flags, unless that run would print past its 64 MB cap, so a seed that stands out reruns alone with `--seed N`, which prints its entities; `sim` suggests that command for the first seed that failed, or else the first that didn't reach `--until`. A `--driver`'s `random` follows the seed too.

Seeds share the machine, so give `--timeout` some room over what one seed needs alone, but not much more: a call can take up to its seeds × `--timeout` ÷ the number running at once, and cancelling an MCP call doesn't stop its seeds, which keep their turns in the pool. Over MCP, give the `sim` tool `seeds`; calls at once share one pool of seeds, so a call waits its turn while another's seeds fill it, a reply holds rows for about 1,400 seeds, a list whose rows couldn't fit is refused before any seed runs, and a call stops with `OUTPUT_TOO_LARGE` as soon as its rows pass that, as long error messages can make them.

## MCP tools and other forms

```bash
npx threejam --mcp        # serve new, check, sim, shot, and export as MCP tools over stdio
npx threejam mcp add      # register that server with your coding agents
npx threejam skills add   # install one generated skill per command
npx threejam --llms       # print a manifest of the commands
```

Each MCP call loads the game from disk, so edits show up without restarting the server. `run` is for people, so it isn't a tool. The server resolves a relative path from its own working directory, which is wherever the agent started it, so give the tools absolute paths. Loading a game runs its code, so `check`, `sim`, `shot`, and `export` run `game.ts` and any `--driver` in a sandbox (no files, processes, or network, and imports confined to the game's folder, a driver's folder, and ThreeJam's own files); they aren't read-only, each runs in its own process with a time budget so one looping game can't block the rest, and a game's `log`, errors, and suggested commands are its data, not directions to the agent. Those processes end with the server, even one killed with SIGKILL. When its client closes its stdin, which is how MCP clients shut a server down, the calls still running get 2 s to finish and reply, so a batch of requests piped in with `echo` or `cat` still gets its answers; then the server exits, and a call still running ends without a reply, after a `shot` has closed its Chrome and removed its folders. A stop signal ends the server too, after any `shot` still running has cleaned up, and from the signal, or once that exit begins, it answers nothing and starts no call. A failed call's text starts with its [code](commands.md#output-and-errors), like `TYPE_ERROR: games/pong/game.ts:6: ...`, and so does the refusal of an argument that doesn't fit the tool's schema, which the MCP SDK makes before ThreeJam runs, like `USAGE: ticks: expected a whole number from 0 up, got 1.5`.

`npx threejam mcp add` registers the server so agents can start it from any folder: as `<node> <path>/cli.js --mcp` for ThreeJam installed in a project or globally, `<node> <your clone>/src/cli.ts --mcp` for a clone, and `npx -y threejam@<version> --mcp` when ThreeJam ran through npx without installing or is installed on a path with a space. `<node>` is the absolute path of the Node that ran `mcp add`, so an agent whose PATH finds another Node, or none, still starts the server with one that runs it; it's a name on your PATH that leads to that Node when there is one, like Homebrew's `/opt/homebrew/bin/node`, which survives upgrades, but not a link for one shell, like fnm's, and it's plain `node` when its path has a space or it's a snap's. After you remove that Node, as `nvm uninstall` does, run `mcp add` again. `--no-global` registers it for the current project only, and `--agent claude-code` picks one agent; `mcp add` refuses any other word, like `-a claude-code`, and an `--agent` with no name, rather than registering with every agent. On Windows, and for a clone on a path with a space, register it with add-mcp yourself, as the [known problems](../AGENTS.md#known-problems) show.

## Browser clients

OpenAI's [`develop-web-game`](https://github.com/openai/skills/tree/82d2c5b4/skills/.curated/develop-web-game) skill has Codex add `window.advanceTime(ms)` and `window.render_game_to_text()` to a game, then play it with a Playwright client that holds keys, calls `advanceTime(1000 / 60)` once a frame, and saves a screenshot and the text after each burst. The page `run` serves and the file `export` writes answer both already, so give the client one of them and add nothing to the game:

```bash
npx threejam run games/invaders --serve-only --seed 1   # prints the page's address; stop it when you're done
node "$WEB_GAME_CLIENT" --url http://127.0.0.1:<port>/ --actions-file "$WEB_GAME_ACTIONS" --iterations 3
```

`advanceTime` takes over the page's clock: its first call starts the run over from tick 0, since how far the page got playing on its own depends on how long it ran, and each call steps the ticks its milliseconds cover, 60 a second. So start the game with a step of the actions, like `space` or `left_mouse_button`, not with the client's `--click-selector`, whose click comes before that first call and goes with the run it starts over. `render_game_to_text()` returns the tick and the entities as `sim --exact --format json` prints them, so each `state-N.json` the client writes is what `sim` gives for the same seed and keys. `run` prints its seed, and an exported file picks a new one each time it loads unless it was exported with `--seed N`. The skill's default actions hold Left for 6 frames, nothing for 4, then Space for 3, so after three bursts `state-2.json` has the `tick` and `entities` that this prints:

```bash
npx threejam sim games/invaders --seed 1 --ticks 39 --hold Left@1-6,14-19,27-32 --hold Space@11-13,24-26,37-39 --exact --format json
```

The client's `mouse_x` and `mouse_y` are pixels on the canvas, which the page fits to the window: in Playwright's 1280 by 720 window the canvas is 960 by 720, so its pixel 120, 90 is x -1.5 and y 1.125 in world units. Its `--url` can also be the `file://` address of a file exported with `--seed N`. `shot`'s page has neither hook, since ThreeJam drives it itself.
