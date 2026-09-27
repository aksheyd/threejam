use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs;
use std::ops::Range;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use toml::Spanned;

use crate::font;

pub const SCENE_FILE: &str = "scene.toml";
pub const SCRIPTS_DIR: &str = "scripts";
pub const RESERVED_FIELDS: [&str; 7] = ["name", "x", "y", "w", "h", "color", "text"];

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
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

pub struct TextDef {
    pub value: String,
    pub size: f64,
    pub align: Align,
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
    pub text: Option<TextDef>,
    pub script: Option<ScriptRef>,
}

pub struct Scene {
    pub background: [f32; 3],
    pub entities: Vec<EntityDef>,
    pub dir: PathBuf,
}

impl Scene {
    pub fn load(dir: &Path, file: Option<&Path>) -> Result<Scene, Vec<Diagnostic>> {
        let path = file.map_or_else(|| dir.join(SCENE_FILE), Path::to_path_buf);
        let source = fs::read_to_string(&path)
            .map_err(|err| vec![Diagnostic(format!("{}: {err}", path.display()))])?;
        parse_scene(&source, &path, dir)
    }

    pub fn set(&mut self, name: &str, field: &str, value: &str) -> Result<(), String> {
        let entity = self
            .entities
            .iter_mut()
            .find(|entity| entity.name == name)
            .ok_or_else(|| format!("no entity named {name:?}"))?;
        let value = value
            .parse()
            .unwrap_or_else(|_| toml::Value::String(value.to_owned()));
        let number =
            || as_number(&value).ok_or_else(|| format!("{field} is a number in scene.toml"));
        let size = || -> Result<f64, String> {
            let size = number()?;
            positive_scale(&[size])?;
            Ok(size)
        };
        match field {
            "x" => entity.position[0] = number()?,
            "y" => entity.position[1] = number()?,
            "w" => entity.size[0] = size()?,
            "h" => entity.size[1] = size()?,
            "color" => {
                let text_color = entity.text.as_mut().map(|text| &mut text.color);
                let slot = entity
                    .mesh
                    .as_mut()
                    .map(|mesh| &mut mesh.color)
                    .or(text_color)
                    .ok_or_else(|| format!("{name} has no mesh, so it has no color"))?;
                let numbers = value
                    .as_array()
                    .and_then(|items| items.iter().map(as_number).collect::<Option<Vec<_>>>())
                    .ok_or("color is an array of numbers in scene.toml")?;
                let color = rgba(field, &numbers)?;
                unit_range(field, &numbers)?;
                *slot = color;
            }
            "text" => {
                let text = entity
                    .text
                    .as_mut()
                    .ok_or_else(|| format!("{name} has no text component, so it has no text"))?;
                let value = value.as_str().ok_or("text is a string in scene.toml")?;
                font::check(value)?;
                text.value = value.to_owned();
            }
            "name" => return Err("name can't be changed".to_owned()),
            _ => {
                let text = entity.text.is_some().then_some("text");
                let values = entity
                    .script
                    .as_mut()
                    .map(|script| script.values.as_mut_slice())
                    .unwrap_or_default();
                let Some((_, slot)) = values.iter_mut().find(|(key, _)| key == field) else {
                    let keys = values.iter().map(|(key, _)| key.as_str());
                    let fields: Vec<&str> = ["x", "y", "w", "h", "color"]
                        .into_iter()
                        .chain(text)
                        .chain(keys)
                        .collect();
                    return Err(format!(
                        "{name} has no field {field:?} (fields: {})",
                        fields.join(", ")
                    ));
                };
                *slot = slot
                    .converted(value)
                    .ok_or_else(|| format!("{field} is {} in scene.toml", slot.kind()))?;
            }
        }
        Ok(())
    }
}

impl Value {
    fn converted(&self, value: toml::Value) -> Option<Value> {
        Some(match (self, value) {
            (Value::Integer(_), toml::Value::Integer(n)) => Value::Integer(n),
            (Value::Float(_), value) => Value::Float(as_number(&value)?),
            (Value::Text(_), toml::Value::String(text)) => Value::Text(text),
            (Value::Bool(_), toml::Value::Boolean(b)) => Value::Bool(b),
            _ => return None,
        })
    }

    fn kind(&self) -> &'static str {
        match self {
            Value::Integer(_) => "an integer",
            Value::Float(_) => "a float",
            Value::Text(_) => "a string",
            Value::Bool(_) => "a boolean",
        }
    }
}

fn as_number(value: &toml::Value) -> Option<f64> {
    match *value {
        toml::Value::Integer(n) => Some(n as f64),
        toml::Value::Float(n) => Some(n),
        _ => None,
    }
}

fn positive_scale(size: &[f64]) -> Result<(), &'static str> {
    if size.iter().all(|&n| n > 0.0) {
        Ok(())
    } else {
        Err("scale values must be greater than 0")
    }
}

fn rgba(field: &str, numbers: &[f64]) -> Result<[f64; 4], String> {
    match *numbers {
        [r, g, b] => Ok([r, g, b, 1.0]),
        [r, g, b, a] => Ok([r, g, b, a]),
        _ => Err(format!(
            "{field} needs 3 or 4 numbers (r, g, b, optional a), got {}",
            numbers.len()
        )),
    }
}

fn unit_range(field: &str, numbers: &[f64]) -> Result<(), String> {
    if numbers.iter().all(|n| (0.0..=1.0).contains(n)) {
        Ok(())
    } else {
        Err(format!("{field} values must be between 0 and 1"))
    }
}

pub fn parse_scene(source: &str, path: &Path, dir: &Path) -> Result<Scene, Vec<Diagnostic>> {
    let mut checker = Checker {
        source,
        dir,
        path,
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
    text: Option<Spanned<RawText>>,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawText {
    value: Spanned<String>,
    size: Spanned<f64>,
    align: Option<Spanned<String>>,
    color: Option<Spanned<Vec<f64>>>,
}

struct Checker<'a> {
    source: &'a str,
    dir: &'a Path,
    path: &'a Path,
    names: HashSet<String>,
    diagnostics: Vec<Diagnostic>,
}

impl Checker<'_> {
    fn scene(&mut self, raw: RawScene) -> Scene {
        let background = match &raw.background {
            Some(background) => self.background(background),
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
            dir: self.dir.to_path_buf(),
        }
    }

    fn entity(&mut self, raw: RawEntity) -> EntityDef {
        let name = raw.name.get_ref();
        if let Err(problem) = check_name("entity", name) {
            self.error(raw.name.span(), problem);
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
                if let Err(problem) = positive_scale(scale.get_ref()) {
                    self.error(scale.span(), problem);
                }
                size
            }
            None => [1.0, 1.0],
        };
        if let (Some(_), Some(text)) = (&raw.mesh, &raw.text) {
            self.error(text.span(), "an entity can have mesh or text, not both");
        }
        let mesh = raw.mesh.and_then(|mesh| self.mesh(mesh));
        let text = raw.text.and_then(|text| self.text(text.into_inner()));
        let script = raw.script.and_then(|script| self.script(script));
        EntityDef {
            name: raw.name.into_inner(),
            position,
            size,
            mesh,
            text,
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

    fn background(&mut self, numbers: &Spanned<Vec<f64>>) -> [f32; 3] {
        let background = match numbers.get_ref()[..] {
            [r, g, b] => [r as f32, g as f32, b as f32],
            _ => {
                let got = numbers.get_ref().len();
                self.error(
                    numbers.span(),
                    format!("background needs 3 numbers (r, g, b), got {got}"),
                );
                DEFAULT_BACKGROUND
            }
        };
        if let Err(problem) = unit_range("background", numbers.get_ref()) {
            self.error(numbers.span(), problem);
        }
        background
    }

    fn color(&mut self, numbers: &Spanned<Vec<f64>>) -> [f64; 4] {
        let color = rgba("color", numbers.get_ref()).unwrap_or_else(|problem| {
            self.error(numbers.span(), problem);
            [1.0; 4]
        });
        if let Err(problem) = unit_range("color", numbers.get_ref()) {
            self.error(numbers.span(), problem);
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
            Some(color) => self.color(color),
            None => [1.0; 4],
        };
        Some(MeshDef {
            shape: shape?,
            color,
        })
    }

    fn text(&mut self, raw: RawText) -> Option<TextDef> {
        if let Err(problem) = font::check(raw.value.get_ref()) {
            self.error(raw.value.span(), problem);
        }
        let size = *raw.size.get_ref();
        if size.is_nan() || size <= 0.0 {
            self.error(raw.size.span(), "size must be greater than 0");
        }
        let align = match &raw.align {
            None => Some(Align::Center),
            Some(align) => match align.get_ref().as_str() {
                "left" => Some(Align::Left),
                "center" => Some(Align::Center),
                "right" => Some(Align::Right),
                other => {
                    self.error(
                        align.span(),
                        format!(
                            r#"unknown text align {other:?} (expected "left", "center", or "right")"#
                        ),
                    );
                    None
                }
            },
        };
        let color = match &raw.color {
            Some(color) => self.color(color),
            None => [1.0; 4],
        };
        Some(TextDef {
            value: raw.value.into_inner(),
            size,
            align: align?,
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

pub fn check_name(kind: &str, name: &str) -> Result<(), String> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    if !name.is_empty() && name.chars().all(allowed) {
        Ok(())
    } else {
        Err(format!(
            r#"{kind} name {name:?} can only use letters, digits, "_", and "-""#
        ))
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

[[entity]]
name = "score"
text = { value = "Score 0", size = 1 }

[[entity]]
name = "title"
text = { value = "", size = 0.25, align = "right", color = [1, 0, 0] }
"#;
        let dir = Path::new("games/demo");
        let scene = parse_scene(source, &dir.join(SCENE_FILE), dir).unwrap();
        assert_eq!(scene.background, [0.2, 0.3, 0.3]);
        let [player, wall, score, title] = &scene.entities[..] else {
            panic!("expected four entities");
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
        let text = |entity: &EntityDef| {
            let text = entity.text.as_ref().unwrap();
            (text.value.clone(), text.size, text.align, text.color)
        };
        assert_eq!(
            text(score),
            ("Score 0".to_owned(), 1.0, Align::Center, [1.0; 4])
        );
        assert_eq!(
            text(title),
            (String::new(), 0.25, Align::Right, [1.0, 0.0, 0.0, 1.0])
        );
    }

    #[test]
    fn background_needs_exactly_3_numbers() {
        let dir = Path::new("games/demo");
        for (background, got) in [("[0.1, 0.2, 0.3, 1.0]", 4), ("[0.1, 0.2]", 2)] {
            let source = format!("background = {background}\n");
            assert_eq!(
                parse_scene(&source, &dir.join(SCENE_FILE), dir).err(),
                Some(vec![Diagnostic(format!(
                    "games/demo/scene.toml:1: background needs 3 numbers (r, g, b), got {got}"
                ))])
            );
        }
    }

    #[test]
    fn unknown_key_is_one_diagnostic_on_its_line() {
        let source = r#"
[[entity]]
name = "player"
meshh = { shape = "square" }
"#;
        let dir = Path::new("games/demo");
        let diagnostics = parse_scene(source, &dir.join(SCENE_FILE), dir)
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
            parse_scene(source, &game.dir.join(SCENE_FILE), &game.dir).err(),
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
    fn text_errors_are_reported_on_their_lines() {
        let game = TempGame::new(&[("scripts/title.lua", "")]);
        let source = r#"
[[entity]]
name = "score"
mesh = { shape = "square" }

[entity.text]
value = "Score é"
size = 0
align = "middle"
color = [2, 0, 0]

[[entity]]
name = "title"
script = { file = "title.lua", text = "hi" }
"#;
        let scene = game.path(SCENE_FILE);
        assert_eq!(
            parse_scene(source, &game.dir.join(SCENE_FILE), &game.dir).err(),
            Some(vec![
                Diagnostic(format!(
                    "{scene}:6: an entity can have mesh or text, not both"
                )),
                Diagnostic(format!(r#"{scene}:7: text can't draw "é""#)),
                Diagnostic(format!("{scene}:8: size must be greater than 0")),
                Diagnostic(format!(
                    r#"{scene}:9: unknown text align "middle" (expected "left", "center", or "right")"#
                )),
                Diagnostic(format!("{scene}:10: color values must be between 0 and 1")),
                Diagnostic(format!(
                    r#"{scene}:14: script value "text" would overwrite the entity's own text; pick another name"#
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
            parse_scene(source, &game.dir.join(SCENE_FILE), &game.dir).err(),
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
        let scene = Scene::load(&game.dir, None).unwrap();
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
            parse_scene(source, &game.dir.join(SCENE_FILE), &game.dir).err(),
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
