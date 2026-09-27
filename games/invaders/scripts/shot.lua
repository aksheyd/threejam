-- The player's shot: fire() launches it from the cannon, and it flies up until it hits something or leaves the top.

local util = require("util")

local PARKED_Y = -2.5

local function stop(self)
  self.active = false
  self.y = PARKED_Y
end

function start(self)
  local home_x, home_y = self.x, self.y
  self.reset = function()
    self.active = false
    self.x, self.y = home_x, home_y
  end

  self.fire = function(x, y)
    self.active = true
    self.x, self.y = x, y + self.h / 2
  end

  self.reset()
end

function update(self, dt)
  if not self.active then return end
  local game = get("game")
  if game.state == "dying" then
    stop(self)
    return
  end
  if game.state ~= "play" then return end

  self.y = self.y + self.speed * dt
  if get("shields").hit(self) > 0 then
    stop(self)
    return
  end
  local fleet = get("fleet")
  for _, bomb in ipairs(fleet.bombs) do
    if bomb.active and util.overlaps(self, bomb) then
      stop(self)
      bomb.stop()
      return
    end
  end
  for _, inv in ipairs(fleet.invaders) do
    if inv.alive and util.overlaps(self, inv.e) then
      stop(self)
      fleet.kill(inv)
      return
    end
  end
  local ufo = get("ufo")
  if ufo.active and util.overlaps(self, ufo) then
    stop(self)
    ufo.destroy()
    return
  end
  if self.y - self.h / 2 > self.top then stop(self) end
end
