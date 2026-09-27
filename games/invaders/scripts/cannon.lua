-- The player's cannon: Left and Right move it, and Space fires whenever the one shot isn't already flying.

local util = require("util")

local function show(self, visible)
  if visible == self.shown then return end
  self.shown = visible
  for _, part in ipairs(self.parts) do
    util.set_alpha(part.e, visible and 1 or 0)
  end
end

function start(self)
  self.parts = util.parts(self)
  local home_x = self.x
  self.reset = function()
    self.x = home_x
    util.place(self)
    show(self, true)
    self.armed = false
  end
  self.reset()
end

function update(self, dt)
  local game = get("game")
  if game.state == "dying" then
    show(self, (game.timer // 6) % 2 == 1)
    return
  end
  show(self, game.lives > 0)
  if game.state ~= "play" then return end

  local move = 0
  if input.held("Left") then move = move - 1 end
  if input.held("Right") then move = move + 1 end
  local half = self.w / 2
  self.x = math.max(self.left + half, math.min(self.right - half, self.x + move * self.speed * dt))
  util.place(self)

  local shot = get("shot")
  -- The press that starts a game doesn't fire; armed is read before it's set so a start tap too short for held doesn't either.
  local fire = self.armed and (input.held("Space") or input.pressed("Space"))
  if not input.held("Space") then self.armed = true end
  if fire and not shot.active then
    shot.fire(self.x, self.y + self.h / 2)
  end
end
