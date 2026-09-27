-- One entity runs the game: the board lives in Lua tables and is drawn by recoloring 200 cell entities.

local COLS, ROWS = 10, 20
local GRAVITY_TICKS = 30     -- the piece falls one row every half second
local SOFT_DROP_TICKS = 2    -- or every 2 ticks while Down is held
local DAS_TICKS = 10         -- a held Left/Right repeats after 10 ticks
local ARR_TICKS = 3          -- and then every 3 ticks
local POINTS = {100, 300, 500, 800}
local OFF_SCREEN = 3

local KINDS = {"I", "O", "T", "S", "Z", "J", "L"}
local COLORS = {
  {0.0, 0.85, 0.95},   -- I cyan
  {0.95, 0.85, 0.1},   -- O yellow
  {0.65, 0.2, 0.85},   -- T purple
  {0.2, 0.85, 0.3},    -- S green
  {0.9, 0.15, 0.15},   -- Z red
  {0.15, 0.35, 0.95},  -- J blue
  {0.95, 0.55, 0.1},   -- L orange
}
local EMPTY = {0.09, 0.09, 0.12}
local GRAY = {0.45, 0.45, 0.45}
local RED = {0.85, 0.15, 0.15}

-- Spawn orientation as {col, row} inside an n-by-n box, row 0 at the bottom.
local SHAPES = {
  {n = 4, {0, 2}, {1, 2}, {2, 2}, {3, 2}},  -- I
  {n = 2, {0, 0}, {1, 0}, {0, 1}, {1, 1}},  -- O
  {n = 3, {1, 2}, {0, 1}, {1, 1}, {2, 1}},  -- T
  {n = 3, {1, 2}, {2, 2}, {0, 1}, {1, 1}},  -- S
  {n = 3, {0, 2}, {1, 2}, {1, 1}, {2, 1}},  -- Z
  {n = 3, {0, 2}, {0, 1}, {1, 1}, {2, 1}},  -- J
  {n = 3, {2, 2}, {0, 1}, {1, 1}, {2, 1}},  -- L
}
-- Bottom-left of the box at spawn; the I sits a row lower so it can turn upright under the ceiling.
local SPAWN = {{4, 17}, {5, 19}, {4, 18}, {4, 18}, {4, 18}, {4, 18}, {4, 18}}

-- ROT[kind][r]: the four {col, row} offsets after r clockwise turns.
local ROT = {}
for k, shape in ipairs(SHAPES) do
  ROT[k] = {}
  local cells = {}
  for i, c in ipairs(shape) do cells[i] = {c[1], c[2]} end
  for r = 0, 3 do
    ROT[k][r] = cells
    local turned = {}
    for i, c in ipairs(cells) do turned[i] = {c[2], shape.n - 1 - c[1]} end
    cells = turned
  end
end

local board = {}   -- board[row][col]: 0 when empty, else the kind locked there
local shown = {}   -- shown[row][col]: what that cell entity currently shows
local cells = {}   -- cells[row][col]: the cell entity
local piece_e, ghost_e, next_e, banner, banner_y = {}, {}, {}, {}, {}
local border, border_color, next_bg, cell_size, score_e, lines_e, title_e, prompt_e, prompt_text

local bag = {}
local kind, rot, px, py, next_kind
local drop_timer, das_dir, das_timer = 0, 0, 0
local score, lines, spawned = 0, 0, 0
local shown_score, shown_lines, shown_next
local state, restart_delay, restart_wait = "waiting", 0, 0

local function paint(e, c, a)
  e.color = {c[1], c[2], c[3], a or 1}
end

local function fits(k, r, x, y)
  for _, c in ipairs(ROT[k][r]) do
    local col, row = x + c[1], y + c[2]
    if col < 1 or col > COLS or row < 1 or row > ROWS or board[row][col] ~= 0 then
      return false
    end
  end
  return true
end

local function span(k, r, x, y)
  local c1, c2, r1, r2 = math.huge, -math.huge, math.huge, -math.huge
  for _, c in ipairs(ROT[k][r]) do
    c1, c2 = math.min(c1, x + c[1]), math.max(c2, x + c[1])
    r1, r2 = math.min(r1, y + c[2]), math.max(r2, y + c[2])
  end
  return c1, c2, r1, r2
end

-- Rows from the bottom up, "/" between them, stopping at the highest filled row.
local function board_text()
  local rows, top = {}, 0
  for r = 1, ROWS do
    local s = {}
    for c = 1, COLS do
      local v = board[r][c]
      s[c] = v == 0 and "." or KINDS[v]
      if v ~= 0 then top = r end
    end
    rows[r] = table.concat(s)
  end
  return table.concat(rows, "/", 1, top)
end

local function shuffle(t)
  for i = #t, 2, -1 do
    local j = math.random(i)
    t[i], t[j] = t[j], t[i]
  end
end

local function take()
  if #bag == 0 then
    bag = {1, 2, 3, 4, 5, 6, 7}
    shuffle(bag)
  end
  return table.remove(bag)
end

local function draw_board()
  for r = 1, ROWS do
    for c = 1, COLS do
      local v = board[r][c]
      local want = (state == "over" and v ~= 0) and -1 or v
      if shown[r][c] ~= want then
        shown[r][c] = want
        paint(cells[r][c], want == 0 and EMPTY or want == -1 and GRAY or COLORS[want])
      end
    end
  end
end

local function draw_piece()
  if state == "over" then
    for i = 1, 4 do
      paint(piece_e[i], EMPTY, 0)
      paint(ghost_e[i], EMPTY, 0)
    end
    return
  end
  local gy = py
  while fits(kind, rot, px, gy - 1) do gy = gy - 1 end
  for i, c in ipairs(ROT[kind][rot]) do
    local home, landing = cells[py + c[2]][px + c[1]], cells[gy + c[2]][px + c[1]]
    piece_e[i].x, piece_e[i].y = home.x, home.y
    ghost_e[i].x, ghost_e[i].y = landing.x, landing.y
    paint(piece_e[i], COLORS[kind])
    paint(ghost_e[i], COLORS[kind], 0.3)
  end
end

local function draw_next()
  if state == "over" then
    for i = 1, 4 do paint(next_e[i], EMPTY, 0) end
    return
  end
  if shown_next == next_kind then return end
  shown_next = next_kind
  local c1, c2, r1, r2 = span(next_kind, 0, 0, 0)
  for i, c in ipairs(ROT[next_kind][0]) do
    next_e[i].x = next_bg.x + (c[1] - (c1 + c2) / 2) * cell_size
    next_e[i].y = next_bg.y + (c[2] - (r1 + r2) / 2) * cell_size
    paint(next_e[i], COLORS[next_kind])
  end
end

local function draw()
  draw_board()
  draw_piece()
  draw_next()
  if shown_score ~= score then
    shown_score = score
    score_e.text = string.format("%06d", score)
  end
  if shown_lines ~= lines then
    shown_lines = lines
    lines_e.text = string.format("%03d", lines)
  end
end

local function show_banner(visible)
  for i, e in ipairs(banner) do
    e.y = visible and banner_y[i] or banner_y[i] + OFF_SCREEN
  end
end

local function game_over()
  state, restart_wait = "over", restart_delay
  paint(border, RED)
  title_e.text, title_e.color = "GAME OVER", RED
  prompt_e.text = restart_wait > 0 and "" or prompt_text
  show_banner(true)
end

local function spawn()
  kind, next_kind = next_kind, take()
  rot, px, py = 0, SPAWN[kind][1], SPAWN[kind][2]
  drop_timer = 0
  spawned = spawned + 1
  if not fits(kind, rot, px, py) then game_over() end
end

local function clear_rows()
  local kept = {}
  for r = 1, ROWS do
    local full = true
    for c = 1, COLS do
      if board[r][c] == 0 then full = false break end
    end
    if not full then kept[#kept + 1] = board[r] end
  end
  local gone = ROWS - #kept
  if gone == 0 then return end
  for r = #kept + 1, ROWS do
    local row = {}
    for c = 1, COLS do row[c] = 0 end
    kept[r] = row
  end
  board = kept
  lines = lines + gone
  score = score + POINTS[gone]
end

local function lock()
  for _, c in ipairs(ROT[kind][rot]) do
    board[py + c[2]][px + c[1]] = kind
  end
  clear_rows()
  spawn()
end

local function shift(dir)
  if fits(kind, rot, px + dir, py) then px = px + dir end
end

local function rotate()
  local r = (rot + 1) % 4
  if fits(kind, r, px, py) then rot = r end
end

local function horizontal()
  local left, right = input.held("Left"), input.held("Right")
  local dir = left == right and 0 or left and -1 or 1
  -- Checking presses catches a tap that was released again before this tick.
  if input.pressed("Left") and not right then
    dir, das_dir = -1, 0
  elseif input.pressed("Right") and not left then
    dir, das_dir = 1, 0
  end
  if dir == 0 then
    das_dir = 0
  elseif dir ~= das_dir then
    das_dir, das_timer = dir, DAS_TICKS
    shift(dir)
  else
    das_timer = das_timer - 1
    if das_timer <= 0 then
      das_timer = ARR_TICKS
      shift(dir)
    end
  end
end

local function gravity()
  drop_timer = drop_timer + 1
  if drop_timer < (input.held("Down") and SOFT_DROP_TICKS or GRAVITY_TICKS) then return end
  drop_timer = 0
  if fits(kind, rot, px, py - 1) then
    py = py - 1
  else
    lock()
  end
end

local function new_game()
  for r = 1, ROWS do
    for c = 1, COLS do board[r][c] = 0 end
  end
  bag, score, lines, spawned, das_dir, shown_next = {}, 0, 0, 0, 0, nil
  paint(border, border_color)
  next_kind = take()
  spawn()
end

-- Copies the game state onto the entity, where sim prints it.
local function mirror(self)
  local c1, c2, r1, r2 = span(kind, rot, px, py)
  self.piece, self.turn, self.next_piece, self.spawned = KINDS[kind], rot, KINDS[next_kind], spawned
  self.left, self.right, self.bottom, self.top = c1, c2, r1, r2
  self.score, self.lines, self.state, self.board = score, lines, state, board_text()
end

function start(self)
  restart_delay = self.restart_delay
  border, next_bg = get("border"), get("next_bg")
  border_color = border.color
  score_e, lines_e, title_e, prompt_e = get("score"), get("lines"), get("banner_title"), get("banner_prompt")
  prompt_text = prompt_e.text
  banner = find_all("banner_")
  for i, e in ipairs(banner) do banner_y[i] = e.y end
  for r = 1, ROWS do
    board[r], shown[r], cells[r] = {}, {}, {}
    for c = 1, COLS do
      cells[r][c] = get(string.format("cell_%02d_%02d", r, c))
    end
  end
  cell_size = cells[1][2].x - cells[1][1].x
  for i = 1, 4 do
    piece_e[i], ghost_e[i], next_e[i] = get("piece_" .. i), get("ghost_" .. i), get("next_" .. i)
  end
  new_game()
  draw()
  mirror(self)
end

function update(self, dt)
  -- Many players hard-drop with Space, so presses just after a game over mustn't skip its screen.
  if restart_wait > 0 then
    restart_wait = restart_wait - 1
    if restart_wait == 0 then prompt_e.text = prompt_text end
    return
  end
  if state ~= "playing" then
    if not input.pressed("Space") then return end
    if state == "over" then new_game() end
    state = "playing"
    show_banner(false)
  else
    if input.pressed("Up") then rotate() end
    horizontal()
    gravity()
  end
  draw()
  mirror(self)
end
