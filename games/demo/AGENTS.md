# Making a game with game-engine

This folder is a game. `scene.toml` lists everything in it, and `scripts/` holds the Lua code that makes things move. You build the game by editing these files, then check your work with the `game-engine` command.

## Commands

Run these from this folder (`.` is the game folder):

```bash
game-engine check .                                     # report errors in scene.toml and scripts, without running
game-engine sim . --ticks 60 --hold D                   # run 60 ticks (1 second) holding D, then print every entity
game-engine shot . --ticks 60 --hold D -o frame.png     # the same run, then save that frame as an 800x600 PNG
game-engine run .                                       # play in a window; Esc quits, Cmd+R or F5 restarts
```

Options, explained under Testing (`game-engine help` lists them too):

| Option | Works on | What it does |
|---|---|---|
| `--ticks N` | `sim`, `shot` | runs N ticks; the default, 0, shows the scene right after every `start` |
| `--hold KEY`, `--press KEY@T` | `sim`, `shot` | holds or presses keys, on every tick or on chosen ones |
| `--driver FILE` | `sim`, `shot` | picks the keys before each tick with Lua |
| `--only NAMES`, `--every N`, `--no-dump` | `sim` | choose which entities and ticks to print |
| `-o FILE`, `--at T,T,...` | `shot` | where to save the PNG (default `shot.png` in the current folder), and at which ticks |
| `--seed N` | `sim`, `shot`, `run` | seeds `math.random` |
| `--set NAME.FIELD=VALUE` | `sim`, `shot`, `run` | changes one `scene.toml` value for this run |
| `--scene FILE` | `check`, `sim`, `shot`, `run` | reads FILE instead of `scene.toml` |

`check` loads the scene and runs the top level of each script the entities use, and of any module a top level `require`s, but not `start` or `update`; errors inside those only show up in `sim`, `shot`, and `run`. It prints `ok: 2 entities, 1 script` when everything loads; the script count is the number of different files the entities use. It also warns about each other file in `scripts/` (`warning: scripts/old.lua isn't used by any entity`) unless one of those scripts `require`s it with a quoted name. Warnings don't change the exit code.

Errors go to stderr as `file:line: message` when there's a line, and the command exits with code 1. An error inside `start` or `update` adds a second line naming the entity and the tick. A mistake in the command itself (an unknown command or option, no folder given, or a `--set` that doesn't fit the scene) prints `error: ...` and the usage, and exits with code 2. A folder that doesn't exist exits with code 1.

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

- `transform`: `position` is the center and `scale` is the width and height. The defaults are `[0, 0]` and `[1, 1]`. Both `scale` numbers must be greater than 0, and whole numbers are fine (`[2, 1]`).
- `mesh`: `shape` is `"square"` or `"triangle"`, stretched to fill the `scale` box. The triangle points up: its tip is at the top center and its base is the bottom edge. `color` is 3 or 4 numbers from 0 to 1, where the fourth is opacity. The default is white.
- `text`: a line of text instead of a mesh; see Text below. An entity with neither a mesh nor text is invisible.
- `script`: `file` is a file in `scripts/`. Every other key becomes a field on the entity, so one script can drive several entities with different settings. Keys must be Lua names (letters, digits, and `_`, not starting with a digit) and can't be `name`, `x`, `y`, `w`, `h`, `color`, or `text`. Values must be numbers, strings, or booleans.

## Scripts

Scripts are Lua 5.4. A script must define `start(self)`, `update(self, dt)`, or both (`check` rejects a file with neither):

```lua
function start(self)
  self.vx = 1.0                 -- fields you add stay on the entity between ticks
end

function update(self, dt)       -- runs 60 times a second; dt is always 1/60
  self.x = self.x + self.vx * dt
end
```

Fields you add can hold any Lua value: numbers, strings, booleans, tables, functions, or entities from `find`. Other scripts can read them, and call stored functions, through `find`.

When the game loads, each script file's top level runs once. Then `start` runs once for every entity that has a script, in file order, and each tick calls `update` for every entity that has a script, in file order. A change one script makes is seen at once by every script that runs after it, in the same `start` pass or the same tick. Loading and `start` count as tick 0, the first round of updates is tick 1, and `--ticks N` stops right after tick N.

`self` is the entity:

| Field | Meaning |
|---|---|
| `self.name` | its name from `scene.toml` (read-only) |
| `self.x`, `self.y` | center position |
| `self.w`, `self.h` | width and height; you can change them |
| `self.color` | `{r, g, b, a}`, always 4 numbers, on entities with a mesh or text. Change it by assigning a new table of 3 or 4 numbers from 0 to 1 (`e.color = {1, 0, 0}`). The entity keeps a copy, so changing that table later does nothing, and single numbers can't be changed in place. |
| `self.text` | the string an entity with text shows; assign a string to change it |
| anything else | values from `scene.toml`, plus fields your scripts set |

A value these fields can't hold, like a string in `x` or `-1` in `w`, is an error on the assigning line (`entity "ball": w must be greater than 0, got -1`).

The engine gives scripts:

- `find(name)`: another entity, with the same fields as `self`, or `nil`. You can read and change it. It returns the same table every time, so you can look entities up once in `start` and keep them. It works on entities without scripts too, and fields you add to another entity stay on it.
- `get(name)`: like `find`, but a name that isn't in the scene is an error on the calling line (`no entity named "balll"`) instead of a `nil` that fails later.
- `find_all(prefix)`: a list of the entities whose names start with `prefix`, in file order, like `find_all("brick_")`. It's empty if none match.
- `input.held(key)`: `true` while the key is down. Keys are `A`-`Z`, `0`-`9`, `Space`, `Enter`, `Tab`, `Backspace`, `Shift`, `Ctrl`, `Alt`, `Up`, `Down`, `Left`, and `Right` (case doesn't matter, here or in `--hold` and `--press`). Any other name is an error, and a name in quotes, like `input.held("Esc")`, fails as soon as its file loads, so `check` reports it for the files it runs. Every key is up during `start`, since keys only count during ticks.
- `input.pressed(key)` and `input.released(key)`: `true` on the tick the key went down or up, and `false` during `start`. In `run`, a tap too short for `input.held` to see still counts, so use `input.pressed` for actions that happen once per press.
- `print(...)`: writes its arguments, separated by tabs, as one line to stderr, starting with the tick number: `[tick 12] ...`. `shot` and `run` print the same lines.
- `math.random`: seeded as described under Determinism. All scripts share one random state, and `math.randomseed()` with no argument goes back to the run's seed.
- `require("util")`: runs `scripts/util.lua` the first time any file asks for it, and gives every file the table it returns, so a script can start with `local util = require("util")`. A module like this must return a table, doesn't need `start` or `update`, and doesn't count as a script in `check`.

Each file has its own top-level variables, which other files can't see; every entity that uses the file shares them, so keep per-entity state on `self`. Scripts share data through entities, whose fields and functions every script can reach with `find`, and through the tables modules return. Library tables (`math`, `string`, `table`, `input`, and so on) are one copy shared by every file, so don't change them.

Scripts also get Lua's `string`, `table`, `math`, `utf8`, and `coroutine` libraries. `io`, `os`, `dofile`, and `loadfile` aren't available. `setmetatable` refuses a metatable that has `__gc` or `__close`, because an endless loop inside one couldn't be stopped; don't add them afterwards either. One call to `start` or `update`, or one file's top level, may run at most 10 million Lua instructions; more is an error (`script ran too long ...; check for an endless loop`).

## Text

A `text` component draws one line in the engine's pixel font, for scores and messages:

```toml
[[entity]]
name = "score"
transform = { position = [-1.9, 1.35] }
text = { value = "SCORE 0", size = 0.14, align = "left", color = [1, 1, 1] }
```

- `value` is the text and `size` is the height of its letters; both are required. A letter is 5 pixels wide and 7 tall with 1 pixel between letters, and a pixel is `size / 7` on each side, so `n` letters are `(6n - 1) * size / 7` wide. Sizes that are multiples of 0.035, like 0.07 or 0.14, make each pixel a whole number of screen pixels, so every stroke has the same width.
- `position` is the anchor, at the text's mid-height. `align` puts the anchor at the text's `"left"` edge, its `"center"` (the default), or its `"right"` edge.
- `color` works as in `mesh`: 3 or 4 numbers from 0 to 1, white by default.
- The font has `A`-`Z`, `0`-`9`, space, and `. , : ; ! ? - + / ( ) % ' "`. Lowercase letters draw as capitals. Any other character is an error (`text can't draw "é"`).
- An entity can have a mesh or text, not both. `scale` still sets `w` and `h`, but they don't change how the text looks.

Scripts change the text by assigning a string, like `self.text = "SCORE " .. self.score`, and change `self.color` as for a mesh. Assigning a number, or a string with a character the font doesn't have, is an error on the assigning line (`entity "score": text can't draw "é"`), so build text with `..` or `tostring`.

## Testing

### What sim prints

After the last tick, `sim` prints one line per entity, in file order. The `sim` example under Commands prints:

```text
player x=2.0 y=0.5 w=1.0 h=1.0 color=0.0,1.0,0.0,1.0 speed=1.5
rock x=-0.5 y=-0.5 w=1.0 h=1.0 color=1.0,0.4,0.8,1.0
```

- After `x`, `y`, `w`, and `h`, entities with a mesh or text print `color=r,g,b,a`, and entities with text then print `text=` and their text (`text="SCORE 0"`). Then come the entity's other number, string, and boolean fields, sorted by name; fields holding tables, functions, or entities aren't printed.
- Numbers are rounded to 4 decimals, and integer values print without a decimal point (floats like `2.0` keep the `.0`). Values from `scene.toml` keep their TOML type: `lives = 3` is an integer and `speed = 3.0` a float. Strings that are empty or contain a space, `=`, or `"` print in double quotes (`demo=""`, `body="6,8 5,8"`).
- `--only ball,paddle` prints only those entities, and `*` matches any run of characters (`--only 'ball,brick_*'`).
- `--every 10` prints the entities after every 10th tick, and also after tick 0 and the last tick, starting each line with `[tick N]`, so with `2>&1` its lines land among script prints in tick order.
- `--no-dump` prints no entities, and can't be combined with `--only` or `--every`. To find when something happens, `print` it from a script and add `--no-dump` to see only those lines: `game-engine sim . --ticks 600 --no-dump 2>&1 | grep score`.

### Keys

- `--hold KEY` holds KEY on every tick. `--hold KEY@30-90` holds it on ticks 30 to 90, and a list like `--hold Left@5,30-90,120-` holds it on tick 5, on ticks 30 to 90, and from tick 120 to the end. `--press KEY@60,75` presses it for one tick at each listed tick. All of these can be repeated.
- Tick 1 is the first update, and `start`, which runs before it, sees every key up. A span that starts within `--ticks` but ends after it is clipped at the last tick; a tick or span that starts after the last one is an error (`error: --press "Space@700": tick 700 is after --ticks 600`).
- Ticks for the same key merge, and each unbroken stretch counts as one press on its first tick and one release on the tick after its last. So `--hold KEY` presses once, on tick 1, and `--press Up@6,7` is a single press held for two ticks; use `@6,8` for two presses.

### Drivers

`--driver FILE` picks the keys with Lua instead, so input can react to the game. FILE defines `keys(tick)`, which runs before each tick's updates with that tick's number, sees the world as the previous tick left it, and returns a list of the keys held during that tick, like `{ "Left", "Space" }`; every other key is up. A key counts as pressed on the tick it joins the list and released on the tick it leaves. This `tests/autopilot.lua` walks the player left until it's above the rock, so `game-engine sim . --ticks 60 --driver tests/autopilot.lua` prints `player x=-0.5 ...`:

```lua
function keys(tick)
  if find("player").x > find("rock").x then
    return { "A" }
  end
  return {}
end
```

- FILE is relative to the current folder. Keep drivers out of `scripts/`, where `check` would warn that no entity uses them (`warning: scripts/autopilot.lua isn't used by any entity`). A helper module in `scripts/` that only a driver `require`s always gets this warning, because `check` doesn't read drivers; it's harmless. A driver can't be combined with `--hold` or `--press`.
- A driver has the same libraries and helpers as scripts and its own top-level variables, but no `input`, since it decides the keys. Its top level runs once, when the game loads, before any `start`.
- `find`, `get`, and `find_all` work, but what they return is read-only, and so are the tables inside it: changing an entity from a driver is an error. `require` gives a driver its own copy of a module, which sees the same read-only entities. Don't call functions stored on entities from a driver either, since they can change the game.
- A driver's `math.random` is a separate stream seeded with the run's seed, so the game gets the same random numbers as without the driver.
- `print` works, and its lines carry the tick `keys` was called for. An error in a driver adds a second line, `  while running the driver before tick N`.

### Changing values for one run

- `--set NAME.FIELD=VALUE` changes one value from `scene.toml` before any `start` runs: `game-engine sim . --ticks 60 --hold D --set player.speed=3`. FIELD is `x`, `y`, `w`, `h`, `color`, `text`, or a key in the entity's `script` table. VALUE is written as in `scene.toml` (`3`, `true`, `"6,8 5,8"`, `[1, 0, 0]`), and anything that isn't valid there is a string (`--set game.mode=easy`). Quote it for the shell when it has spaces, brackets, or quotes: `--set 'rock.color=[1, 0, 0]'`.
- The value must have the type the scene gives that field, except that a whole number can fill a float, as `speed=3` does above. `--set` can be repeated.
- `--scene FILE` reads FILE instead of `scene.toml`. FILE is relative to the current folder, while scripts still come from the game folder's `scripts/`, and errors name FILE. Keep test setups that change many values in files like `tests/full_board.toml` rather than in copies of the folder.

### Frames

`shot` saves the frame after the last tick. `--at 30,60,90` instead saves the frames at ticks 30, 60, and 90 of one run, as `shot-30.png`, `shot-60.png`, and `shot-90.png` (`frame-30.png` and so on with `-o frame.png`). Ticks are zero-padded to the widest one (`--at 5,100` writes `shot-005.png` and `shot-100.png`), and `--ticks` defaults to the largest one. One run for all the frames is faster than a `shot` for each tick.

### Determinism

`sim` and `shot` give the same output every time for the same files, options, and seed. They use seed 0 unless you pass `--seed N`, and `run` picks a new seed each session. This holds as long as scripts avoid what can change between runs:

- `pairs` visits keys in a fixed order: numbers, then strings, then booleans, then entities in file order. Any other keys come in an order that can change.
- A loop written with `next` visits keys in an order that can change, and over an entity it skips `name`, `x`, `y`, `w`, `h`, `color`, and `text`.
- `tostring` of a table or function prints a memory address, which can change between runs, and so can `string.format("%p", ...)` and `collectgarbage("count")`.

## Playing in a window

`game-engine run .` opens the game in a window; Esc quits. Without `--seed`, each session picks a new seed and prints the command that repeats it, like `seed 4172093 (repeat with: game-engine run . --seed 4172093)`.

- Cmd+R (on a Mac) or F5 restarts the game from the files: it reads `scene.toml` (or the `--scene` file) and the scripts again, applies `--set` again, and starts over. A session started with `--seed N` restarts with seed N, so it replays the same way; otherwise each restart picks a new seed and prints its line. Scripts never see the press; R without Cmd is still an ordinary key.
- If the files fail to load, or a `start` fails, the restart prints the error and the old game keeps playing, so you can fix it and restart again. An error in `update` ends `run`, even after a restart.
- Fully covering or minimizing the window pauses the game on macOS and X11, but not on Windows or Wayland.

## Not supported yet

Images, sound, mouse input, rotation, and adding or removing entities while the game runs. To hide an entity, move it off screen, set the fourth number of its color to 0, or, for text, assign `""`. What has worked in other games:

- A fixed pool of entities (shots, body segments) parked off screen until needed.
- A sprite made of several shapes, moved by one script that keeps each part's offset from a leader entity.
- An overlap test instead of a collision system: the boxes of entities `a` and `b` overlap when `math.abs(a.x - b.x) < (a.w + b.w) / 2` and `math.abs(a.y - b.y) < (a.h + b.h) / 2`. Put it in a module to use it from several files.

A tick costs time only for what scripts do and the entities they change. In the debug build, moving 2,000 entities every tick runs about 2,000 ticks a second, so a 10,000-tick run takes about 5 s, and recoloring 2,000 entities every tick runs about 500. Entities nothing changes cost nothing per tick, so a parked pool doesn't slow the simulation. But `run` draws every entity with a mesh on every frame, even off screen, and draws each text as many small squares, so prefer fewer, larger shapes.

## Working loop

1. Edit `scene.toml` and the files in `scripts/`.
2. Run `game-engine check .` until it prints `ok`, then `game-engine sim . --ticks 1` to run `start` and one `update`.
3. Test behavior with numbers: `game-engine sim . --ticks N`, with the keys, drivers, and one-run changes under Testing.
4. Look at it: `game-engine shot . --ticks N` and open the PNG, or `--at 30,60,90` to see several moments of one run.
5. Ask a person to play it with `game-engine run .`. Numbers and single frames can't show whether motion feels right. They can leave it open while you edit and press Cmd+R (or F5) to play your latest files.
