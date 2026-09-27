-- Moves this entity with WASD at self.speed units per second.

function update(self, dt)
  local dx, dy = 0, 0
  if input.held("D") then dx = dx + 1 end
  if input.held("A") then dx = dx - 1 end
  if input.held("W") then dy = dy + 1 end
  if input.held("S") then dy = dy - 1 end
  local length = math.sqrt(dx * dx + dy * dy)
  if length > 0 then
    self.x = self.x + dx / length * self.speed * dt
    self.y = self.y + dy / length * self.speed * dt
  end
end
