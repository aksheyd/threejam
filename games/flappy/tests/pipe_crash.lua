-- Flies through three gaps like bot.lua, then above the fourth gap so the bird hits that pair's top pipe.

local bird = get("bird")
local pipes = {}
for _, entity in ipairs(find_all("pipe")) do
  if entity.name:match("^pipe%d+$") then table.insert(pipes, entity) end
end

local function next_gap()
  local nearest, gap = math.huge, bird.home_y
  for _, pipe in ipairs(pipes) do
    local right = pipe.x + pipe.w / 2
    if right > bird.x - bird.w / 2 and right < nearest then nearest, gap = right, pipe.y end
  end
  return gap
end

function keys(tick)
  if bird.state == "ready" then return { "Space" } end
  if bird.state ~= "play" then return {} end
  local target = next_gap() - 0.12
  if bird.score >= 3 then target = math.min(next_gap() + 0.55, 1.0) end
  if bird.y < target and bird.vy < 0 then return { "Space" } end
  return {}
end
