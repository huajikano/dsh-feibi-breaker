/**
 * Test isolation for anything that touches DSH_HOME.
 *
 * Activating this plugin seeds `$DSH_HOME/feibi-prompt.md` and writes a state
 * file next to it. That is correct behaviour for a real Host, and exactly wrong
 * inside a test suite: without isolation, `node --test` rewrites the developer's
 * own prompt file and leaves stray state behind.
 *
 * Every test file that calls `apply()` must call this first, at module scope so
 * it runs before any test body.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

let isolated = null

/**
 * Point DSH_HOME at a throwaway directory for the life of this process.
 *
 * Idempotent: a second call in the same process returns the same directory,
 * because two temp homes would make the prompt-state cache in
 * `lib/prompt-store.js` churn between tests for no benefit.
 *
 * @returns {string} the isolated home path.
 */
export function isolateDshHome() {
  if (isolated !== null) return isolated
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feibi-test-home-'))
  isolated = home
  process.env.DSH_HOME = home

  after(() => {
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not a test failure.
    }
  })

  return home
}

/** The isolated home, or null when isolation was never requested. */
export function currentDshHome() {
  return isolated
}
