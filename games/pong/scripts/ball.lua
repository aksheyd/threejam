local TOP, BOTTOM = 1.5, -1.5
local LEFT, RIGHT = -2.0, 2.0
local SERVE_ANGLE = math.rad(30)
local HIT_ANGLE = math.rad(50)

local function overlaps(a, b)
  return math.abs(a.x - b.x) < (a.w + b.w) / 2
     and math.abs(a.y - b.y) < (a.h + b.h) / 2
end

local function serve(self, dir)
  self.x, self.y = 0.0, 0.0
  self.speed = self.serve_speed
  local angle = (math.random() * 2 - 1) * SERVE_ANGLE
  self.vx = dir * self.speed * math.cos(angle)
  self.vy = self.speed * math.sin(angle)
  self.wait = self.serve_pause
end

local function hit(self, paddle, dir)
  local offset = (self.y - paddle.y) / ((paddle.h + self.h) / 2)
  local angle = math.max(-1, math.min(1, offset)) * HIT_ANGLE
  self.speed = math.min(self.speed * self.speedup, self.max_speed)
  self.vx = dir * self.speed * math.cos(angle)
  self.vy = self.speed * math.sin(angle)
  self.x = paddle.x + dir * (paddle.w + self.w) / 2
end

function start(self)
  self.game = get("game")
  self.left_paddle, self.right_paddle = get("left_paddle"), get("right_paddle")
  serve(self, 1)
end

function update(self, dt)
  if self.game.state ~= "play" then return end
  if self.wait > 0 then
    self.wait = self.wait - 1
    return
  end

  self.x = self.x + self.vx * dt
  self.y = self.y + self.vy * dt

  local r = self.h / 2
  if self.y + r > TOP then
    self.y = TOP - r
    self.vy = -math.abs(self.vy)
  elseif self.y - r < BOTTOM then
    self.y = BOTTOM + r
    self.vy = math.abs(self.vy)
  end

  -- A ball already past a paddle's middle doesn't bounce, so it can score.
  local left, right = self.left_paddle, self.right_paddle
  if self.vx < 0 and self.x > left.x and overlaps(self, left) then
    hit(self, left, 1)
  elseif self.vx > 0 and self.x < right.x and overlaps(self, right) then
    hit(self, right, -1)
  end

  if self.x - self.w / 2 > RIGHT then
    self.game.point("left")
    serve(self, 1)
  elseif self.x + self.w / 2 < LEFT then
    self.game.point("right")
    serve(self, -1)
  end
end
