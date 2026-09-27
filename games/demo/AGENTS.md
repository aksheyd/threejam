# Making a game with game-engine

This folder is a game. `scene.toml` lists everything in it, and `scripts/` holds the Lua code that makes things move. You build the game by editing these files, then check your work with the `game-engine` command.

## Commands

Run these from this folder (`.` is the game folder):

```bash
game-engine check .                                     # report errors in scene.toml and scripts, without running
game-engine sim . --ticks 60 --hold D                   # run 60 ticks (1 second) holding D, then print every entity
game-engine shot . --ticks 60 --hold D -o frame.png     # the same run, then save that frame as an 800x600 PNG
game-engine run .                                       # play in a window; Esc quits
```

- `--ticks` defaults to 0, which shows the scene right after every `start` has run.
- `--hold KEY` can be repeated. Held keys are down on every tick of the run, so anything they move keeps moving to the end (a held paddle ends pinned at an edge), and keys can't be pressed partway through a run yet.
- `shot` writes `shot.png` in the current folder if you leave out `-o`.
- Errors go to stderr as `file:line: message` when there's a line, and the command exits with code 1. An error inside `start` or `update` adds a second line naming the entity and the tick. A mistake in the command itself (an unknown command or option, or no folder given) exits with code 2. A folder that doesn't exist exits with code 1.
- `sim` prints only the last tick. To find when something happens, `print` it from a script; each line goes to stderr as `[tick N] ...`.
- Runs are deterministic: the same files and flags always print the same output, as long as scripts follow the `pairs` note under Scripts.

`check` prints `ok: 2 entities, 1 script` when everything loads. `sim` prints one line per entity, in file order:

```text
player x=2.0 y=0.5 w=1.0 h=1.0 speed=1.5
rock x=-0.5 y=-0.5 w=1.0 h=1.0
```

After `x`, `y`, `w`, and `h` come the entity's other number, string, and boolean fields, sorted by name. Numbers are rounded to 4 decimals, and integer values print without a decimal point (floats like `2.0` keep the `.0`).

## The screen

The window is 800x600 pixels. It shows x from -2 (left edge) to 2 (right edge) and y from -1.5 (bottom) to 1.5 (top). (0, 0) is the center, and one unit is 200 pixels. Entities are drawn in file order, so later entities appear on top.

## scene.toml

```toml
background = [0.2, 0.3, 0.3]    # optional: r, g, b from 0 to 1

[[entity]]
name = "player"                 # required: unique, only A-Z, a-z, 0-9, _, and -
transform = { position = [0.5, 0.5], scale = [1.0, 1.0] }
mesh = { shape = "square", color = [0.0, 1.0, 0.0] }
script = { file = "player.lua", speed = 1.5 }
```

Every key after `name` is a component, and each one is optional:

- `transform`: `position` is the center and `scale` is the width and height. The defaults are `[0, 0]` and `[1, 1]`.
- `mesh`: `shape` is `"square"` or `"triangle"`, stretched to fill the `scale` box. `color` is 3 or 4 numbers from 0 to 1, where the fourth is opacity. The default is white. An entity without a mesh is invisible.
- `script`: `file` is a file in `scripts/`. Every other key becomes a field on the entity, so one script can drive several entities with different settings. Keys must be Lua names (letters, digits, and `_`, not starting with a digit) and can't be `name`, `x`, `y`, `w`, `h`, or `color`. Values must be numbers, strings, or booleans.

## Scripts

Scripts are Lua 5.4. A script defines `start(self)`, `update(self, dt)`, or both:

```lua
function start(self)
  self.vx = 1.0                 -- fields you add stay on the entity between ticks
end

function update(self, dt)       -- runs 60 times a second; dt is always 1/60
  self.x = self.x + self.vx * dt
end
```

`start` runs once for every entity, before the first tick. Each tick then calls `update` for every entity that has a script, in file order.

`self` is the entity:

| Field | Meaning |
|---|---|
| `self.name` | its name from scene.toml |
| `self.x`, `self.y` | center position |
| `self.w`, `self.h` | width and height |
| `self.color` | `{r, g, b, a}` on entities with a mesh; assign a new table like `{1, 0, 0}` to change it. A 3-number table stays 3 numbers, and its opacity counts as 1. |
| anything else | values from scene.toml, plus fields your scripts set |

The engine gives scripts:

- `find(name)`: another entity, with the same fields as `self`, or `nil`. You can read and change it.
- `input.held(key)`: `true` while the key is down. Keys are `A`-`Z`, `0`-`9`, `Space`, `Enter`, `Tab`, `Backspace`, `Shift`, `Ctrl`, `Alt`, `Up`, `Down`, `Left`, and `Right` (case doesn't matter). Any other name is an error. It reports every key as up during `start`, since keys only count during ticks.
- `print(...)`: writes a line to stderr, starting with the tick number.
- `math.random`: seeded the same way on every run.

Scripts also get Lua's `string`, `table`, `math`, `utf8`, and `coroutine` libraries. `io`, `os`, `require`, `dofile`, and `loadfile` aren't available. To keep runs deterministic, `pairs` visits keys in a fixed order: numbers, then strings, then booleans, then entities in file order; any other keys, and loops written with `next`, come in an order that can change between runs. `tostring` of a table or function prints a memory address, which changes between runs. `math.randomseed()` with no argument uses seed 0.

Variables at the top level of a script file are shared by every entity that uses that file. Keep per-entity state on `self`.

## Not supported yet

Text, images, sound, rotation, and adding or removing entities while the game runs. To hide an entity, move it off screen or set the fourth number of its color to 0.

There's no collision system either. The boxes of entities `a` and `b` overlap when `math.abs(a.x - b.x) < (a.w + b.w) / 2` and `math.abs(a.y - b.y) < (a.h + b.h) / 2`.

## Working loop

1. Edit `scene.toml` and the files in `scripts/`.
2. Run `game-engine check .` until it prints `ok`. `check` only loads files, so also run `game-engine sim . --ticks 1` to catch errors inside `start` and `update`.
3. Test behavior with numbers: `game-engine sim . --ticks N --hold KEY`.
4. Look at it: `game-engine shot . --ticks N` and open the PNG.
5. Ask a person to play it with `game-engine run .`. Numbers and single frames can't show whether motion feels right.
