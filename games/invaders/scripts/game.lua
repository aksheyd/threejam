-- Score, lives, and the game's states; other scripts call the functions that start() puts on this entity.

local util = require("util")

local WHITE = { 1, 1, 1 }
local GREEN = { 0.2, 1, 0.2 }
local RED = { 1, 0.2, 0.2 }

local function lives_phrase(n)
  return n == 1 and "1 life" or n .. " lives"
end

local function draw_hud(self)
  self.hud.score.text = string.format("%04d", self.score)
  self.hud.lives.text = tostring(self.lives)
  for k, icon in ipairs(self.spare_icons) do
    for _, part in ipairs(icon) do
      util.set_alpha(part, k < self.lives and 1 or 0)
    end
  end
end

local function show(self, message, color)
  self.hud.message.text = message
  self.hud.message.color = color
  self.hud.hint.text = ""
end

local function begin(self)
  self.state = "play"
  show(self, "", WHITE)
  print(string.format("the invasion begins with %s", lives_phrase(self.lives)))
end

local function finish(self, state, message)
  self.state = state
  self.timer = self.restart_ticks
  print(string.format("%s (final score %d)", message, self.score))
  if state == "over" then
    self.ground.color = RED
    show(self, "GAME OVER", RED)
  else
    show(self, "YOU WIN", WHITE)
  end
end

-- Every script's start() stores a reset() that puts its entity back the way start() left it.
local function restart(self)
  for _, e in ipairs(find_all("")) do
    if e.reset then e.reset() end
  end
  begin(self)
end

function start(self)
  local lives = self.lives
  self.hud = { score = get("score"), lives = get("lives"), message = get("message"), hint = get("hint") }
  self.ground = get("ground")
  self.spare_icons = { find_all("life1_p"), find_all("life2_p") }

  self.reset = function()
    self.state = "ready" -- waiting for Space; then "play", "dying" (cannon exploding, everything paused), "won", or "over"
    self.score, self.lives, self.timer = 0, lives, 0
    self.ground.color = GREEN
    show(self, "PRESS SPACE TO START", WHITE)
    draw_hud(self)
  end

  self.add_score = function(points, what)
    self.score = self.score + points
    print(string.format("score +%d for %s = %d", points, what, self.score))
    draw_hud(self)
  end

  self.cannon_hit = function(by)
    if self.state ~= "play" then return end
    self.lives = self.lives - 1
    print(string.format("cannon hit by %s: %s left", by, lives_phrase(self.lives)))
    draw_hud(self)
    if self.lives <= 0 then
      finish(self, "over", "GAME OVER: the last life is lost")
    else
      self.state = "dying"
      self.timer = self.respawn_ticks
    end
  end

  self.invaded = function(lowest_y)
    if self.state == "play" then
      finish(self, "over", string.format("GAME OVER: the invaders reached the bottom (lowest edge y=%.2f)", lowest_y))
    end
  end

  self.cleared = function()
    finish(self, "won", "YOU WIN: the wave is cleared")
  end

  self.reset()
end

function update(self, dt)
  if self.state == "ready" then
    if input.pressed("Space") then begin(self) end
  elseif self.state == "dying" then
    self.timer = self.timer - 1
    if self.timer <= 0 then self.state = "play" end
  elseif self.state == "won" or self.state == "over" then
    if self.timer > 0 then
      self.timer = self.timer - 1
    elseif self.hud.hint.text == "" then
      self.hud.hint.text = "PRESS SPACE TO PLAY AGAIN"
    elseif input.pressed("Space") then
      restart(self)
    end
  end
end
