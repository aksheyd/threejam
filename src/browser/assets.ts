import * as THREE from 'three'
import { isImageFile, isSoundFile } from '../assets.ts'

// The address of each image and sound file, by name: the page loads files only from these, and whoever builds the page picks them.
export type Assets = Readonly<Record<string, string>>

// An SVG has no pixels of its own, so it's drawn on a canvas this many pixels along its longer side.
const VECTOR_SIZE = 1024

export function parseAssets(value: unknown): Assets {
  if (typeof value !== 'object' || value === null) throw new Error('the page has no list of its images and sounds')
  return Object.fromEntries(
    Object.entries(value).map(([name, url]: [string, unknown]) => {
      if (typeof url !== 'string') throw new Error(`the page has no address for ${name}`)
      return [name, url]
    }),
  )
}

export async function loadImages(assets: Assets): Promise<ReadonlyMap<string, THREE.Texture>> {
  const images = Object.entries(assets).filter(([name]) => isImageFile(name))
  return new Map(await Promise.all(images.map(async ([name, url]) => [name, await loadImage(name, url)] as const)))
}

async function loadImage(name: string, url: string): Promise<THREE.Texture> {
  const image = new Image()
  image.src = url
  await image.decode().catch(() => {
    throw new Error(`the image ${name} couldn't be loaded; check that the file is a whole image of its type`)
  })
  const svg = name.toLowerCase().endsWith('.svg')
  const texture = svg ? new THREE.CanvasTexture(rasterized(image)) : new THREE.Texture(image)
  // Drawn larger, a raster image keeps its pixels square, which suits pixel art, while an SVG's big raster is smoothed.
  texture.magFilter = svg ? THREE.LinearFilter : THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function rasterized(image: HTMLImageElement): HTMLCanvasElement {
  const [width, height] = image.naturalWidth > 0 && image.naturalHeight > 0 ? [image.naturalWidth, image.naturalHeight] : [1, 1]
  const scale = VECTOR_SIZE / Math.max(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('this browser has no 2D canvas to draw SVG images on')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

export async function loadSounds(assets: Assets, context: BaseAudioContext): Promise<ReadonlyMap<string, AudioBuffer>> {
  const sounds = Object.entries(assets).filter(([name]) => isSoundFile(name))
  return new Map(await Promise.all(sounds.map(async ([name, url]) => [name, await loadSound(name, url, context)] as const)))
}

async function loadSound(name: string, url: string, context: BaseAudioContext): Promise<AudioBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`the sound ${name} couldn't be loaded (HTTP ${response.status})`)
  return context.decodeAudioData(await response.arrayBuffer()).catch(() => {
    throw new Error(`the sound ${name} couldn't be decoded; check that the file is a whole sound of its type`)
  })
}
