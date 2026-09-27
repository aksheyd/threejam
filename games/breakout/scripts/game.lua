-- The ball's start sets the fields this script shows, so "ball" must come before "game" in scene.toml.

local MESSAGE = { over = "GAME OVER", won = "YOU WIN" }

local function set_text(entity, text)
  if entity.text ~= text then entity.text = text end
end

local function show(self)
  set_text(self.score_text, tostring(self.score))
  set_text(self.lives_text, tostring(self.lives))
  set_text(self.message, MESSAGE[self.state] or "")
  local prompt = ""
  if self.state == "ready" then
    prompt = "PRESS SPACE"
  elseif self.can_restart then
    prompt = "PRESS SPACE TO PLAY AGAIN"
  end
  set_text(self.prompt, prompt)
end

function start(self)
  self.score_text = get("score_text")
  self.lives_text = get("lives_text")
  self.message = get("message")
  self.prompt = get("prompt")
  self.shown_score, self.shown_lives, self.shown_state = self.score, self.lives, self.state
  show(self)
  print(string.format("score %d, lives %d, %d bricks to clear", self.score, self.lives, self.bricks_left))
end

function update(self, dt)
  if self.score ~= self.shown_score then print("score " .. self.score) end
  if self.lives ~= self.shown_lives then print("lives " .. self.lives) end
  if self.state ~= self.shown_state then
    if self.state == "won" then print("YOU WIN! every brick cleared, final score " .. self.score) end
    if self.state == "over" then print("GAME OVER, final score " .. self.score) end
  end
  self.shown_score, self.shown_lives, self.shown_state = self.score, self.lives, self.state
  show(self)
end
