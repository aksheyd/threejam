# Contributing to ThreeJam

ThreeJam is a prototype, and issues and pull requests are welcome. [`AGENTS.md`](AGENTS.md) is the manual for making games with it; this file is for changing ThreeJam itself, and coding agents working in this repo follow it too.

## Setting up

You need Node 22.18 or later, and Chrome or Chromium for the page tests, found the way `shot` finds it. [`.nvmrc`](.nvmrc) names Node 26, the version CI runs on every OS:

```bash
git clone https://github.com/aksheyd/threejam
cd threejam
nvm install    # Node 26, from .nvmrc
npm install
npm test
```

In a clone, `npx threejam` runs the TypeScript sources directly, with nothing to build.

## Where things are

- `src/types.ts`, `entities.ts`, `engine.ts`, `input.ts`, `random.ts`, `guard.ts`, `math.ts`, `font.ts`, `colors.ts`, `assets.ts`, `errors.ts`: the engine, shared by `sim` and the page. `assets.ts` knows the image and sound file types and checks the names games use.
- `src/browser/client.ts` and `src/browser/view.ts`: the page's loop, keyboard and mouse, and `window.engine`, and the default Three.js view. `src/browser/assets.ts` is the only place the page reads files: it loads images and sounds from the addresses the page was built with, which `serve.ts` points at the local server and `export.ts` replaces with data URLs. `src/browser/sound.ts` plays sounds and makes the built-in ones. `src/browser/bare.ts` bares the page's globals to what `sim`'s realm has while game code runs.
- `src/cli.ts`: the incur command definitions. The CLI, the MCP tools, the generated skills, and `--llms` all come from these, so descriptions and examples change here.
- `src/package.ts`: the package's name and version, where its files are, and the command `mcp add` registers. A clone runs the TypeScript in `src`, and the published package runs the JavaScript compiled into `lib`, so code finds the engine's own files through `engineFile`, never by assuming `src`.
- `src/load.ts`: bundling a game and its driver confined to their folders and the engine, running them in a sandbox (a `vm` realm in a child process under Node's permission model) with a time and output budget, listing a game's images and sounds, the type checks, and turning errors into `path:line`. `src/sandbox.ts` is the half that runs inside the realm: it fixes the realm's globals before any game module loads, then loads and simulates. `src/confine.ts` is the import rule that bundle and the page's share: what the game's, a driver's, and the engine's files may import. `src/serve.ts` and `src/shot.ts`: bundling, the local server, the Chrome window, and headless frames. `src/export.ts`: the one-file page. `src/new.ts`: the starter game and project files `new` writes. `src/output.ts`: making the folders and files `new`, `shot`, and `export` write, a folder at a time, since Node's recursive `mkdir` never returns for one under `/proc`, with each failure an `IO_ERROR`.
- `games/`: the example games and their tests. `test/`: engine, CLI, MCP, and page tests, which share one Chrome in `browser.test.ts`; in `serve.test.ts`, what the page server, the page bundle, and Chrome let through; in `shot.test.ts`, `shot`'s frames; in `fuzz.test.ts`, every example game under random input; and in `docs.test.ts`, that the docs name the keys, sounds, file types, portable functions, error codes, commands, and flags the code has, and that the Pages index links every example game and its sitemap names the site's address. `browser.test.ts` also checks `shot`'s time limit on two stuck pages, which take about 11 s, beside its other tests once the first page test has finished, so running even one page test takes about that much longer. `test/chrome.ts` starts the tests' own Chrome with a temporary folder of its own, compositing in software, which takes far less CPU, and `test/children.ts` starts the CLI so it stops, with every process it started, when its test ends, and gives the processes the tests start one compile cache.
- `scripts/build.ts` and `tsconfig.build.json`: the build of the published package into `dist`, with its own `package.json`, the declarations its entry point needs, a copy of the README whose links point at GitHub, and `AGENTS.md` without its last section, the one that points here. It fails unless each runtime dependency names the exact version `package-lock.json` installs, since users install them without the lockfile, and `.npmrc` makes `npm install` save versions that way. `scripts/verify-package.ts`: `npm run test:package`, which builds and packs the package, installs the tarball in a project in a temporary folder with install scripts off, as npm 12 has them, and runs `new`, `check`, `sim`, `shot`, `export`, `run`, and the new game's test there, then runs ThreeJam through npx with nothing installed. It isn't part of `npm test`.
- `AGENTS.md`: the manual for making games, which agents read here and in the package. `skills/threejam/SKILL.md`: the agent skill, which the package ships too, and which the docs' `npx skills add` installs from the latest release's tag.
- `README.md` and `docs/`: the README is the pitch and a quick start, and the guides it links to are in `docs/`, next to the README's screenshots in `docs/images`. `CHANGELOG.md`: what changed in each release. `SECURITY.md`: reporting a vulnerability, and which versions get fixes.
- `.github/workflows/ci.yml`: CI for pushes to main, pull requests, and each release. It runs the typecheck, `npm test`, and `check` on every game with Node 26 on Linux, macOS, and Windows, and with Node 22.18 and 24 on Linux, and `npm run test:package` with all three on Linux. `.github/workflows/release.yml`: publishing to npm when a version tag is pushed. `.github/workflows/pages.yml`: deploying the example games' site to GitHub Pages on each push to main, or a run started by hand on main, and building it without deploying it for a pull request or a run on another branch. The site is the file `export` writes for each folder in `games/`, `.github/pages/index.html`, the page that links them, and `.github/pages/sitemap.xml`, which names the site's address, and nothing else, so a new example game also gets a line in the index. `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`: the forms for bug reports and feature requests, the link for reporting a vulnerability, and what a pull request's description starts with.

## Checks

```bash
npm test                # every test, including the games'; the page tests need Chrome
npx tsc -p .            # typecheck
npx threejam check games/pong
npm run build           # the published package, in dist
npm run test:package    # build, pack, install, and use the package; needs Chrome and the npm registry
```

## Rules

- `npm test` and `npx tsc -p .` stay clean, every game in `games/` passes `check`, and `npm run test:package` passes.
- `sim` and the page reach the same state for the same files, flags, and seed.
- Failures print a code and a one-line message and exit 1; problems in game files start with `path:line:`.
- `check` and `sim` never open a browser. The engine has no game-specific code.
- Code runs on macOS, Linux, and Windows: start Node as `process.execPath` rather than `node` or a `node_modules/.bin` shim, import files through `pathToFileURL`, build paths with `node:path`, and print paths with forward slashes.
- Code runs from a clone and from the published package: nothing needs a build to run in the repo, and nothing assumes the `src` folder at run time.
- Tests and scripts run ThreeJam from the working tree or a packed tarball, never through a bare `npx threejam` where the package isn't installed, since that downloads the published version instead.
- Follow the TypeScript rules in the repo's style: model variants as discriminated unions, parse `unknown` input at the boundary, avoid `as` casts except right after validation, and make switches exhaustive with `never`.
- Match the code around you: no semicolons, single quotes, and lines as long as they need to be. `.editorconfig` sets the rest, and no formatter runs yet.
- A change agents can see goes into `AGENTS.md` in the same change, into the guide in `docs/` that describes it, and into the skill if it changes the skill's steps. A change users can see also gets a line under Unreleased in `CHANGELOG.md`.
- Comments are single lines and only say what the code can't. No emojis. Each test covers something no other test does.
- Don't leave a `run` window open: start `run --serve-only` in the background, check it, and stop it.
- Commit messages are Conventional Commits, with a scope where one fits, in the imperative and lowercase after the colon, and with `!` for a breaking change, like `fix(shot): retry a page navigation Chrome aborts in a new tab`.

## Issues and pull requests

Report a bug or ask for a feature through the [issue forms](https://github.com/aksheyd/threejam/issues/new/choose), and a vulnerability privately, as [`SECURITY.md`](SECURITY.md) says. Open pull requests against `main`, one change to a pull request: the [template](.github/pull_request_template.md) lists the checks above, and CI runs them on Linux, macOS, and Windows, apart from `npm run test:package`, which runs on Linux.

## Releasing

The version in the root `package.json` is the only one; the CLI, the MCP server, `new`, and the build all read it. The root is marked private so it can't be published by mistake: what gets published is `dist`, which `npm run build` writes.

Every release goes through `release.yml`, which runs when a `v*` tag is pushed. It runs all of CI on the tagged commit. Its build job checks that the tag matches `package.json`, then builds and packs the package with install scripts off, so the only dependency code it runs is the TypeScript compiler. Its test job builds the package again from its own checkout and proves that build with `npm run test:package`. The publish job waits for all of them, checks that the build job's tarball has the digest both builds reported, and publishes it. It's the only job that can sign in to npm, through trusted publishing, and it runs no dependency code, so no dependency can use that sign-in, and no npm token is stored anywhere. To release:

1. On main, commit the release's notes: in `CHANGELOG.md`, give the Unreleased notes the new version and the day's date, and point the `npx skills add` commands in `README.md` and `docs/agents.md` at the new version's tag.
2. Run `npm version <new version> -m "chore(release): %s"` on main, which changes `package.json` and `package-lock.json`, commits, and tags `v<new version>`. Then run `npm test`, which fails unless `CHANGELOG.md` has an entry for the new version and the skill's tag is the newest release's.
3. Run `git push --follow-tags`. `release.yml` publishes the package, with provenance.
4. Make a GitHub Release from the tag, with that version's notes from `CHANGELOG.md`.

npm trusts the workflow through the package's trusted publisher on npmjs.com: GitHub Actions, the owner `aksheyd`, the repository `threejam`, and the workflow `release.yml`, allowed to run `npm publish`, with the package's publishing access set to require two-factor authentication and disallow tokens. The workflows pin every action to a full commit SHA, so a moved tag can't change what runs; update the SHA and its version comment together. The repository allows only GitHub's own actions and `browser-actions/setup-chrome`, requires the SHA pins, and has rulesets that let only its admin push to main or create, move, or delete `v*` tags.
