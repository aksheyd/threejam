use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use game_engine::{Diagnostic, Input, Key, World, create_game, run, screenshot};

const USAGE: &str = "usage: game-engine <command> <game folder> [options]

commands:
  new <dir>              create a game from the starter template
  check <dir>            report scene and script errors without running
  sim <dir> [options]    run with no window, then print every entity
  shot <dir> [options]   run with no window, then save one frame as a PNG
  run <dir>              play in a window (Esc quits)

options for sim and shot:
  --ticks N              advance N ticks at 60 per second (default 0)
  --hold KEY             hold KEY down for the whole run; repeatable
  -o FILE                where shot writes the PNG (default shot.png)";

enum Command {
    Help,
    New(PathBuf),
    Check(PathBuf),
    Sim {
        dir: PathBuf,
        ticks: u64,
        held: Vec<Key>,
    },
    Shot {
        dir: PathBuf,
        ticks: u64,
        held: Vec<Key>,
        output: PathBuf,
    },
    Run(PathBuf),
}

enum Kind {
    New,
    Check,
    Sim,
    Shot,
    Run,
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("error: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let result = match command {
        Command::Help => Ok(format!("{USAGE}\n")),
        Command::New(dir) => create_game(&dir)
            .map(|()| format!("created {0}\nnext: game-engine check {0}\n", dir.display()))
            .map_err(|message| vec![Diagnostic(message)]),
        Command::Check(dir) => World::load(&dir).map(|world| format!("ok: {}\n", world.summary())),
        Command::Sim { dir, ticks, held } => sim(&dir, ticks, &held),
        Command::Shot {
            dir,
            ticks,
            held,
            output,
        } => shot(&dir, ticks, &held, &output),
        Command::Run(dir) => play(&dir),
    };
    match result {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err(diagnostics) => {
            for diagnostic in diagnostics {
                eprintln!("{diagnostic}");
            }
            ExitCode::FAILURE
        }
    }
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
    let mut dir = None;
    let mut ticks = 0;
    let mut held = Vec::new();
    let mut output = PathBuf::from("shot.png");
    let mut rest = rest.iter().copied();
    while let Some(arg) = rest.next() {
        match arg {
            "--ticks" if simulates => {
                let value = rest.next().ok_or("--ticks needs a whole number")?;
                ticks = value
                    .parse()
                    .map_err(|_| format!("--ticks needs a whole number, got {value:?}"))?;
            }
            "--hold" if simulates => {
                let name = rest.next().ok_or("--hold needs a key")?;
                let key = Key::from_name(name).ok_or_else(|| {
                    format!("unknown key {name:?} (keys: {})", Key::names().join(", "))
                })?;
                held.push(key);
            }
            "-o" if matches!(kind, Kind::Shot) => {
                output = PathBuf::from(rest.next().ok_or("-o needs a file")?);
            }
            option if option.starts_with('-') => return Err(format!("unknown option {option:?}")),
            _ if dir.is_some() => return Err(format!("unexpected argument {arg:?}")),
            _ => dir = Some(PathBuf::from(arg)),
        }
    }
    let dir = dir
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| format!("{command} needs a game folder"))?;
    Ok(match kind {
        Kind::New => Command::New(dir),
        Kind::Check => Command::Check(dir),
        Kind::Sim => Command::Sim { dir, ticks, held },
        Kind::Shot => Command::Shot {
            dir,
            ticks,
            held,
            output,
        },
        Kind::Run => Command::Run(dir),
    })
}

fn sim(dir: &Path, ticks: u64, held: &[Key]) -> Result<String, Vec<Diagnostic>> {
    simulate(dir, ticks, held)?
        .dump()
        .map_err(|diagnostic| vec![diagnostic])
}

fn shot(dir: &Path, ticks: u64, held: &[Key], output: &Path) -> Result<String, Vec<Diagnostic>> {
    let world = simulate(dir, ticks, held)?;
    screenshot(&world, &title(dir), output).map_err(|message| vec![Diagnostic(message)])?;
    Ok(format!("wrote {}\n", output.display()))
}

fn play(dir: &Path) -> Result<String, Vec<Diagnostic>> {
    let world = simulate(dir, 0, &[])?;
    run(world, &title(dir)).map_err(|message| vec![Diagnostic(message)])?;
    Ok(String::new())
}

fn simulate(dir: &Path, ticks: u64, held: &[Key]) -> Result<World, Vec<Diagnostic>> {
    let mut world = World::load(dir)?;
    let mut input = Input::default();
    for &key in held {
        input.set(key, true);
    }
    advance(&mut world, ticks, &input).map_err(|diagnostic| vec![diagnostic])?;
    Ok(world)
}

fn advance(world: &mut World, ticks: u64, input: &Input) -> Result<(), Diagnostic> {
    world.start()?;
    for _ in 0..ticks {
        world.tick(input)?;
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
