## What this changes

<!-- What changes and why, and anything a reviewer should try. -->

## Checks

[CONTRIBUTING.md](https://github.com/aksheyd/threejam/blob/main/CONTRIBUTING.md) has the rules these come from. A fix for a vulnerability that isn't public yet starts as a private report instead, as [SECURITY.md](https://github.com/aksheyd/threejam/blob/main/SECURITY.md) says.

- [ ] `npm test` and `npx tsc -p .` pass, and every game in `games/` passes `check`
- [ ] `npm run test:package` passes, if the change touches the package or `scripts/`
- [ ] `AGENTS.md`, the guide in `docs/` that covers it, and the skill say what changed, if agents can see it
- [ ] `CHANGELOG.md` has a line under Unreleased, if users can see it
