local TOP, BOTTOM = 1.5, -1.5

function update(self, dt)
  local dir = 0
  if input.held(self.up) then dir = dir + 1 end
  if input.held(self.down) then dir = dir - 1 end
  local half = self.h / 2
  local y = self.y + dir * self.speed * dt
  self.y = math.max(BOTTOM + half, math.min(TOP - half, y))
end
