-- The bird, and the game state every other script reads from it: "ready", "play", or "over".

local PARTS = {
  "bird_line", "bird_body", "bird_belly", "bird_wing_line", "bird_wing",
  "bird_eye", "bird_pupil", "bird_beak_line", "bird_beak_top", "bird_beak_bot",
}
local WING_PARTS = { bird_wing_line = true, bird_wing = true }
local WING_FRAMES = { 0.018, 0.0, -0.018, 0.0 }

local function overlap(a, b)
  return math.abs(a.x - b.x) < (a.w + b.w) / 2 and math.abs(a.y - b.y) < (a.h + b.h) / 2
end

local function place_parts(self)
  local wing = 0
  if self.state ~= "over" then wing = WING_FRAMES[(self.age // 5) % 4 + 1] end
  for _, part in ipairs(self.parts) do
    part.entity.x = self.x + part.dx
    part.entity.y = self.y + part.dy + (part.wing and wing or 0)
  end
end

local function fly(self, dt, flap)
  self.vy = self.vy - self.gravity * dt
  if flap then self.vy = self.flap_speed end
  self.vy = math.max(self.vy, -self.max_fall)
  self.y = self.y + self.vy * dt
end

local function crash(self)
  self.state = "over"
  self.vy = math.min(self.vy, 0)
end

local function land(self)
  self.y, self.vy = self.rest_y, 0
  self.landed = true
end

local function restart(self)
  self.state = "ready"
  self.round = self.round + 1
  self.y = self.home_y
  self.vy = 0
  self.score = 0
  self.landed = false
  self.over_ticks = 0
  self.can_restart = false
end

function start(self)
  self.home_y = self.y
  self.vy = 0
  self.score = 0
  self.round = 1
  self.state = "ready"
  self.age = 0
  self.landed = false
  self.over_ticks = 0
  self.can_restart = false
  self.crash = crash
  self.ground = get("ground")
  self.ceiling = get("ceiling")
  self.rest_y = self.ground.y + (self.ground.h + self.h) / 2
  local parts = {}
  for i, name in ipairs(PARTS) do
    local part = get(name)
    parts[i] = { entity = part, dx = part.x - self.x, dy = part.y - self.y, wing = WING_PARTS[name] }
  end
  self.parts = parts
  -- The body box matches bird_line; the beak sticks out of it, so pipes test both.
  self.boxes = { self, get("bird_beak_line") }
end

function update(self, dt)
  local pressed = input.pressed("Space")
  self.age = self.age + 1

  if self.state == "ready" then
    self.y = self.home_y + self.bob * math.sin(self.age * dt * 2 * math.pi / 0.8)
    if pressed then self.state = "play" end
  end

  if self.state == "play" then
    fly(self, dt, pressed)
    if overlap(self, self.ground) then
      land(self)
      crash(self)
    elseif overlap(self, self.ceiling) then
      self.y = self.ceiling.y - (self.ceiling.h + self.h) / 2
      crash(self)
    end
  elseif self.state == "over" then
    if self.can_restart and pressed then
      restart(self)
    elseif not self.landed then
      fly(self, dt, false)
      if self.y <= self.rest_y then land(self) end
    else
      self.over_ticks = self.over_ticks + 1
      self.can_restart = self.over_ticks >= self.restart_delay
    end
  end

  place_parts(self)
end
