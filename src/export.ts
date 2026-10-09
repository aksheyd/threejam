import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { mediaType } from './assets.ts'
import { BuildError, UsageError, quote } from './errors.ts'
import { bundleWithin, gameFiles, timeLimit } from './load.ts'
import { makeFolder, saveFile } from './output.ts'
import { formatMessage, html, pageBuild } from './serve.ts'

export interface Exported {
  readonly file: string
  readonly bytes: number
}

// Checked before anything runs, as shot checks its -o.
export function exportPath(out: string): string {
  if (!/\.html?$/i.test(out)) throw new UsageError(`-o ${quote(out)} should be an .html file, like pong.html`)
  return out
}

// A script the page loads from the network, like the widget a game jam requires on every entry, which a page served over https can load only over https too.
export function scriptAddress(value: string): string {
  const url = URL.parse(value)
  if (url?.protocol !== 'https:') throw new UsageError(`--script ${quote(value)} should be the https:// address of a script, like https://jam.pieter.com/2026/widget.js`)
  return url.href
}

// One HTML file that plays the game from disk: the page code, Three.js, the game, its view, and its images and sounds as data URLs, and nothing it loads from the network but the scripts it's given.
export async function exportGame({ dir, out, seed, scripts = [], timeout }: { dir: string; out: string; seed?: number; scripts?: readonly string[]; timeout?: number }): Promise<Exported> {
  exportPath(out)
  const sources = scripts.map(scriptAddress)
  const files = gameFiles(dir)
  const address = (name: string) => dataUrl(join(files.folder, name))
  const build = esbuild.build({ ...pageBuild({ files, address }), minify: true, write: false }).catch((failure: esbuild.BuildFailure) => failure)
  const built = await bundleWithin(build, timeLimit(timeout))
  if (built instanceof Error) throw new BuildError(built.errors.map(formatMessage).join('; '))
  const page = html({ title: basename(files.folder), config: { mode: 'export', seed }, script: { kind: 'inline', code: built.outputFiles[0].text }, scripts: sources })
  makeFolder(dirname(resolve(out)))
  saveFile(out, page)
  return { file: out, bytes: Buffer.byteLength(page) }
}

function dataUrl(path: string): string {
  const type = mediaType(path)
  if (type === undefined) throw new UsageError(`${path} isn't an image or sound file`)
  return `data:${type};base64,${readFileSync(path).toString('base64')}`
}
