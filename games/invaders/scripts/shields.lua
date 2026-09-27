-- The four bunkers, built from small cells; hit(box) destroys every cell the box overlaps and returns how many.

local util = require("util")

function start(self)
  local bunkers = {}
  local top, bottom = -math.huge, math.huge
  for s = 1, self.count do
    local bunker = { cells = find_all("shield" .. s .. "_"), left = math.huge, right = -math.huge }
    for _, e in ipairs(bunker.cells) do
      bunker.left = math.min(bunker.left, e.x - e.w / 2)
      bunker.right = math.max(bunker.right, e.x + e.w / 2)
      top = math.max(top, e.y + e.h / 2)
      bottom = math.min(bottom, e.y - e.h / 2)
    end
    bunkers[s] = bunker
  end
  self.top, self.bottom = top, bottom

  self.reset = function()
    for _, bunker in ipairs(bunkers) do
      for _, e in ipairs(bunker.cells) do
        e.alive = true
        util.set_alpha(e, 1)
      end
    end
    self.destroyed = 0
  end

  self.hit = function(box)
    if box.y - box.h / 2 >= self.top or box.y + box.h / 2 <= self.bottom then return 0 end
    local count = 0
    for _, bunker in ipairs(bunkers) do
      if box.x + box.w / 2 > bunker.left and box.x - box.w / 2 < bunker.right then
        for _, e in ipairs(bunker.cells) do
          if e.alive and util.overlaps(box, e) then
            e.alive = false
            util.set_alpha(e, 0)
            count = count + 1
          end
        end
      end
    end
    self.destroyed = self.destroyed + count
    return count
  end

  self.reset()
end
