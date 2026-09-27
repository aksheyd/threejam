use std::ffi::OsStr;
use std::fs::{self, File};
use std::io;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[allow(dead_code)]
#[path = "../src/test_support.rs"]
mod test_support;

use test_support::TempGame;

fn game_engine(args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> Output {
    Command::new(env!("CARGO_BIN_EXE_game-engine"))
        .args(args)
        .output()
        .unwrap()
}

fn game(name: &str) -> String {
    format!("{}/games/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn stdout(output: &Output) -> &str {
    std::str::from_utf8(&output.stdout).unwrap()
}

fn stderr(output: &Output) -> &str {
    std::str::from_utf8(&output.stderr).unwrap()
}

fn assert_usage_error(args: &[&str], message: &str) {
    let output = game_engine(args);
    assert_eq!(output.status.code(), Some(2), "{args:?}");
    assert!(
        stderr(&output).starts_with(&format!("error: {message}\n\nusage: ")),
        "{args:?}: {}",
        stderr(&output)
    );
}

#[test]
fn check_prints_a_summary() {
    let output = game_engine(["check", &game("demo")]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout(&output), "ok: 2 entities, 1 script\n");
}

#[test]
fn check_reports_literal_key_names_that_arent_keys() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"player\"\nscript = { file = \"player.lua\" }\n",
        ),
        (
            "scripts/player.lua",
            "function update(self, dt)\n  if input.held(\"Esc\") or input.pressed(\"space\") then\n    \
             self.x = 0\n  end\n  -- input.released(\"F1\") in a comment isn't checked\n  \
             self.paused = input.released 'F1'\nend\n",
        ),
    ]);
    let output = game_engine(["check", game.dir.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    let script = game.path("scripts/player.lua");
    let keys = game_engine::Key::names().join(", ");
    assert_eq!(
        stderr(&output),
        format!(
            "{script}:2: unknown key \"Esc\" (keys: {keys})\n\
             {script}:6: unknown key \"F1\" (keys: {keys})\n"
        )
    );
}

#[test]
fn check_warns_about_script_files_that_nothing_uses() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"player\"\nscript = { file = \"player.lua\" }\n",
        ),
        (
            "scripts/player.lua",
            "local util = require(\"util\")\n\n\
             function update(self, dt)\n  require(\"later\").step(self)\nend\n",
        ),
        ("scripts/util.lua", "return {}\n"),
        ("scripts/later.lua", "return { step = function(e) end }\n"),
        ("scripts/old.lua", "function update(self, dt) end\n"),
        ("scripts/levels/boss.lua", "function update(self, dt) end\n"),
        ("scripts/notes.txt", "not a script\n"),
    ]);
    let output = game_engine(["check", game.dir.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(stdout(&output), "ok: 1 entity, 1 script\n");
    assert_eq!(
        stderr(&output),
        "warning: scripts/levels/boss.lua isn't used by any entity\n\
         warning: scripts/old.lua isn't used by any entity\n"
    );
}

#[cfg(unix)]
#[test]
fn a_script_used_under_another_name_counts_as_used() {
    let game = TempGame::new(&[
        ("scripts/player.lua", "function update(self, dt) end\n"),
        ("scripts/rock.lua", "function update(self, dt) end\n"),
    ]);
    std::os::unix::fs::symlink("rock.lua", game.dir.join("scripts/alias.lua")).unwrap();
    // Another case names the same file only on a case-insensitive file system, like macOS's default.
    let player = if game.dir.join("scripts/PLAYER.lua").exists() {
        "Player.lua"
    } else {
        "player.lua"
    };
    fs::write(
        game.dir.join("scene.toml"),
        format!(
            "[[entity]]\nname = \"player\"\nscript = {{ file = \"{player}\" }}\n\n\
             [[entity]]\nname = \"rock\"\nscript = {{ file = \"alias.lua\" }}\n"
        ),
    )
    .unwrap();
    let output = game_engine(["check", game.dir.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(stdout(&output), "ok: 2 entities, 2 scripts\n");
    assert_eq!(stderr(&output), "");
}

#[test]
fn sim_prints_every_entity_after_the_last_tick() {
    let output = game_engine(["sim", &game("demo"), "--ticks", "60", "--hold", "D"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout(&output),
        "player x=2.0 y=0.5 w=1.0 h=1.0 color=0.0,1.0,0.0,1.0 speed=1.5\n\
         rock x=-0.5 y=-0.5 w=1.0 h=1.0 color=1.0,0.4,0.8,1.0\n"
    );
}

#[test]
fn a_seed_changes_only_random_values_and_repeats_exactly() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"walker\"\nscript = { file = \"walker.lua\" }\n\n\
             [[entity]]\nname = \"dice\"\nscript = { file = \"dice.lua\" }\n",
        ),
        (
            "scripts/walker.lua",
            "function update(self, dt)\n  self.x = self.x + dt\nend\n",
        ),
        (
            "scripts/dice.lua",
            "function update(self, dt)\n  self.x = math.random()\nend\n",
        ),
    ]);
    let sim = |seed: &[&str]| {
        let dir = game.dir.to_str().unwrap();
        let output = game_engine([&["sim", dir, "--ticks", "3"], seed].concat());
        assert_eq!(output.status.code(), Some(0), "{output:?}");
        stdout(&output).to_owned()
    };
    let default = sim(&[]);
    let seeded = sim(&["--seed", "7"]);
    let (walker, dice) = default.split_once('\n').unwrap();
    let (seeded_walker, seeded_dice) = seeded.split_once('\n').unwrap();
    assert_eq!(seeded_walker, walker);
    assert_ne!(seeded_dice, dice);
    assert_eq!(sim(&["--seed", "0"]), default);
    assert_eq!(sim(&["--seed", "7"]), seeded);
}

#[test]
fn a_seed_must_be_a_whole_number() {
    assert_usage_error(
        &["sim", &game("demo"), "--seed", "abc"],
        r#"--seed needs a whole number, got "abc""#,
    );
}

// A run whose game loads opens a window, so one still going at the deadline is killed.
fn run_until_it_exits(args: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_game-engine"))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(30) {
            child.kill().unwrap();
            panic!("{args:?} was still running after 30 s");
        }
        thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn run_prints_its_seed_before_loading_so_a_load_error_can_be_repeated() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"dice\"\nscript = { file = \"dice.lua\" }\n",
        ),
        (
            "scripts/dice.lua",
            "print(\"rolled \" .. math.random(1000000))\nerror(\"unlucky\")\n",
        ),
    ]);
    let dir = game.dir.to_str().unwrap();
    let first = run_until_it_exits(&["run", dir]);
    assert_eq!(first.status.code(), Some(1), "{first:?}");
    let (seed_line, rest) = stderr(&first).split_once('\n').unwrap();
    let seed = seed_line
        .strip_prefix("seed ")
        .and_then(|line| line.split_once(' '))
        .map(|(seed, _)| seed)
        .unwrap_or_else(|| panic!("no seed line: {seed_line}"));
    assert_eq!(
        seed_line,
        format!("seed {seed} (repeat with: game-engine run {dir} --seed {seed})")
    );
    let (rolled, error) = rest.split_once('\n').unwrap();
    assert!(rolled.starts_with("[tick 0] rolled "), "{rest}");
    assert_eq!(
        error,
        format!("{}:2: unlucky\n", game.path("scripts/dice.lua"))
    );
    let again = run_until_it_exits(&["run", dir, "--seed", seed]);
    assert_eq!(again.status.code(), Some(1), "{again:?}");
    assert_eq!(stderr(&again), rest);
}

#[test]
fn run_prints_no_seed_line_when_a_set_doesnt_fit_the_scene() {
    let game = TempGame::new(&[("scene.toml", "[[entity]]\nname = \"ball\"\n")]);
    let output = run_until_it_exits(&["run", game.dir.to_str().unwrap(), "--set", "ghost.x=1"]);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        stderr(&output)
            .starts_with("error: --set \"ghost.x=1\": no entity named \"ghost\"\n\nusage: "),
        "{}",
        stderr(&output)
    );
}

const COUNTER_SCRIPT: &str = r#"
function start(self)
  self.presses, self.releases, self.held_ticks = 0, 0, 0
  print(string.format("start: held=%s pressed=%s released=%s",
    input.held("Space"), input.pressed("Space"), input.released("Space")))
end

function update(self, dt)
  if input.pressed("Space") then
    self.presses = self.presses + 1
    print("pressed " .. self.presses)
  end
  if input.released("Space") then
    self.releases = self.releases + 1
    print("released " .. self.releases)
  end
  if input.held("Space") then
    self.held_ticks = self.held_ticks + 1
  end
end
"#;

fn count_presses(flags: &[&str]) -> (String, String) {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"counter\"\nscript = { file = \"counter.lua\" }\n",
        ),
        ("scripts/counter.lua", COUNTER_SCRIPT),
    ]);
    let output = game_engine([&["sim", game.dir.to_str().unwrap()], flags].concat());
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    (stderr(&output).to_owned(), stdout(&output).to_owned())
}

#[test]
fn presses_and_holds_are_pressed_on_their_first_tick_and_released_after_their_last() {
    let (prints, dump) = count_presses(&[
        "--ticks",
        "30",
        "--press",
        "Space@3,10",
        "--hold",
        "Space@20-25",
    ]);
    assert_eq!(
        prints,
        "[tick 0] start: held=false pressed=false released=false\n\
         [tick 3] pressed 1\n\
         [tick 4] released 1\n\
         [tick 10] pressed 2\n\
         [tick 11] released 2\n\
         [tick 20] pressed 3\n\
         [tick 26] released 3\n"
    );
    assert_eq!(
        dump,
        "counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=8 presses=3 releases=3\n"
    );
}

#[test]
fn a_bare_hold_is_pressed_on_tick_1_only() {
    let (prints, dump) = count_presses(&["--ticks", "30", "--hold", "Space"]);
    assert_eq!(
        prints,
        "[tick 0] start: held=false pressed=false released=false\n[tick 1] pressed 1\n"
    );
    assert_eq!(
        dump,
        "counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=30 presses=1 releases=0\n"
    );
}

#[test]
fn spans_can_be_listed_and_open_ended_and_merge_per_key() {
    let (prints, dump) = count_presses(&[
        "--hold",
        "space@2,5-6,9-",
        "--press",
        "SPACE@4",
        "--ticks",
        "12",
    ]);
    assert_eq!(
        prints,
        "[tick 0] start: held=false pressed=false released=false\n\
         [tick 2] pressed 1\n\
         [tick 3] released 1\n\
         [tick 4] pressed 2\n\
         [tick 7] released 2\n\
         [tick 9] pressed 3\n"
    );
    assert_eq!(
        dump,
        "counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=8 presses=3 releases=2\n"
    );
}

#[test]
fn bad_or_misplaced_key_flags_are_usage_errors_but_a_hold_may_end_after_the_run() {
    // Usage errors come before loading, so a regression can't open a window or write a PNG.
    let missing = game("missing");
    let unknown = format!(
        "unknown key \"Esc\" (keys: {})",
        game_engine::Key::names().join(", ")
    );
    for (args, message) in [
        (
            vec!["sim", &missing, "--ticks", "600", "--hold", "Left@0-10"],
            r#"--hold "Left@0-10": ticks start at 1"#,
        ),
        (
            vec!["sim", &missing, "--ticks", "600", "--hold", "Left@30-10"],
            r#"--hold "Left@30-10": 30-10 ends before it starts"#,
        ),
        (
            vec!["sim", &missing, "--ticks", "600", "--hold", "Left@5,x-"],
            r#"--hold "Left@5,x-": expected KEY@SPANS, like Left@30-90"#,
        ),
        (
            vec!["sim", &missing, "--ticks", "600", "--hold", "Left@700-800"],
            r#"--hold "Left@700-800": tick 700 is after --ticks 600"#,
        ),
        (
            vec!["sim", &missing, "--ticks", "600", "--press", "Space@x"],
            r#"--press "Space@x": expected KEY@TICK, like Space@60"#,
        ),
        (
            vec!["sim", &missing, "--ticks", "600", "--press", "Space@5-6"],
            r#"--press "Space@5-6": expected KEY@TICK, like Space@60"#,
        ),
        (
            vec!["shot", &missing, "--press", "Space@700", "--ticks", "600"],
            r#"--press "Space@700": tick 700 is after --ticks 600"#,
        ),
        (vec!["sim", &missing, "--press", "Esc@5"], &unknown),
        (
            vec!["run", &missing, "--hold", "Left"],
            r#"unknown option "--hold""#,
        ),
        (
            vec!["run", &missing, "--press", "Space@60"],
            r#"unknown option "--press""#,
        ),
    ] {
        assert_usage_error(&args, message);
    }
    let (_, dump) = count_presses(&["--ticks", "10", "--hold", "Space@5-20"]);
    assert_eq!(
        dump,
        "counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=6 presses=1 releases=0\n"
    );
}

#[test]
fn a_driver_holds_keys_while_a_condition_on_the_world_holds() {
    let driver = TempGame::new(&[(
        "hold.lua",
        r#"
local done = false

function keys(tick)
  local held = find("counter").held_ticks
  if held < 3 then
    return { "Space" }
  end
  if not done then
    print("let go after " .. held .. " ticks in keys(" .. tick .. ")")
    done = true
  end
  return {}
end
"#,
    )]);
    let (prints, dump) = count_presses(&["--ticks", "10", "--driver", &driver.path("hold.lua")]);
    assert_eq!(
        prints,
        "[tick 0] start: held=false pressed=false released=false\n\
         [tick 1] pressed 1\n\
         [tick 4] let go after 3 ticks in keys(4)\n\
         [tick 4] released 1\n"
    );
    assert_eq!(
        dump,
        "counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=3 presses=1 releases=1\n"
    );
}

#[test]
fn a_drivers_random_numbers_leave_the_games_unchanged() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"dice\"\nscript = { file = \"dice.lua\" }\n",
        ),
        (
            "scripts/dice.lua",
            "function update(self, dt)\n  print(\"game \" .. math.random(1000000))\nend\n",
        ),
        (
            "gambler.lua",
            "function keys(tick)\n  print(\"driver \" .. math.random(1000000))\n  \
             math.randomseed(tick)\n  return {}\nend\n",
        ),
    ]);
    let sim = |flags: &[&str]| {
        let dir = game.dir.to_str().unwrap();
        let output = game_engine([&["sim", dir, "--ticks", "3", "--seed", "7"], flags].concat());
        assert_eq!(output.status.code(), Some(0), "{output:?}");
        stderr(&output).to_owned()
    };
    let alone = sim(&[]);
    let driven = sim(&["--driver", &game.path("gambler.lua")]);
    let (driver_lines, game_lines): (Vec<&str>, Vec<&str>) =
        driven.lines().partition(|line| line.contains("] driver "));
    assert_eq!(game_lines, alone.lines().collect::<Vec<_>>());
    assert_eq!(game_lines.len(), 3);
    // Both streams start from the run's seed, so the first draws match.
    assert_eq!(driver_lines[0].replace("driver", "game"), game_lines[0]);
}

#[test]
fn driver_errors_name_the_driver_and_the_tick() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"paddle\"\n\n\
             [[entity]]\nname = \"ball\"\nscript = { file = \"ball.lua\" }\n",
        ),
        (
            "scripts/ball.lua",
            "function start(self)\n  self.bricks = { { alive = true } }\nend\n",
        ),
        (
            "scripts/util.lua",
            "return { nudge = function() find(\"paddle\").x = 1 end }\n",
        ),
        ("tests/autopilot.lua", ""),
    ]);
    let driven = |driver: &str| {
        Command::new(env!("CARGO_BIN_EXE_game-engine"))
            .current_dir(&game.dir)
            .args(["sim", ".", "--ticks", "20", "--driver", driver])
            .output()
            .unwrap()
    };
    let refused = |line: u32, target: &str, tick: u32| {
        format!(
            "tests/autopilot.lua:{line}: the driver can't change entities (tried to set {target})\n  \
             while running the driver before tick {tick}\n"
        )
    };
    for (source, expected) in [
        (
            "function keys(tick)\n  if tick == 12 then\n    error(\"boom\")\n  end\n  return {}\nend\n",
            "tests/autopilot.lua:3: boom\n  while running the driver before tick 12\n".to_owned(),
        ),
        (
            "local paddle = find(\"paddle\")\n\nfunction keys(tick)\n  if tick == 2 then\n    \
             paddle.x = 0\n  end\n  return {}\nend\n",
            refused(5, "paddle.x", 2),
        ),
        (
            "function keys(tick)\n  find(\"ball\").bricks[1].alive = false\nend\n",
            refused(2, "ball.bricks[1].alive", 1),
        ),
        (
            "function keys(tick)\n  rawset(find(\"paddle\"), \"x\", 0)\nend\n",
            refused(2, "paddle.x", 1),
        ),
        (
            "function keys(tick)\n  load(\"return _G.find\")()(\"paddle\").x = 0\nend\n",
            refused(2, "paddle.x", 1),
        ),
        (
            "function keys(tick)\n  get(\"paddle\").x = 0\nend\n",
            refused(2, "paddle.x", 1),
        ),
        (
            "function keys(tick)\n  find_all(\"pad\")[1].x = 0\nend\n",
            refused(2, "paddle.x", 1),
        ),
        (
            // The driver's copy of a module gets the driver's find.
            "function keys(tick)\n  require(\"util\").nudge()\nend\n",
            "./scripts/util.lua:1: the driver can't change entities (tried to set paddle.x)\n  \
             while running the driver before tick 1\n"
                .to_owned(),
        ),
        (
            "function keys(tick)\n  return tick < 12 and {} or { \"Left\", \"Esc\" }\nend\n",
            format!(
                "tests/autopilot.lua: keys() returned unknown key \"Esc\" before tick 12 (keys: {})\n",
                game_engine::Key::names().join(", ")
            ),
        ),
        (
            "function keys(tick)\n  return 5\nend\n",
            "tests/autopilot.lua: keys() must return a list of key names, got number\n".to_owned(),
        ),
        (
            "function keys(tick)\n  return { false }\nend\n",
            "tests/autopilot.lua: keys() must return a list of key names, got boolean in the list\n"
                .to_owned(),
        ),
        (
            "function key(tick)\n  return {}\nend\n",
            "tests/autopilot.lua: defines no keys(tick)\n".to_owned(),
        ),
        (
            // Three calls of 4 million instructions each pass only if every call gets its own limit.
            "function keys(tick)\n  if tick < 4 then\n    for _ = 1, 4000000 do end\n    return {}\n  end\n  \
             while true do end\nend\n",
            "tests/autopilot.lua:6: script ran too long (more than 10000000 instructions in one call); \
             check for an endless loop\n  while running the driver before tick 4\n"
                .to_owned(),
        ),
    ] {
        fs::write(game.dir.join("tests/autopilot.lua"), source).unwrap();
        let output = driven("tests/autopilot.lua");
        assert_eq!(output.status.code(), Some(1), "{source}");
        assert_eq!(stderr(&output), expected, "{source}");
    }
    let output = driven("tests/missing.lua");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        "tests/missing.lua: No such file or directory (os error 2)\n"
    );
}

#[test]
fn bad_or_misplaced_driver_flags_are_usage_errors() {
    let missing = game("missing");
    let combined = "--driver can't be combined with --hold or --press";
    for (args, message) in [
        (
            vec!["sim", &missing, "--driver", "bot.lua", "--hold", "Left"],
            combined,
        ),
        (
            vec![
                "shot", &missing, "--press", "Space@5", "--driver", "bot.lua",
            ],
            combined,
        ),
        (
            vec!["run", &missing, "--driver", "bot.lua"],
            r#"unknown option "--driver""#,
        ),
        (vec!["sim", &missing, "--driver"], "--driver needs a file"),
    ] {
        assert_usage_error(&args, message);
    }
}

#[test]
fn only_prints_the_entities_its_patterns_match_in_file_order() {
    let game = TempGame::new(&[(
        "scene.toml",
        "[[entity]]\nname = \"brick_1_1\"\n\n[[entity]]\nname = \"brick_1_2\"\n\n\
         [[entity]]\nname = \"brick_2_1\"\n\n[[entity]]\nname = \"ball\"\n",
    )]);
    let output = game_engine([
        "sim",
        game.dir.to_str().unwrap(),
        "--only",
        "ball,brick_1_*",
    ]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(
        stdout(&output),
        "brick_1_1 x=0.0 y=0.0 w=1.0 h=1.0\n\
         brick_1_2 x=0.0 y=0.0 w=1.0 h=1.0\n\
         ball x=0.0 y=0.0 w=1.0 h=1.0\n"
    );
}

#[test]
fn an_only_pattern_that_matches_no_entity_is_a_usage_error() {
    assert_usage_error(
        &["sim", &game("demo"), "--only", "player,balll"],
        r#"--only "balll" matches no entity"#,
    );
    // Patterns are checked against the loaded scene, so a folder that can't load is reported first.
    let output = game_engine(["sim", &game("missing"), "--only", "balll"]);
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn every_prints_each_nth_tick_as_it_ends_between_script_prints() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"wall\"\n\n\
             [[entity]]\nname = \"counter\"\nscript = { file = \"counter.lua\" }\n",
        ),
        ("scripts/counter.lua", COUNTER_SCRIPT),
    ]);
    let log = game.dir.join("log.txt");
    let file = File::create(&log).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_game-engine"))
        .args([
            "sim",
            game.dir.to_str().unwrap(),
            "--ticks",
            "26",
            "--every",
            "10",
            "--only",
            "counter",
            "--press",
            "Space@3,10",
            "--hold",
            "Space@20-25",
        ])
        // A cloned handle shares one file offset, so writes to both streams land in order, as with 2>&1.
        .stdout(file.try_clone().unwrap())
        .stderr(file)
        .status()
        .unwrap();
    let combined = fs::read_to_string(&log).unwrap();
    assert!(status.success(), "{combined}");
    assert_eq!(
        combined,
        "[tick 0] start: held=false pressed=false released=false\n\
         [tick 0] counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=0 presses=0 releases=0\n\
         [tick 3] pressed 1\n\
         [tick 4] released 1\n\
         [tick 10] pressed 2\n\
         [tick 10] counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=2 presses=2 releases=1\n\
         [tick 11] released 2\n\
         [tick 20] pressed 3\n\
         [tick 20] counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=3 presses=3 releases=2\n\
         [tick 26] released 3\n\
         [tick 26] counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=8 presses=3 releases=3\n"
    );
}

#[test]
fn no_dump_leaves_only_script_prints() {
    let (prints, dump) = count_presses(&["--ticks", "5", "--press", "Space@3", "--no-dump"]);
    assert_eq!(
        prints,
        "[tick 0] start: held=false pressed=false released=false\n\
         [tick 3] pressed 1\n\
         [tick 4] released 1\n"
    );
    assert_eq!(dump, "");
}

#[test]
fn a_reader_that_closes_the_pipe_early_is_not_an_error() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"counter\"\nscript = { file = \"counter.lua\" }\n",
        ),
        ("scripts/counter.lua", COUNTER_SCRIPT),
    ]);
    // Writes to a pipe whose reading end is gone fail at once, as after `| head -1` exits.
    let closed = || -> Stdio {
        let (reader, writer) = io::pipe().unwrap();
        drop(reader);
        writer.into()
    };
    let sim = |flags: &[&str], out: Stdio, err: Stdio| {
        let dir = game.dir.to_str().unwrap();
        Command::new(env!("CARGO_BIN_EXE_game-engine"))
            .args([&["sim", dir, "--ticks", "10", "--press", "Space@3"], flags].concat())
            .stdout(out)
            .stderr(err)
            .output()
            .unwrap()
    };
    let start = "[tick 0] start: held=false pressed=false released=false\n";
    let dump = sim(&[], closed(), Stdio::piped());
    assert_eq!(dump.status.code(), Some(0), "{dump:?}");
    assert_eq!(
        stderr(&dump),
        format!("{start}[tick 3] pressed 1\n[tick 4] released 1\n")
    );
    let every = sim(&["--every", "1"], closed(), Stdio::piped());
    assert_eq!(every.status.code(), Some(0), "{every:?}");
    assert_eq!(stderr(&every), start);
    let prints = sim(&[], Stdio::piped(), closed());
    assert_eq!(prints.status.code(), Some(0), "{prints:?}");
    assert_eq!(
        stdout(&prints),
        "counter x=0.0 y=0.0 w=1.0 h=1.0 held_ticks=1 presses=1 releases=1\n"
    );
}

#[test]
fn bad_or_misplaced_dump_flags_are_usage_errors() {
    let missing = game("missing");
    let combined = "--no-dump can't be combined with --only or --every";
    for (args, message) in [
        (
            vec!["sim", &missing, "--no-dump", "--only", "ball"],
            combined,
        ),
        (vec!["sim", &missing, "--every", "5", "--no-dump"], combined),
        (
            vec!["sim", &missing, "--every", "0"],
            r#"--every needs a whole number of at least 1, got "0""#,
        ),
        (
            vec!["shot", &missing, "--only", "ball"],
            r#"unknown option "--only""#,
        ),
        (
            vec!["shot", &missing, "--every", "5"],
            r#"unknown option "--every""#,
        ),
        (
            vec!["shot", &missing, "--no-dump"],
            r#"unknown option "--no-dump""#,
        ),
    ] {
        assert_usage_error(&args, message);
    }
}

#[test]
fn bad_or_misplaced_at_flags_are_usage_errors() {
    let missing = game("missing");
    let expected = "ticks separated by commas, like 30,60,90";
    for (args, message) in [
        (
            vec!["shot", &missing, "--at", "30,700,800", "--ticks", "600"],
            "--at 700 is after --ticks 600".to_owned(),
        ),
        (
            vec!["shot", &missing, "--at", "30,x"],
            format!(r#"--at "30,x": expected {expected}"#),
        ),
        (
            vec!["shot", &missing, "--at"],
            format!("--at needs {expected}"),
        ),
        (
            vec!["sim", &missing, "--at", "30"],
            r#"unknown option "--at""#.to_owned(),
        ),
        (
            vec!["run", &missing, "--at", "30"],
            r#"unknown option "--at""#.to_owned(),
        ),
    ] {
        assert_usage_error(&args, &message);
    }
}

#[test]
fn set_changes_fields_before_the_run_and_a_whole_number_fills_a_float() {
    let output = game_engine([
        "sim",
        &game("demo"),
        "--ticks",
        "60",
        "--hold",
        "D",
        "--set",
        "player.speed=3",
        "--set",
        "rock.x=1",
        "--set",
        "rock.w=0.5",
        "--set",
        "rock.color=[0, 0, 1]",
    ]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(
        stdout(&output),
        "player x=3.5 y=0.5 w=1.0 h=1.0 color=0.0,1.0,0.0,1.0 speed=3.0\n\
         rock x=1.0 y=-0.5 w=0.5 h=1.0 color=0.0,0.0,1.0,1.0\n"
    );
}

#[test]
fn a_set_value_that_isnt_toml_is_a_string_and_start_sees_it() {
    let game = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"game\"\n\
             script = { file = \"game.lua\", mode = \"hard\", body = \"4,8\" }\n\n\
             [[entity]]\nname = \"title\"\ntext = { value = \"0\", size = 0.1 }\n",
        ),
        (
            "scripts/game.lua",
            "function start(self)\n  self.started_as = self.mode\nend\n",
        ),
    ]);
    let output = game_engine([
        "sim",
        game.dir.to_str().unwrap(),
        "--set",
        "game.mode=easy",
        "--set",
        r#"game.body="6,8 5,8""#,
        "--set",
        "title.text=READY",
        "--set",
        "title.color=[1, 0, 0]",
    ]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(
        stdout(&output),
        "game x=0.0 y=0.0 w=1.0 h=1.0 body=\"6,8 5,8\" mode=easy started_as=easy\n\
         title x=0.0 y=0.0 w=1.0 h=1.0 color=1.0,0.0,0.0,1.0 text=READY\n"
    );
}

#[test]
fn bad_or_misplaced_override_flags_are_usage_errors() {
    let temp = TempGame::new(&[
        (
            "scene.toml",
            "[[entity]]\nname = \"game\"\nscript = { file = \"idle.lua\", lives = 3 }\n\n\
             [[entity]]\nname = \"ball\"\nmesh = { shape = \"square\" }\n\n\
             [[entity]]\nname = \"cannon\"\n\
             script = { file = \"idle.lua\", speed = 1.2, left = -1.9, right = 1.9, autopilot = false }\n\n\
             [[entity]]\nname = \"score\"\ntext = { value = \"0\", size = 0.1 }\n",
        ),
        ("scripts/idle.lua", "function update(self, dt) end\n"),
    ]);
    let dir = temp.dir.to_str().unwrap();
    let missing = game("missing");
    let malformed = "expected NAME.FIELD=VALUE, like ball.x=0.5";
    for (args, message) in [
        (
            vec!["sim", dir, "--set", "pipe9.x=1"],
            r#"--set "pipe9.x=1": no entity named "pipe9""#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "cannon.autopilott=true"],
            r#"--set "cannon.autopilott=true": cannon has no field "autopilott" (fields: x, y, w, h, color, autopilot, left, right, speed)"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "cannon.autopilot=yes"],
            r#"--set "cannon.autopilot=yes": autopilot is a boolean in scene.toml"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "ball.w=-1"],
            r#"--set "ball.w=-1": scale values must be greater than 0"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "game.lives=2.5"],
            r#"--set "game.lives=2.5": lives is an integer in scene.toml"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "ball.x=left"],
            r#"--set "ball.x=left": x is a number in scene.toml"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "ball.color=[2, 0, 0]"],
            r#"--set "ball.color=[2, 0, 0]": color values must be between 0 and 1"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "cannon.color=[1, 0, 0]"],
            r#"--set "cannon.color=[1, 0, 0]": cannon has no mesh, so it has no color"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "ball.name=wall"],
            r#"--set "ball.name=wall": name can't be changed"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "score.text=Bien joué"],
            r#"--set "score.text=Bien joué": text can't draw "é""#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "score.text=5"],
            r#"--set "score.text=5": text is a string in scene.toml"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "game.text=HI"],
            r#"--set "game.text=HI": game has no text component, so it has no text"#.to_owned(),
        ),
        (
            vec!["sim", dir, "--set", "score.txt=1"],
            r#"--set "score.txt=1": score has no field "txt" (fields: x, y, w, h, color, text)"#
                .to_owned(),
        ),
        (
            vec!["run", &missing, "--set", "ball"],
            format!(r#"--set "ball": {malformed}"#),
        ),
        (
            vec!["shot", &missing, "--set", "ball=1"],
            format!(r#"--set "ball=1": {malformed}"#),
        ),
        (
            vec!["check", &missing, "--set", "ball.x=1"],
            r#"unknown option "--set""#.to_owned(),
        ),
        (
            vec!["run", &missing, "--scene"],
            "--scene needs a file".to_owned(),
        ),
    ] {
        assert_usage_error(&args, &message);
    }
    // A --set is checked against the loaded scene, so a folder that can't load is reported first.
    let output = game_engine(["sim", &missing, "--set", "ball.x=1"]);
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_scene_file_outside_the_game_folder_takes_scripts_from_the_game_folder() {
    let game = TempGame::new(&[
        ("scene.toml", "[[entity]]\nname = \"usual\"\n"),
        (
            "scripts/mover.lua",
            "function update(self, dt)\n  self.x = self.x + self.speed * dt\nend\n",
        ),
    ]);
    let variants = TempGame::new(&[
        (
            "fast.toml",
            "[[entity]]\nname = \"racer\"\nscript = { file = \"mover.lua\", speed = 2.0 }\n",
        ),
        (
            "broken.toml",
            "[[entity]]\nname = \"racer\"\nscript = { file = \"missing.lua\" }\n",
        ),
    ]);
    let dir = game.dir.to_str().unwrap();
    let fast = variants.path("fast.toml");
    let output = game_engine(["sim", dir, "--scene", &fast, "--ticks", "30"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(stdout(&output), "racer x=1.0 y=0.0 w=1.0 h=1.0 speed=2.0\n");

    let broken = variants.path("broken.toml");
    let output = game_engine(["check", dir, "--scene", &broken]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        format!(
            "{broken}:3: script file {} not found\n",
            game.path("scripts/missing.lua")
        )
    );
}

#[test]
fn game_errors_exit_1_and_usage_errors_exit_2() {
    let missing = game("missing");
    for (args, code) in [
        (vec!["check", &missing], 1),
        (vec!["bogus"], 2),
        (vec!["sim", ""], 2),
    ] {
        assert_eq!(game_engine(&args).status.code(), Some(code), "{args:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_non_utf8_argument_is_a_usage_error() {
    use std::os::unix::ffi::OsStrExt;
    let output = game_engine([OsStr::new("check"), OsStr::from_bytes(b"games/\xff")]);
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn help_anywhere_prints_the_usage() {
    let output = game_engine(["sim", "--help"]);
    assert_eq!(output.status.code(), Some(0));
    assert!(
        stdout(&output).starts_with("usage: game-engine "),
        "{}",
        stdout(&output)
    );
}
