-- Helpers shared by several scripts.

local util = {}

function util.overlaps(a, b)
  return math.abs(a.x - b.x) < (a.w + b.w) / 2 and math.abs(a.y - b.y) < (a.h + b.h) / 2
end

function util.set_alpha(e, a)
  local c = e.color
  e.color = { c[1], c[2], c[3], a }
end

-- The parts drawn for a leader, named like cannon_p1, each with its offset from the leader.
function util.parts(leader)
  local parts = {}
  for _, e in ipairs(find_all(leader.name .. "_p")) do
    parts[#parts + 1] = { e = e, x = e.x - leader.x, y = e.y - leader.y }
  end
  return parts
end

function util.place(leader)
  for _, part in ipairs(leader.parts) do
    part.e.x, part.e.y = leader.x + part.x, leader.y + part.y
  end
end

return util
