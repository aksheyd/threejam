-- A bot for sim and shot, run from the game folder: game-engine sim . --ticks 2100 --driver tests/autopilot.lua

local hint_seen_at

-- Dodge a bomb about to land on the cannon; otherwise line up under the nearest column's lowest invader and fire.
local function steer(cannon)
  local fleet, shot = get("fleet"), get("shot")
  local half = cannon.w / 2
  for _, bomb in ipairs(fleet.bombs) do
    local dx = bomb.x - cannon.x
    if bomb.active and bomb.y - cannon.y < 0.5 and math.abs(dx) < half + bomb.w / 2 + 0.05 then
      local away = dx > 0 and -1 or 1
      local x = cannon.x + away * 0.2
      if x < cannon.left + half or x > cannon.right - half then away = -away end
      return away, false
    end
  end

  local drift = fleet.dir * fleet.step_x / fleet.interval -- invader x change per tick
  local best_x, best_w
  for c = 1, #fleet.columns do
    for r = #fleet.columns[c], 1, -1 do
      local inv = fleet.columns[c][r]
      if inv.alive then
        local flight = (inv.e.y - cannon.y) / (shot.speed / 60)
        local x = inv.e.x + drift * flight
        if not best_x or math.abs(x - cannon.x) < math.abs(best_x - cannon.x) then best_x, best_w = x, inv.e.w end
        break
      end
    end
  end
  if not best_x then return 0, false end
  local dx = best_x - cannon.x
  return math.abs(dx) > 0.01 and (dx > 0 and 1 or -1) or 0, math.abs(dx) < best_w / 2 - 0.01
end

function keys(tick)
  local state = get("game").state
  if state == "ready" then
    return { "Space" }
  elseif state == "won" or state == "over" then
    if get("hint").text == "" then
      hint_seen_at = nil
      return {}
    end
    hint_seen_at = hint_seen_at or tick
    -- wait half a second after the hint appears, as a player would
    return tick - hint_seen_at >= 30 and { "Space" } or {}
  elseif state ~= "play" then
    return {}
  end

  local cannon = get("cannon")
  local move, fire = steer(cannon)
  local held = {}
  if move < 0 then held[#held + 1] = "Left" end
  if move > 0 then held[#held + 1] = "Right" end
  -- the cannon ignores Space until it has been let go after the press that started the game
  if fire and cannon.armed then held[#held + 1] = "Space" end
  return held
end
