use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use glam::{DVec2, Vec2, Vec4};
use mlua::{
    ChunkMode, Function, HookTriggers, Lua, LuaOptions, StdLib, Table, Value as LuaValue, VmState,
};

use crate::font;
use crate::game::{Align, Diagnostic, EntityDef, SCRIPTS_DIR, Scene, Shape, Value, check_name};
use crate::input::{Input, Key};
use crate::lint;

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
    // Sets of entity indices, counted from 1, whose x, y, w, h, color, or text the prelude saw assigned.
    moved: Table,
    recolored: Table,
    retexted: Table,
    scripts: Vec<Script>,
    // Every file loaded into the Lua state, so messages can restore paths Lua shortened.
    files: Rc<RefCell<Vec<PathBuf>>>,
    dir: PathBuf,
    driver_globals: Table,
    driver: Option<Driver>,
    input: Rc<RefCell<Input>>,
    tick: Rc<Cell<u64>>,
    instructions: Rc<Cell<u64>>,
    background: [f32; 3],
    // Tables and functions stay usable only while the state they belong to is alive.
    lua: Lua,
}

struct Entity {
    name: String,
    table: Table,
    // The engine fields; the prelude routes reads and validated writes of `table` here.
    fields: Table,
    look: Look,
    sprites: Vec<Sprite>,
    script: Option<usize>,
}

enum Look {
    Hidden,
    Mesh(Shape),
    Text { size: f64, align: Align },
}

struct Script {
    start: Option<Function>,
    update: Option<Function>,
}

struct Driver {
    path: PathBuf,
    keys: Function,
}

impl World {
    pub fn load(dir: &Path, seed: i64) -> Result<World, Vec<Diagnostic>> {
        World::new(Scene::load(dir, None)?, seed)
    }

    pub fn new(scene: Scene, seed: i64) -> Result<World, Vec<Diagnostic>> {
        let (world, diagnostics) =
            World::build(scene, seed).map_err(|err| vec![diagnostic(err)])?;
        if diagnostics.is_empty() {
            Ok(world)
        } else {
            Err(diagnostics)
        }
    }

    fn build(scene: Scene, seed: i64) -> mlua::Result<(World, Vec<Diagnostic>)> {
        let lua = Lua::new_with(
            StdLib::STRING | StdLib::TABLE | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE,
            LuaOptions::default(),
        )?;
        // Each math library copy has its own random state, so the driver's can't advance the game's.
        let driver_math: Table = lua.globals().get("math")?;
        lua.unload_module("math")?;
        lua.load_std_libs(StdLib::MATH)?;
        let mut entities = Vec::new();
        let mut paths: Vec<PathBuf> = Vec::new();
        for def in scene.entities {
            let (table, fields) = entity_tables(&lua, &def)?;
            let look = match (&def.mesh, &def.text) {
                (Some(mesh), _) => Look::Mesh(mesh.shape),
                (None, Some(text)) => Look::Text {
                    size: text.size,
                    align: text.align,
                },
                (None, None) => Look::Hidden,
            };
            let sprites = look.sprites(&fields)?;
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
                table,
                fields,
                look,
                sprites,
                script,
            });
        }

        let input = Rc::new(RefCell::new(Input::default()));
        let tick = Rc::new(Cell::new(0));
        let key_query = |query: fn(&Input, Key) -> bool| {
            let input = Rc::clone(&input);
            lua.create_function(move |_, name: LuaValue| {
                let key = match name {
                    LuaValue::String(name) => Key::from_name(&name.to_string_lossy()),
                    LuaValue::Integer(n) => Key::from_name(&n.to_string()),
                    _ => None,
                };
                Ok(key.map(|key| query(&input.borrow(), key)))
            })
        };
        let log = {
            let tick = Rc::clone(&tick);
            lua.create_function(move |_, text: mlua::String| {
                // A closed stderr, as after `2>&1 | head` exits, mustn't end the run.
                let _ = writeln!(
                    io::stderr(),
                    "[tick {}] {}",
                    tick.get(),
                    text.to_string_lossy()
                );
                Ok(())
            })?
        };
        let script_line = lua.create_function(|lua, ()| Ok(running_script_line(lua)))?;
        let files = Rc::new(RefCell::new(paths.clone()));
        let module_chunk = {
            let dir = scene.dir.clone();
            let files = Rc::clone(&files);
            lua.create_function(move |lua, (name, env): (mlua::String, Table)| {
                Ok(
                    match module_chunk(lua, &dir, &files, &name.to_string_lossy(), env) {
                        Ok(chunk) => (Some(chunk), None),
                        Err(problem) => (None, Some(problem)),
                    },
                )
            })?
        };
        let instructions = Rc::new(Cell::new(0));
        let over_limit = {
            let instructions = Rc::clone(&instructions);
            lua.create_function(move |_, ()| Ok(instructions.get() > MAX_INSTRUCTIONS))?
        };
        let in_file_order =
            lua.create_sequence_from(entities.iter().map(|entity| &entity.table))?;
        let backing = lua.create_sequence_from(entities.iter().map(|entity| &entity.fields))?;
        let (moved, recolored, retexted) = (
            lua.create_table()?,
            lua.create_table()?,
            lua.create_table()?,
        );
        let driver_globals = lua.load(PRELUDE).set_name("=prelude").call((
            key_query(Input::is_held)?,
            key_query(Input::was_pressed)?,
            key_query(Input::was_released)?,
            log,
            script_line,
            in_file_order,
            backing,
            &moved,
            &recolored,
            &retexted,
            lua.create_function(|_, name: mlua::String| {
                Ok(Key::unknown_message(&name.to_string_lossy()))
            })?,
            lua.create_function(|_, text: mlua::String| {
                Ok(font::check(&text.to_string_lossy()).err())
            })?,
            seed,
            driver_math,
            module_chunk,
            over_limit,
        ))?;

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
            scripts.push(load_script(&lua, path, &files, &mut diagnostics)?);
        }
        let world = World {
            entities,
            moved,
            recolored,
            retexted,
            scripts,
            files,
            dir: scene.dir,
            driver_globals,
            driver: None,
            input,
            tick,
            instructions,
            background: scene.background,
            lua,
        };
        Ok((world, diagnostics))
    }

    pub fn load_driver(&mut self, path: &Path) -> Result<(), Diagnostic> {
        let env = environment(&self.lua, self.driver_globals.clone()).map_err(diagnostic)?;
        self.files.borrow_mut().push(path.to_owned());
        self.instructions.set(0);
        let source = read_source(path)?;
        let chunk = compile(&self.lua, path, &source, env.clone(), &self.files.borrow())?;
        run(&chunk, path, &self.files)?;
        let LuaValue::Function(keys) = env.raw_get("keys").map_err(diagnostic)? else {
            return Err(Diagnostic(format!(
                "{}: defines no keys(tick)",
                path.display()
            )));
        };
        self.driver = Some(Driver {
            path: path.to_owned(),
            keys,
        });
        Ok(())
    }

    pub fn driver_keys(&self) -> Result<Option<Vec<Key>>, Diagnostic> {
        let Some(driver) = &self.driver else {
            return Ok(None);
        };
        let tick = self.tick.get() + 1;
        // Prints from keys(tick) carry the tick it chooses keys for.
        self.tick.set(tick);
        self.instructions.set(0);
        let held = self.call_driver(driver, tick);
        self.tick.set(tick - 1);
        held.map(Some)
    }

    fn call_driver(&self, driver: &Driver, tick: u64) -> Result<Vec<Key>, Diagnostic> {
        let file = driver.path.display();
        let failed = |err: mlua::Error| {
            Diagnostic(format!(
                "{}\n  while running the driver before tick {tick}",
                lua_message(&err, &self.files.borrow())
            ))
        };
        let not_a_list = |kind: &str| {
            Diagnostic(format!(
                "{file}: keys() must return a list of key names, got {kind}"
            ))
        };
        let list = match driver.keys.call(tick).map_err(failed)? {
            LuaValue::Table(list) => list,
            other => return Err(not_a_list(lua_type(&other))),
        };
        let mut held = Vec::new();
        for i in 1..=list.len().map_err(failed)? {
            let name = match list.get(i).map_err(failed)? {
                LuaValue::String(name) => name.to_string_lossy(),
                LuaValue::Integer(n) => n.to_string(),
                other => return Err(not_a_list(&format!("{} in the list", lua_type(&other)))),
            };
            let key = Key::from_name(&name).ok_or_else(|| {
                Diagnostic(format!(
                    "{file}: keys() returned unknown key {name:?} before tick {tick} (keys: {})",
                    Key::names().join(", ")
                ))
            })?;
            held.push(key);
        }
        Ok(held)
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
        self.redraw().map_err(diagnostic)
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
        self.redraw().map_err(diagnostic)
    }

    fn redraw(&mut self) -> mlua::Result<()> {
        let mut relaid = drain(&self.retexted)?;
        for index in drain(&self.moved)? {
            let entity = &mut self.entities[index];
            match entity.look {
                Look::Mesh(_) => {
                    let sprite = &mut entity.sprites[0];
                    (sprite.position, sprite.size) = geometry(&entity.fields)?;
                }
                Look::Text { .. } => relaid.push(index),
                Look::Hidden => {}
            }
        }
        for index in drain(&self.recolored)? {
            let entity = &mut self.entities[index];
            let rgba = color(&entity.fields)?;
            for sprite in &mut entity.sprites {
                sprite.color = rgba;
            }
        }
        relaid.sort_unstable();
        relaid.dedup();
        for index in relaid {
            let entity = &mut self.entities[index];
            entity.sprites = entity.look.sprites(&entity.fields)?;
        }
        Ok(())
    }

    fn failure(&self, err: &mlua::Error, phase: &str, entity: &Entity) -> Diagnostic {
        Diagnostic(format!(
            "{}\n  while running {phase} for entity {:?} at tick {}",
            lua_message(err, &self.files.borrow()),
            entity.name,
            self.tick.get()
        ))
    }

    pub(crate) fn sprites(&self) -> impl Iterator<Item = &Sprite> {
        self.entities.iter().flat_map(|entity| &entity.sprites)
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entities.iter().map(|entity| entity.name.as_str())
    }

    pub fn dump(&self, shown: impl Fn(&str) -> bool) -> Result<String, Diagnostic> {
        let mut dump = String::new();
        for entity in self.entities.iter().filter(|entity| shown(&entity.name)) {
            let mut fields = vec![entity.name.clone()];
            for key in ["x", "y", "w", "h"] {
                let value = entity.fields.raw_get(key).map_err(diagnostic)?;
                fields.push(format!(
                    "{key}={}",
                    format_number(&value).unwrap_or_default()
                ));
            }
            if let Some(color) = entity
                .fields
                .raw_get::<Option<Table>>("color")
                .map_err(diagnostic)?
            {
                let mut rgba = Vec::new();
                for i in 1..=4 {
                    let value = color.get(i).map_err(diagnostic)?;
                    rgba.push(format_number(&value).unwrap_or_default());
                }
                fields.push(format!("color={}", rgba.join(",")));
            }
            let text = entity.fields.raw_get("text").map_err(diagnostic)?;
            if let Some(text) = format_value(&text) {
                fields.push(format!("text={text}"));
            }
            let mut extra = BTreeMap::new();
            for pair in entity.table.pairs::<LuaValue, LuaValue>() {
                let (key, value) = pair.map_err(diagnostic)?;
                if let (LuaValue::String(key), Some(text)) = (key, format_value(&value)) {
                    extra.insert(key.to_string_lossy(), text);
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

    pub fn unused_scripts(&self) -> Vec<PathBuf> {
        let mut used = BTreeSet::new();
        // A require inside start or update hasn't run yet, so modules are also found by name.
        let mut unread = self.files.borrow().clone();
        while let Some(path) = unread.pop() {
            let Some(id) = file_id(&path) else {
                continue;
            };
            if !used.insert(id) {
                continue;
            }
            let Ok(source) = fs::read(&path) else {
                continue;
            };
            let named = lint::required_modules(&source).into_iter();
            let modules = named.filter(|name| check_name("module", name).is_ok());
            unread.extend(modules.map(|name| module_path(&self.dir, name)));
        }
        let mut unused: Vec<PathBuf> = lua_files(&self.dir.join(SCRIPTS_DIR))
            .into_iter()
            .filter(|file| file_id(file).is_some_and(|id| !used.contains(&id)))
            .filter_map(|file| Some(file.strip_prefix(&self.dir).ok()?.to_owned()))
            .collect();
        unused.sort();
        unused
    }
}

// One file can have several paths: through symlinks, or through case on a case-insensitive file system.
#[cfg(unix)]
fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_id(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn lua_files(folder: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    // The warnings are advisory, so a folder that can't be listed is skipped rather than failing check.
    for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            files.extend(lua_files(&path));
        } else if path.extension().is_some_and(|extension| extension == "lua") && path.is_file() {
            files.push(path);
        }
    }
    files
}

fn entity_tables(lua: &Lua, def: &EntityDef) -> mlua::Result<(Table, Table)> {
    let fields = lua.create_table()?;
    fields.set("name", def.name.as_str())?;
    fields.set("x", def.position[0])?;
    fields.set("y", def.position[1])?;
    fields.set("w", def.size[0])?;
    fields.set("h", def.size[1])?;
    let text_color = def.text.as_ref().map(|text| text.color);
    if let Some(color) = def.mesh.as_ref().map(|mesh| mesh.color).or(text_color) {
        fields.set("color", lua.create_sequence_from(color)?)?;
    }
    if let Some(text) = &def.text {
        fields.set("text", text.value.as_str())?;
    }
    let table = lua.create_table()?;
    for (key, value) in def.script.iter().flat_map(|script| &script.values) {
        match value {
            Value::Integer(n) => table.set(key.as_str(), *n)?,
            Value::Float(n) => table.set(key.as_str(), *n)?,
            Value::Text(text) => table.set(key.as_str(), text.as_str())?,
            Value::Bool(b) => table.set(key.as_str(), *b)?,
        }
    }
    Ok((table, fields))
}

fn drain(indices: &Table) -> mlua::Result<Vec<usize>> {
    let mut drained = Vec::new();
    indices.for_each(|index: usize, _: bool| {
        drained.push(index - 1);
        Ok(())
    })?;
    // mlua's Table::clear never pops the table off the Lua stack, so calling it every tick overflows the stack.
    for &index in &drained {
        indices.raw_set(index + 1, LuaValue::Nil)?;
    }
    Ok(drained)
}

impl Look {
    fn sprites(&self, fields: &Table) -> mlua::Result<Vec<Sprite>> {
        Ok(match *self {
            Look::Hidden => Vec::new(),
            Look::Mesh(shape) => {
                let (position, size) = geometry(fields)?;
                vec![Sprite {
                    shape,
                    position,
                    size,
                    color: color(fields)?,
                }]
            }
            Look::Text { size, align } => {
                let text: mlua::String = fields.raw_get("text")?;
                let anchor = DVec2::new(fields.raw_get("x")?, fields.raw_get("y")?);
                let color = color(fields)?;
                font::quads(&text.to_str()?, anchor, size, align)
                    .into_iter()
                    .map(|(position, size)| Sprite {
                        shape: Shape::Square,
                        position,
                        size,
                        color,
                    })
                    .collect()
            }
        })
    }
}

fn geometry(fields: &Table) -> mlua::Result<(Vec2, Vec2)> {
    let number = |key| fields.raw_get::<f64>(key).map(|n| n as f32);
    Ok((
        Vec2::new(number("x")?, number("y")?),
        Vec2::new(number("w")?, number("h")?),
    ))
}

fn color(fields: &Table) -> mlua::Result<Vec4> {
    let color: Table = fields.raw_get("color")?;
    let mut rgba = Vec4::ZERO;
    for i in 0..4 {
        rgba[i] = color.get::<f64>(i + 1)? as f32;
    }
    Ok(rgba)
}

fn load_script(
    lua: &Lua,
    path: &Path,
    files: &RefCell<Vec<PathBuf>>,
    diagnostics: &mut Vec<Diagnostic>,
) -> mlua::Result<Script> {
    let mut script = Script {
        start: None,
        update: None,
    };
    let env = environment(lua, lua.globals())?;
    let loaded = read_source(path).and_then(|source| {
        let chunk = compile(lua, path, &source, env.clone(), &files.borrow())?;
        check_keys(path, &source)?;
        run(&chunk, path, files)
    });
    if let Err(diagnostic) = loaded {
        diagnostics.push(diagnostic);
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

fn environment(lua: &Lua, globals: Table) -> mlua::Result<Table> {
    let env = lua.create_table()?;
    let meta = lua.create_table()?;
    meta.set("__index", globals)?;
    env.set_metatable(Some(meta))?;
    Ok(env)
}

fn read_source(path: &Path) -> Result<Vec<u8>, Diagnostic> {
    fs::read(path).map_err(|err| Diagnostic(format!("{}: {err}", path.display())))
}

fn compile(
    lua: &Lua,
    path: &Path,
    source: &[u8],
    env: Table,
    files: &[PathBuf],
) -> Result<Function, Diagnostic> {
    lua.load(source)
        .set_name(chunk_name(path))
        .set_environment(env)
        .set_mode(ChunkMode::Text)
        .into_function()
        .map_err(|err| file_error(path, &err, files))
}

fn run(chunk: &Function, path: &Path, files: &RefCell<Vec<PathBuf>>) -> Result<(), Diagnostic> {
    chunk
        .call(())
        .map_err(|err| file_error(path, &err, &files.borrow()))
}

fn file_error(path: &Path, err: &mlua::Error, files: &[PathBuf]) -> Diagnostic {
    let message = lua_message(err, files);
    let located = |file: &PathBuf| message.starts_with(&format!("{}:", file.display()));
    // Some load errors, like a binary chunk in text mode, don't name the file.
    Diagnostic(if files.iter().any(located) {
        message
    } else {
        format!("{}: {message}", path.display())
    })
}

fn module_chunk(
    lua: &Lua,
    dir: &Path,
    files: &RefCell<Vec<PathBuf>>,
    name: &str,
    env: Table,
) -> Result<Function, String> {
    let caller = || running_script_line(lua);
    check_name("module", name).map_err(|problem| {
        format!(
            r#"{}{problem} (require("util") loads scripts/util.lua)"#,
            caller()
        )
    })?;
    let path = module_path(dir, name);
    if !path.is_file() {
        return Err(format!(
            "{}no script file {SCRIPTS_DIR}/{name}.lua",
            caller()
        ));
    }
    let source = read_source(&path).map_err(|Diagnostic(problem)| caller() + &problem)?;
    if !files.borrow().contains(&path) {
        files.borrow_mut().push(path.clone());
    }
    let chunk = compile(lua, &path, &source, env, &files.borrow());
    let checked = chunk.and_then(|chunk| check_keys(&path, &source).map(|()| chunk));
    checked.map_err(|Diagnostic(problem)| problem)
}

fn check_keys(path: &Path, source: &[u8]) -> Result<(), Diagnostic> {
    let unknown: Vec<String> = lint::key_literals(source)
        .into_iter()
        .filter(|(_, key)| Key::from_name(key).is_none())
        .map(|(line, key)| format!("{}:{line}: {}", path.display(), Key::unknown_message(key)))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(Diagnostic(unknown.join("\n")))
    }
}

fn module_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(SCRIPTS_DIR).join(format!("{name}.lua"))
}

fn lua_type(value: &LuaValue) -> &'static str {
    match value {
        LuaValue::Integer(_) => "number",
        other => other.type_name(),
    }
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

fn lua_message(mut err: &mlua::Error, files: &[PathBuf]) -> String {
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
    for path in files {
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
    Diagnostic(lua_message(&err, &[]))
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
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::*;
    use crate::game::SCENE_FILE;
    use crate::test_support::TempGame;

    const BALL: &str = r#"
[[entity]]
name = "ball"
script = { file = "ball.lua" }
"#;
    const MESH_BALL: &str = r#"
[[entity]]
name = "ball"
mesh = { shape = "square" }
script = { file = "ball.lua" }
"#;
    const TEXT_BALL: &str = r#"
[[entity]]
name = "ball"
text = { value = "0", size = 0.1 }
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
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        for _ in 0..30 {
            world.tick(&Input::default()).unwrap();
        }
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "wall x=1.5 y=0.0 w=1.0 h=1.0\nball x=1.0 y=0.0 w=1.0 h=1.0 speed=2 vx=2 wall_x=1.5\n"
        );
    }

    #[test]
    fn runtime_errors_name_the_line_the_entity_and_the_tick() {
        let game = ball_game(
            BALL,
            "function update(self, dt)\n  self.x = self.x + nil\nend\n",
        );
        let mut world = World::load(&game.dir, 0).unwrap();
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

    fn update_error(scene: &str, statement: &str) -> String {
        let game = ball_game(
            scene,
            &format!("function update(self, dt)\n  {statement}\nend\n"),
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        let Diagnostic(message) = world.tick(&Input::default()).unwrap_err();
        message.replace(&game.path(BALL_SCRIPT), "ball.lua")
    }

    fn failed_update(message: &str) -> String {
        format!("ball.lua:2: {message}\n  while running update for entity \"ball\" at tick 1")
    }

    #[test]
    fn number_fields_must_be_finite_numbers() {
        let scene = r#"
[[entity]]
name = "wall"

[[entity]]
name = "ball"
script = { file = "ball.lua" }
"#;
        assert_eq!(
            update_error(scene, r#"find("wall").x = "left""#),
            failed_update(r#"entity "wall": x must be a number, got string"#)
        );
        assert_eq!(
            update_error(BALL, "self.y = -math.huge"),
            failed_update(r#"entity "ball": y must be a finite number, got -inf"#)
        );
        assert_eq!(
            update_error(BALL, "self.x = 0 / 0"),
            failed_update(r#"entity "ball": x must be a finite number, got nan"#)
        );
    }

    #[test]
    fn sizes_must_be_greater_than_0() {
        assert_eq!(
            update_error(BALL, "self.w = -1"),
            failed_update(r#"entity "ball": w must be greater than 0, got -1"#)
        );
        assert_eq!(
            update_error(BALL, "self.h = 0.0"),
            failed_update(r#"entity "ball": h must be greater than 0, got 0.0"#)
        );
    }

    #[test]
    fn a_color_is_3_or_4_numbers_from_0_to_1_and_reads_back_as_4() {
        for color in ["{2, 0, 0}", "{1, 0}", "{1, 0, 0, 1, 1}", r#""red""#] {
            assert_eq!(
                update_error(MESH_BALL, &format!("self.color = {color}")),
                failed_update(r#"entity "ball": color must be 3 or 4 numbers from 0 to 1"#),
                "{color}"
            );
        }
        let game = ball_game(
            MESH_BALL,
            "function start(self)\n  self.color = {1, 0, 0}\n  self.rgba = table.concat(self.color, \",\")\nend\n",
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 color=1.0,0.0,0.0,1.0 rgba=1.0,0.0,0.0,1.0\n"
        );
    }

    #[test]
    fn an_entity_without_a_mesh_has_no_color() {
        assert_eq!(
            update_error(BALL, "self.color = {1, 1, 1}"),
            failed_update(r#"entity "ball": has no mesh, so it has no color"#)
        );
    }

    #[test]
    fn text_is_a_string_the_font_can_draw_on_an_entity_with_text() {
        assert_eq!(
            update_error(BALL, r#"self.text = "hi""#),
            failed_update(r#"entity "ball": has no text component, so it has no text"#)
        );
        assert_eq!(
            update_error(TEXT_BALL, "self.text = 5"),
            failed_update(r#"entity "ball": text must be a string, got number"#)
        );
        assert_eq!(
            update_error(TEXT_BALL, r#"self.text = "Score: é""#),
            failed_update(r#"entity "ball": text can't draw "é""#)
        );
    }

    #[test]
    fn a_text_entity_prints_its_color_and_then_its_text() {
        let game = ball_game(
            r#"
[[entity]]
name = "title"
text = { value = "READY", size = 0.2, color = [1, 0, 0] }

[[entity]]
name = "ball"
transform = { position = [0.5, 0] }
text = { value = "0", size = 0.1 }
script = { file = "ball.lua", best = 3 }
"#,
            r#"
function start(self)
  self.text = "Score " .. self.best
  self.color = { 0, 1, 0, 0.5 }
  self.shown = self.text
end
"#,
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "title x=0.0 y=0.0 w=1.0 h=1.0 color=1.0,0.0,0.0,1.0 text=READY\n\
             ball x=0.5 y=0.0 w=1.0 h=1.0 color=0.0,1.0,0.0,0.5 text=\"Score 3\" best=3 shown=\"Score 3\"\n"
        );
    }

    #[test]
    fn text_draws_as_squares_in_file_order_and_redraws_when_it_changes() {
        let game = TempGame::new(&[
            (
                SCENE_FILE,
                r#"
[[entity]]
name = "back"
mesh = { shape = "triangle" }

[[entity]]
name = "label"
text = { value = "-", size = 0.875, align = "left" }
script = { file = "label.lua" }

[[entity]]
name = "front"
mesh = { shape = "triangle" }
"#,
            ),
            (
                "scripts/label.lua",
                r#"
local ticks = 0

function update(self, dt)
  ticks = ticks + 1
  if ticks == 1 then
    self.x = 1
  elseif ticks == 2 then
    self.color = { 1, 0, 0 }
  else
    self.text = "--"
  end
end
"#,
            ),
        ]);
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        // "-" lights one run of 5 pixels in its middle row, and 0.875 / 7 makes a pixel 0.125 units.
        let label = |world: &World| {
            let sprites: Vec<&Sprite> = world.sprites().collect();
            let [back, label @ .., front] = &sprites[..] else {
                panic!("expected the label between two triangles, got {sprites:?}");
            };
            assert_eq!(
                (back.shape, front.shape),
                (Shape::Triangle, Shape::Triangle)
            );
            label
                .iter()
                .map(|sprite| {
                    assert_eq!(
                        (sprite.shape, sprite.size),
                        (Shape::Square, Vec2::new(0.625, 0.125))
                    );
                    (sprite.position, sprite.color)
                })
                .collect::<Vec<_>>()
        };
        let (white, red) = (Vec4::ONE, Vec4::new(1.0, 0.0, 0.0, 1.0));
        assert_eq!(label(&world), [(Vec2::new(0.3125, 0.0), white)]);
        world.tick(&Input::default()).unwrap();
        assert_eq!(label(&world), [(Vec2::new(1.3125, 0.0), white)]);
        world.tick(&Input::default()).unwrap();
        assert_eq!(label(&world), [(Vec2::new(1.3125, 0.0), red)]);
        world.tick(&Input::default()).unwrap();
        assert_eq!(
            label(&world),
            [(Vec2::new(1.3125, 0.0), red), (Vec2::new(2.0625, 0.0), red)]
        );
    }

    #[test]
    fn name_is_read_only() {
        assert_eq!(
            update_error(BALL, r#"self.name = "wall""#),
            failed_update(r#"entity "ball": name can't be changed"#)
        );
    }

    #[test]
    fn a_color_cant_be_changed_in_place() {
        let message = failed_update(
            r#"entity "ball": color can't be changed in place; assign a new table, like e.color = {1, 0, 0, 0.5}"#,
        );
        for statement in [
            "self.color[4] = 0.5",
            "table.insert(self.color, 1)",
            "rawset(self.color, 1, 0)",
        ] {
            assert_eq!(update_error(MESH_BALL, statement), message, "{statement}");
        }
    }

    #[test]
    fn a_nil_key_on_an_entity_keeps_its_line() {
        assert_eq!(
            update_error(BALL, "self[nil] = 1"),
            failed_update("table index is nil")
        );
    }

    #[test]
    fn pairs_over_an_entity_visits_engine_and_custom_fields_in_order() {
        let game = ball_game(
            r#"
[[entity]]
name = "ball"
transform = { position = [0.5, 0] }
mesh = { shape = "square" }
script = { file = "ball.lua", speed = 2 }
"#,
            r#"
function start(self)
  self.vx = 1
  local fields = {}
  for key, value in pairs(self) do
    fields[#fields + 1] = key .. "=" .. (type(value) == "table" and #value or tostring(value))
  end
  self.fields = table.concat(fields, " ")
end
"#,
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=0.5 y=0.0 w=1.0 h=1.0 color=1.0,1.0,1.0,1.0 \
             fields=\"color=4 h=1.0 name=ball speed=2 vx=1 w=1.0 x=0.5 y=0.0\" speed=2 vx=1\n"
        );
    }

    #[test]
    fn rawget_and_rawset_follow_the_field_rules() {
        let game = ball_game(
            BALL,
            r#"
function start(self)
  rawset(self, "x", 2)
  self.raw_x = rawget(self, "x")
  rawset(self, "vx", 1)
end

function update(self, dt)
  rawset(self, "w", -1)
end
"#,
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=2 y=0.0 w=1.0 h=1.0 raw_x=2 vx=1\n"
        );
        assert_eq!(
            world.tick(&Input::default()),
            Err(Diagnostic(format!(
                "{}:9: entity \"ball\": w must be greater than 0, got -1\n  \
                 while running update for entity \"ball\" at tick 1",
                game.path(BALL_SCRIPT)
            )))
        );
    }

    #[test]
    fn an_entity_changed_through_find_is_redrawn() {
        let game = TempGame::new(&[
            (
                SCENE_FILE,
                r#"
[[entity]]
name = "ball"
mesh = { shape = "square" }

[[entity]]
name = "mover"
script = { file = "mover.lua" }
"#,
            ),
            (
                "scripts/mover.lua",
                r#"
function update(self, dt)
  local ball = find("ball")
  ball.x = ball.x + 0.5
  ball.color = { 1, 0, 0 }
end
"#,
            ),
        ]);
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        world.tick(&Input::default()).unwrap();
        let sprites: Vec<&Sprite> = world.sprites().collect();
        let [ball] = sprites[..] else {
            panic!("expected one sprite, got {sprites:?}");
        };
        assert_eq!(
            (ball.position, ball.color),
            (Vec2::new(0.5, 0.0), Vec4::new(1.0, 0.0, 0.0, 1.0))
        );
    }

    // Lua's stack holds 1,000,000 values, so leaking one per change set each tick fails by tick 333,334.
    #[test]
    fn a_long_run_redraws_without_filling_the_lua_stack() {
        let game = ball_game(
            TEXT_BALL,
            r#"
function update(self, dt)
  self.x = -self.x
  self.text = self.text == "0" and "1" or "0"
  self.color = { 1, 0, 0 }
end
"#,
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        for _ in 0..400_000 {
            world.tick(&Input::default()).unwrap();
        }
    }

    #[test]
    fn entity_metatables_are_protected() {
        let game = ball_game(
            BALL,
            "function start(self)\n  self.hidden = getmetatable(self)\n  setmetatable(self, {})\nend\n",
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        assert_eq!(
            world.start(),
            Err(Diagnostic(format!(
                "{}:3: cannot change a protected metatable\n  \
                 while running start for entity \"ball\" at tick 0",
                game.path(BALL_SCRIPT)
            )))
        );
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 hidden=false\n"
        );
    }

    #[test]
    fn an_endless_loop_stops_on_its_line() {
        let game = ball_game(
            BALL,
            "function update(self, dt)\n  while true do end\nend\n",
        );
        let mut world = World::load(&game.dir, 0).unwrap();
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

    // A regression here loops forever, so the update runs on its own thread with a deadline.
    fn stopped_update(statement: &str) -> Result<String, String> {
        let script = format!("function update(self, dt)\n  {statement}\nend\n");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let game = ball_game(BALL, &script);
            let mut world = World::load(&game.dir, 0).unwrap();
            world.start().unwrap();
            let stopped = world.tick(&Input::default()).err();
            let _ =
                sender.send(stopped.map(|Diagnostic(message)| {
                    message.replace(&game.path(BALL_SCRIPT), "ball.lua")
                }));
        });
        match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(stopped) => stopped.ok_or_else(|| "the update finished normally".to_owned()),
            Err(err) => Err(err.to_string()),
        }
    }

    #[test]
    fn a_caught_instruction_limit_still_stops_the_call() {
        let limit = format!(
            "script ran too long (more than {MAX_INSTRUCTIONS} instructions in one call); \
             check for an endless loop"
        );
        for statement in [
            "for _ = 1, 3 do pcall(function() while true do end end) end",
            "while true do pcall(function() while true do end end) end",
            "xpcall(function() while true do end end, function(e) return e end)",
            "xpcall(function() while true do end end, function(e) while true do end end)",
            "coroutine.resume(coroutine.create(function() while true do end end))",
            "load(function() while true do end end)",
            // Lua reads __close when the variable closes, so a field added after setmetatable still counts.
            "local mt = {} local t = setmetatable({}, mt) mt.__close = function() while true do end end \
             local co = coroutine.create(function() local x <close> = t coroutine.yield() end) \
             coroutine.resume(co) coroutine.close(co)",
        ] {
            assert_eq!(
                stopped_update(statement),
                Ok(failed_update(&limit)),
                "{statement}"
            );
        }
    }

    #[test]
    fn gc_and_close_metamethods_are_rejected() {
        for (meta, message) in [
            ("{ __gc = function() end }", "__gc isn't supported"),
            ("{ __gc = false }", "__gc isn't supported"),
            ("{ __close = function() end }", "__close isn't supported"),
        ] {
            assert_eq!(
                update_error(BALL, &format!("setmetatable({{}}, {meta})")),
                failed_update(message),
                "{meta}"
            );
        }
    }

    #[test]
    fn an_unknown_key_is_reported_on_the_calling_line() {
        for query in ["held", "pressed", "released"] {
            let script = format!("function start(self)\n  input.{query}(\"Q\" .. '\"!')\nend\n");
            let game = ball_game(BALL, &script);
            let mut world = World::load(&game.dir, 0).unwrap();
            let Diagnostic(message) = world.start().unwrap_err();
            let expected = format!(
                "{}:2: {}",
                game.path(BALL_SCRIPT),
                Key::unknown_message("Q\"!")
            );
            assert!(message.starts_with(&expected), "{message}");
        }
    }

    #[test]
    fn bad_randomseed_arguments_are_reported_on_the_calling_line() {
        for (args, problem) in [
            (r#""x""#, "#1 to 'randomseed' (number expected, got string)"),
            (
                "1.5",
                "#1 to 'randomseed' (number has no integer representation)",
            ),
            ("1, {}", "#2 to 'randomseed' (number expected, got table)"),
        ] {
            let script = format!("function start(self)\n  math.randomseed({args})\nend\n");
            let game = ball_game(BALL, &script);
            let mut world = World::load(&game.dir, 0).unwrap();
            let Diagnostic(message) = world.start().unwrap_err();
            let expected = format!("{}:2: bad argument {problem}\n", game.path(BALL_SCRIPT));
            assert!(message.starts_with(&expected), "{message}");
        }
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
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        let mut input = Input::default();
        input.set(Key::from_name("1").unwrap(), true);
        world.tick(&input).unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 float_accepted=false one=true\n"
        );
    }

    #[test]
    fn math_randomseed_without_an_argument_goes_back_to_the_run_seed() {
        let game = ball_game(
            BALL,
            r#"
function start(self)
  math.randomseed(7)
  local seven = math.random()
  math.randomseed()
  self.back_to_run_seed = math.random() == seven
end
"#,
        );
        let mut world = World::load(&game.dir, 7).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 back_to_run_seed=true\n"
        );
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
  self.chunk = load("return type(math)")()
end
"#,
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 binary=nil chunk=table dofile=nil io=nil loadfile=nil os=nil\n"
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
            World::load(&game.dir, 0).err(),
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
  -- 3 takes false's hash slot, so next visits true before false here.
  self.flags = order({ [3] = 0, [true] = 0, [false] = 0 })
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
        let mut worlds: Vec<World> = (0..8).map(|_| World::load(&game.dir, 0).unwrap()).collect();
        for world in &mut worlds {
            world.start().unwrap();
            assert_eq!(
                world.dump(|_| true).unwrap(),
                "a x=0.0 y=0.0 w=1.0 h=1.0\n\
                 b x=0.0 y=0.0 w=1.0 h=1.0\n\
                 ball x=0.0 y=0.0 w=1.0 h=1.0 custom=z,y,x flags=3,false,true hits=false,true,a,b order=1,2,a,b,c\n"
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
        assert!(lua_message(&err, &[]).starts_with("..."));
        assert_eq!(
            lua_message(&err, std::slice::from_ref(&path)),
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
    fn find_all_and_get_look_entities_up_by_name() {
        let game = ball_game(
            r#"
[[entity]]
name = "brick_2"

[[entity]]
name = "bricks"

[[entity]]
name = "brick_1"

[[entity]]
name = "ball"
script = { file = "ball.lua" }
"#,
            r#"
function start(self)
  local names = {}
  for _, brick in ipairs(find_all("brick_")) do
    names[#names + 1] = brick.name
  end
  self.bricks = table.concat(names, ",")
  self.none = #find_all("wall")
  self.same = get("brick_1") == find("brick_1")
end
"#,
        );
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(
            world.dump(|name| name == "ball").unwrap(),
            "ball x=0.0 y=0.0 w=1.0 h=1.0 bricks=brick_2,brick_1 none=0 same=true\n"
        );
    }

    #[test]
    fn require_loads_a_module_once_and_gives_every_file_the_same_table() {
        let game = TempGame::new(&[
            (
                SCENE_FILE,
                r#"
[[entity]]
name = "a"
script = { file = "a.lua" }

[[entity]]
name = "b"
script = { file = "b.lua" }
"#,
            ),
            (
                "scripts/util.lua",
                "leaked = true\nlocal a = get(\"a\")\na.util_loads = (a.util_loads or 0) + 1\nreturn {}\n",
            ),
            (
                "scripts/a.lua",
                "local util = require(\"util\")\n\nfunction start(self)\n  self.util = util\nend\n",
            ),
            (
                "scripts/b.lua",
                "function start(self)\n  self.shared = find(\"a\").util == require(\"util\")\n  \
                 self.leaked = type(leaked)\nend\n",
            ),
        ]);
        let mut world = World::load(&game.dir, 0).unwrap();
        world.start().unwrap();
        assert_eq!(world.summary(), "2 entities, 2 scripts");
        assert_eq!(
            world.dump(|_| true).unwrap(),
            "a x=0.0 y=0.0 w=1.0 h=1.0 util_loads=1\nb x=0.0 y=0.0 w=1.0 h=1.0 leaked=nil shared=true\n"
        );
    }

    #[test]
    fn helper_errors_name_the_calling_line() {
        let bytecode = Lua::new()
            .load("return {}")
            .into_function()
            .unwrap()
            .dump(true);
        let unknown_key = format!("util.lua:1: {}", Key::unknown_message("Esc"));
        let cases: [(&str, &[u8], &str); 9] = [
            (
                r#"get("balll")"#,
                b"",
                r#"ball.lua:1: no entity named "balll""#,
            ),
            (
                "get(nil)",
                b"",
                "ball.lua:1: bad argument #1 to 'get' (string expected, got nil)",
            ),
            (
                "find_all(1)",
                b"",
                "ball.lua:1: bad argument #1 to 'find_all' (string expected, got number)",
            ),
            (
                r#"require("utill")"#,
                b"return {}\n",
                "ball.lua:1: no script file scripts/utill.lua",
            ),
            (
                r#"require("../scene")"#,
                b"return {}\n",
                r#"ball.lua:1: module name "../scene" can only use letters, digits, "_", and "-" (require("util") loads scripts/util.lua)"#,
            ),
            (
                r#"require("util")"#,
                b"local speed = 1\n",
                "ball.lua:1: scripts/util.lua must return a table",
            ),
            (
                r#"require("util")"#,
                b"local util = require(\"util\")\nreturn util\n",
                "util.lua:1: scripts/util.lua is still loading; modules can't require each other in a loop",
            ),
            (
                r#"require("util")"#,
                &bytecode,
                "util.lua: attempt to load a binary chunk (mode is 't')",
            ),
            (
                r#"require("util")"#,
                b"return { paused = function() return input.held(\"Esc\") end }\n",
                &unknown_key,
            ),
        ];
        for (call, module, message) in cases {
            let script = format!("{call}\nfunction update(self, dt) end\n");
            let game = ball_game(BALL, &script);
            fs::write(game.dir.join("scripts/util.lua"), module).unwrap();
            let diagnostics = World::load(&game.dir, 0).err().unwrap_or_default();
            let [Diagnostic(error)] = &diagnostics[..] else {
                panic!("{call}: expected one diagnostic, got {diagnostics:?}");
            };
            let scripts = format!("{}/", game.path("scripts"));
            assert_eq!(error.replace(&scripts, ""), message, "{call}");
        }
    }

    #[test]
    fn a_script_without_start_or_update_is_rejected() {
        let game = ball_game(BALL, "speed = 1\n");
        assert_eq!(
            World::load(&game.dir, 0).err(),
            Some(vec![Diagnostic(format!(
                "{}: defines neither start(self) nor update(self, dt)",
                game.path(BALL_SCRIPT)
            ))])
        );
    }
}
