-- Written for seed 0, the default. Each spawn gets {piece it expects, moves}: U rotates, L and R shift, D soft-drops onto the ghost, and . waits.
local PLAN = {
  {"O", "LLL"}, {"I", "."}, {"S", "URR"}, {"L", "UUURRRR"}, {"J", "ULLLL"}, {"Z", "L"},
  {"T", "UUURDU"},    -- the T lands, then its turn is blocked by the S
  {"I", "URRRRRU"},   -- the I stands in column 10, where the last R and U are blocked by the wall
  {"L", "UURRR"}, {"J", "UUL"}, {"O", "LLLL"}, {"T", "UUR"}, {"Z", "UL"}, {"S", "URRRR"},
}
local KEYS = {U = "Up", L = "Left", R = "Right"}
local piece, step, resting = 0, 1, false

local function press(key)
  print("press " .. key)
  return {key}
end

function keys(tick)
  local game = get("game")
  if game.state == "waiting" then return press("Space") end
  local plan = PLAN[game.spawned]
  if not plan then return {} end
  if piece ~= game.spawned then
    if game.piece ~= plan[1] then
      error(string.format("piece %d is %s, but the plan expects %s; the plan is written for seed 0",
        game.spawned, game.piece, plan[1]))
    end
    piece, step, resting = game.spawned, 1, false
  end
  if resting then
    resting = false
    return {}
  end
  local action = plan[2]:sub(step, step)
  if action == "" then return {"Down"} end
  if action == "D" and get("piece_1").y > get("ghost_1").y then return {"Down"} end
  step, resting = step + 1, action ~= "D"
  return KEYS[action] and press(KEYS[action]) or {}
end
