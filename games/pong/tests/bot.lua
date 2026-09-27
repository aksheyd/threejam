-- Waits 2 seconds on each waiting screen, presses Space, then plays one side (left in odd matches, right in even ones) while the other paddle stays still.
local matches, waiting_since = 0, nil

function keys(tick)
  local game = get("game")
  if game.state ~= "play" then
    waiting_since = waiting_since or tick
    if tick - waiting_since < 120 then return {} end
    waiting_since = nil
    matches = matches + 1
    return { "Space" }
  end
  local paddle = get(matches % 2 == 1 and "left_paddle" or "right_paddle")
  local dy = get("ball").y - paddle.y
  if dy > 0.05 then return { paddle.up } end
  if dy < -0.05 then return { paddle.down } end
  return {}
end
