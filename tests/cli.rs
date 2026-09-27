use std::ffi::OsStr;
use std::process::{Command, Output};

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

#[test]
fn check_prints_a_summary() {
    let output = game_engine(["check", &game("demo")]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout(&output), "ok: 2 entities, 1 script\n");
}

#[test]
fn sim_prints_every_entity_after_the_last_tick() {
    let output = game_engine(["sim", &game("demo"), "--ticks", "60", "--hold", "D"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout(&output),
        "player x=2.0 y=0.5 w=1.0 h=1.0 speed=1.5\nrock x=-0.5 y=-0.5 w=1.0 h=1.0\n"
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
