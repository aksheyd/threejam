import type { Key } from '../types.ts'

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

// How far the canvas stays from each edge of the page, in CSS pixels.
export interface Room {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface Layout {
  readonly room: Room
  readonly pads: readonly Box[]
  readonly buttons: readonly { readonly key: Key; readonly box: Box }[]
}

const NO_ROOM: Room = { top: 0, right: 0, bottom: 0, left: 0 }
const COLUMNS = 3
// A key's side as a share of the screen's shorter side, about 50 pixels on a phone, from 24 up to 72, and a fingertip's 44 where the share falls short of it and the game still keeps half its width.
const SHARE = 0.13
const FINGER = 44
const LARGEST = 72
const SMALLEST = 24
const LEAST_MARGIN = 6
// The keys stay this far above the bottom edge, clear of the swipe phones keep there and of a badge in a corner, like a jam's widget.
const LIFT = 40

// A cross's keys by column and row: up on top, left and right beside each other, down at the bottom.
const ARROWS: readonly (readonly [Key, number, number])[] = [['Up', 1, 0], ['Left', 0, 1], ['Right', 2, 1], ['Down', 1, 2]]
const WASD: readonly (readonly [Key, number, number])[] = [['W', 1, 0], ['A', 0, 1], ['D', 2, 1], ['S', 1, 2]]
const LABELS: Partial<Readonly<Record<Key, string>>> = { Up: '▲\uFE0E', Down: '▼\uFE0E', Left: '◀\uFE0E', Right: '▶\uFE0E', Backspace: 'BKSP' }

interface Cell {
  readonly key: Key
  readonly col: number
  readonly row: number
  readonly span: number
}

// A finger is the mouse already, so only keyboard keys get buttons.
function onScreen(key: Key): boolean {
  return key !== 'Mouse' && key !== 'MouseRight'
}

// The rows that have a key close up, so Up and Down alone stand one above the other.
function cross(keys: ReadonlySet<Key>, places: typeof ARROWS): Cell[] {
  const found = places.filter(([key]) => keys.has(key))
  const rows = [...new Set(found.map(([, , row]) => row))].sort((a, b) => a - b)
  return found.map(([key, col, row]) => ({ key, col, row: rows.indexOf(row), span: 1 }))
}

// Space spans a row, like a space bar.
function grid(keys: readonly Key[], below: number): Cell[] {
  const cells: Cell[] = []
  let [row, col] = [below, 0]
  for (const key of keys) {
    const span = key === 'Space' ? COLUMNS : 1
    if (col + span > COLUMNS) [row, col] = [row + 1, 0]
    cells.push({ key, col, row, span })
    col += span
  }
  return cells
}

function rowsOf(cells: readonly Cell[]): number {
  return cells.reduce((rows, cell) => Math.max(rows, cell.row + 1), 0)
}

// With both arrows and W, A, S, and D, as in a game for two players, each set gets a side; the other keys go on the right, below any cross there, so a key that appears later never moves one above it.
function pads(keys: readonly Key[]): readonly [Cell[], Cell[]] {
  const shown = new Set(keys)
  const arrows = cross(shown, ARROWS)
  const wasd = cross(shown, WASD)
  const crossed = new Set([...arrows, ...wasd].map((cell) => cell.key))
  const rest = keys.filter((key) => !crossed.has(key))
  if (arrows.length > 0 && wasd.length > 0) return [wasd, [...arrows, ...grid(rest, rowsOf(arrows))]]
  return [arrows.length > 0 ? arrows : wasd, grid(rest, 0)]
}

// The keys sit in the bottom corners, and the canvas makes room for them beside it or below it, whichever leaves it larger.
export function layoutKeys(keys: readonly Key[], width: number, height: number): Layout {
  const sides = pads(keys.filter(onScreen))
  if (sides.every((cells) => cells.length === 0)) return { room: NO_ROOM, pads: [], buttons: [] }
  const share = Math.max(SMALLEST, Math.min(LARGEST, Math.round(Math.min(width, height) * SHARE)))
  const proportional = arrange(sides, width, height, share, false)
  if (share >= FINGER) return proportional.layout
  // Fingertip keys, unless they'd leave the game less than half the width it has alone, as they would in a short window or embed.
  const finger = arrange(sides, width, height, FINGER, true)
  return Math.floor(800 * finger.scale) >= 400 * Math.min(width / 800, height / 600) ? finger.layout : proportional.layout
}

// The layout with keys of at most largest pixels, and the canvas's scale beside them.
function arrange(sides: readonly (readonly Cell[])[], width: number, height: number, largest: number, narrow: boolean): { readonly layout: Layout; readonly scale: number } {
  // A pad keeps room for a whole cross, so a cross that appears later moves nothing.
  const rows = Math.max(3, ...sides.map(rowsOf))
  const metrics = (unit: number) => {
    const gap = Math.round(unit / 6)
    const span = (count: number) => count * unit + (count - 1) * gap
    // Narrowed, margins let a phone 320 pixels wide fit two pads of fingertip keys side by side.
    const margin = narrow ? Math.max(LEAST_MARGIN, Math.min(Math.round(unit / 4), Math.floor((width - 2 * span(COLUMNS)) / 3))) : Math.round(unit / 4)
    return { unit, gap, margin, lift: Math.max(margin, LIFT), span, padWidth: span(COLUMNS), padHeight: span(rows) }
  }
  type Metrics = ReturnType<typeof metrics>
  const fitting = (fits: (m: Metrics) => boolean): Metrics => {
    for (let unit = largest; unit > SMALLEST; unit--) if (fits(metrics(unit))) return metrics(unit)
    return metrics(SMALLEST)
  }
  const tall = (m: Metrics) => m.padHeight + m.margin + m.lift <= height
  const beside = fitting(tall)
  const below = fitting((m) => tall(m) && 2 * m.padWidth + 3 * m.margin <= width)
  const scale = (room: Room) => Math.min((width - room.left - room.right) / 800, (height - room.top - room.bottom) / 600)
  const besideRoom = { ...NO_ROOM, left: beside.padWidth + 2 * beside.margin, right: beside.padWidth + 2 * beside.margin }
  const belowRoom = { ...NO_ROOM, bottom: below.padHeight + below.margin + below.lift }
  const [m, room] = scale(besideRoom) > scale(belowRoom) ? [beside, besideRoom] : [below, belowRoom]
  const padBoxes: Box[] = []
  const buttons: { key: Key; box: Box }[] = []
  for (const [side, cells] of sides.entries()) {
    if (cells.length === 0) continue
    const h = m.span(rowsOf(cells))
    const pad = { x: side === 0 ? m.margin : width - m.margin - m.padWidth, y: height - m.lift - h, w: m.padWidth, h }
    padBoxes.push(pad)
    for (const { key, col, row, span } of cells) buttons.push({ key, box: { x: pad.x + col * (m.unit + m.gap), y: pad.y + row * (m.unit + m.gap), w: m.span(span), h: m.unit } })
  }
  return { layout: { room, pads: padBoxes, buttons }, scale: scale(room) }
}

const BUTTON_STYLE =
  'position:fixed;box-sizing:border-box;margin:0;padding:0;border:2px solid rgba(255,255,255,.4);color:rgba(255,255,255,.9);' +
  'font-family:system-ui,sans-serif;font-weight:700;line-height:1;outline:none;-webkit-tap-highlight-color:transparent'
// A finger on the keys never scrolls, zooms, selects, or opens a menu.
const STILL = 'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none'
const UP = 'rgba(255,255,255,.12)'
const DOWN = 'rgba(255,255,255,.45)'

// On a touch screen, a button for each keyboard key the game has read holds that key while a finger is on it, as the keyboard would, so sim replays what it does.
export class TouchKeys {
  readonly #press: (key: Key) => void
  readonly #release: (key: Key) => void
  readonly #changed: () => void
  readonly #touch = matchMedia('(pointer: coarse)')
  readonly #layer = document.createElement('div')
  readonly #pads: HTMLElement[] = []
  readonly #buttons = new Map<Key, { readonly element: HTMLButtonElement; readonly fingers: Set<number> }>()

  constructor({ press, release, changed }: { press(key: Key): void; release(key: Key): void; changed(): void }) {
    this.#press = press
    this.#release = release
    this.#changed = changed
    this.#layer.style.cssText = 'position:fixed;inset:0;pointer-events:none'
    document.body.append(this.#layer)
    this.#touch.addEventListener('change', () => {
      if (!this.#touch.matches) {
        for (const [key, { fingers }] of this.#buttons) {
          if (fingers.size > 0) this.#up(key)
          fingers.clear()
        }
      }
      this.#changed()
    })
  }

  // On a touch screen, adds a button for each key that has none.
  show(keys: readonly Key[]): void {
    if (!this.#touch.matches) return
    const fresh = keys.filter((key) => onScreen(key) && !this.#buttons.has(key))
    for (const key of fresh) this.#add(key)
    if (fresh.length > 0) this.#changed()
  }

  // Places the keys for a page of this size, and gives the room they leave the canvas.
  room(width: number, height: number): Room {
    const shown = this.#touch.matches && this.#buttons.size > 0
    this.#layer.hidden = !shown
    if (!shown) return NO_ROOM
    const { room, pads, buttons } = layoutKeys([...this.#buttons.keys()], width, height)
    for (const [index, box] of pads.entries()) place(this.#pad(index), box)
    for (const { key, box } of buttons) {
      const element = this.#buttons.get(key)?.element
      if (!element) continue
      place(element, box)
      const label = element.textContent ?? ''
      element.style.borderRadius = `${Math.round(box.h / 5)}px`
      element.style.fontSize = `${Math.round(Math.min(0.42 * box.h, (1.5 * box.w) / [...label.replace('\uFE0E', '')].length))}px`
    }
    return room
  }

  // A pad takes every touch on it, so a finger that misses a key between two of them doesn't reach the game as the mouse.
  #pad(index: number): HTMLElement {
    let pad = this.#pads[index]
    if (pad === undefined) {
      pad = document.createElement('div')
      pad.style.cssText = `position:fixed;pointer-events:auto;${STILL}`
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) pad.addEventListener(type, (event) => event.stopPropagation())
      this.#layer.prepend(pad)
      this.#pads[index] = pad
    }
    return pad
  }

  // A key stays held while any finger that pressed it is down, even one that slides off it.
  #add(key: Key): void {
    const element = document.createElement('button')
    element.type = 'button'
    element.tabIndex = -1
    element.dataset.key = key
    element.setAttribute('aria-label', key)
    element.textContent = LABELS[key] ?? key.toUpperCase()
    element.style.cssText = `${BUTTON_STYLE};background:${UP};pointer-events:auto;${STILL}`
    const fingers = new Set<number>()
    this.#buttons.set(key, { element, fingers })
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      element.setPointerCapture(event.pointerId)
      fingers.add(event.pointerId)
      if (fingers.size > 1) return
      element.style.background = DOWN
      this.#press(key)
    })
    const lift = (event: PointerEvent) => {
      event.stopPropagation()
      if (fingers.delete(event.pointerId) && fingers.size === 0) this.#up(key)
    }
    element.addEventListener('pointerup', lift)
    element.addEventListener('pointercancel', lift)
    element.addEventListener('pointermove', (event) => event.stopPropagation())
    this.#layer.append(element)
  }

  #up(key: Key): void {
    const element = this.#buttons.get(key)?.element
    if (element) element.style.background = UP
    this.#release(key)
  }
}

function place(element: HTMLElement, { x, y, w, h }: Box): void {
  element.style.left = `${x}px`
  element.style.top = `${y}px`
  element.style.width = `${w}px`
  element.style.height = `${h}px`
}
