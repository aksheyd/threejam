use std::fs;
use std::io;
use std::path::Path;

const FILES: [(&str, &str); 3] = [
    ("scene.toml", include_str!("../games/demo/scene.toml")),
    (
        "scripts/player.lua",
        include_str!("../games/demo/scripts/player.lua"),
    ),
    ("AGENTS.md", include_str!("../games/demo/AGENTS.md")),
];

pub fn create_game(dir: &Path) -> Result<(), String> {
    let error = |path: &Path, err: io::Error| format!("{}: {err}", path.display());
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|err| error(parent, err))?;
    }
    fs::create_dir(dir).map_err(|err| match err.kind() {
        io::ErrorKind::AlreadyExists => format!("{} already exists", dir.display()),
        _ => error(dir, err),
    })?;
    let scripts = dir.join("scripts");
    fs::create_dir(&scripts).map_err(|err| error(&scripts, err))?;
    for (name, contents) in FILES {
        let path = dir.join(name);
        fs::write(&path, contents).map_err(|err| error(&path, err))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempGame;
    use crate::world::World;

    #[test]
    fn create_game_writes_a_game_that_loads() {
        let temp = TempGame::new(&[]);
        let dir = temp.dir.join("game");
        create_game(&dir).unwrap();
        assert_eq!(
            World::load(&dir, 0).unwrap().summary(),
            "2 entities, 1 script"
        );
    }

    #[test]
    fn create_game_refuses_an_existing_folder() {
        let temp = TempGame::new(&[]);
        let dir = temp.dir.join("game");
        create_game(&dir).unwrap();
        assert_eq!(
            create_game(&dir),
            Err(format!("{} already exists", dir.display()))
        );
    }
}
