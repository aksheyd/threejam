local held, pressed, released, log, script_line, in_file_order, backing, moved, recolored, retexted, unknown_key, cant_draw, seed, driver_math, module_chunk, over_limit = ...

dofile = nil
loadfile = nil

local stock_load, stock_pcall, stock_xpcall, stock_setmetatable = load, pcall, xpcall, setmetatable
local stock_rawget, resume, close = rawget, coroutine.resume, coroutine.close
local globals = _G

local function bad_argument(position, name, kind, value)
  return "bad argument #" .. position .. " to '" .. name .. "' (" .. kind .. " expected, got " .. type(value) .. ")"
end

-- Once a call passes the instruction limit, anything that catches its error must pass it on, or a loop could catch it forever.
local function rethrow_over_limit(ok, ...)
  if not ok and over_limit() then
    error((...), 0)
  end
  return ok, ...
end

-- Lua runs binary chunks without checking them, and bad bytecode can crash the VM.
function load(chunk, chunkname, _, ...)
  return rethrow_over_limit(stock_load(chunk, chunkname, "t", ...))
end

-- Errors raised by the stock functions below would point at the prelude instead of the calling script.
function pcall(...)
  if select("#", ...) == 0 then
    error("bad argument #1 to 'pcall' (value expected)", 2)
  end
  return rethrow_over_limit(stock_pcall(...))
end

-- Lua calls the handler for the limit error while the hook is still off, so a looping handler would never stop.
function xpcall(f, handler, ...)
  if type(handler) ~= "function" then
    error(bad_argument(2, "xpcall", "function", handler), 2)
  end
  return rethrow_over_limit(stock_xpcall(f, function(problem)
    if over_limit() then
      return problem
    end
    return handler(problem)
  end, ...))
end

function coroutine.resume(co, ...)
  if type(co) ~= "thread" then
    error(bad_argument(1, "resume", "coroutine", co), 2)
  end
  return rethrow_over_limit(resume(co, ...))
end

function coroutine.close(co)
  if type(co) ~= "thread" then
    error(bad_argument(1, "close", "coroutine", co), 2)
  end
  return rethrow_over_limit(close(co))
end

function setmetatable(t, ...)
  local meta = ...
  if type(t) ~= "table" then
    error(bad_argument(1, "setmetatable", "table", t), 2)
  elseif select("#", ...) == 0 or meta ~= nil and type(meta) ~= "table" then
    error(bad_argument(2, "setmetatable", "nil or table", meta), 2)
  elseif meta ~= nil and stock_rawget(meta, "__gc") ~= nil then
    -- Lua runs finalizers with the instruction hook off, so an endless loop in one would hang the run.
    error("__gc isn't supported", 2)
  elseif meta ~= nil and stock_rawget(meta, "__close") ~= nil then
    -- When the limit stops a function, mlua runs its __close handlers with the hook still off.
    error("__close isn't supported", 2)
  end
  local ok, problem = stock_pcall(stock_setmetatable, t, meta)
  if not ok then
    error(problem, 2)
  end
  return t
end

local function seed_error(position, value)
  local problem = tonumber(value) and "number has no integer representation"
    or "number expected, got " .. type(value)
  return "bad argument #" .. position .. " to 'randomseed' (" .. problem .. ")"
end

local function seed_from_run(library)
  local randomseed = library.randomseed
  -- Stock randomseed() with no argument seeds from the clock and a memory address.
  function library.randomseed(...)
    if select("#", ...) == 0 then
      return randomseed(seed)
    end
    local first, second = ...
    -- Stock argument errors would point at the prelude instead of the calling script.
    if math.tointeger(first) == nil then
      error(seed_error(1, first), 2)
    elseif second ~= nil and math.tointeger(second) == nil then
      error(seed_error(2, second), 2)
    end
    return randomseed(...)
  end
  library.randomseed(seed)
end

seed_from_run(math)
seed_from_run(driver_math)

local function key_query(query)
  return function(key)
    local answer = query(key)
    if answer == nil then
      error(unknown_key(tostring(key)), 2)
    end
    return answer
  end
end

input = { held = key_query(held), pressed = key_query(pressed), released = key_query(released) }

local by_name = {}

function find(name)
  return by_name[name]
end

function get(name)
  local entity = by_name[name]
  if entity == nil then
    local problem = type(name) == "string" and 'no entity named "' .. name .. '"'
      or bad_argument(1, "get", "string", name)
    error(script_line() .. problem, 0)
  end
  return entity
end

function find_all(prefix)
  if type(prefix) ~= "string" then
    error(script_line() .. bad_argument(1, "find_all", "string", prefix), 0)
  end
  local found = {}
  for i, entity in ipairs(in_file_order) do
    if backing[i].name:sub(1, #prefix) == prefix then
      found[#found + 1] = entity
    end
  end
  return found
end

local function module_loader(module_globals)
  local modules, loading = {}, {}
  return function(name)
    local module = modules[name]
    if module ~= nil then
      return module
    elseif type(name) ~= "string" then
      error(script_line() .. bad_argument(1, "require", "string", name), 0)
    end
    local file = "scripts/" .. name .. ".lua"
    if loading[name] then
      error(script_line() .. file .. " is still loading; modules can't require each other in a loop", 0)
    end
    local chunk, problem = module_chunk(name, stock_setmetatable({}, { __index = module_globals }))
    if chunk == nil then
      error(problem, 0)
    end
    loading[name] = true
    local ok, value = stock_pcall(chunk)
    loading[name] = nil
    if not ok then
      error(value, 0)
    elseif type(value) ~= "table" then
      error(script_line() .. file .. " must return a table", 0)
    end
    modules[name] = value
    return value
  end
end

require = module_loader(globals)

function print(...)
  local parts = table.pack(...)
  for i = 1, parts.n do
    parts[i] = tostring(parts[i])
  end
  log(table.concat(parts, "\t", 1, parts.n))
end

local stock_pairs, stock_rawset, next = pairs, rawset, next
local key_groups = { number = 1, string = 2, boolean = 3 }
local entity_order = {}
local fields_of = {}
local color_owner = stock_setmetatable({}, { __mode = "k" })

local IN_PLACE = "color can't be changed in place; assign a new table, like e.color = {1, 0, 0, 0.5}"
local BAD_COLOR = "color must be 3 or 4 numbers from 0 to 1"

local function fail(fields, problem)
  error(script_line() .. 'entity "' .. fields.name .. '": ' .. problem, 0)
end

local function reject_color_edit(color)
  fail(color_owner[color], IN_PLACE)
end

local function four()
  return 4
end

local function read_only_color(rgba, fields)
  local color = stock_setmetatable({}, {
    __index = rgba,
    __newindex = reject_color_edit,
    __len = four,
    __pairs = ipairs,
    __metatable = false,
  })
  color_owner[color] = fields
  return color
end

local huge = math.huge

local function finite(key, value)
  if type(value) ~= "number" then
    return nil, key .. " must be a number, got " .. type(value)
  elseif value ~= value or value == huge or value == -huge then
    return nil, key .. " must be a finite number, got " .. (value == value and tostring(value) or "nan")
  end
  return value
end

local function positive(key, value)
  local n, problem = finite(key, value)
  if n ~= nil and n <= 0 then
    return nil, key .. " must be greater than 0, got " .. tostring(n)
  end
  return n, problem
end

local function color(_, value, fields)
  if fields.color == nil then
    return nil, "has no mesh, so it has no color"
  end
  local n = type(value) == "table" and #value
  if n ~= 3 and n ~= 4 then
    return nil, BAD_COLOR
  end
  local rgba = { 1.0, 1.0, 1.0, 1.0 }
  for i = 1, n do
    local channel = value[i]
    if type(channel) ~= "number" or not (channel >= 0 and channel <= 1) then
      return nil, BAD_COLOR
    end
    rgba[i] = channel + 0.0
  end
  return read_only_color(rgba, fields)
end

local function text(_, value, fields)
  if fields.text == nil then
    return nil, "has no text component, so it has no text"
  elseif type(value) ~= "string" then
    return nil, "text must be a string, got " .. type(value)
  end
  local problem = cant_draw(value)
  if problem ~= nil then
    return nil, problem
  end
  return value
end

local function read_only(key)
  return nil, key .. " can't be changed"
end

local rules = { name = read_only, x = finite, y = finite, w = positive, h = positive, color = color, text = text }
local changes = { x = moved, y = moved, w = moved, h = moved, color = recolored, text = retexted }

local function set_field(t, key, value)
  local rule = rules[key]
  if rule == nil then
    -- Stock rawset reports a bad key without the line of the script that assigned it.
    if key == nil or key ~= key then
      error(script_line() .. "table index is " .. (key == nil and "nil" or "NaN"), 0)
    end
    return stock_rawset(t, key, value)
  end
  local fields = fields_of[t]
  local stored, problem = rule(key, value, fields)
  if problem ~= nil then
    fail(fields, problem)
  end
  fields[key] = stored
  changes[key][entity_order[t]] = true
end

local function raw_field(t, key)
  local fields = fields_of[t]
  if fields ~= nil and rules[key] ~= nil then
    return fields[key]
  end
  return stock_rawget(t, key)
end

function rawget(t, key)
  if type(t) ~= "table" then
    error(bad_argument(1, "rawget", "table", t), 2)
  end
  return raw_field(t, key)
end

function rawset(t, key, value)
  if type(t) ~= "table" then
    error(bad_argument(1, "rawset", "table", t), 2)
  elseif color_owner[t] ~= nil then
    reject_color_edit(t)
  elseif fields_of[t] ~= nil then
    set_field(t, key, value)
    return t
  end
  return stock_rawset(t, key, value)
end

local function add_keys(groups, t)
  for key in next, t do
    local group = groups[key_groups[type(key)] or (entity_order[key] and 4) or 5]
    group[#group + 1] = key
  end
end

-- next visits string keys in a hash order that changes from run to run.
local function ordered_pairs(t, fields)
  local groups = { {}, {}, {}, {}, {} }
  add_keys(groups, t)
  if fields ~= nil then
    add_keys(groups, fields)
  end
  table.sort(groups[1])
  table.sort(groups[2])
  table.sort(groups[3], function(a, b) return b and not a end)
  table.sort(groups[4], function(a, b) return entity_order[a] < entity_order[b] end)
  local keys = {}
  for _, group in ipairs(groups) do
    for _, key in ipairs(group) do
      keys[#keys + 1] = key
    end
  end
  local i = 0
  return function()
    while i < #keys do
      i = i + 1
      local value = raw_field(t, keys[i])
      if value ~= nil then
        return keys[i], value
      end
    end
  end, t, nil
end

function pairs(t)
  -- Stock pairs finds __pairs through the raw metatable, which getmetatable can hide.
  local iterate, state, control = stock_pairs(t)
  if iterate ~= next or not rawequal(state, t) or control ~= nil then
    return iterate, state, control
  end
  if type(t) ~= "table" then
    error(bad_argument(1, "pairs", "table", t), 2)
  end
  return ordered_pairs(t)
end

local function entity_pairs(t)
  return ordered_pairs(t, fields_of[t])
end

for i, entity in ipairs(in_file_order) do
  local fields = backing[i]
  entity_order[entity] = i
  fields_of[entity] = fields
  by_name[fields.name] = entity
  if fields.color ~= nil then
    fields.color = read_only_color(fields.color, fields)
  end
  stock_setmetatable(entity, {
    __index = fields,
    __newindex = set_field,
    __pairs = entity_pairs,
    __metatable = false,
  })
end

local view_target = stock_setmetatable({}, { __mode = "k" })
local view_label = stock_setmetatable({}, { __mode = "k" })
local view_of = stock_setmetatable({}, { __mode = "k" })
local view_meta = { __metatable = false }

local function segment(key)
  local kind = type(key)
  if kind == "string" then
    return key:match("^[%a_][%w_]*$") and "." .. key or '["' .. key .. '"]'
  elseif kind == "number" or kind == "boolean" then
    return "[" .. tostring(key) .. "]"
  end
  local fields = fields_of[view_target[key] or key]
  return "[" .. (fields and fields.name or kind) .. "]"
end

local function view(value, parent, key)
  if type(value) ~= "table" then
    return value
  end
  local shown = view_of[value]
  if shown == nil then
    local fields = fields_of[value]
    shown = stock_setmetatable({}, view_meta)
    view_target[shown] = value
    view_label[shown] = fields and fields.name or view_label[parent] .. segment(key)
    view_of[value] = shown
  end
  return shown
end

local function refuse(shown, key)
  error(script_line() .. "the driver can't change entities (tried to set "
    .. view_label[shown] .. segment(key) .. ")", 0)
end

function view_meta.__index(shown, key)
  return view(view_target[shown][view_target[key] or key], shown, key)
end

view_meta.__newindex = refuse

function view_meta.__len(shown)
  return #view_target[shown]
end

function view_meta.__pairs(shown)
  local iterate, state, key = pairs(view_target[shown])
  return function()
    local value
    key, value = iterate(state, key)
    if key ~= nil then
      return view(key, shown, key), view(value, shown, key)
    end
  end
end

local driver_globals = {}
for key, value in next, _G do
  driver_globals[key] = value
end
driver_globals._G = driver_globals
driver_globals.input = nil
driver_globals.math = driver_math

function driver_globals.find(name)
  return view(by_name[name])
end

function driver_globals.get(name)
  return view(get(name))
end

function driver_globals.find_all(prefix)
  local found = find_all(prefix)
  for i, entity in ipairs(found) do
    found[i] = view(entity)
  end
  return found
end

-- The game's copy of a module has the scripts' find, which returns entities the driver could change.
driver_globals.require = module_loader(driver_globals)

-- A chunk loaded without an environment gets the scripts' globals, whose find returns entities.
function driver_globals.load(chunk, chunkname, mode, ...)
  if select("#", ...) == 0 then
    return load(chunk, chunkname, mode, driver_globals)
  end
  return load(chunk, chunkname, mode, ...)
end

-- Views are empty proxies, so the raw functions look through them.
function driver_globals.rawget(t, key)
  local target = view_target[t]
  if target == nil then
    return rawget(t, key)
  end
  return view(raw_field(target, view_target[key] or key), t, key)
end

function driver_globals.rawset(t, key, value)
  if view_target[t] ~= nil then
    refuse(t, key)
  end
  return rawset(t, key, value)
end

function driver_globals.rawlen(t)
  return rawlen(view_target[t] or t)
end

function driver_globals.next(t, key)
  local target = view_target[t]
  if target == nil then
    return next(t, key)
  end
  local found, value = next(target, view_target[key] or key)
  return view(found, t, found), view(value, t, found)
end

return driver_globals
