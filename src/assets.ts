import { isColor } from './colors.ts'
import { GameError, show } from './errors.ts'
import { SOUNDS, type SoundEntry } from './types.ts'

// The files a game may use, by extension, with the type a page serves each as.
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}
const SOUND_TYPES: Readonly<Record<string, string>> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' }

export function isImageFile(name: string): boolean {
  return Object.hasOwn(IMAGE_TYPES, extension(name))
}

export function isSoundFile(name: string): boolean {
  return Object.hasOwn(SOUND_TYPES, extension(name))
}

export function mediaType(name: string): string | undefined {
  const type = extension(name)
  return IMAGE_TYPES[type] ?? SOUND_TYPES[type]
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

// How much of the start of each image and sound file fileProblem reads.
export const FILE_HEAD = 256

// Why an image or sound file that starts with head isn't one the page takes, if it isn't. Chrome reads a raster image's own type, whatever its extension says, and a sound's too, so any type it draws or plays passes under any of the names, but an SVG must be text that starts with "<", after any byte order mark and space.
export function fileProblem(name: string, head: Uint8Array): string | undefined {
  const [kind, use] = isSoundFile(name) ? ['sound', 'play'] : ['image', 'draw']
  const named = `${kind} ${show(name)} in the game's folder`
  if (head.length === 0) return `${named} is empty, so the page can't ${use} it`
  if (isSoundFile(name)) return isSound(head) ? undefined : `${named} doesn't start like a WAV, MP3, Ogg, FLAC, MP4, or WebM sound`
  if (extension(name) === '.svg') return isSvg(head) ? undefined : `${named} isn't an SVG image, which starts with "<", so the page can't draw it`
  return isRaster(head) ? undefined : `${named} doesn't start like a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or CUR image`
}

function has(head: Uint8Array, at: number, bytes: string | readonly number[]): boolean {
  const wanted = typeof bytes === 'string' ? [...bytes].map((char) => char.charCodeAt(0)) : bytes
  return wanted.every((byte, i) => head[at + i] === byte)
}

// ISO media files, like AVIF and MP4, start with an ftyp box that names the brands they follow: the main one, then any they're compatible with.
function brands(head: Uint8Array): string[] {
  if (head.length < 16 || !has(head, 4, 'ftyp')) return []
  const end = Math.min(head.length, new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0))
  const starts = [8, ...Array.from({ length: Math.max(0, Math.floor((end - 16) / 4)) }, (_, i) => 16 + i * 4)]
  return starts.map((at) => String.fromCharCode(...head.subarray(at, at + 4)))
}

// ICO and CUR files start with the same header but for their type, 1 for an icon and 2 for a cursor.
function isRaster(head: Uint8Array): boolean {
  return (
    has(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    has(head, 0, [0xff, 0xd8, 0xff]) ||
    has(head, 0, 'GIF87a') ||
    has(head, 0, 'GIF89a') ||
    (has(head, 0, 'RIFF') && has(head, 8, 'WEBP')) ||
    brands(head).some((brand) => brand === 'avif' || brand === 'avis') ||
    has(head, 0, 'BM') ||
    has(head, 0, [0, 0, 1, 0]) ||
    has(head, 0, [0, 0, 2, 0])
  )
}

function isSvg(head: Uint8Array): boolean {
  const encoding = has(head, 0, [0xff, 0xfe]) ? 'utf-16le' : has(head, 0, [0xfe, 0xff]) ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding).decode(head).trimStart().startsWith('<')
}

// An MP3 starts with its ID3 tag, or with the 11 set bits that begin each of its frames, and a WebM with the header of Matroska, which it is.
function isSound(head: Uint8Array): boolean {
  return (
    (has(head, 0, 'RIFF') && has(head, 8, 'WAVE')) ||
    has(head, 0, 'ID3') ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ||
    has(head, 0, 'OggS') ||
    has(head, 0, 'fLaC') ||
    brands(head).length > 0 ||
    has(head, 0, [0x1a, 0x45, 0xdf, 0xa3])
  )
}

// What an image may name: a file in the game's folder, or a sprite the game declares, whose name has no dot.
export interface Images {
  // The image and sound files in the game's folder; without them, as when a test imports a game, any file name of the right type passes.
  readonly files: readonly string[] | undefined
  readonly sprites: readonly string[]
}

const IMAGES_ARE = "images are .png, .jpg, .jpeg, .webp, .gif, or .svg files in the game's folder, or sprites the game declares"

export function imageProblem(name: string, { files, sprites }: Images): string | undefined {
  if (!name.includes('.')) {
    if (sprites.includes(name)) return undefined
    const problem = sprites.length === 0 ? `image ${show(name)} isn't an image file or a sprite; ${IMAGES_ARE}` : `no sprite ${show(name)} in the game's sprites, which are ${sprites.join(', ')}`
    const file = files?.find((file) => isImageFile(file) && file.slice(0, file.lastIndexOf('.')) === name)
    return file === undefined ? problem : `${problem}; the folder has ${file}, which image names with its extension`
  }
  if (!isImageFile(name)) return `image ${show(name)} isn't an image file; ${IMAGES_ARE}`
  if (files === undefined || files.includes(name)) return undefined
  return `no image ${show(name)} in the game's folder, ${inventory('image', files.filter(isImageFile))}`
}

// The most rows a sprite may have, and the most pixels to a row.
export const SPRITE_SIDE = 256
// The most pixels a game's sprites may have in all, as many as 64 sprites of 256 by 256, so a page, a phone's too, holds their textures in 16 MB and makes them in a moment.
export const SPRITE_TOTAL = 4_194_304
// In every sprite's rows, the pixel that shows what's behind it, which no palette gives a color.
const SEE_THROUGH = '.'
const DEFAULT_PALETTE: Readonly<Record<string, string>> = { '#': '#ffffff' }

// A sprite as the page draws it: its rows, each width pixels long, and the color of each character in them but the see-through one.
export interface Art {
  readonly width: number
  readonly rows: readonly string[]
  readonly palette: ReadonlyMap<string, string>
}

// A game's sprites, checked whole, so one the page couldn't draw fails before the first tick, in sim as in the page.
export function parseSprites(value: unknown): ReadonlyMap<string, Art> {
  if (value === undefined) return new Map()
  if (!isObject(value)) throw new GameError(`sprites must be an object that maps names to sprites, like { ship: { rows: ['.#.', '###'] } }, got ${Array.isArray(value) ? 'an array' : show(value)}`)
  const sprites = new Map<string, Art>()
  let total = 0
  for (const [name, sprite] of Object.entries(value)) {
    const art = parseSprite(name, sprite)
    total += art.width * art.rows.length
    if (total > SPRITE_TOTAL) {
      throw new GameError(`sprite ${show(name)} brings the game's sprites to ${total} pixels, but a game's sprites may have ${SPRITE_TOTAL} in all, as many as 64 sprites of 256 by 256`)
    }
    sprites.set(name, art)
  }
  return sprites
}

function parseSprite(name: string, sprite: unknown): Art {
  const where = `sprite ${show(name)}`
  if (name === '') throw new GameError('sprites can\'t have one named "", which image takes for none')
  if (name.includes('.')) throw new GameError(`${where}: name it without a dot, like "ship", since image reads a name with a dot as a file's`)
  if (Array.isArray(sprite)) throw new GameError(`${where} must be an object with rows, like { rows: ['.#.', '###'] }, not the rows alone`)
  if (!isObject(sprite)) throw new GameError(`${where} must be an object with rows, like { rows: ['.#.', '###'] }, got ${show(sprite)}`)
  const extra = Object.keys(sprite).find((field) => field !== 'rows' && field !== 'palette')
  if (extra !== undefined) throw new GameError(`${where} has no field ${show(extra)}; a sprite's fields are rows and palette`)
  const palette = paletteOf(where, sprite.palette)
  const rows: unknown = sprite.rows
  if (!Array.isArray(rows)) throw new GameError(`${where}: rows must be an array of strings, one for each row of pixels, like ['.#.', '###'], got ${show(rows)}`)
  if (!rows.every((row): row is string => typeof row === 'string')) {
    const odd = rows.findIndex((row) => typeof row !== 'string')
    throw new GameError(`${where}: rows[${odd}] is ${show(rows[odd])}, but each row is a string of pixels`)
  }
  if (rows.length < 1 || rows.length > SPRITE_SIDE) throw new GameError(`${where} has ${rows.length} rows; a sprite has 1 to ${SPRITE_SIDE}`)
  const width = [...rows[0]].length
  if (width < 1 || width > SPRITE_SIDE) throw new GameError(`${where}: rows[0] has ${width} pixels; a row has 1 to ${SPRITE_SIDE}`)
  for (const [r, row] of rows.entries()) {
    const pixels = [...row]
    const stray = pixels.findIndex((pixel) => pixel !== SEE_THROUGH && !palette.has(pixel))
    if (stray !== -1) {
      const has = palette.size === 0 ? 'none' : [...palette.keys()].map((char) => show(char)).join(', ')
      throw new GameError(`${where}: rows[${r}][${stray}] is ${show(pixels[stray])}, which isn't "." or in its palette, which has ${has}`)
    }
    if (pixels.length !== width) throw new GameError(`${where}: rows[${r}] has ${pixels.length} pixels, but rows[0] has ${width}, and every row must have the same number`)
  }
  return { width, rows: Object.freeze([...rows]), palette }
}

function paletteOf(where: string, value: unknown): ReadonlyMap<string, string> {
  if (value === undefined) return new Map(Object.entries(DEFAULT_PALETTE))
  if (!isObject(value)) throw new GameError(`${where}: palette must map characters to colors, like { '#': 'white', o: 'orange' }, got ${show(value)}`)
  const palette = new Map<string, string>()
  for (const [char, color] of Object.entries(value)) {
    if (char === SEE_THROUGH) throw new GameError(`${where}: palette can't give "." a color, since "." shows what's behind`)
    if (!/^[!-~]$/.test(char)) throw new GameError(`${where}: palette has ${show(char)}, but each of its keys is one character from ! to ~`)
    if (typeof color !== 'string' || !isColor(color)) throw new GameError(`${where}: palette[${show(char)}] must be a CSS color like "#ff8800" or "orange", got ${show(color)}`)
    palette.set(char, color)
  }
  return palette
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function soundEntry({ tick, sound, options, files }: { tick: number; sound: unknown; options: unknown; files: readonly string[] | undefined }): SoundEntry {
  if (typeof sound !== 'string' || !(SOUNDS.some((name) => name === sound) || isSoundFile(sound))) {
    throw new GameError(`unknown sound ${show(sound)}; play a built-in sound (${SOUNDS.join(', ')}) or a .wav, .mp3, or .ogg file in the game's folder by its name`)
  }
  if (isSoundFile(sound) && files !== undefined && !files.includes(sound)) {
    throw new GameError(`no sound ${show(sound)} in the game's folder, ${inventory('sound', files.filter(isSoundFile))}`)
  }
  return { tick, name: sound, ...soundOptions(options) }
}

function soundOptions(options: unknown): { volume: number; pitch: number } {
  if (options === undefined) return { volume: 1, pitch: 1 }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new GameError(`ctx.play takes options like { volume: 0.5, pitch: 2 }, got ${show(options)}`)
  }
  const unknown = Object.keys(options).find((key) => key !== 'volume' && key !== 'pitch')
  if (unknown !== undefined) throw new GameError(`ctx.play has no option "${unknown}"; its options are volume and pitch`)
  const volume = ('volume' in options ? options.volume : undefined) ?? 1
  const pitch = ('pitch' in options ? options.pitch : undefined) ?? 1
  if (typeof volume !== 'number' || !(volume >= 0 && volume <= 1)) throw new GameError(`volume must be from 0 to 1, got ${show(volume)}`)
  if (typeof pitch !== 'number' || !(pitch > 0 && Number.isFinite(pitch))) throw new GameError(`pitch must be a finite number greater than 0, got ${show(pitch)}`)
  return { volume, pitch }
}

function inventory(kind: 'image' | 'sound', names: readonly string[]): string {
  return names.length === 0 ? `which has no ${kind} files` : `which has ${names.join(', ')}`
}
