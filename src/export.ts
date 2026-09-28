import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { mediaType } from './assets.ts'
import { UsageError, quote } from './errors.ts'
import { gameFiles } from './load.ts'
import { formatMessage, html, pageBuild } from './serve.ts'

export interface Exported {
  readonly file: string
  readonly bytes: number
}

// One HTML file that plays the game from disk: the page code, Three.js, the game, its view, and its images and sounds as data URLs.
export async function exportGame({ dir, out, seed }: { dir: string; out: string; seed?: number }): Promise<Exported> {
  if (!/\.html?$/i.test(out)) throw new UsageError(`${quote(out)} must end in .html`)
  const files = gameFiles(dir)
  const address = (name: string) => dataUrl(join(files.folder, name))
  const built = await esbuild.build({ ...pageBuild({ files, address }), minify: true, write: false }).catch((failure: esbuild.BuildFailure) => failure)
  if (built instanceof Error) throw new UsageError(built.errors.map(formatMessage).join('; '))
  const page = html({ title: basename(files.folder), config: { mode: 'export', seed }, script: { kind: 'inline', code: built.outputFiles[0].text } })
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, page)
  return { file: out, bytes: Buffer.byteLength(page) }
}

function dataUrl(path: string): string {
  const type = mediaType(path)
  if (type === undefined) throw new UsageError(`${path} isn't an image or sound file`)
  return `data:${type};base64,${readFileSync(path).toString('base64')}`
}
