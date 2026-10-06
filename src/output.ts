// The folders and files that new, shot, export, and run write.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { IoError } from './errors.ts'
import { isSystemError, reasonOf } from './load.ts'

// Node's mkdirSync({ recursive: true }) never returns for a folder under /proc, so the missing folders are made one at a time, from the nearest one that exists.
export function makeFolder(folder: string): void {
  const missing: string[] = []
  let at = resolve(folder)
  while (!existsSync(at) && dirname(at) !== at) {
    missing.unshift(at)
    at = dirname(at)
  }
  if (statSync(at, { throwIfNoEntry: false })?.isDirectory() === false) throw new IoError(`couldn't make the folder ${shown(folder)}: ${shown(at)} is a file`)
  for (const path of missing) {
    try {
      mkdirSync(path)
    } catch (error) {
      if (isSystemError(error) && error.code === 'EEXIST' && statSync(path).isDirectory()) continue
      throw new IoError(`couldn't make the folder ${shown(path)}: ${reasonOf(error)}`)
    }
  }
}

export function saveFile(file: string, data: string | Uint8Array): void {
  try {
    writeFileSync(file, data)
  } catch (error) {
    throw new IoError(`couldn't write ${shown(file)}: ${reasonOf(error)}`)
  }
}

// Writes a new file beside the one named, then renames it into place: a link there is replaced rather than written through, and a write cut short leaves the file as it was.
export function replaceFile(file: string, data: string | Uint8Array): void {
  const beside = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(beside, data, { flag: 'wx' })
    renameSync(beside, file)
  } catch (error) {
    // Whatever was already at the name beside isn't this write's to remove.
    if (!(isSystemError(error) && error.code === 'EEXIST')) rmSync(beside, { force: true })
    throw new IoError(`couldn't write ${shown(file)}: ${reasonOf(error)}`)
  }
}

function shown(path: string): string {
  return resolve(path).replaceAll(sep, '/')
}
