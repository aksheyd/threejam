// The folders and files that new, shot, and export write.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
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

function shown(path: string): string {
  return resolve(path).replaceAll(sep, '/')
}
