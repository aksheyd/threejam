use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use glam::{Vec2, Vec4};
use mlua::{
    ChunkMode, Function, HookTriggers, Lua, LuaOptions, StdLib, Table, Value as LuaValue, VmState,
};

use crate::game::{self, Diagnostic, EntityDef, RESERVED_FIELDS, Scene, Shape, Value};
use crate::input::{Input, Key};

pub const TICKS_PER_SECOND: u32 = 60;
pub const DT: f64 = 1.0 / TICKS_PER_SECOND as f64;

// luaconf.h: a longer chunk name shows as "..." plus the tail that fits with a NUL terminator.
const LUA_IDSIZE: usize = 60;

// Scripts without an endless loop stay far below this in any one call.
const MAX_INSTRUCTIONS: u64 = 10_000_000;
const INSTRUCTIONS_PER_HOOK: u32 = 1000;

const PRELUDE: &str = include_str!("prelude.lua");

#[derive(Clone, Copy, Debug)]
pub struct Sprite {
    pub shape: Shape,
    pub position: Vec2,
    pub size: Vec2,
    pub color: Vec4,
}

pub struct World {
    entities: Vec<Entity>,
    scripts: Vec<Script>,
    input: Rc<RefCell<Input>>,
    tick: Rc<Cell<u64>>,
    instructions: Rc<Cell<u64>>,
    background: [f32; 3],
    // Tables and functions stay usable only while the state they belong to is alive.
    _lua: Lua,
}

struct Entity {
    name: String,
    shape: Option<Shape>,
    table: Table,
    script: Option<usize>,
}

struct Script {
    path: PathBuf,
    start: Option<Function>,
    update: Option<Function>,
}

impl World {
    pub fn load(dir: &Path) -> Result<World, Vec<Diagnostic>> {
        let scene = game::load_scene(dir)?;
        let (world, diagnostics) = World::build(scene).map_err(|err| vec![diagnostic(err)])?;
        if diagnostics.is_empty() {
            Ok(world)
        } else {
            Err(diagnostics)
        }
    }

    fn build(scene: Scene) -> mlua::Result<(World, Vec<Diagnostic>)> {
        let lua = Lua::new_with(
            StdLib::STRING | StdLib::TABLE | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE,
            LuaOptions::default(),
        )?;
        let mut entities = Vec::new();
        let mut paths: Vec<PathBuf> = Vec::new();
        for def in scene.entities {
            let table = entity_table(&lua, &def)?;
            let script = def.script.map(|script| {
                paths
                    .iter()
                    .position(|path| *path == script.path)
                    .unwrap_or_else(|| {
                        paths.push(script.path);
                        paths.len() - 1
                    })
            });
            entities.push(Entity {
                name: def.name,
                shape: def.mesh.map(|mesh| mesh.shape),
                table,
                script,
            });
        }

        let input = Rc::new(RefCell::new(Input::default()));
        let tick = Rc::new(Cell::new(0));
        let held = {
            let input = Rc::clone(&input);
            lua.create_function(move |_, name: LuaValue| {
                let key = match name {
                    LuaValue::String(name) => Key::from_name(&name.to_string_lossy()),
                    LuaValue::Integer(n) => Key::from_name(&n.to_string()),
                    _ => None,
                };
                Ok(key.map(|key| input.borrow().is_held(key)))
            })?
        };
        let log = {
            let tick = Rc::clone(&tick);
            lua.create_function(move |_, text: mlua::String| {
                eprintln!("[tick {}] {}", tick.get(), text.to_string_lossy());
                Ok(())
            })?
        };
        let by_name = lua.create_table_from(
            entities
                .iter()
                .map(|entity| (entity.name.as_str(), &entity.table)),
        )?;
        let in_file_order =
            lua.create_sequence_from(entities.iter().map(|entity| &entity.table))?;
        lua.load(PRELUDE).set_name("=prelude").call::<()>((
            held,
            log,
            by_name,
            in_file_order,
            Key::names().join(", "),
        ))?;

        let instructions = Rc::new(Cell::new(0));
        lua.set_global_hook(
            HookTriggers::new().every_nth_instruction(INSTRUCTIONS_PER_HOOK),
            {
                let instructions = Rc::clone(&instructions);
                move |lua, _| {
                    instructions.set(instructions.get() + u64::from(INSTRUCTIONS_PER_HOOK));
                    if instructions.get() <= MAX_INSTRUCTIONS {
                        return Ok(VmState::Continue);
                    }
                    Err(mlua::Error::runtime(format!(
                        "{}script ran too long (more than {MAX_INSTRUCTIONS} instructions in one call); \
                         check for an endless loop",
                        running_script_line(lua)
                    )))
                }
            },
        )?;

        let mut diagnostics = Vec::new();
        let mut scripts = Vec::new();
        for path in &paths {
            instructions.set(0);
            scripts.push(load_script(&lua, path, &paths, &mut diagnostics)?);
        }
        let world = World {
            entities,
            scripts,
            input,
            tick,
            instructions,
            background: scene.background,
            _lua: lua,
        };
        Ok((world, diagnostics))
    }

    pub fn start(&mut self) -> Result<(), Diagnostic> {
        for entity in &self.entities {
            let Some(start) = entity.script.and_then(|i| self.scripts[i].start.as_ref()) else {
                continue;
            };
            self.instructions.set(0);
            start
                .call::<()>(&entity.table)
                .map_err(|err| self.failure(&err, "start", entity))?;
        }
        self.check("start")
    }

    pub fn tick(&mut self, input: &Input) -> Result<(), Diagnostic> {
        self.input.replace(input.clone());
        self.tick.set(self.tick.get() + 1);
        for entity in &self.entities {
            let Some(update) = entity.script.and_then(|i| self.scripts[i].update.as_ref()) else {
                continue;
            };
            self.instructions.set(0);
            update
                .call::<()>((&entity.table, DT))
                .map_err(|err| self.failure(&err, "update", entity))?;
        }
        self.check("update")
    }

    fn check(&self, phase: &str) -> Result<(), Diagnostic> {
        for entity in &self.entities {
            entity.check().map_err(|Diagnostic(message)| {
                Diagnostic(format!(
                    "{message}\n  after {phase} at tick {}",
                    self.tick.get()
                ))
            })?;
        }
        Ok(())
    }

    fn failure(&self, err: &mlua::Error, phase: &str, entity: &Entity) -> Diagnostic {
        let paths = self.scripts.iter().map(|script| script.path.as_path());
        Diagnostic(format!(
            "{}\n  while running {phase} for entity {:?} at tick {}",
            lua_message(err, paths),
            entity.name,
            self.tick.get()
        ))
    }

    pub(crate) fn sprites(&self) -> Result<Vec<Sprite>, Diagnostic> {
        self.entities
            .iter()
            .filter_map(|entity| entity.shape.map(|shape| entity.sprite(shape)))
            .collect()
    }

    pub fn dump(&self) -> Result<String, Diagnostic> {
        let mut dump = String::new();
        for entity in &self.entities {
            let mut fields = vec![entity.name.clone()];
            for key in ["x", "y", "w", "h"] {
                let text =
                    format_number(&entity.get(key)?).ok_or_else(|| entity.not_a_number(key))?;
                fields.push(format!("{key}={text}"));
            }
            let mut extra = BTreeMap::new();
            for pair in entity.table.pairs::<LuaValue, LuaValue>() {
                let (key, value) = pair.map_err(diagnostic)?;
                if let (LuaValue::String(key), Some(text)) = (key, format_value(&value)) {
                    let key = key.to_string_lossy();
                    if !RESERVED_FIELDS.contains(&key.as_str()) {
                        extra.insert(key, text);
                    }
                }
            }
            fields.extend(extra.iter().map(|(key, text)| format!("{key}={text}")));
            dump.push_str(&fields.join(" "));
            dump.push('\n');
        }
        Ok(dump)
    }

    pub(crate) fn background(&self) -> [f32; 3] {
        self.background
    }

    pub fn summary(&self) -> String {
        let (entities, scripts) = (self.entities.len(), self.scripts.len());
        format!(
            "{entities} {}, {scripts} {}",
            if entities == 1 { "entity" } else { "entities" },
            if scripts == 1 { "script" } else { "scripts" }
        )
    }
}

impl Entity {
    fn check(&self) -> Result<(), Diagnostic> {
        for key in ["x", "y", "w", "h"] {
            self.number(key)?;
        }
        if self.shape.is_some() {
            self.color()?;
        }
        Ok(())
    }

    fn sprite(&self, shape: Shape) -> Result<Sprite, Diagnostic> {
        Ok(Sprite {
            shape,
            position: Vec2::new(self.number("x")?, self.number("y")?),
            size: Vec2::new(self.number("w")?, self.number("h")?),
            color: self.color()?,
        })
    }

    fn number(&self, key: &str) -> Result<f32, Diagnostic> {
        as_number(&self.get(key)?)
            .map(|n| n as f32)
            .ok_or_else(|| self.not_a_number(key))
    }

    fn color(&self) -> Result<Vec4, Diagnostic> {
        let invalid = || self.error("color must be {r, g, b} or {r, g, b, a}");
        let LuaValue::Table(color) = self.get("color")? else {
            return Err(invalid());
        };
        let len = color.raw_len();
        if !(3..=4).contains(&len) {
            return Err(invalid());
        }
        let mut rgba = Vec4::ONE;
        for i in 0..len {
            let channel = color.raw_get(i + 1).map_err(diagnostic)?;
            rgba[i] = as_number(&channel).ok_or_else(invalid)? as f32;
        }
        Ok(rgba)
    }

    fn get(&self, key: &str) -> Result<LuaValue, Diagnostic> {
        self.table.raw_get(key).map_err(diagnostic)
    }

    fn not_a_number(&self, key: &str) -> Diagnostic {
        self.error(&format!("{key} must be a number"))
    }

    fn error(&self, message: &str) -> Diagnostic {
        Diagnostic(format!("entity {:?}: {message}", self.name))
    }
}

fn entity_table(lua: &Lua, def: &EntityDef) -> mlua::Result<Table> {
    let table = lua.create_table()?;
    table.set("name", def.name.as_str())?;
    table.set("x", def.position[0])?;
    table.set("y", def.position[1])?;
    table.set("w", def.size[0])?;
    table.set("h", def.size[1])?;
    if let Some(mesh) = &def.mesh {
        table.set("color", lua.create_sequence_from(mesh.color)?)?;
    }
    for (key, value) in def.script.iter().flat_map(|script| &script.values) {
        match value {
            Value::Integer(n) => table.set(key.as_str(), *n)?,
            Value::Float(n) => table.set(key.as_str(), *n)?,
            Value::Text(text) => table.set(key.as_str(), text.as_str())?,
            Value::Bool(b) => table.set(key.as_str(), *b)?,
        }
    }
    Ok(table)
}

fn load_script(
    lua: &Lua,
    path: &Path,
    paths: &[PathBuf],
    diagnostics: &mut Vec<Diagnostic>,
) -> mlua::Result<Script> {
    let mut script = Script {
        path: path.to_owned(),
        start: None,
        update: None,
    };
    let source = match fs::read(path) {
        Ok(source) => source,
        Err(err) => {
            diagnostics.push(Diagnostic(format!("{}: {err}", path.display())));
            return Ok(script);
        }
    };
    let env = lua.create_table()?;
    let meta = lua.create_table()?;
    meta.set("__index", lua.globals())?;
    env.set_metatable(Some(meta))?;
    let chunk = lua
        .load(source)
        .set_name(chunk_name(path))
        .set_environment(env.clone())
        .set_mode(ChunkMode::Text);
    if let Err(err) = chunk.exec() {
        let message = lua_message(&err, paths.iter().map(PathBuf::as_path));
        let file = path.display().to_string();
        // Some load errors, like a binary chunk in text mode, don't name the file.
        diagnostics.push(Diagnostic(if message.starts_with(&file) {
            message
        } else {
            format!("{file}: {message}")
        }));
        return Ok(script);
    }
    let start = env.raw_get::<LuaValue>("start")?;
    let update = env.raw_get::<LuaValue>("update")?;
    if start.is_nil() && update.is_nil() {
        diagnostics.push(Diagnostic(format!(
            "{}: defines neither start(self) nor update(self, dt)",
            path.display()
        )));
    }
    script.start = function(start, "start", path, diagnostics);
    script.update = function(update, "update", path, diagnostics);
    Ok(script)
}

fn function(
    value: LuaValue,
    name: &str,
    path: &Path,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Function> {
    match value {
        LuaValue::Nil => None,
        LuaValue::Function(function) => Some(function),
        _ => {
            diagnostics.push(Diagnostic(format!(
                "{}: {name} must be a function",
                path.display()
            )));
            None
        }
    }
}

fn lua_message<'a>(mut err: &mlua::Error, paths: impl IntoIterator<Item = &'a Path>) -> String {
    while let mlua::Error::CallbackError { cause, .. } = err {
        err = cause;
    }
    let mut message = match err {
        mlua::Error::SyntaxError { message, .. } | mlua::Error::RuntimeError(message) => {
            message.clone()
        }
        other => other.to_string(),
    };
    if let Some(end) = message.find("\nstack traceback:") {
        message.truncate(end);
    }
    for path in paths {
        let name = chunk_name(path);
        if name.len() > LUA_IDSIZE {
            let kept = LUA_IDSIZE - "...".len() - 1;
            let tail = String::from_utf8_lossy(&name.as_bytes()[name.len() - kept..]);
            message = message.replace(&format!("...{tail}"), &path.display().to_string());
        }
    }
    message
}

fn chunk_name(path: &Path) -> String {
    format!("@{}", path.display())
}

// The hook can fire inside the prelude or a load()ed chunk, so report the nearest script file line.
fn running_script_line(lua: &Lua) -> String {
    (0..)
        .map_while(|level| {
            lua.inspect_stack(level, |frame| {
                let source = frame.source().source?;
                let path = source.strip_prefix('@')?;
                Some(format!("{path}:{}: ", frame.current_line()?))
            })
        })
        .flatten()
        .next()
        .unwrap_or_default()
}

fn diagnostic(err: mlua::Error) -> Diagnostic {
    Diagnostic(lua_message(&err, []))
}

fn as_number(value: &LuaValue) -> Option<f64> {
    match *value {
        LuaValue::Integer(n) => Some(n as f64),
        LuaValue::Number(n) => Some(n),
        _ => None,
    }
}

fn format_number(value: &LuaValue) -> Option<String> {
    match *value {
        LuaValue::Integer(n) => Some(n.to_string()),
        LuaValue::Number(n) => {
            let rounded = format!("{n:.4}");
            let trimmed = rounded.trim_end_matches('0');
            Some(match trimmed {
                "-0." => "0.0".to_owned(),
                _ if trimmed.ends_with('.') => format!("{trimmed}0"),
                _ => trimmed.to_owned(),
            })
        }
        _ => None,
    }
}

fn format_value(value: &LuaValue) -> Option<String> {
    match value {
        LuaValue::Boolean(b) => Some(b.to_string()),
        LuaValue::String(text) => {
            let text = text.to_string_lossy();
            let plain = !text.is_empty()
                && !text.contains(|c: char| c.is_whitespace() || c == '=' || c == '"');
            Some(if plain { text } else { format!("{text:?}") })
        }
        _ => format_number(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::SCENE_FILE;
    use crate::test_support::TempGame;

    const BALL: &str = r#"
[[entity]]
name = "ball"
script = { file = "ball.lua" }
"#;
    const BALL_SCRIPT: &str = "scripts/ball.lua";

    fn ball_game(scene: &str, script: &str) -> TempGame {
        TempGame::new(&[(SCENE_FILE, scene), (BALL_SCRIPT, script)])
    }

    #[test]
    fn start_update_and_find_work_together() {
        let game = ball_game(
            r#"
[[entity]]
name = "wall"
transform = { position = [1.5, 0.0] }

[[entity]]
name = "ball"
script = { file = "ball.lua", speed = 2 }
"#,
            r#"
function start(self)
  self.vx = self.speed
end

function update(self, dt)
  self.x = self.x + self.vx * dt
  self.wall_x = find("wall").x
end
"#,
        );
        let mut world = World::load(&game.dir).unwrap();
        world.start().unwrap();
        for _ in 0..30 {
            world.tick(&Input::default()).unwrap();
        }
        assert_eq!(
            world.dump().unwrap(),
            "wall x=1.5 y=0.0 w=1.0 h=1.0\nball x=1.0 y=0.0 w=1.0 h=1.0 speed=2 vx=2 wall_x=1.5\n"
        );
    }

    #[test]
    fn runtime_errors_name_the_line_the_entity_and_the_tick() {
        let game = ball_game(
            BALL,
            "function update(self, dt)\n  self.x = self.x + nil\nend\n",
        );
        let mut world = World::load(&game.dir).unwrap();
        world.start().unwrap();
        let Diagnostic(message) = world.tick(&Input::default()).unwrap_err();
        let (first, second) = message.split_once('\n').unwrap();
        assert!(
            first.starts_with(&format!("{}:2:", game.path(BALL_SCRIPT))),
            "{message}"
        );
        assert_eq!(
            second,
            r#"  while running update for entity "ball" at tick 1"#
        );
    }

    #[test]
    fn a_bad_value_fails_the_tick_that_set_it() {
        let game = ball_game(
            r#"
[[entity]]
name = "ball"
mesh = { shape = "square" }
script = { file = "ball.lua" }
"#,
            r#"
local ticks = 0

function update(self, dt)
  ticks = ticks + 1
  self.color = ticks == 3 and "red" or { 1, 1, 1 }
end
"#,
        );
        let mut world = World::load(&game.dir).unwrap();
        world.start().unwrap();
        for _ in 0..2 {
            world.tick(&Input::default()).unwrap();
        }
        assert_eq!(
            world.tick(&Input::default()),
            Err(Diagnostic(
                "entity \"ball\": color must be {r, g, b} or {r, g, b, a}\n  after update at tick 3"
                    .to_owned()
            ))
        );
    }

    #[test]
    fn an_endless_loop_stops_on_its_line() {
        let game = ball_game(
            BALL,
            "function update(self, dt)\n  while true do end\nend\n",
        );
        let mut world = World::load(&game.dir).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.tick(&Input::default()),
            Err(Diagnostic(format!(
                "{}:2: script ran too long (more than {MAX_INSTRUCTIONS} instructions in one call); \
                 check for an endless loop\n  while running update for entity \"ball\" at tick 1",
                game.path(BALL_SCRIPT)
            )))
        );
    }

    #[test]
    fn an_unknown_key_is_reported_on_the_calling_line() {
        let game = ball_game(BALL, "function start(self)\n  input.held(\"Q!\")\nend\n");
        let mut world = World::load(&game.dir).unwrap();
        let Diagnostic(message) = world.start().unwrap_err();
        assert!(
            message.contains(&format!("{}:2: unknown key \"Q!\"", game.path(BALL_SCRIPT))),
            "{message}"
        );
    }

    #[test]
    fn input_held_takes_an_integer_as_a_key_name() {
        let game = ball_game(
            BALL,
            r#"
function update(self, dt)
  self.one = input.held(1)
  self.float_accepted = pcall(input.held, 1.0)
end
"#,
        );
        let mut world = World::load(&game.dir).unwrap();
        world.start().unwrap();
        let mut input = Input::default();
        input.set(Key::from_name("1").unwrap(), true);
        world.tick(&input).unwrap();
        assert_eq!(
            world.dump().unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 float_accepted=false one=true\n"
        );
    }

    #[test]
    fn math_random_repeats_across_loads() {
        let game = ball_game(
            BALL,
            r#"
function start(self)
  self.r = math.random()
  math.randomseed()
  local reseeded = math.random()
  math.randomseed(0)
  self.reseeded_like_zero = reseeded == math.random()
end
"#,
        );
        let mut first = World::load(&game.dir).unwrap();
        let mut second = World::load(&game.dir).unwrap();
        first.start().unwrap();
        second.start().unwrap();
        let dump = first.dump().unwrap();
        assert!(dump.contains(" reseeded_like_zero=true"), "{dump}");
        assert_eq!(dump, second.dump().unwrap());
    }

    #[test]
    fn scripts_cannot_reach_files_or_the_os() {
        let game = ball_game(
            BALL,
            r#"
function start(self)
  self.io = type(io)
  self.os = type(os)
  self.dofile = type(dofile)
  self.loadfile = type(loadfile)
  self.binary = type(load(string.dump(function() end)))
  self.text = load("return type(math)")()
end
"#,
        );
        let mut world = World::load(&game.dir).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump().unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 binary=nil dofile=nil io=nil loadfile=nil os=nil text=table\n"
        );
    }

    #[test]
    fn a_compiled_script_file_is_rejected() {
        let game = ball_game(BALL, "");
        let bytecode = Lua::new()
            .load("function update(self, dt) end")
            .into_function()
            .unwrap()
            .dump(true);
        fs::write(game.path(BALL_SCRIPT), bytecode).unwrap();
        assert_eq!(
            World::load(&game.dir).err(),
            Some(vec![Diagnostic(format!(
                "{}: attempt to load a binary chunk (mode is 't')",
                game.path(BALL_SCRIPT)
            ))])
        );
    }

    #[test]
    fn pairs_visits_keys_in_a_fixed_order() {
        let game = ball_game(
            r#"
[[entity]]
name = "a"

[[entity]]
name = "b"

[[entity]]
name = "ball"
script = { file = "ball.lua" }
"#,
            r#"
local function order(t)
  local keys = {}
  for key in pairs(t) do
    keys[#keys + 1] = type(key) == "table" and key.name or tostring(key)
  end
  return table.concat(keys, ",")
end

function start(self)
  self.order = order({c = 1, a = 2, b = 3, [2] = 0, [1] = 0})
  local hits = { [true] = 0, [false] = 0 }
  hits[find("b")] = 1
  hits[find("a")] = 1
  self.hits = order(hits)
  local fixed = { "z", "y", "x" }
  self.custom = order(setmetatable({ a = 1 }, {
    __pairs = function()
      local i = 0
      return function()
        i = i + 1
        return fixed[i], i
      end
    end,
  }))
end
"#,
        );
        // Hash order can match these by chance in one state; only live states get distinct seeds.
        let mut worlds: Vec<World> = (0..8).map(|_| World::load(&game.dir).unwrap()).collect();
        for world in &mut worlds {
            world.start().unwrap();
            assert_eq!(
                world.dump().unwrap(),
                "a x=0.0 y=0.0 w=1.0 h=1.0\n\
                 b x=0.0 y=0.0 w=1.0 h=1.0\n\
                 ball x=0.0 y=0.0 w=1.0 h=1.0 custom=z,y,x hits=false,true,a,b order=1,2,a,b,c\n"
            );
        }
    }

    #[test]
    fn lua_message_restores_a_path_that_lua_shortened() {
        let path = PathBuf::from(format!("/{}/scripts/ball.lua", "x".repeat(LUA_IDSIZE)));
        let err = Lua::new()
            .load("error('boom')")
            .set_name(chunk_name(&path))
            .exec()
            .unwrap_err();
        assert!(lua_message(&err, []).starts_with("..."));
        assert_eq!(
            lua_message(&err, [path.as_path()]),
            format!("{}:1: boom", path.display())
        );
    }

    #[test]
    fn dump_values_are_formatted_compactly() {
        let lua = Lua::new();
        let text = |text: &str| LuaValue::String(lua.create_string(text).unwrap());
        let cases = [
            (LuaValue::Number(2.0), "2.0"),
            (LuaValue::Number(0.5), "0.5"),
            (LuaValue::Number(1.0 / 3.0), "0.3333"),
            (LuaValue::Number(-0.0), "0.0"),
            (LuaValue::Integer(7), "7"),
            (text("plain"), "plain"),
            (text(""), r#""""#),
            (text("a b"), r#""a b""#),
            (text("a=b"), r#""a=b""#),
            (text(r#"say "hi""#), r#""say \"hi\"""#),
        ];
        for (value, expected) in cases {
            assert_eq!(format_value(&value).as_deref(), Some(expected), "{value:?}");
        }
    }

    #[test]
    fn a_script_without_start_or_update_is_rejected() {
        let game = ball_game(BALL, "speed = 1\n");
        assert_eq!(
            World::load(&game.dir).err(),
            Some(vec![Diagnostic(format!(
                "{}: defines neither start(self) nor update(self, dt)",
                game.path(BALL_SCRIPT)
            ))])
        );
    }
}
