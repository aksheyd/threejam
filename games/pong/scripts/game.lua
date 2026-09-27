local function show_overlay(self, shown)
  for _, e in ipairs(self.overlay) do
    local c = e.color
    e.color = { c[1], c[2], c[3], shown and 1 or 0 }
  end
end

local function set_score(self, side, points)
  self.score[side] = points
  self.digits[side].text = tostring(points)
end

function start(self)
  self.state = "ready"
  self.score = { left = 0, right = 0 }
  self.digits = { left = get("left_score"), right = get("right_score") }
  self.winner, self.prompt = get("winner"), get("prompt")
  self.overlay = { self.winner, self.prompt, get("left_keys"), get("right_keys") }

  -- ball.lua calls this with "left" or "right", the side that scored.
  self.point = function(side)
    set_score(self, side, self.score[side] + 1)
    print(("%s scores, %d-%d"):format(side, self.score.left, self.score.right))
    if self.score[side] >= self.win_score then
      self.state = "over"
      self.winner.text = side:upper() .. " PLAYER WINS"
      self.prompt.text = "PRESS SPACE TO PLAY AGAIN"
      show_overlay(self, true)
      print(("%s wins %d-%d"):format(side, self.score.left, self.score.right))
    end
  end
end

function update(self, dt)
  if self.state ~= "play" and input.pressed("Space") then
    set_score(self, "left", 0)
    set_score(self, "right", 0)
    show_overlay(self, false)
    self.state = "play"
  end
end
