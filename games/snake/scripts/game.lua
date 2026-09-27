-- The body is a pool of "seg" entities parked off screen, since entities can't be added while the game runs.

local KEYS = {
  { "Up", 0, 1 },
  { "Down", 0, -1 },
  { "Left", -1, 0 },
  { "Right", 1, 0 },
}
local DIR_NAMES = { ["0,1"] = "up", ["0,-1"] = "down", ["-1,0"] = "left", ["1,0"] = "right" }
local APPLE_PARTS = { "food", "food_b", "shine", "stem", "leaf" }
local PARK_X = 3.0

-- Only the "game" entity uses this file, so the game's state can live here.
local head, eyes, overlay, score_text, message, hint
local head_color, clear_tint
local apple = {}       -- { e, dx, dy } per apple part, offset from the food cell's center
local pool             -- body segments, taken in order as the snake grows
local used = 0
local start_cells = {} -- the starting snake from the tail to the head
local cx, cy           -- snake cells from the tail (index first) to the head (index last)
local seg              -- seg[i] draws body cell i; the head cell has none
local first, last
local occupied         -- occupied[cell_key] is true under every part of the snake
local turns            -- turns waiting for the next step, oldest first
local dir_x, dir_y     -- direction of the last step
local countdown        -- ticks until the next step

local function cell_key(self, x, y)
  return (y - 1) * self.cols + x
end

local function to_world(self, x, y)
  return (x - 0.5 - self.cols / 2) * self.cell, (y - 0.5 - self.rows / 2) * self.cell
end

local function place(self, e, x, y)
  e.x, e.y = to_world(self, x, y)
end

local function place_head(self)
  local x, y = to_world(self, cx[last], cy[last])
  head.x, head.y = x, y
  local ahead, side = 0.045, 0.045
  eyes[1].x = x + dir_x * ahead - dir_y * side
  eyes[1].y = y + dir_y * ahead + dir_x * side
  eyes[2].x = x + dir_x * ahead + dir_y * side
  eyes[2].y = y + dir_y * ahead - dir_x * side
  self.dir = DIR_NAMES[dir_x .. "," .. dir_y]
  self.head_x, self.head_y = cx[last], cy[last]
end

local function place_food(self, x, y)
  self.food_x, self.food_y = x, y
  local wx, wy = to_world(self, x, y)
  for _, part in ipairs(apple) do
    part.e.x, part.e.y = wx + part.dx, wy + part.dy
  end
end

local function spawn_food(self)
  local free = {}
  for key = 1, self.cols * self.rows do
    if not occupied[key] then free[#free + 1] = key end
  end
  if #free == 0 then return false end
  local key = free[math.random(#free)]
  place_food(self, (key - 1) % self.cols + 1, (key - 1) // self.cols + 1)
  print(string.format("food at (%d,%d), picked from %d free cell%s",
    self.food_x, self.food_y, #free, #free == 1 and "" or "s"))
  return true
end

local function end_game(self, state, title, tint)
  self.state = state
  overlay.color = tint
  message.text = title
  hint.text = "PRESS SPACE TO PLAY AGAIN"
end

local function game_over(self, why, x, y)
  head.color = { 0.95, 0.3, 0.2 }
  end_game(self, "over", "GAME OVER", { 0.45, 0.0, 0.0, 0.4 })
  print(string.format("game over: %s at (%d,%d). final score %d", why, x, y, self.score))
end

local function read_keys()
  local any = false
  for _, k in ipairs(KEYS) do
    local name, kx, ky = k[1], k[2], k[3]
    if input.pressed(name) then
      any = true
      local px, py = dir_x, dir_y
      if #turns > 0 then px, py = turns[#turns][1], turns[#turns][2] end
      -- only quarter turns: reversing would drive the head straight into the neck
      if #turns < 2 and kx * px + ky * py == 0 then turns[#turns + 1] = { kx, ky } end
    end
  end
  return any
end

local function step(self)
  if #turns > 0 then
    dir_x, dir_y = turns[1][1], turns[1][2]
    table.remove(turns, 1)
  end
  self.steps = self.steps + 1
  local nx, ny = cx[last] + dir_x, cy[last] + dir_y
  if nx < 1 or nx > self.cols or ny < 1 or ny > self.rows then
    return game_over(self, "hit the wall", nx, ny)
  end
  local grows = nx == self.food_x and ny == self.food_y
  local new_key = cell_key(self, nx, ny)
  local tail_key = cell_key(self, cx[first], cy[first])
  -- the tail leaves its cell this step unless the snake grows, so the head may take it
  if occupied[new_key] and (grows or new_key ~= tail_key) then
    return game_over(self, "ran into itself", nx, ny)
  end

  local neck
  if grows then
    used = used + 1
    neck = pool[used]
    if not neck then error("out of body segments: scene.toml needs more seg entities") end
  else
    occupied[tail_key] = nil
    neck = seg[first]
    seg[first], cx[first], cy[first] = nil, nil, nil
    first = first + 1
  end
  if neck then
    seg[last] = neck
    place(self, neck, cx[last], cy[last])
  end
  last = last + 1
  cx[last], cy[last] = nx, ny
  occupied[new_key] = true
  place_head(self)
  self.length = last - first + 1

  if grows then
    self.score = self.score + 1
    score_text.text = tostring(self.score)
    print(string.format("ate food at (%d,%d): score %d, length %d", nx, ny, self.score, self.length))
    if not spawn_food(self) then
      for _, part in ipairs(apple) do part.e.x = PARK_X end
      end_game(self, "won", "YOU WIN", { 0.0, 0.45, 0.0, 0.3 })
      print(string.format("you win! the snake fills the board. final score %d", self.score))
    end
  end
end

local function new_game(self)
  for i = 1, used do pool[i].x = PARK_X end
  used = 0
  cx, cy, seg, occupied, turns = {}, {}, {}, {}, {}
  first, last = 1, #start_cells
  for n, c in ipairs(start_cells) do
    cx[n], cy[n] = c[1], c[2]
    occupied[cell_key(self, c[1], c[2])] = true
    if n < last then
      used = used + 1
      seg[n] = pool[used]
      place(self, seg[n], c[1], c[2])
    end
  end
  if last > 1 then
    dir_x, dir_y = cx[last] - cx[last - 1], cy[last] - cy[last - 1]
  else
    dir_x, dir_y = 1, 0
  end
  head.color = head_color
  place_head(self)
  overlay.color = clear_tint
  self.state, self.score, self.length, self.steps = "ready", 0, last, 0
  score_text.text = "0"
  message.text = ""
  hint.text = "PRESS AN ARROW KEY"
  spawn_food(self)
end

function start(self)
  head, overlay = get("head"), get("overlay")
  eyes = { get("eye1"), get("eye2") }
  score_text, message, hint = get("score"), get("message"), get("hint")
  head_color, clear_tint = head.color, overlay.color
  local anchor = get("food")
  for _, name in ipairs(APPLE_PARTS) do
    local part = get(name)
    apple[#apple + 1] = { e = part, dx = part.x - anchor.x, dy = part.y - anchor.y }
  end
  pool = find_all("seg")

  -- start_body lists the snake's cells head first, like "6,8 5,8 4,8"
  local seen = {}
  for x, y in self.start_body:gmatch("(%d+),(%d+)") do
    x, y = tonumber(x), tonumber(y)
    if x < 1 or x > self.cols or y < 1 or y > self.rows then
      error(string.format("start_body cell (%d,%d) is off the board", x, y))
    end
    if seen[cell_key(self, x, y)] then
      error(string.format("start_body lists cell (%d,%d) twice", x, y))
    end
    local before = start_cells[1]
    if before and math.abs(x - before[1]) + math.abs(y - before[2]) ~= 1 then
      error(string.format("start_body cell (%d,%d) doesn't touch the cell before it", x, y))
    end
    seen[cell_key(self, x, y)] = true
    table.insert(start_cells, 1, { x, y })
  end
  if #start_cells == 0 then error("start_body needs at least one cell, like \"6,8 5,8\"") end
  new_game(self)
end

function update(self, dt)
  if self.state == "over" or self.state == "won" then
    if not input.pressed("Space") then return end
    print("new game")
    new_game(self)
  end
  local pressed = read_keys()
  if self.state == "ready" then
    if pressed then
      self.state = "playing"
      hint.text = ""
      countdown = self.step_ticks
      print("the snake starts moving")
    end
    return
  end
  countdown = countdown - 1
  if countdown == 0 then
    countdown = self.step_ticks
    step(self)
  end
end
