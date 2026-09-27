-- A pipe pair: this entity is the gap, and its parts, named <name>_<suffix>, keep their scene offsets from it.

local PARTS = {
  "top_line", "top", "top_hi", "top_lo", "top_cap_line", "top_cap", "top_cap_hi", "top_cap_lo",
  "bot_line", "bot", "bot_hi", "bot_lo", "bot_cap_line", "bot_cap", "bot_cap_hi", "bot_cap_lo",
}
local SOLIDS = { "top_line", "top_cap_line", "bot_line", "bot_cap_line" }

local function place_parts(self)
  for _, part in ipairs(self.parts) do
    part.entity.x = self.x + part.dx
    part.entity.y = self.y + part.dy
  end
end

local function new_gap(self)
  self.y = self.gap_min + (self.gap_max - self.gap_min) * math.random()
end

local function go_home(self)
  self.x = self.home_x
  new_gap(self)
  self.scored = self.x < self.bird.x  -- a pair that starts behind the bird can't be passed
end

function start(self)
  self.bird = get("bird")
  self.home_x = self.x
  self.round = self.bird.round
  local parts, solids = {}, {}
  for i, suffix in ipairs(PARTS) do
    local part = get(self.name .. "_" .. suffix)
    parts[i] = { entity = part, dx = part.x - self.x, dy = part.y - self.y }
  end
  for i, suffix in ipairs(SOLIDS) do
    solids[i] = get(self.name .. "_" .. suffix)
  end
  self.parts = parts
  self.solids = solids
  go_home(self)
  place_parts(self)
end

function update(self, dt)
  local bird = self.bird
  if self.round ~= bird.round then
    self.round = bird.round
    go_home(self)
  end
  if bird.state == "play" then
    self.x = self.x - bird.forward_speed * dt
    if self.x < -2 - self.w / 2 then
      self.x = self.x + self.wrap
      new_gap(self)
      self.scored = false
    end
  end
  place_parts(self)
end
