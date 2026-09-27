-- Presses Space, then both paddles follow the ball, so the rally never ends and the ball speeds up to max_speed.
local function follow(paddle, ball, held)
  local dy = ball.y - paddle.y
  if dy > 0.05 then
    held[#held + 1] = paddle.up
  elseif dy < -0.05 then
    held[#held + 1] = paddle.down
  end
end

function keys(tick)
  if get("game").state ~= "play" then return { "Space" } end
  local held, ball = {}, get("ball")
  follow(get("left_paddle"), ball, held)
  follow(get("right_paddle"), ball, held)
  return held
end
