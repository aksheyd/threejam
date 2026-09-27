-- An invader bomb: drop() starts it under an invader, and it falls until it hits the cannon, a shield cell, or the ground.

local util = require("util")

local PARKED_Y = -2.5

-- The stem follows the bomb; the crossbar slides down it as it falls.
local function place(self)
  self.stem.x, self.stem.y = self.x, self.y
  local slot = (self.age // 4) % 3
  self.bar.x = self.x
  self.bar.y = self.y + self.h / 2 - self.bar.h / 2 - slot * self.h / 3
end

function start(self)
  self.stem = get(self.name .. "_stem")
  self.bar = get(self.name .. "_bar")
  local home_x, home_y = self.x, self.y
  self.reset = function()
    self.active, self.age = false, 0
    self.x, self.y = home_x, home_y
    place(self)
  end

  self.drop = function(x, y)
    self.active, self.age = true, 0
    self.x, self.y = x, y - self.h / 2
    place(self)
  end

  self.stop = function()
    self.active = false
    self.y = PARKED_Y
    place(self)
  end

  self.reset()
end

function update(self, dt)
  if not self.active then return end
  local game = get("game")
  if game.state == "dying" then
    self.stop()
    return
  end
  if game.state ~= "play" then return end

  self.y = self.y - self.speed * dt
  self.age = self.age + 1
  place(self)
  for _, part in ipairs(get("cannon").parts) do
    if util.overlaps(self, part.e) then
      self.stop()
      game.cannon_hit(self.name)
      return
    end
  end
  if get("shields").hit(self) > 0 or self.y - self.h / 2 < self.ground then self.stop() end
end
