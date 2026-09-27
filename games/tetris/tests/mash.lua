-- Flips each key at random to shake out errors across many games and restarts; --seed picks the pattern.
local KEYS = {"Left", "Right", "Up", "Down", "Space"}
local down = {}

function keys(tick)
  local held = {}
  for _, k in ipairs(KEYS) do
    if math.random() < 0.1 then down[k] = not down[k] end
    if down[k] then held[#held + 1] = k end
  end
  return held
end
