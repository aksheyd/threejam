-- Serves, then meets the ball at a random point on the paddle so the bounce angles vary and the whole wall gets hit.

local paddle, ball, game = get("paddle"), get("ball"), get("game")
local aim, aiming = 0, false

-- Where the ball's center will be at paddle height, after bouncing off the side walls on the way down.
local function landing_x()
  local contact_y = paddle.y + (paddle.h + ball.h) / 2
  local t = (ball.y - contact_y) / -ball.vy
  local lo = paddle.min_x - paddle.w / 2 + ball.w / 2
  local span = (paddle.max_x + paddle.w / 2 - ball.w / 2) - lo
  local u = (ball.x + ball.vx * t - lo) % (2 * span)
  if u > span then u = 2 * span - u end
  return lo + u
end

function keys(tick)
  if game.state == "ready" then return { "Space" } end
  if game.state ~= "playing" then return {} end
  local target = ball.x
  if ball.vy < 0 then
    if not aiming then
      aim = (math.random() * 2 - 1) * 0.7
      aiming = true
    end
    target = landing_x() - aim * (paddle.w + ball.w) / 2
  else
    aiming = false
  end
  local half_step = paddle.speed / 60 / 2
  if target < paddle.x - half_step then return { "Left" } end
  if target > paddle.x + half_step then return { "Right" } end
  return {}
end
