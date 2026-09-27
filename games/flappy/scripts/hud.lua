-- The text on screen. Each line has a <name>_shadow copy, drawn under it, that shows the same text.

local function show(line, text)
  if line.main.text ~= text then
    line.main.text = text
    line.shadow.text = text
  end
end

local function refresh(self)
  local bird = self.bird
  show(self.lines.score, tostring(bird.score))
  show(self.lines.title, bird.state == "ready" and "GET READY" or bird.landed and "GAME OVER" or "")
  show(self.lines.prompt, (bird.state == "ready" or bird.can_restart) and "PRESS SPACE" or "")
end

function start(self)
  self.bird = get("bird")
  self.lines = {}
  for _, name in ipairs({ "score", "title", "prompt" }) do
    self.lines[name] = { main = get(name), shadow = get(name .. "_shadow") }
  end
  refresh(self)
end

function update(self, dt)
  refresh(self)
end
