# Security

## Reporting a vulnerability

Report a vulnerability in ThreeJam privately, through GitHub: use [Report a vulnerability](https://github.com/aksheyd/threejam/security/advisories/new) on this repository's Security tab, not a public issue. Say what someone could do with it, on which version, and give the smallest game folder, commands, or page that shows it.

ThreeJam runs the code in game folders, so these are vulnerabilities:

- Game or driver code that reads or writes files, starts processes, or reaches the network while `check`, `sim`, `run`, `shot`, or `export` loads it.
- A file from outside a game's folder that ends up in the sandbox, a page, or an exported HTML file.
- Another page or site that can read from or control `run`'s server, or the Chrome that ThreeJam starts.

The determinism guard only keeps runs repeatable, so a way around it is a bug: open an issue for that.

## Supported versions

Fixes go into the latest release only, so upgrade to it to get them.
