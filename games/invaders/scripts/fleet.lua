-- The invader formation: it marches, steps down and turns at the edges, speeds up as invaders die, and drops bombs.

local POINTS = { 30, 20, 20, 10, 10 } -- per row, top to bottom
local WHITE = { 1, 1, 1 }
local GREEN = { 0.2, 1, 0.2 } -- like the arcade's green overlay near the bottom

-- Pose 0 parts are drawn in both poses, pose 1 or 2 parts only in that pose.
local function collect(prefix, pose, parts)
  for _, e in ipairs(find_all(prefix)) do
    parts[#parts + 1] = { e = e, x = e.x, y = e.y, pose = pose }
  end
end

local function paint(part, color, visible)
  part.e.color = { color[1], color[2], color[3], visible and 1 or 0 }
end

local function interval_for(self, alive)
  return math.max(1, math.floor(alive * self.tempo + 0.5))
end

local function band_color(self, y)
  return y < self.green_below and GREEN or WHITE
end

local function alive_extents(self)
  local left, right, bottom = math.huge, -math.huge, math.huge
  for _, inv in ipairs(self.invaders) do
    if inv.alive then
      local e = inv.e
      left = math.min(left, e.x - e.w / 2)
      right = math.max(right, e.x + e.w / 2)
      bottom = math.min(bottom, e.y - e.h / 2)
    end
  end
  return left, right, bottom
end

local function place(self)
  local ox, oy = self.sx * self.step_x, -self.sy * self.step_down
  local pose = self.steps % 2 + 1
  for _, inv in ipairs(self.invaders) do
    if inv.alive then
      inv.e.x, inv.e.y = inv.x + ox, inv.y + oy
      local color = band_color(self, inv.e.y)
      for _, part in ipairs(inv.parts) do
        part.e.x, part.e.y = part.x + ox, part.y + oy
        paint(part, color, part.pose == 0 or part.pose == pose)
      end
    end
  end
end

local function march(self, game)
  local left, right = alive_extents(self)
  local edge = self.dir > 0 and right + self.step_x > self.right + 1e-6
    or self.dir < 0 and left - self.step_x < self.left - 1e-6
  self.steps = self.steps + 1
  if edge then
    self.sy = self.sy + 1
    self.dir = -self.dir
  else
    self.sx = self.sx + self.dir
  end
  place(self)

  local _, _, bottom = alive_extents(self)
  local shields = get("shields")
  if bottom < shields.top then
    for _, inv in ipairs(self.invaders) do
      if inv.alive then shields.hit(inv.e) end
    end
  end
  if bottom < self.invade_below then game.invaded(bottom) end
end

local function lowest_in_column(self, col)
  local column = self.columns[col]
  for r = #column, 1, -1 do
    if column[r].alive then return column[r] end
  end
end

-- "aimed" bombs come from the column nearest the cannon, the others from a random column.
local function pick_shooter(self, kind)
  local shooters = {}
  for c = 1, #self.columns do
    shooters[#shooters + 1] = lowest_in_column(self, c)
  end
  if #shooters == 0 then return nil end
  if kind ~= "aimed" then return shooters[math.random(#shooters)] end
  local cannon_x, best = get("cannon").x, nil
  for _, inv in ipairs(shooters) do
    if not best or math.abs(inv.e.x - cannon_x) < math.abs(best.e.x - cannon_x) then best = inv end
  end
  return best
end

local function drop_bomb(self)
  if self.bomb_wait > 0 then
    self.bomb_wait = self.bomb_wait - 1
    return
  end
  for _ = 1, #self.bombs do
    self.next_bomb = self.next_bomb % #self.bombs + 1
    local bomb = self.bombs[self.next_bomb]
    if not bomb.active then
      local shooter = pick_shooter(self, bomb.kind)
      if shooter then
        bomb.drop(shooter.e.x, shooter.e.y - shooter.e.h / 2)
        self.bomb_wait = math.random(self.bomb_gap_min, self.bomb_gap_max)
      end
      return
    end
  end
end

local function show_boom(self, x, y, color)
  for _, part in ipairs(self.boom) do
    part.e.x, part.e.y = x + part.x, y + part.y
    paint(part, color, true)
  end
  self.boom_timer = self.boom_ticks
end

local function tick_boom(self)
  if self.boom_timer > 0 then
    self.boom_timer = self.boom_timer - 1
    if self.boom_timer == 0 then
      for _, part in ipairs(self.boom) do paint(part, WHITE, false) end
    end
  end
end

function start(self)
  self.invaders, self.columns = {}, {}
  for c = 1, self.cols do self.columns[c] = {} end
  for r = 1, self.rows do
    for c = 1, self.cols do
      local name = "inv_r" .. r .. "_c" .. c
      local e = get(name)
      local inv = { e = e, x = e.x, y = e.y, points = POINTS[r], parts = {} }
      collect(name .. "_c", 0, inv.parts)
      collect(name .. "_a", 1, inv.parts)
      collect(name .. "_b", 2, inv.parts)
      e.points = inv.points
      self.invaders[#self.invaders + 1] = inv
      self.columns[c][r] = inv
    end
  end

  local anchor = get("boom")
  self.boom = {}
  collect("boom_p", 0, self.boom)
  for _, part in ipairs(self.boom) do
    part.x, part.y = part.x - anchor.x, part.y - anchor.y
  end

  self.bombs = {}
  for _, e in ipairs(find_all("bomb")) do
    if e.name:match("^bomb%d+$") then self.bombs[#self.bombs + 1] = e end
  end

  self.reset = function()
    for _, inv in ipairs(self.invaders) do
      inv.alive, inv.e.alive = true, true
    end
    self.alive_count = #self.invaders
    self.interval = interval_for(self, self.alive_count)
    self.wait = self.interval
    self.dir, self.sx, self.sy, self.steps = 1, 0, 0, 0
    self.bomb_wait, self.next_bomb = self.bomb_gap_max, 0
    place(self)
    for _, part in ipairs(self.boom) do
      part.e.x, part.e.y = anchor.x + part.x, anchor.y + part.y
      paint(part, WHITE, false)
    end
    self.boom_timer = 0
  end

  self.kill = function(inv)
    inv.alive, inv.e.alive = false, false
    for _, part in ipairs(inv.parts) do paint(part, WHITE, false) end
    show_boom(self, inv.e.x, inv.e.y, band_color(self, inv.e.y))
    self.alive_count = self.alive_count - 1
    self.interval = interval_for(self, self.alive_count)
    self.wait = math.min(self.wait, self.interval)
    local game = get("game")
    game.add_score(inv.points, inv.e.name)
    if self.alive_count == 0 then game.cleared() end
  end

  self.reset()
end

function update(self, dt)
  tick_boom(self)
  local game = get("game")
  if game.state ~= "play" then return end
  self.wait = self.wait - 1
  if self.wait <= 0 then
    march(self, game)
    self.wait = self.interval
  end
  if game.state == "play" then drop_bomb(self) end
end
