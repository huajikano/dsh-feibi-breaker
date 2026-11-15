/**
 * Installer helpers for feibi-breaker.
 *
 * The two originals installed differently: 菲比破限 rewrote the profile's
 * `cordis.patch.yml` to override the host identity and mounted its row, while
 * 闸总 relied on the bundle patch alone. The merged plugin does both, but the
 * identity override is written here rather than shipped in `cordis.patch.yml`,
 * because a bundle patch that rewrites `system-prompt` fights every other
 * bundle doing the same thing.
 *
 * Everything below is idempotent: running it twice changes nothing the second
 * time, and a pre-existing `.bak` is never overwritten, so the first run always
 * preserves the user's original file.
 *
 * @module feibi-breaker/install
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** Loader row id; matches `package.json` `dsh.id`. */
export const PLUGIN_ID = 'feibi-breaker'

/** Plugin display name. */
export const PLUGIN_LABEL = '菲比破限'

/**
 * Ids this plugin supersedes. **Empty on purpose.**
 *
 * This plugin coexists with `dsh-gatekeeper` and any other
 * guard: installing it adds one Loader row and touches nothing else. Earlier
 * builds of 菲比破限 carried the merged predecessors' ids here, which made an
 * install silently unmount another plugin the user had chosen to keep. A public
 * package must not make that decision for the user, so the list is now empty and
 * `stripRows` stays available for anyone who wants an explicit cleanup.
 */
export const SUPERSEDED_IDS = Object.freeze([])

/**
 * Locate the DSH home directory.
 *
 * @param {string} [override] - explicit path.
 * @returns {string} the directory.
 */
export function findDshHome(override) {
  if (override && fs.existsSync(override)) return override
  if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/**
 * List every profile directory under a DSH home.
 *
 * @param {string} dshHome - DSH home.
 * @returns {string[]} absolute profile paths.
 */
export function listProfiles(dshHome = findDshHome()) {
  const root = path.join(dshHome, 'profiles')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .filter((name) => name !== 'node_modules')
    .map((name) => path.join(root, name))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'package.json'))
      } catch {
        return false
      }
    })
}

/** Copy a file once, never clobbering an earlier backup. */
function backupOnce(file) {
  const bak = `${file}.before-${PLUGIN_ID}.bak`
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
  return bak
}

/** Write through a temp file so a crash cannot leave a half-written patch. */
function writeAtomic(file, text) {
  const tmp = `${file}.${PLUGIN_ID}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Remove one top-level YAML sequence entry whose `id:` matches.
 *
 * The patch file is hand-written YAML with `!!js` expressions and block
 * scalars, so a real parser round-trip would reformat it and drop comments.
 * This walks lines instead, tracking indentation and literal blocks, and
 * removes only the exact mapping node — the same approach the 富江 migration
 * used, which is why it is safe on a file a user has edited.
 *
 * @param {string} text - patch file contents.
 * @param {readonly string[]} ids - ids to remove.
 * @returns {string} the text without those entries.
 */
export function stripRows(text, ids) {
  const targets = new Set(ids)
  if (!text || targets.size === 0) return text

  const lines = text.split(/\r?\n/)
  const keep = new Array(lines.length).fill(true)

  // A literal block (`key: |`) owns every following line that is more indented.
  const inScalar = new Array(lines.length).fill(false)
  let scalarIndent = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const indent = /^ */.exec(raw)[0].length
    const blank = /^\s*(?:#.*)?$/.test(raw)
    if (scalarIndent !== null && (blank || indent > scalarIndent)) {
      inScalar[i] = true
      continue
    }
    scalarIndent = null
    if (!blank && /:\s*[>|][+-]?\d*\s*(?:#.*)?$/.test(raw)) scalarIndent = indent
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (inScalar[i]) continue
    const head = /^(\s*)-\s+id:\s*(.+?)\s*(?:#.*)?$/.exec(lines[i])
    if (head === null) continue
    const value = head[2].replace(/^['"]|['"]$/g, '')
    if (!targets.has(value)) continue

    const indent = head[1].length
    let end = i + 1
    while (end < lines.length) {
      const raw = lines[end]
      const blank = /^\s*$/.test(raw)
      const lineIndent = /^ */.exec(raw)[0].length
      if (!blank && !inScalar[end] && lineIndent <= indent) break
      end += 1
    }
    for (let cursor = i; cursor < end; cursor += 1) keep[cursor] = false
    i = end - 1
  }

  // An `insert:` wrapper left with no children would be a null insert.
  //
  // Iterate backwards: splicing forward shifts the next wrapper into the index
  // the loop is about to skip, which left one empty `insert:` behind per run
  // and made the whole installer non-idempotent.
  const out = lines.filter((_, index) => keep[index])
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (!/^\s*-\s+insert:\s*$/.test(out[i])) continue
    const baseIndent = /^ */.exec(out[i])[0].length
    let hasChild = false
    for (let j = i + 1; j < out.length; j += 1) {
      if (/^\s*$/.test(out[j])) continue
      const childIndent = /^ */.exec(out[j])[0].length
      if (childIndent > baseIndent) { hasChild = true; break }
      break
    }
    if (!hasChild) out.splice(i, 1)
  }
  return out.join('\n')
}

/**
 * Build the row this plugin needs in a profile patch.
 *
 * @param {Record<string, unknown>} [config] - initial config overrides.
 * @returns {string} the YAML block.
 */
export function buildRow(config = {}) {
  const entries = Object.entries(config)
  if (entries.length === 0) {
    return `- insert:\n    - id: ${PLUGIN_ID}\n      name: '${PLUGIN_ID}'\n`
  }
  const body = entries.map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`).join('\n')
  return `- insert:\n    - id: ${PLUGIN_ID}\n      name: '${PLUGIN_ID}'\n      config:\n${body}\n`
}

/**
 * The host identity override, used only when the profile has no such row.
 *
 * 菲比破限 wrote this block itself; here it is a separate, clearly-labelled
 * step so a user can see what it does and skip it if another plugin owns the
 * identity.
 */
export const IDENTITY_BLOCK = `# [${PLUGIN_ID}] Host identity: no built-in refusal framing.
- id: system-prompt
  config:
    includeHarnessIdentity: false
    personaPrefix: ''
`

/** Marker the identity step leaves behind, so it is never applied twice. */
const IDENTITY_MARKER = `[${PLUGIN_ID}] Host identity`

/**
 * Set `includeHarnessIdentity: false` without adding a duplicate row.
 *
 * Most real profiles already carry a `- id: system-prompt` row — this machine's
 * desktop profile does, with its own `personaPrefix`. Prepending a second row
 * with the same id leaves two conflicting entries, and which one wins depends on
 * the Loader's merge order. So: if the row exists, edit it in place; only when
 * it is absent is a fresh block prepended.
 *
 * A row that already names `includeHarnessIdentity` is left completely alone —
 * the user made a deliberate choice there and this installer must not undo it.
 *
 * @param {string} text - patch file contents.
 * @returns {{text: string, action: 'prepended' | 'patched' | 'present' | 'respect-owner'}} the result.
 */
export function ensureIdentity(text) {
  const lines = text.split(/\r?\n/)

  let rowStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s+id:\s*['"]?system-prompt['"]?\s*(?:#.*)?$/.test(lines[i])) {
      rowStart = i
      break
    }
  }

  if (rowStart === -1) {
    return { text: `${IDENTITY_BLOCK}\n${text.trimStart()}`, action: 'prepended' }
  }

  // Bound the row: the next top-level sequence entry ends it.
  const baseIndent = /^ */.exec(lines[rowStart])[0].length
  let rowEnd = lines.length
  for (let i = rowStart + 1; i < lines.length; i += 1) {
    if (/^\s*$/.test(lines[i])) continue
    if (/^ */.exec(lines[i])[0].length <= baseIndent && /^\s*-/.test(lines[i])) { rowEnd = i; break }
  }

  // Scan the whole row for an existing `includeHarnessIdentity` before deciding
  // to insert one. Checking for `config:` first would break out of the loop
  // before reaching a setting the user already made one line below it.
  let configLine = -1
  for (let i = rowStart + 1; i < rowEnd; i += 1) {
    if (/^\s*includeHarnessIdentity\s*:/.test(lines[i])) {
      return { text, action: 'present' }
    }
    if (configLine === -1 && /^\s*config\s*:\s*(?:#.*)?$/.test(lines[i])) configLine = i
  }

  if (configLine === -1) {
    // A row with no `config:` block: append one right under it.
    const indent = ' '.repeat(baseIndent + 2)
    lines.splice(rowStart + 1, 0, `${indent}config:`, `${indent}  includeHarnessIdentity: false`)
    return { text: lines.join('\n'), action: 'patched' }
  }

  const configIndent = /^ */.exec(lines[configLine])[0].length
  lines.splice(configLine + 1, 0, `${' '.repeat(configIndent + 2)}includeHarnessIdentity: false`)
  return { text: lines.join('\n'), action: 'patched' }
}

/**
 * Patch one profile: add this row, optionally set identity, leave the rest.
 *
 * @param {string} profileDir - the profile directory.
 * @param {{config?: Record<string, unknown>, identity?: boolean}} [options] - install options.
 * @returns {{profileDir: string, changed: boolean, removed: string[], backup: string | null}} the result.
 */
export function patchProfile(profileDir, { config = {}, identity = true } = {}) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  let text = stripRows(before, SUPERSEDED_IDS)

  const removed = SUPERSEDED_IDS.filter((id) => before !== text && before.includes(`id: ${id}`))

  if (!text.includes(`id: ${PLUGIN_ID}`)) {
    text = `${text.trimEnd()}\n\n${buildRow(config)}`
  }
  if (identity) text = ensureIdentity(text).text
  text = `${text.trimEnd()}\n`

  if (text === before) return { profileDir, changed: false, removed, backup: null }
  const backup = before.length > 0 ? backupOnce(file) : null
  writeAtomic(file, text)
  return { profileDir, changed: true, removed, backup }
}

/**
 * Ensure the profile's `package.json` depends on this plugin and does not list
 * a superseded bundle.
 *
 * @param {string} profileDir - the profile directory.
 * @param {{pluginsDir?: string}} [options] - where the plugin lives.
 * @returns {{profileDir: string, changed: boolean, backup: string | null}} the result.
 */
export function patchPackage(profileDir, { pluginsDir } = {}) {
  const file = path.join(profileDir, 'package.json')
  if (!fs.existsSync(file)) return { profileDir, changed: false, backup: null }
  const before = fs.readFileSync(file, 'utf8')
  let pkg
  try {
    pkg = JSON.parse(before.replace(/^\uFEFF/, ''))
  } catch {
    return { profileDir, changed: false, backup: null }
  }

  const spec = pluginsDir ? `link:${pluginsDir.replace(/\\/g, '/')}` : `file:../../plugins/${PLUGIN_ID}`
  pkg.dependencies = pkg.dependencies ?? {}

  let changed = false
  for (const id of SUPERSEDED_IDS) {
    if (Object.hasOwn(pkg.dependencies, id)) {
      delete pkg.dependencies[id]
      changed = true
    }
  }
  if (!Object.hasOwn(pkg.dependencies, PLUGIN_ID)) {
    pkg.dependencies[PLUGIN_ID] = spec
    changed = true
  }

  // A third-party plugin must not also load as a base bundle.
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const next = bundles.filter((item) => {
      const id = typeof item === 'string' ? item : item?.id ?? item?.name
      return !SUPERSEDED_IDS.includes(id) && id !== PLUGIN_ID
    })
    if (next.length !== bundles.length) {
      pkg.dsh.profile.bundles = next
      changed = true
    }
  }

  if (!changed) return { profileDir, changed: false, backup: null }
  const indent = /^([\t ]+)"/m.exec(before)?.[1] || '  '
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const backup = backupOnce(file)
  writeAtomic(file, `${JSON.stringify(pkg, null, indent).replace(/\n/g, eol)}${eol}`)
  return { profileDir, changed: true, backup }
}

/**
 * Install into every profile, or the named ones.
 *
 * @param {{dshHome?: string, profiles?: string[], config?: Record<string, unknown>, identity?: boolean, pluginsDir?: string}} [options] - install options.
 * @returns {object} a report.
 */
export function install(options = {}) {
  const dshHome = findDshHome(options.dshHome)
  const pluginsDir = options.pluginsDir ?? path.join(dshHome, 'plugins', PLUGIN_ID)
  const all = listProfiles(dshHome)
  const selected = Array.isArray(options.profiles) && options.profiles.length > 0
    ? all.filter((dir) => options.profiles.includes(path.basename(dir)))
    : all

  const results = selected.map((profileDir) => ({
    profile: path.basename(profileDir),
    patch: patchProfile(profileDir, { config: options.config, identity: options.identity !== false }),
    package: patchPackage(profileDir, { pluginsDir }),
  }))

  return { dshHome, pluginsDir, profiles: results }
}

/**
 * Whether this module was launched directly rather than imported.
 *
 * Comparing `path.resolve(process.argv[1])` against a hand-built string from
 * `import.meta.url` is fragile: `URL.pathname` keeps percent-encoding (so a
 * path containing a space or a CJK character never matches) and the
 * leading-slash strip has to handle both `C:` and UNC forms. The result was a
 * script that exited 0 with no output and installed nothing, while its caller
 * printed "配置已更新".
 *
 * `fileURLToPath` is the inverse of the URL encoding and is the only correct
 * way to turn `import.meta.url` into a filesystem path.
 */
function isMain() {
  if (typeof process.argv[1] !== 'string') return false
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const report = install({ dshHome: process.argv[2] })
  console.log(JSON.stringify(report, null, 2))
}
