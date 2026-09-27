-- Steers along a cycle through every cell (up column 1, a serpentine over the rest above row 1, back along row 1); needs an even column count.
local game, head, food = get("game"), get("head"), get("food")
local body = find_all("seg")
local KEY = { ["1,0"] = "Right", ["-1,0"] = "Left", ["0,1"] = "Up", ["0,-1"] = "Down" }
local DIR = { right = "1,0", left = "-1,0", up = "0,1", down = "0,-1" }
local decided_at = -1
local food_seen, won_at

local function next_cell(x, y)
  if x == 1 then
    if y < game.rows then return 1, y + 1 end
    return 2, game.rows
  end
  if y == 1 then return x - 1, 1 end
  if x % 2 == 0 then
    if y > 2 then return x, y - 1 end
    if x < game.cols then return x + 1, 2 end
    return x, 1
  end
  if y < game.rows then return x, y + 1 end
  return x + 1, game.rows
end

local function covers_food(e)
  return math.abs(e.x - food.x) < 0.01 and math.abs(e.y - food.y) < 0.01
end

local function check_food()
  local cell = game.food_x .. "," .. game.food_y
  if cell == food_seen then return end
  food_seen = cell
  if covers_food(head) then error("food at (" .. cell .. ") is under the head") end
  for _, e in ipairs(body) do
    if covers_food(e) then error("food at (" .. cell .. ") is under " .. e.name) end
  end
end

function keys(tick)
  check_food()
  if game.state == "won" then
    won_at = won_at or tick
    if tick == won_at + 60 then return { "Space" } end
    return {}
  end
  if won_at or game.steps == decided_at then return {} end
  decided_at = game.steps
  local nx, ny = next_cell(game.head_x, game.head_y)
  local want = (nx - game.head_x) .. "," .. (ny - game.head_y)
  if game.state == "ready" or want ~= DIR[game.dir] then return { KEY[want] } end
  return {}
end
