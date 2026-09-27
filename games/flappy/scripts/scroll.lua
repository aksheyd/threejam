-- A ground stripe: it scrolls with the world until the run is over, and jumps `period` right once past `wrap_at`.

function start(self)
  self.bird = get("bird")
end

function update(self, dt)
  if self.bird.state ~= "over" then
    self.x = self.x - self.bird.forward_speed * dt
    if self.x < self.wrap_at then
      self.x = self.x + self.period
    end
  end
end
