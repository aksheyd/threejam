-- The referee: it comes after every mover in scene.toml, so it judges where things ended up this tick.

local function overlap(a, b)
  return math.abs(a.x - b.x) < (a.w + b.w) / 2 and math.abs(a.y - b.y) < (a.h + b.h) / 2
end

local function hits_pipe(self, bird)
  for _, pipe in ipairs(self.pipes) do
    for _, solid in ipairs(pipe.solids) do
      for _, box in ipairs(bird.boxes) do
        if overlap(box, solid) then return true end
      end
    end
  end
  return false
end

local function referee(self, bird)
  if hits_pipe(self, bird) then
    bird:crash()
    return
  end
  for _, pipe in ipairs(self.pipes) do
    if not pipe.scored and pipe.x + pipe.w / 2 < bird.x - bird.w / 2 then
      pipe.scored = true
      bird.score = bird.score + 1
    end
  end
end

function start(self)
  self.bird = get("bird")
  self.flash = get("flash")
  self.pipes = {}
  for _, entity in ipairs(find_all("pipe")) do
    if entity.name:match("^pipe%d+$") then table.insert(self.pipes, entity) end
  end
  self.flash_left = 0
  self.last_state = self.bird.state
end

function update(self, dt)
  local bird = self.bird
  if bird.state == "play" then
    referee(self, bird)
  end
  if bird.state == "over" and self.last_state ~= "over" then
    self.flash_left = self.flash_ticks
  elseif self.flash_left > 0 then
    self.flash_left = self.flash_left - 1
  end
  self.last_state = bird.state
  self.flash.color = { 1, 1, 1, self.flash_peak * self.flash_left / self.flash_ticks }
end
