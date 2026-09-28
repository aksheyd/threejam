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

// files names the image and sound files in the game's folder; without it, as when a test imports a game, any name of the right type passes.
export function imageProblem(name: string, files: readonly string[] | undefined): string | undefined {
  if (!isImageFile(name)) return `image ${show(name)} isn't an image file; images are .png, .jpg, .jpeg, .webp, .gif, or .svg files in the game's folder`
  if (files === undefined || files.includes(name)) return undefined
  return `no image ${show(name)} in the game's folder, ${inventory('image', files.filter(isImageFile))}`
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
