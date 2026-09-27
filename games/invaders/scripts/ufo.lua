-- The mystery ship: every so often it crosses the top while at least 8 invaders are left, worth 50 to 300 points.

local util = require("util")

local POINTS = { 50, 100, 150, 300 }

function start(self)
  self.parts = util.parts(self)
  local home_x = self.x
  self.reset = function()
    self.active, self.wait, self.dir = false, self.first_wait, 1
    self.x = home_x
    util.place(self)
  end

  self.destroy = function()
    self.active = false
    self.x = -self.edge - 0.2
    util.place(self)
    self.dir = -self.dir
    get("game").add_score(POINTS[math.random(#POINTS)], "the UFO")
  end

  self.reset()
end

function update(self, dt)
  local game = get("game")
  if game.state ~= "play" then return end
  if not self.active then
    self.wait = self.wait - 1
    if self.wait <= 0 then
      self.wait = self.every
      if get("fleet").alive_count >= 8 then
        self.active = true
        self.x = -self.dir * self.edge
      end
    end
    return
  end
  self.x = self.x + self.dir * self.speed * dt
  util.place(self)
  if self.x * self.dir > self.edge then
    self.active = false
    self.dir = -self.dir
  end
end
