/**
 * Prompt transparency: the payload becomes a file the user can see and edit.
 *
 * Before this module the armor payload was baked into the package: the only way
 * to change one line was to edit `prompts/*.md` inside the installed copy and
 * restart the Host. Nothing told the user *where* the text came from, whether it
 * was the shipped default or their own edit, or how to get back to the default.
 *
 * The model here — borrowed in shape from dsh-purge's `prompt-inject.md`, not in
 * content — is:
 *
 *   $DSH_HOME/feibi-prompt.md          ← the user's own copy; wins when non-empty
 *   $DSH_HOME/.feibi/prompt-state.json ← customized / hash / seedHash / updatedAt
 *   core/payload.bin (bundled)         ← the shipped default, packed and read-only
 *
 * Resolution is a two-step fallback, and the UI is told which step it landed on
 * (`source`), so "using the default" and "using my edit" are visibly different
 * states rather than the same text box.
 *
 * The bundled default in this project is 菲比's own payload. dsh-purge's prompts
 * are its own and are not used here; only the management design is adapted.
 *
 * @module feibi-breaker/prompt-store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadCore } from './core.js'

/** Largest accepted custom payload. A prompt larger than this is a mistake. */
export const MAX_PROMPT_BYTES = 256 * 1024

/** File name of the user's editable copy. */
export const PROMPT_FILE_NAME = 'feibi-prompt.md'

/**
 * Locate the DSH home directory.
 *
 * `DSH_HOME` is set by the host process and is authoritative; the fallback
 * matches what the installer writes to, so an unset variable in a test or a
 * headless run still lands in the same place.
 *
 * @param {string} [override] - explicit home, used by tests.
 * @returns {string} absolute path.
 */
export function findDshHome(override) {
  if (typeof override === 'string' && override.length > 0) return override
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * Paths this module owns.
 *
 * @param {string} [home] - DSH home.
 * @returns {{file: string, stateFile: string, dir: string}} the paths.
 */
export function promptPaths(home) {
  const root = findDshHome(home)
  return {
    file: path.join(root, PROMPT_FILE_NAME),
    stateFile: path.join(root, '.feibi', 'prompt-state.json'),
    dir: path.join(root, '.feibi'),
  }
}

/**
 * Normalize a payload for comparison.
 *
 * Line endings and trailing whitespace differ between an editor on Windows and
 * one on Linux, but they carry no meaning. Without this, saving the same text
 * twice would report a change twice.
 *
 * @param {unknown} text - raw text.
 * @returns {string} normalized text.
 */
export function normalizePrompt(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '').trim()
}

/**
 * Hash a payload for the state file.
 *
 * @param {unknown} text - raw text.
 * @returns {string} sha256 hex.
 */
export function hashPrompt(text) {
  return createHash('sha256').update(normalizePrompt(text), 'utf8').digest('hex')
}

/**
 * The bundled default payload, unmodified.
 *
 * Read from the packed core asset, so the published package carries behaviour
 * and interfaces rather than a readable copy of the rules.
 *
 * @returns {string} the text.
 */
export function defaultPromptText() {
  return loadCore().prompt.primary
}

/**
 * Escape a payload for the host's `{{…}}` interpolation.
 *
 * The host substitutes `{{cwd}}`, `{{model}}`, `{{provider}}` and throws on any
 * other brace pair. The payloads are prose, so every other pair is split to
 * survive interpolation intact. This is applied at injection time, never stored:
 * the file on disk keeps the user's exact text.
 *
 * @param {string} text - raw payload.
 * @returns {string} interpolatable payload.
 */
export function escapeInterpolation(text) {
  return String(text ?? '').replace(/\{\{(?!(?:cwd|model|provider)\}\})/g, '{ {')
}

/**
 * Read the user's copy.
 *
 * @param {string} [home] - DSH home.
 * @returns {string} the text, or an empty string when absent.
 */
export function readCustomPrompt(home) {
  try {
    return fs.readFileSync(promptPaths(home).file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Read the state file.
 *
 * @param {string} [home] - DSH home.
 * @returns {{customized: boolean, hash: string | null, seedHash: string | null, updatedAt: string | null}} the state.
 */
export function readPromptState(home) {
  const empty = { customized: false, hash: null, seedHash: null, updatedAt: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(promptPaths(home).stateFile, 'utf8'))
    return {
      customized: parsed?.customized === true,
      hash: typeof parsed?.hash === 'string' ? parsed.hash : null,
      seedHash: typeof parsed?.seedHash === 'string' ? parsed.seedHash : null,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return empty
  }
}

/** Write a file through a temp file in the same directory. */
function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* the rename failure is the reason to report */ }
    throw error
  }
}

/** Persist the state file. */
function writePromptState(home, state) {
  writeAtomic(promptPaths(home).stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * mtime cache.
 *
 * `systemPrompt.section` text is evaluated on every assemble, which is every
 * turn. A synchronous stat is cheap; a synchronous read of a 5 KB file on every
 * turn is not. One entry is enough: DSH has a single home.
 */
let cache = { home: '', mtime: 0, size: 0, resolved: null }

/**
 * Resolve which payload is in force.
 *
 * `source` is the whole point of this module: `custom` means the user's file
 * won, `default` means the bundled payload is in force, and `empty` means both
 * are unusable — a state that must be visible rather than silently injecting
 * nothing.
 *
 * @param {string} [home] - DSH home.
 * @param {{fresh?: boolean}} [options] - bypass the cache.
 * @returns {{text: string, source: 'custom' | 'default' | 'empty', file: string, customized: boolean, chars: number, hash: string | null, seedHash: string | null, updatedAt: string | null}} the resolution.
 */
export function resolvePrompt(home, { fresh = false } = {}) {
  const root = findDshHome(home)
  const paths = promptPaths(root)
  const fallback = defaultPromptText()
  const seedHash = fallback ? hashPrompt(fallback) : null

  let mtime = 0
  let size = 0
  try {
    const stat = fs.statSync(paths.file)
    mtime = stat.mtimeMs
    size = stat.size
  } catch {
    mtime = 0
    size = 0
  }

  if (
    !fresh
    && cache.resolved !== null
    && cache.home === root
    && cache.mtime === mtime
    && cache.size === size
  ) {
    return cache.resolved
  }

  const custom = normalizePrompt(readCustomPrompt(root)) ? readCustomPrompt(root) : ''
  const state = readPromptState(root)
  const customNorm = normalizePrompt(custom)

  let text = ''
  let source = 'empty'
  if (customNorm) {
    text = custom
    // A file that exists but holds exactly the shipped text is not an edit.
    // Seeding materialises the default on disk, and reporting that as `custom`
    // would show a "已自定义" badge to a user who never changed anything.
    source = hashPrompt(custom) === seedHash ? 'default' : 'custom'
  } else if (normalizePrompt(fallback)) {
    text = fallback
    source = 'default'
  }

  const resolved = {
    text,
    source,
    file: paths.file,
    customized: source === 'custom',
    chars: normalizePrompt(text).length,
    hash: text ? hashPrompt(text) : null,
    seedHash,
    updatedAt: state.updatedAt,
  }
  cache = { home: root, mtime, size, resolved }
  return resolved
}

/** Drop the cache; called after a write so the next read sees the new text. */
export function invalidatePromptCache() {
  cache = { home: '', mtime: 0, size: 0, resolved: null }
}

/**
 * Save the user's payload.
 *
 * An empty body is rejected rather than written: an empty file would silently
 * fall back to the default while the UI showed an empty box, which is exactly
 * the confusion this module exists to remove.
 *
 * @param {string} [home] - DSH home.
 * @param {unknown} content - the new payload.
 * @returns {{ok: true, ...object} | {ok: false, error: string}} the result.
 */
export function savePrompt(home, content) {
  const root = findDshHome(home)
  if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }
  const norm = normalizePrompt(content)
  if (!norm) return { ok: false, error: '提示词不能为空；要回到内置默认请点「恢复默认」' }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_PROMPT_BYTES) {
    return { ok: false, error: `提示词超过 ${MAX_PROMPT_BYTES} 字节上限（当前 ${bytes}）` }
  }
  try {
    writeAtomic(promptPaths(root).file, content)
  } catch (error) {
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const fallback = defaultPromptText()
  const seedHash = fallback ? hashPrompt(fallback) : null
  const hash = hashPrompt(content)
  // Saving the bundled text verbatim is not a customisation: it must resolve
  // back to `default`, or the badge would claim an edit that is not there.
  const customized = hash !== seedHash
  writePromptState(root, {
    customized,
    hash,
    seedHash,
    updatedAt: new Date().toISOString(),
  })
  invalidatePromptCache()
  return { ok: true, ...resolvePrompt(root, { fresh: true }) }
}

/**
 * Delete the user's payload so the bundled default takes over again.
 *
 * @param {string} [home] - DSH home.
 * @returns {{ok: true, ...object}} the resolution after reset.
 */
export function resetPrompt(home) {
  const root = findDshHome(home)
  const paths = promptPaths(root)
  try {
    fs.unlinkSync(paths.file)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, error: `删除失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const fallback = defaultPromptText()
  writePromptState(root, {
    customized: false,
    hash: fallback ? hashPrompt(fallback) : null,
    seedHash: fallback ? hashPrompt(fallback) : null,
    updatedAt: new Date().toISOString(),
  })
  invalidatePromptCache()
  return { ok: true, ...resolvePrompt(root, { fresh: true }) }
}

/**
 * Seed the user's file from the bundled default when it is absent.
 *
 * Called at activation so the file exists and is discoverable: a user who wants
 * to edit the prompt needs a file to open, and "the path in the UI is a file
 * that does not exist yet" is a bad first experience. A file that already has
 * content is never touched.
 *
 * @param {string} [home] - DSH home.
 * @returns {{action: 'created' | 'kept' | 'empty_default', file: string}} what happened.
 */
export function seedPromptFile(home) {
  const root = findDshHome(home)
  const paths = promptPaths(root)
  const fallback = defaultPromptText()
  const existing = normalizePrompt(readCustomPrompt(root))
  if (existing) return { action: 'kept', file: paths.file }
  if (!normalizePrompt(fallback)) return { action: 'empty_default', file: paths.file }
  try {
    writeAtomic(paths.file, fallback)
    const hash = hashPrompt(fallback)
    writePromptState(root, {
      customized: false,
      hash,
      seedHash: hash,
      updatedAt: new Date().toISOString(),
    })
    invalidatePromptCache()
    return { action: 'created', file: paths.file }
  } catch {
    // A read-only home is not a reason to fail activation; the bundled default
    // still injects, the file just cannot be seeded.
    return { action: 'kept', file: paths.file }
  }
}
