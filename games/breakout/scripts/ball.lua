-- The ball runs the rules and keeps the game's state on the "game" entity; game.lua shows it.

local ROW_POINTS = { 7, 7, 5, 5, 3, 3, 1, 1 }  -- red, orange, green, yellow rows
local SCREEN_BOTTOM = -1.5
local OFF_SCREEN_Y = -10

local function overlap(a, b)
  local px = (a.w + b.w) / 2 - math.abs(a.x - b.x)
  local py = (a.h + b.h) / 2 - math.abs(a.y - b.y)
  if px > 0 and py > 0 then return px, py end
end

local function current_speed(self)
  local level = 0
  if self.hits >= 4 then level = level + 1 end
  if self.hits >= 12 then level = level + 1 end
  if self.hit_orange then level = level + 1 end
  if self.hit_red then level = level + 1 end
  return self.speed + level * self.speed_step
end

local function rest_above_paddle(self)
  local p = self.paddle
  self.x = p.x
  self.y = p.y + (p.h + self.h) / 2 + 0.01
end

local function reset(self)
  rest_above_paddle(self)
  self.vx, self.vy = 0, 0
  self.hits = 0
  self.hit_orange, self.hit_red = false, false
  self.game.state = "ready"
end

local function new_game(self)
  for _, b in ipairs(self.bricks) do
    b.alive = true
    b.entity.y = b.y
  end
  local game = self.game
  game.score = 0
  game.lives = self.lives_per_game
  game.bricks_left = #self.bricks
  game.can_restart = false
  reset(self)
end

local function launch(self)
  local angle = math.rad(20 + math.random() * 25)
  if math.random() < 0.5 then angle = -angle end
  local speed = current_speed(self)
  self.vx = speed * math.sin(angle)
  self.vy = speed * math.cos(angle)
  self.game.state = "playing"
end

local function bounce_walls(self)
  local hw, hh = self.w / 2, self.h / 2
  if self.x - hw < self.left and self.vx < 0 then
    self.x = 2 * (self.left + hw) - self.x
    self.vx = -self.vx
  elseif self.x + hw > self.right and self.vx > 0 then
    self.x = 2 * (self.right - hw) - self.x
    self.vx = -self.vx
  end
  if self.y + hh > self.top and self.vy > 0 then
    self.y = 2 * (self.top - hh) - self.y
    self.vy = -self.vy
  end
end

local function bounce_paddle(self)
  local p = self.paddle
  if self.vy >= 0 or self.y < p.y - p.h / 2 or not overlap(self, p) then return end
  local offset = (self.x - p.x) / ((p.w + self.w) / 2)
  offset = math.max(-1, math.min(1, offset))
  local angle = offset * math.rad(self.max_angle)
  local speed = current_speed(self)
  self.vx = speed * math.sin(angle)
  self.vy = speed * math.cos(angle)
  self.y = p.y + (p.h + self.h) / 2
end

local function bounce_off_brick(self, b)
  local px, py = overlap(self, b)
  if not px then return false end
  local dx, dy = self.x - b.x, self.y - b.y
  if px < py then
    if dx * self.vx >= 0 then return false end
    self.vx = -self.vx
    return true
  end
  if dy * self.vy >= 0 then return false end
  self.vy = -self.vy
  return true
end

local function knock_out(self, b)
  b.alive = false
  b.entity.y = OFF_SCREEN_Y
  local game = self.game
  game.score = game.score + (ROW_POINTS[b.row] or 1)
  game.bricks_left = game.bricks_left - 1
  self.hits = self.hits + 1
  if b.row <= 2 then self.hit_red = true elseif b.row <= 4 then self.hit_orange = true end
  local speed = current_speed(self)
  local scale = speed / math.sqrt(self.vx * self.vx + self.vy * self.vy)
  self.vx, self.vy = self.vx * scale, self.vy * scale
end

-- One brick per tick, so a ball that meets the seam between two bricks bounces once.
local function hit_brick(self)
  if self.y + self.h / 2 < self.bricks_bottom or self.y - self.h / 2 > self.bricks_top then return end
  for _, b in ipairs(self.bricks) do
    if b.alive and bounce_off_brick(self, b) then
      knock_out(self, b)
      return
    end
  end
end

local function finish(self, state)
  self.y = OFF_SCREEN_Y
  self.vx, self.vy = 0, 0
  self.end_ticks = 0
  self.game.state = state
end

local function lose_ball(self)
  local game = self.game
  game.lives = game.lives - 1
  if game.lives > 0 then
    reset(self)
  else
    finish(self, "over")
  end
end

function start(self)
  self.paddle = get("paddle")
  self.game = get("game")
  self.lives_per_game = self.game.lives
  local left, right, top = get("wall_left"), get("wall_right"), get("wall_top")
  self.left = left.x + left.w / 2
  self.right = right.x - right.w / 2
  self.top = top.y - top.h / 2

  self.bricks = {}
  self.bricks_top, self.bricks_bottom = -math.huge, math.huge
  for _, e in ipairs(find_all("brick_")) do
    local row = tonumber(e.name:match("^brick_(%d+)_"))
    table.insert(self.bricks, { entity = e, row = row, x = e.x, y = e.y, w = e.w, h = e.h })
    self.bricks_top = math.max(self.bricks_top, e.y + e.h / 2)
    self.bricks_bottom = math.min(self.bricks_bottom, e.y - e.h / 2)
  end
  new_game(self)
end

function update(self, dt)
  local game = self.game
  if game.state == "ready" then
    rest_above_paddle(self)
    if input.pressed("Space") then launch(self) end
    return
  elseif game.state ~= "playing" then
    if game.can_restart and input.pressed("Space") then
      new_game(self)
    else
      self.end_ticks = self.end_ticks + 1
      game.can_restart = self.end_ticks >= self.restart_delay
    end
    return
  end
  self.x = self.x + self.vx * dt
  self.y = self.y + self.vy * dt
  bounce_walls(self)
  bounce_paddle(self)
  hit_brick(self)
  if game.bricks_left == 0 then
    finish(self, "won")
  elseif self.y + self.h / 2 < SCREEN_BOTTOM then
    lose_ball(self)
  end
end
