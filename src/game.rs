use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs;
use std::ops::Range;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use toml::Spanned;

pub const SCENE_FILE: &str = "scene.toml";
pub const SCRIPTS_DIR: &str = "scripts";
pub const RESERVED_FIELDS: [&str; 6] = ["name", "x", "y", "w", "h", "color"];

const DEFAULT_BACKGROUND: [f32; 3] = [0.2, 0.3, 0.3];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic(pub String);

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Square,
    Triangle,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Integer(i64),
    Float(f64),
    Text(String),
    Bool(bool),
}

pub struct MeshDef {
    pub shape: Shape,
    pub color: [f64; 4],
}

pub struct ScriptRef {
    pub path: PathBuf,
    pub values: Vec<(String, Value)>,
}

pub struct EntityDef {
    pub name: String,
    pub position: [f64; 2],
    pub size: [f64; 2],
    pub mesh: Option<MeshDef>,
    pub script: Option<ScriptRef>,
}

pub struct Scene {
    pub background: [f32; 3],
    pub entities: Vec<EntityDef>,
}

pub fn load_scene(dir: &Path) -> Result<Scene, Vec<Diagnostic>> {
    let path = dir.join(SCENE_FILE);
    let source = fs::read_to_string(&path)
        .map_err(|err| vec![Diagnostic(format!("{}: {err}", path.display()))])?;
    parse_scene(&source, dir)
}

pub fn parse_scene(source: &str, dir: &Path) -> Result<Scene, Vec<Diagnostic>> {
    let mut checker = Checker {
        source,
        dir,
        path: dir.join(SCENE_FILE),
        names: HashSet::new(),
        diagnostics: Vec::new(),
    };
    let raw = toml::from_str::<RawScene>(source)
        .map_err(|err| vec![checker.diagnostic(err.span(), err.message())])?;
    let scene = checker.scene(raw);
    if checker.diagnostics.is_empty() {
        Ok(scene)
    } else {
        Err(checker.diagnostics)
    }
}

type ScriptTable = BTreeMap<String, Spanned<toml::Value>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawScene {
    background: Option<Spanned<Vec<f64>>>,
    #[serde(default)]
    entity: Vec<RawEntity>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntity {
    name: Spanned<String>,
    #[serde(default)]
    transform: RawTransform,
    mesh: Option<RawMesh>,
    script: Option<Spanned<ScriptTable>>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTransform {
    position: Option<Spanned<Vec<f64>>>,
    scale: Option<Spanned<Vec<f64>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMesh {
    shape: Spanned<String>,
    color: Option<Spanned<Vec<f64>>>,
}

struct Checker<'a> {
    source: &'a str,
    dir: &'a Path,
    path: PathBuf,
    names: HashSet<String>,
    diagnostics: Vec<Diagnostic>,
}

impl Checker<'_> {
    fn scene(&mut self, raw: RawScene) -> Scene {
        let background = match &raw.background {
            Some(background) => {
                let [r, g, b, _] = self.color("background", background);
                [r as f32, g as f32, b as f32]
            }
            None => DEFAULT_BACKGROUND,
        };
        let entities = raw
            .entity
            .into_iter()
            .map(|entity| self.entity(entity))
            .collect();
        Scene {
            background,
            entities,
        }
    }

    fn entity(&mut self, raw: RawEntity) -> EntityDef {
        let name = raw.name.get_ref();
        let allowed = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if name.is_empty() || !name.chars().all(allowed) {
            self.error(
                raw.name.span(),
                format!(r#"entity name {name:?} can only use letters, digits, "_", and "-""#),
            );
        } else if !self.names.insert(name.clone()) {
            self.error(
                raw.name.span(),
                format!("entity name {name:?} is already used"),
            );
        }
        let position = match &raw.transform.position {
            Some(position) => self.pair("position", position),
            None => [0.0, 0.0],
        };
        let size = match &raw.transform.scale {
            Some(scale) => {
                let size = self.pair("scale", scale);
                if !scale.get_ref().iter().all(|&n| n > 0.0) {
                    self.error(scale.span(), "scale values must be greater than 0");
                }
                size
            }
            None => [1.0, 1.0],
        };
        let mesh = raw.mesh.and_then(|mesh| self.mesh(mesh));
        let script = raw.script.and_then(|script| self.script(script));
        EntityDef {
            name: raw.name.into_inner(),
            position,
            size,
            mesh,
            script,
        }
    }

    fn pair(&mut self, field: &str, numbers: &Spanned<Vec<f64>>) -> [f64; 2] {
        match numbers.get_ref()[..] {
            [a, b] => [a, b],
            _ => {
                let got = numbers.get_ref().len();
                self.error(
                    numbers.span(),
                    format!("{field} needs 2 numbers, got {got}"),
                );
                [0.0; 2]
            }
        }
    }

    fn color(&mut self, field: &str, numbers: &Spanned<Vec<f64>>) -> [f64; 4] {
        let color = match numbers.get_ref()[..] {
            [r, g, b] => [r, g, b, 1.0],
            [r, g, b, a] => [r, g, b, a],
            _ => {
                let got = numbers.get_ref().len();
                self.error(
                    numbers.span(),
                    format!("{field} needs 3 or 4 numbers (r, g, b, optional a), got {got}"),
                );
                [1.0; 4]
            }
        };
        if !numbers.get_ref().iter().all(|n| (0.0..=1.0).contains(n)) {
            self.error(
                numbers.span(),
                format!("{field} values must be between 0 and 1"),
            );
        }
        color
    }

    fn mesh(&mut self, raw: RawMesh) -> Option<MeshDef> {
        let shape = match raw.shape.get_ref().as_str() {
            "square" => Some(Shape::Square),
            "triangle" => Some(Shape::Triangle),
            other => {
                self.error(
                    raw.shape.span(),
                    format!("unknown mesh shape {other:?} (expected \"square\" or \"triangle\")"),
                );
                None
            }
        };
        let color = match &raw.color {
            Some(color) => self.color("color", color),
            None => [1.0; 4],
        };
        Some(MeshDef {
            shape: shape?,
            color,
        })
    }

    fn script(&mut self, raw: Spanned<ScriptTable>) -> Option<ScriptRef> {
        let span = raw.span();
        let mut table = raw.into_inner();
        let path = match table.remove("file") {
            Some(file) => match file.get_ref() {
                toml::Value::String(name) => {
                    let inside = Path::new(name)
                        .components()
                        .all(|part| matches!(part, Component::Normal(_) | Component::CurDir));
                    let path = self.dir.join(SCRIPTS_DIR).join(name);
                    if !inside {
                        self.error(
                            file.span(),
                            format!("script file {name:?} must be a path inside scripts/"),
                        );
                    } else if !path.is_file() {
                        self.error(
                            file.span(),
                            format!("script file {} not found", path.display()),
                        );
                    }
                    Some(path)
                }
                _ => {
                    self.error(file.span(), "script file must be a string");
                    None
                }
            },
            None => {
                self.error(span, "script needs a file, like file = \"player.lua\"");
                None
            }
        };
        let mut values = Vec::new();
        for (key, value) in table {
            if RESERVED_FIELDS.contains(&key.as_str()) {
                self.error(
                    value.span(),
                    format!(
                        "script value {key:?} would overwrite the entity's own {key}; pick another name"
                    ),
                );
            } else if !is_lua_name(&key) {
                self.error(
                    value.span(),
                    format!(
                        r#"script value {key:?} must be a Lua name (letters, digits, and "_", not starting with a digit)"#
                    ),
                );
            }
            let span = value.span();
            let value = match value.into_inner() {
                toml::Value::Integer(n) => Value::Integer(n),
                toml::Value::Float(n) => Value::Float(n),
                toml::Value::String(text) => Value::Text(text),
                toml::Value::Boolean(b) => Value::Bool(b),
                toml::Value::Array(_) | toml::Value::Table(_) | toml::Value::Datetime(_) => {
                    self.error(
                        span,
                        format!("script value {key:?} must be a number, string, or boolean"),
                    );
                    continue;
                }
            };
            values.push((key, value));
        }
        Some(ScriptRef {
            path: path?,
            values,
        })
    }

    fn error(&mut self, span: Range<usize>, message: impl fmt::Display) {
        let diagnostic = self.diagnostic(Some(span), message);
        self.diagnostics.push(diagnostic);
    }

    fn diagnostic(&self, span: Option<Range<usize>>, message: impl fmt::Display) -> Diagnostic {
        let path = self.path.display();
        match span {
            Some(span) => {
                let line = self
                    .source
                    .bytes()
                    .take(span.start)
                    .filter(|&b| b == b'\n')
                    .count()
                    + 1;
                Diagnostic(format!("{path}:{line}: {message}"))
            }
            None => Diagnostic(format!("{path}: {message}")),
        }
    }
}

fn is_lua_name(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempGame;

    #[test]
    fn valid_scene_fills_in_defaults() {
        let source = r#"
[[entity]]
name = "player"
mesh = { shape = "square", color = [0, 1, 0] }

[[entity]]
name = "wall"
transform = { position = [-1.5, 1], scale = [0.25, 3] }
mesh = { shape = "triangle", color = [1.0, 0.4, 0.8, 0.5] }
"#;
        let scene = parse_scene(source, Path::new("games/demo")).unwrap();
        assert_eq!(scene.background, [0.2, 0.3, 0.3]);
        let [player, wall] = &scene.entities[..] else {
            panic!("expected two entities");
        };
        assert_eq!(player.name, "player");
        assert_eq!((player.position, player.size), ([0.0, 0.0], [1.0, 1.0]));
        let mesh = player.mesh.as_ref().unwrap();
        assert_eq!(
            (mesh.shape, mesh.color),
            (Shape::Square, [0.0, 1.0, 0.0, 1.0])
        );
        assert_eq!(wall.name, "wall");
        assert_eq!((wall.position, wall.size), ([-1.5, 1.0], [0.25, 3.0]));
        let mesh = wall.mesh.as_ref().unwrap();
        assert_eq!(
            (mesh.shape, mesh.color),
            (Shape::Triangle, [1.0, 0.4, 0.8, 0.5])
        );
    }

    #[test]
    fn unknown_key_is_one_diagnostic_on_its_line() {
        let source = r#"
[[entity]]
name = "player"
meshh = { shape = "square" }
"#;
        let diagnostics = parse_scene(source, Path::new("games/demo"))
            .err()
            .expect("meshh is rejected");
        let [Diagnostic(message)] = &diagnostics[..] else {
            panic!("expected one diagnostic, got {diagnostics:?}");
        };
        assert!(
            message.starts_with("games/demo/scene.toml:4: ") && message.contains("meshh"),
            "{message}"
        );
    }

    #[test]
    fn every_semantic_error_is_reported_on_its_line() {
        let game = TempGame::new(&[("scripts/paddle.lua", "")]);
        let source = r#"
[[entity]]
name = "ball"

[[entity]]
name = "ball"
mesh = { shape = "circle" }

[[entity]]
name = "paddle"

[entity.mesh]
shape = "square"
color = [1.5, 0, 0]

[entity.script]
file = "paddle.lua"
x = 1
"#;
        let scene = game.path(SCENE_FILE);
        assert_eq!(
            parse_scene(source, &game.dir).err(),
            Some(vec![
                Diagnostic(format!(r#"{scene}:6: entity name "ball" is already used"#)),
                Diagnostic(format!(
                    r#"{scene}:7: unknown mesh shape "circle" (expected "square" or "triangle")"#
                )),
                Diagnostic(format!("{scene}:14: color values must be between 0 and 1")),
                Diagnostic(format!(
                    r#"{scene}:18: script value "x" would overwrite the entity's own x; pick another name"#
                )),
            ])
        );
    }

    #[test]
    fn names_and_script_keys_stay_parseable_in_sim_output() {
        let game = TempGame::new(&[("scripts/paddle.lua", "")]);
        let source = r#"
[[entity]]
name = "left-paddle_2"
script = { file = "paddle.lua", _speed2 = 1 }

[[entity]]
name = "a=b"

[[entity]]
name = ""
script = { file = "paddle.lua", top-speed = 1, 2fast = 1 }
"#;
        let scene = game.path(SCENE_FILE);
        let name = r#"can only use letters, digits, "_", and "-""#;
        let key = r#"must be a Lua name (letters, digits, and "_", not starting with a digit)"#;
        assert_eq!(
            parse_scene(source, &game.dir).err(),
            Some(vec![
                Diagnostic(format!(r#"{scene}:7: entity name "a=b" {name}"#)),
                Diagnostic(format!(r#"{scene}:10: entity name "" {name}"#)),
                Diagnostic(format!(r#"{scene}:11: script value "2fast" {key}"#)),
                Diagnostic(format!(r#"{scene}:11: script value "top-speed" {key}"#)),
            ])
        );
    }

    #[test]
    fn script_files_resolve_inside_the_scripts_folder() {
        let game = TempGame::new(&[
            ("scripts/present.lua", ""),
            (
                SCENE_FILE,
                r#"
[[entity]]
name = "player"
script = { file = "present.lua", speed = 1.5 }
"#,
            ),
        ]);
        let scene = load_scene(&game.dir).unwrap();
        let script = scene.entities[0].script.as_ref().unwrap();
        assert_eq!(script.path, game.dir.join("scripts/present.lua"));
        assert_eq!(script.values, [("speed".to_owned(), Value::Float(1.5))]);

        let source = r#"
[[entity]]
name = "player"
script = { file = "missing.lua" }

[[entity]]
name = "parent"
script = { file = "../scene.toml" }

[[entity]]
name = "absolute"
script = { file = "/abs/paddle.lua" }
"#;
        let scene = game.path(SCENE_FILE);
        assert_eq!(
            parse_scene(source, &game.dir).err(),
            Some(vec![
                Diagnostic(format!(
                    "{scene}:4: script file {} not found",
                    game.path("scripts/missing.lua")
                )),
                Diagnostic(format!(
                    r#"{scene}:8: script file "../scene.toml" must be a path inside scripts/"#
                )),
                Diagnostic(format!(
                    r#"{scene}:12: script file "/abs/paddle.lua" must be a path inside scripts/"#
                )),
            ])
        );
    }
}
