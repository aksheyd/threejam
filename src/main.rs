use std::ffi::OsString;
use std::fmt::Display;
use std::io::{self, Write};
use std::num::NonZeroU64;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use game_engine::{Diagnostic, Frame, Input, Key, Scene, World, create_game, run, screenshot};

#[cfg(test)]
mod test_support;

const USAGE: &str = "usage: game-engine <command> <game folder> [options]

commands:
  new <dir>              create a game from the starter template
  check <dir> [options]  report scene and script errors without running
  sim <dir> [options]    run with no window, then print every entity
  shot <dir> [options]   run with no window, then save one frame as a PNG
  run <dir> [options]    play in a window (Esc quits, Cmd+R or F5 restarts)

options for sim and shot:
  --ticks N              advance N ticks at 60 per second (default 0)
  --hold KEY             hold KEY down on every tick; repeatable
  --hold KEY@SPANS       hold KEY on the ticks in SPANS, a comma list of
                         T, A-B, and A- (A to the end), like Left@5,30-90,120-
  --press KEY@T[,T...]   press KEY for one tick at each T, like Space@60,75
  --driver FILE          before each tick, hold the keys that keys(tick) in
                         the Lua FILE returns; not with --hold or --press

options for shot:
  -o FILE                where to write the PNG (default shot.png)
  --at T[,T...]          save a PNG at each tick T from one run, adding the
                         tick to the name (--at 5,60: shot-05.png and
                         shot-60.png); --ticks defaults to the largest T

options for sim:
  --only NAMES           print only the entities in NAMES, a comma list where
                         * matches any run of characters, like ball,brick_*
  --every N              also print tick 0 and every Nth tick, each line
                         starting with [tick N]
  --no-dump              print no entities

options for sim, shot, and run:
  --seed N               seed for math.random (default 0; run picks a new one)
  --set NAME.FIELD=VALUE change one scene.toml value for this run, like
                         ball.x=0.5 or game.mode=easy; repeatable

options for check, sim, shot, and run:
  --scene FILE           read FILE instead of scene.toml, still taking scripts
                         from the game folder";

// The ticks a key is down on; `parse` merges each key's flags into one entry.
type KeyTicks = (Key, Vec<RangeInclusive<u64>>);

enum Command {
    Help,
    New(PathBuf),
    Check(Game),
    Sim {
        game: Game,
        seed: i64,
        ticks: u64,
        keys: Vec<KeyTicks>,
        dump: Option<Dump>,
    },
    Shot {
        game: Game,
        seed: i64,
        ticks: u64,
        keys: Vec<KeyTicks>,
        frames: Vec<(u64, PathBuf)>,
    },
    Run {
        game: Game,
        seed: Option<i64>,
    },
}

struct Game {
    dir: PathBuf,
    scene: Option<PathBuf>,
    sets: Vec<String>,
    driver: Option<PathBuf>,
}

impl Game {
    fn load(&self, seed: i64) -> Result<World, Failure> {
        let mut world = World::new(self.load_scene()?, seed)?;
        if let Some(driver) = &self.driver {
            world.load_driver(driver)?;
        }
        Ok(world)
    }

    fn load_scene(&self) -> Result<Scene, Failure> {
        let mut scene = Scene::load(&self.dir, self.scene.as_deref())?;
        for text in &self.sets {
            let (name, field, value) = assignment(text).map_err(Failure::Usage)?;
            scene
                .set(name, field, value)
                .map_err(|problem| Failure::Usage(format!("--set {text:?}: {problem}")))?;
        }
        Ok(scene)
    }

    fn run_command(&self, seed: i64) -> String {
        let mut words = vec![self.dir.to_string_lossy()];
        if let Some(scene) = &self.scene {
            words.extend(["--scene".into(), scene.to_string_lossy()]);
        }
        for set in &self.sets {
            words.extend(["--set".into(), set.into()]);
        }
        let words: Vec<String> = words.iter().map(|word| shell_word(word)).collect();
        format!("game-engine run {} --seed {seed}", words.join(" "))
    }
}

struct Dump {
    only: Vec<String>,
    every: Option<NonZeroU64>,
}

enum Kind {
    New,
    Check,
    Sim,
    Shot,
    Run,
}

#[derive(Debug)]
enum Failure {
    Usage(String),
    Game(Vec<Diagnostic>),
    OutputClosed,
}

impl From<Vec<Diagnostic>> for Failure {
    fn from(diagnostics: Vec<Diagnostic>) -> Failure {
        Failure::Game(diagnostics)
    }
}

impl From<Diagnostic> for Failure {
    fn from(diagnostic: Diagnostic) -> Failure {
        Failure::Game(vec![diagnostic])
    }
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let finished = parse(&args)
        .map_err(Failure::Usage)
        .and_then(execute)
        .and_then(|output| write_out(&output));
    match finished {
        Ok(()) | Err(Failure::OutputClosed) => ExitCode::SUCCESS,
        Err(Failure::Usage(message)) => {
            report(
                &mut io::stderr(),
                format_args!("error: {message}\n\n{USAGE}"),
            );
            ExitCode::from(2)
        }
        Err(Failure::Game(diagnostics)) => {
            for diagnostic in diagnostics {
                report(&mut io::stderr(), diagnostic);
            }
            ExitCode::FAILURE
        }
    }
}

fn write_out(text: &str) -> Result<(), Failure> {
    let mut stdout = io::stdout().lock();
    // With --every, each tick's lines must reach stdout before the next tick's script prints reach stderr.
    let written = stdout
        .write_all(text.as_bytes())
        .and_then(|()| stdout.flush());
    written.map_err(|err| match err.kind() {
        io::ErrorKind::BrokenPipe => Failure::OutputClosed,
        _ => Diagnostic(format!("stdout: {err}")).into(),
    })
}

// A stderr that can't be written leaves nowhere to report it, and a closed pipe isn't an error.
fn report(log: &mut dyn Write, message: impl Display) {
    let _ = writeln!(log, "{message}");
}

fn execute(command: Command) -> Result<String, Failure> {
    Ok(match command {
        Command::Help => format!("{USAGE}\n"),
        Command::New(dir) => {
            create_game(&dir).map_err(Diagnostic)?;
            format!("created {0}\nnext: game-engine check {0}\n", dir.display())
        }
        Command::Check(game) => {
            let world = game.load(0)?;
            for file in world.unused_scripts() {
                report(
                    &mut io::stderr(),
                    format_args!("warning: {} isn't used by any entity", file.display()),
                );
            }
            format!("ok: {}\n", world.summary())
        }
        Command::Sim {
            game,
            seed,
            ticks,
            keys,
            dump,
        } => sim(&game, seed, ticks, &keys, dump)?,
        Command::Shot {
            game,
            seed,
            ticks,
            keys,
            frames,
        } => shot(&game, seed, ticks, &keys, &frames)?,
        Command::Run { game, seed } => play(&game, seed)?,
    })
}

fn parse(args: &[OsString]) -> Result<Command, String> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Ok(Command::Help);
    }
    let args = args
        .iter()
        .map(|arg| {
            arg.to_str()
                .ok_or_else(|| format!("argument {arg:?} is not valid UTF-8"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some((&command, rest)) = args.split_first() else {
        return Err("missing command".to_owned());
    };
    let kind = match command {
        "help" => return Ok(Command::Help),
        "new" => Kind::New,
        "check" => Kind::Check,
        "sim" => Kind::Sim,
        "shot" => Kind::Shot,
        "run" => Kind::Run,
        _ => return Err(format!("unknown command {command:?}")),
    };
    let simulates = matches!(kind, Kind::Sim | Kind::Shot);
    let runs = simulates || matches!(kind, Kind::Run);
    let mut dir = None;
    let mut scene = None;
    let mut sets = Vec::new();
    let mut seed = None;
    let mut ticks = None;
    let mut key_flags = Vec::new();
    let mut driver = None;
    let mut only = Vec::new();
    let mut every = None;
    let mut no_dump = false;
    let mut output = PathBuf::from("shot.png");
    let mut at = Vec::new();
    let mut rest = rest.iter().copied();
    while let Some(arg) = rest.next() {
        match arg {
            "--scene" if !matches!(kind, Kind::New) => {
                scene = Some(PathBuf::from(rest.next().ok_or("--scene needs a file")?));
            }
            "--set" if runs => {
                let value = rest
                    .next()
                    .ok_or("--set needs NAME.FIELD=VALUE, like ball.x=0.5")?;
                assignment(value)?;
                sets.push(value.to_owned());
            }
            "--seed" if runs => {
                let value = rest.next().ok_or("--seed needs a whole number")?;
                seed = Some(
                    value
                        .parse()
                        .map_err(|_| format!("--seed needs a whole number, got {value:?}"))?,
                );
            }
            "--ticks" if simulates => {
                let value = rest.next().ok_or("--ticks needs a whole number")?;
                ticks = Some(
                    value
                        .parse()
                        .map_err(|_| format!("--ticks needs a whole number, got {value:?}"))?,
                );
            }
            "--hold" if simulates => {
                key_flags.push((arg, rest.next().ok_or("--hold needs a key")?));
            }
            "--press" if simulates => {
                let value = rest.next().ok_or("--press needs KEY@TICK, like Space@60")?;
                key_flags.push((arg, value));
            }
            "--driver" if simulates => {
                driver = Some(PathBuf::from(rest.next().ok_or("--driver needs a file")?));
            }
            "--only" if matches!(kind, Kind::Sim) => {
                let value = rest.next().ok_or("--only needs entity names")?;
                only.extend(value.split(',').map(str::to_owned));
            }
            "--every" if matches!(kind, Kind::Sim) => {
                let value = rest
                    .next()
                    .ok_or("--every needs a whole number of at least 1")?;
                every = Some(value.parse::<NonZeroU64>().map_err(|_| {
                    format!("--every needs a whole number of at least 1, got {value:?}")
                })?);
            }
            "--no-dump" if matches!(kind, Kind::Sim) => no_dump = true,
            "-o" if matches!(kind, Kind::Shot) => {
                output = PathBuf::from(rest.next().ok_or("-o needs a file")?);
            }
            "--at" if matches!(kind, Kind::Shot) => {
                let expected = "ticks separated by commas, like 30,60,90";
                let value = rest
                    .next()
                    .ok_or_else(|| format!("--at needs {expected}"))?;
                for tick in value.split(',') {
                    at.push(
                        tick.parse::<u64>()
                            .map_err(|_| format!("--at {value:?}: expected {expected}"))?,
                    );
                }
            }
            option if option.starts_with('-') => return Err(format!("unknown option {option:?}")),
            _ if dir.is_some() => return Err(format!("unexpected argument {arg:?}")),
            _ => dir = Some(PathBuf::from(arg)),
        }
    }
    let dir = dir
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| format!("{command} needs a game folder"))?;
    if no_dump && (!only.is_empty() || every.is_some()) {
        return Err("--no-dump can't be combined with --only or --every".to_owned());
    }
    if driver.is_some() && !key_flags.is_empty() {
        return Err("--driver can't be combined with --hold or --press".to_owned());
    }
    let ticks = ticks.or(at.iter().max().copied()).unwrap_or(0);
    if let Some(late) = at.iter().find(|&&tick| tick > ticks) {
        return Err(format!("--at {late} is after --ticks {ticks}"));
    }
    let mut keys: Vec<KeyTicks> = Vec::new();
    for (flag, value) in key_flags {
        let (key, spans) = key_ticks(flag, value, ticks)?;
        match keys.iter_mut().find(|(known, _)| *known == key) {
            Some((_, merged)) => merged.extend(spans),
            None => keys.push((key, spans)),
        }
    }
    let game = Game {
        dir,
        scene,
        sets,
        driver,
    };
    Ok(match kind {
        Kind::New => Command::New(game.dir),
        Kind::Check => Command::Check(game),
        Kind::Sim => Command::Sim {
            game,
            seed: seed.unwrap_or(0),
            ticks,
            keys,
            dump: (!no_dump).then_some(Dump { only, every }),
        },
        Kind::Shot => Command::Shot {
            game,
            seed: seed.unwrap_or(0),
            ticks,
            keys,
            frames: frames(at, ticks, output),
        },
        Kind::Run => Command::Run { game, seed },
    })
}

fn frames(mut at: Vec<u64>, ticks: u64, output: PathBuf) -> Vec<(u64, PathBuf)> {
    let Some(width) = at.iter().max().map(|last| last.to_string().len()) else {
        return vec![(ticks, output)];
    };
    at.sort_unstable();
    at.dedup();
    let stem = output.file_stem().unwrap_or_default();
    at.into_iter()
        .map(|tick| {
            let mut name = stem.to_owned();
            name.push(format!("-{tick:0width$}"));
            if let Some(extension) = output.extension() {
                name.push(".");
                name.push(extension);
            }
            (tick, output.with_file_name(name))
        })
        .collect()
}

fn assignment(text: &str) -> Result<(&str, &str, &str), String> {
    let malformed = || format!("--set {text:?}: expected NAME.FIELD=VALUE, like ball.x=0.5");
    let (target, value) = text.split_once('=').ok_or_else(malformed)?;
    let (name, field) = target.split_once('.').ok_or_else(malformed)?;
    Ok((name, field, value))
}

fn key_ticks(flag: &str, value: &str, ticks: u64) -> Result<KeyTicks, String> {
    let press = flag == "--press";
    let fail = |problem: String| format!("{flag} {value:?}: {problem}");
    let expected = if press {
        "KEY@TICK, like Space@60"
    } else {
        "KEY@SPANS, like Left@30-90"
    };
    let malformed = || fail(format!("expected {expected}"));
    let (name, spans) = match value.split_once('@') {
        Some(parts) => parts,
        None if press => return Err(malformed()),
        None => return Ok((key_named(value)?, std::iter::once(1..=ticks).collect())),
    };
    let key = key_named(name)?;
    let mut ranges = Vec::new();
    for span in spans.split(',') {
        let (first, last) = parse_span(span, !press).ok_or_else(malformed)?;
        if first == 0 {
            return Err(fail("ticks start at 1".to_owned()));
        }
        if last.is_some_and(|last| last < first) {
            return Err(fail(format!("{span} ends before it starts")));
        }
        if first > ticks {
            return Err(fail(format!("tick {first} is after --ticks {ticks}")));
        }
        ranges.push(first..=last.unwrap_or(ticks).min(ticks));
    }
    Ok((key, ranges))
}

fn parse_span(span: &str, ranges: bool) -> Option<(u64, Option<u64>)> {
    let (first, last) = match span.split_once('-') {
        None => (span, Some(span)),
        Some(_) if !ranges => return None,
        Some((first, "")) => (first, None),
        Some((first, last)) => (first, Some(last)),
    };
    Some((first.parse().ok()?, last.map(str::parse).transpose().ok()?))
}

fn key_named(name: &str) -> Result<Key, String> {
    Key::from_name(name).ok_or_else(|| Key::unknown_message(name))
}

fn sim(
    game: &Game,
    seed: i64,
    ticks: u64,
    keys: &[KeyTicks],
    dump: Option<Dump>,
) -> Result<String, Failure> {
    let Some(Dump { only, every }) = dump else {
        simulate(game, seed, ticks, keys)?;
        return Ok(String::new());
    };
    let mut world = game.load(seed)?;
    if let Some(pattern) = only
        .iter()
        .find(|pattern| !world.names().any(|name| pattern_matches(pattern, name)))
    {
        return Err(Failure::Usage(format!(
            "--only {pattern:?} matches no entity"
        )));
    }
    let shown =
        |name: &str| only.is_empty() || only.iter().any(|pattern| pattern_matches(pattern, name));
    advance(&mut world, ticks, keys, |world, tick| match every {
        Some(every) if tick % every == 0 || tick == ticks => print_tick(tick, &world.dump(shown)?),
        _ => Ok(()),
    })?;
    Ok(match every {
        Some(_) => String::new(),
        None => world.dump(shown)?,
    })
}

fn pattern_matches(pattern: &str, name: &str) -> bool {
    let Some((front, last)) = pattern.rsplit_once('*') else {
        return pattern == name;
    };
    let mut parts = front.split('*');
    let Some(mut rest) = parts.next().and_then(|first| name.strip_prefix(first)) else {
        return false;
    };
    for part in parts {
        let Some(at) = rest.find(part) else {
            return false;
        };
        rest = &rest[at + part.len()..];
    }
    rest.ends_with(last)
}

fn print_tick(tick: u64, dump: &str) -> Result<(), Failure> {
    let lines: String = dump
        .lines()
        .map(|line| format!("[tick {tick}] {line}\n"))
        .collect();
    write_out(&lines)
}

fn shot(
    game: &Game,
    seed: i64,
    ticks: u64,
    keys: &[KeyTicks],
    frames: &[(u64, PathBuf)],
) -> Result<String, Failure> {
    let mut world = game.load(seed)?;
    let mut due = frames.iter().peekable();
    let mut shots = Vec::new();
    advance(&mut world, ticks, keys, |world, tick| {
        if let Some((_, path)) = due.next_if(|(at, _)| *at == tick) {
            shots.push((Frame::new(world), path.as_path()));
        }
        Ok(())
    })?;
    screenshot(&shots, &title(&game.dir)).map_err(Diagnostic)?;
    Ok(shots
        .iter()
        .map(|(_, path)| format!("wrote {}\n", path.display()))
        .collect())
}

fn play(game: &Game, seed: Option<i64>) -> Result<String, Failure> {
    let world = session(game, seed, &mut io::stderr())?;
    run(world, &title(&game.dir), |world| {
        reload(game, seed, world, &mut io::stderr())
    })
    .map_err(Diagnostic)?;
    Ok(String::new())
}

// The seed line comes before scripts run, so a load error from a top-level random draw can be repeated.
fn session(game: &Game, seed: Option<i64>, log: &mut dyn Write) -> Result<World, Failure> {
    let scene = game.load_scene()?;
    let seed = seed.unwrap_or_else(|| {
        let seed = clock_seed();
        report(
            log,
            format_args!("seed {seed} (repeat with: {})", game.run_command(seed)),
        );
        seed
    });
    let mut world = World::new(scene, seed)?;
    world.start()?;
    Ok(world)
}

fn reload(game: &Game, seed: Option<i64>, world: &mut World, log: &mut dyn Write) {
    match session(game, seed, log) {
        Ok(fresh) => *world = fresh,
        Err(Failure::Usage(message)) => report(log, format_args!("error: {message}")),
        Err(Failure::Game(diagnostics)) => {
            for diagnostic in diagnostics {
                report(log, diagnostic);
            }
        }
        Err(Failure::OutputClosed) => {}
    }
}

fn clock_seed() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    i64::from(now.subsec_micros())
}

fn simulate(game: &Game, seed: i64, ticks: u64, keys: &[KeyTicks]) -> Result<World, Failure> {
    let mut world = game.load(seed)?;
    advance(&mut world, ticks, keys, |_, _| Ok(()))?;
    Ok(world)
}

fn advance(
    world: &mut World,
    ticks: u64,
    keys: &[KeyTicks],
    mut after_tick: impl FnMut(&World, u64) -> Result<(), Failure>,
) -> Result<(), Failure> {
    world.start()?;
    after_tick(world, 0)?;
    let mut input = Input::default();
    for tick in 1..=ticks {
        for (key, spans) in keys {
            input.set(*key, spans.iter().any(|span| span.contains(&tick)));
        }
        if let Some(held) = world.driver_keys()? {
            input.hold_only(&held);
        }
        world.tick(&input)?;
        input.end_tick();
        after_tick(world, tick)?;
    }
    Ok(())
}

fn title(dir: &Path) -> String {
    dir.canonicalize()
        .ok()
        .and_then(|dir| {
            dir.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "game".to_owned())
}

fn shell_word(word: &str) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "-_./,:@+%".contains(c);
    // zsh expands a word that starts with =.
    if word.starts_with(safe) && word.chars().all(|c| safe(c) || c == '=') {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::TempGame;

    #[test]
    fn a_star_matches_any_run_of_characters() {
        for (pattern, name, expected) in [
            ("ball", "balls", false),
            ("*", "ball", true),
            ("*_2", "brick_1_2", true),
            ("b*_*_2", "brick_1_2", true),
            ("b*_*_2", "brick_2_1", false),
            ("ab*ba", "aba", false),
        ] {
            assert_eq!(pattern_matches(pattern, name), expected, "{pattern} {name}");
        }
    }

    #[test]
    fn at_names_each_frame_after_its_tick_padded_to_the_widest() {
        let parse_frames = |line: &str| {
            let args: Vec<OsString> = line.split(' ').map(OsString::from).collect();
            match parse(&args) {
                Ok(Command::Shot { ticks, frames, .. }) => (ticks, frames),
                Ok(_) => panic!("{line}: not a shot"),
                Err(message) => panic!("{line}: {message}"),
            }
        };
        let path = PathBuf::from;
        assert_eq!(
            parse_frames("shot g --at 100,5,30,5 -o shots/frame.png"),
            (
                100,
                vec![
                    (5, path("shots/frame-005.png")),
                    (30, path("shots/frame-030.png")),
                    (100, path("shots/frame-100.png")),
                ]
            )
        );
        assert_eq!(
            parse_frames("shot g --ticks 600 --at 7 -o frame"),
            (600, vec![(7, path("frame-7"))])
        );
        assert_eq!(
            parse_frames("shot g --at 0"),
            (0, vec![(0, path("shot-0.png"))])
        );
        assert_eq!(
            parse_frames("shot g --ticks 60"),
            (60, vec![(60, path("shot.png"))])
        );
    }

    #[test]
    fn the_repeat_command_keeps_overrides_quoted_for_the_shell() {
        let game = Game {
            dir: PathBuf::from("games/snake"),
            scene: Some(PathBuf::from("tests/full board.toml")),
            sets: vec![
                "game.step_ticks=4".to_owned(),
                r#"game.start_body="6,8 5,8""#.to_owned(),
                "game.note=it's".to_owned(),
            ],
            driver: None,
        };
        assert_eq!(
            game.run_command(7),
            r#"game-engine run games/snake --scene 'tests/full board.toml' --set game.step_ticks=4 --set 'game.start_body="6,8 5,8"' --set 'game.note=it'\''s' --seed 7"#
        );
    }

    #[test]
    fn a_reload_rereads_the_files_keeps_a_given_seed_and_a_load_error_keeps_the_world() {
        let temp = TempGame::new(&[
            (
                "scene.toml",
                "[[entity]]\nname = \"ball\"\nscript = { file = \"ball.lua\", speed = 1.0 }\n",
            ),
            (
                "scripts/ball.lua",
                "function update(self, dt)\n  self.x = self.x + self.speed * dt\nend\n",
            ),
        ]);
        let game = Game {
            dir: temp.dir.clone(),
            scene: None,
            sets: vec!["ball.speed=6".to_owned()],
            driver: None,
        };
        let tick = |world: &mut World| {
            world.tick(&Input::default()).unwrap();
            world.dump(|_| true).unwrap()
        };
        let reload_printing = |seed: Option<i64>, world: &mut World| {
            let mut log = Vec::new();
            reload(&game, seed, world, &mut log);
            String::from_utf8(log).unwrap()
        };
        let seed_line = |printed: &str| {
            let seed: i64 = printed
                .strip_prefix("seed ")
                .and_then(|rest| rest.split_once(' '))
                .and_then(|(seed, _)| seed.parse().ok())
                .unwrap_or_else(|| panic!("no seed line: {printed}"));
            format!("seed {seed} (repeat with: {})\n", game.run_command(seed))
        };
        let mut world = session(&game, Some(0), &mut io::sink()).unwrap();
        assert_eq!(tick(&mut world), "ball x=0.1 y=0.0 w=1.0 h=1.0 speed=6.0\n");

        let broken = "function update(self, dt)\n  self.x =\nend\n";
        fs::write(temp.path("scripts/ball.lua"), broken).unwrap();
        let printed = reload_printing(None, &mut world);
        assert_eq!(
            printed,
            format!(
                "{}{}:3: unexpected symbol near 'end'\n",
                seed_line(&printed),
                temp.path("scripts/ball.lua")
            )
        );
        assert_eq!(tick(&mut world), "ball x=0.2 y=0.0 w=1.0 h=1.0 speed=6.0\n");

        fs::write(
            temp.path("scene.toml"),
            "[[entity]]\nname = \"ball\"\ntransform = { position = [0, 1] }\n\
             script = { file = \"ball.lua\", speed = 1.0 }\n",
        )
        .unwrap();
        let rolled = "function start(self)\n  self.roll = math.random(0)\nend\n";
        fs::write(temp.path("scripts/ball.lua"), rolled).unwrap();
        let replay = session(&game, Some(4172093), &mut io::sink())
            .unwrap()
            .dump(|_| true)
            .unwrap();
        assert!(
            replay.starts_with("ball x=0.0 y=1.0 w=1.0 h=1.0 roll=")
                && replay.ends_with(" speed=6.0\n"),
            "{replay}"
        );
        assert_eq!(reload_printing(Some(4172093), &mut world), "");
        assert_eq!(world.dump(|_| true).unwrap(), replay);
        // Clock seeds are below 1,000,000, so a reload without --seed can't pick 4172093.
        let printed = reload_printing(None, &mut world);
        assert_eq!(printed, seed_line(&printed));
        assert_ne!(world.dump(|_| true).unwrap(), replay);
    }
}
