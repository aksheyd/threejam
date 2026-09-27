function start(self)
  self.game = get("game")
  local left, right = get("wall_left"), get("wall_right")
  self.min_x = left.x + left.w / 2 + self.w / 2
  self.max_x = right.x - right.w / 2 - self.w / 2
end

function update(self, dt)
  local state = self.game.state
  if state == "over" or state == "won" then return end
  local dir = 0
  if input.held("Left") or input.held("A") then dir = dir - 1 end
  if input.held("Right") or input.held("D") then dir = dir + 1 end
  self.x = math.max(self.min_x, math.min(self.max_x, self.x + dir * self.speed * dt))
end
