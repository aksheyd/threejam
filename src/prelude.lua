local held, log, by_name, in_file_order, key_names = ...

dofile = nil
loadfile = nil

local stock_load = load

-- Lua runs binary chunks without checking them, and bad bytecode can crash the VM.
function load(chunk, chunkname, _, ...)
  return stock_load(chunk, chunkname, "t", ...)
end

local randomseed = math.randomseed

-- Stock randomseed() with no argument seeds from the clock and a memory address.
function math.randomseed(...)
  if select("#", ...) == 0 then
    return randomseed(0)
  end
  return randomseed(...)
end

math.randomseed(0)

input = {}

function input.held(key)
  local down = held(key)
  if down == nil then
    error('unknown key "' .. tostring(key) .. '" (keys: ' .. key_names .. ')', 2)
  end
  return down
end

function find(name)
  return by_name[name]
end

function print(...)
  local parts = table.pack(...)
  for i = 1, parts.n do
    parts[i] = tostring(parts[i])
  end
  log(table.concat(parts, "\t", 1, parts.n))
end

local stock_pairs, next = pairs, next
local key_groups = { number = 1, string = 2, boolean = 3 }
local entity_order = {}
for i, entity in ipairs(in_file_order) do
  entity_order[entity] = i
end

-- next visits string keys in a hash order that changes from run to run.
function pairs(t)
  -- Stock pairs finds __pairs through the raw metatable, which getmetatable can hide.
  local iterate, state, control = stock_pairs(t)
  if iterate ~= next or not rawequal(state, t) or control ~= nil then
    return iterate, state, control
  end
  if type(t) ~= "table" then
    error("bad argument #1 to 'pairs' (table expected, got " .. type(t) .. ")", 2)
  end
  local groups = { {}, {}, {}, {}, {} }
  for key in next, t do
    local group = groups[key_groups[type(key)] or (entity_order[key] and 4) or 5]
    group[#group + 1] = key
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
      local value = rawget(t, keys[i])
      if value ~= nil then
        return keys[i], value
      end
    end
  end, t, nil
end
