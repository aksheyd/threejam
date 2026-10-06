import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'puppeteer-core'
import { findChrome, removeProfile } from '../src/serve.ts'
import { launchChrome } from '../src/shot.ts'

export const CHROME = findChrome()

export interface TestChrome {
  readonly browser: Browser
  // Closes Chrome, then removes its folder.
  close(): Promise<void>
}

// Chrome for a test, with its profile and temporary files in a folder of its own, so the test leaves nothing in the system's temporary folder; a page call that hangs fails within a minute, well inside CI's job timeout.
export async function testChrome(executable = CHROME ?? 'no Chrome'): Promise<TestChrome> {
  const temp = mkdtempSync(join(tmpdir(), 'threejam-test-'))
  const profile = join(temp, 'profile')
  let browser: Browser
  try {
    browser = await launchChrome(executable, { protocolTimeout: 60_000, profile, temp })
  } catch (error) {
    remove(temp, profile)
    throw error
  }
  return {
    browser,
    async close() {
      await browser.close()
      remove(temp, profile)
    },
  }
}

function remove(temp: string, profile: string): void {
  removeProfile(profile)
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 })
  } catch (error) {
    // On Windows, Chrome's helpers can hold a file a moment after Chrome exits, and the OS removes it later.
    if (process.platform !== 'win32') throw error
  }
}
