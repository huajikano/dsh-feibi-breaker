/**
 * Profile-side helpers for the feibi-breaker installer.
 *
 * The 1.1.x installer rewrote files it did not own: it patched the host's
 * `dsh-agent-instructions` package, prepended a global `system-prompt` override,
 * and ran `pnpm install` inside the profile — which on DSH 0.2.x purges
 * `node_modules` and leaves every other plugin unresolvable. This module keeps
 * only the parts that are safe on 0.2.2-rc.5 and makes each one idempotent:
 *
 *   - read/write a profile `package.json` preserving indent and line endings;
 *   - add exactly one `link:` dependency and one `dsh.profile.bundles` entry;
 *   - edit the profile's `cordis.patch.yml` by line, never through a YAML
 *     round-trip (comments, `!!js` scalars and block literals survive);
 *   - create the `node_modules` junction with `fs.symlinkSync(..., 'junction')`
 *     instead of `cmd /c mklink` (no `cmd` quoting layer, no non-ASCII damage);
 *   - back up the profile into `$DSH_HOME/backups/feibi-breaker/<stamp>/`
 *     without ever overwriting an earlier backup.
 *
 * Nothing here runs a package manager. DSH 0.2.x resolves a profile plugin from
 * `node_modules`; the lockfile is pnpm's business, and touching it is what broke
 * other plugins in the first place.
 *
 * @module feibi-breaker/scripts/lib/profile
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Loader row id, bundle name and package name — one identity for all three. */
export const PLUGIN_ID = 'feibi-breaker'

/** Plugin display name used in console output. */
export const PLUGIN_LABEL = '菲比破限'

/** Profile directory names that are snapshots, not live profiles. */
const SNAPSHOT_PROFILE = /(?:^|[-_.])(?:bak|backup|stale|old|empty|copy|test)(?:[-_.]|$)/i

/**
 * Locate the DSH home directory.
 *
 * @param {string} [override] - explicit path.
 * @returns {string} the directory.
 */
export function findDshHome(override) {
  if (override !== undefined && override !== '') return path.resolve(override)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/**
 * List every live profile directory under a DSH home.
 *
 * Snapshot directories (`desktop-backup-*`, `node_modules.stale-*`, …) are
 * excluded: the 1.1.x installer wrote into them, so uninstalling a plugin once
 * edited the user's own backups.
 *
 * @param {string} dshHome - DSH home.
 * @param {{includeSnapshots?: boolean}} [options] - keep snapshot directories.
 * @returns {string[]} absolute profile paths.
 */
export function listProfiles(dshHome = findDshHome(), { includeSnapshots = false } = {}) {
  const root = path.join(dshHome, 'profiles')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => name !== 'node_modules')
    .filter((name) => includeSnapshots || !SNAPSHOT_PROFILE.test(name))
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .sort()
}

/**
 * Whether a directory name looks like a snapshot instead of a live profile.
 *
 * @param {string} name - profile directory basename.
 * @returns {boolean} whether it is a snapshot.
 */
export function isSnapshotProfile(name) {
  return SNAPSHOT_PROFILE.test(name)
}

/**
 * Pick the profiles an install or uninstall applies to, without asking.
 *
 * A one-click launcher cannot prompt: by the time it asks "which profile", it
 * is no longer one click. The order is deterministic and safe, because every
 * step is idempotent and only touches this plugin's own row/dependency/link:
 *
 *   1. `--profile <name>` — explicit wins;
 *   2. `--all` — every live profile;
 *   3. `$DSH_PROFILE` — the profile the running Harness was launched with
 *      (set by DSH in every shell of a profile-launched session);
 *   4. a single live profile — nothing to choose;
 *   5. otherwise every live profile — snapshot directories stay excluded.
 *
 * @param {string} dshHome - DSH home.
 * @param {{profiles?: readonly string[], all?: boolean}} [options] - CLI flags.
 * @returns {{targets: string[], reason: 'named' | 'all' | 'active' | 'single' | 'default'}} the choice.
 * @throws {Error} when a named profile does not exist.
 */
export function resolveTargetProfiles(dshHome, { profiles = [], all = false } = {}) {
  const live = listProfiles(dshHome)

  if (profiles.length > 0) {
    const targets = profiles.map((name) => {
      const dir = path.join(dshHome, 'profiles', name)
      if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`profile 不存在或缺少 package.json：${dir}`)
      return dir
    })
    return { targets, reason: 'named' }
  }

  if (all) return { targets: live, reason: 'all' }
  if (live.length === 0) return { targets: [], reason: 'single' }

  const active = process.env.DSH_PROFILE
  if (typeof active === 'string' && active !== '') {
    const dir = path.join(dshHome, 'profiles', active)
    if (fs.existsSync(path.join(dir, 'package.json'))) return { targets: [dir], reason: 'active' }
  }

  return { targets: live, reason: live.length === 1 ? 'single' : 'default' }
}

/** Human-readable label for a resolution reason. */
export const REASON_LABEL = Object.freeze({
  named: '由 --profile 指定',
  all: '由 --all 指定',
  active: '当前运行的 profile（$DSH_PROFILE）',
  single: '唯一的 profile',
  default: '自动：所有活动 profile（快照目录已排除）',
})

/** UTC stamp safe for a directory name. */
export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Copy one profile file into a fresh backup directory.
 *
 * @param {string} dshHome - DSH home.
 * @param {string} profileDir - profile directory.
 * @param {readonly string[]} files - relative file names to copy when present.
 * @returns {string | null} the backup directory, or null when nothing existed.
 */
export function backupProfile(dshHome, profileDir, files) {
  const present = files.filter((name) => fs.existsSync(path.join(profileDir, name)))
  if (present.length === 0) return null
  const root = path.join(dshHome, 'backups', PLUGIN_ID)
  fs.mkdirSync(root, { recursive: true })
  const base = path.join(root, `${path.basename(profileDir)}-${stamp()}`)
  let dir = base
  for (let index = 1; fs.existsSync(dir); index += 1) dir = `${base}-${index}`
  fs.mkdirSync(dir, { recursive: true })
  for (const name of present) {
    fs.copyFileSync(path.join(profileDir, name), path.join(dir, name.replace(/[\\/]/g, '__')))
  }
  return dir
}

/** Read a text file, returning `''` when it does not exist. */
export function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

/**
 * Write a text file through a temp file in the same directory.
 *
 * @param {string} file - destination.
 * @param {string} text - contents.
 */
export function writeTextAtomic(file, text) {
  const tmp = `${file}.${PLUGIN_ID}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

/**
 * Read a profile manifest.
 *
 * @param {string} profileDir - profile directory.
 * @returns {object} the parsed manifest.
 * @throws {Error} when the file is missing or not JSON.
 */
export function readManifest(profileDir) {
  const file = path.join(profileDir, 'package.json')
  if (!fs.existsSync(file)) throw new Error(`profile has no package.json: ${file}`)
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Serialize a manifest the way the profile already formats it.
 *
 * @param {object} manifest - value to write.
 * @param {string} before - the file's previous text, for indent and EOL.
 * @returns {string} the JSON text.
 */
export function formatManifest(manifest, before) {
  const indent = /^([\t ]+)"/m.exec(before)?.[1] ?? '  '
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  return `${JSON.stringify(manifest, undefined, indent).replace(/\n/g, eol)}${eol}`
}

/**
 * The `link:` specifier a profile should carry for this plugin.
 *
 * @param {string} pluginDir - absolute plugin directory.
 * @returns {string} the specifier.
 */
export function linkSpec(pluginDir) {
  return `link:${pluginDir.replace(/\\/g, '/')}`
}

/**
 * Plan the manifest change: one `link:` dependency, one bundle entry.
 *
 * The bundle list is the official 0.2.x load path (`dsh.bundle.patch` inside the
 * package), so the plugin is listed there and **not** inserted a second time from
 * the profile patch — two inserts would mount the plugin twice.
 *
 * @param {object} manifest - current manifest.
 * @param {string} pluginDir - absolute plugin directory.
 * @returns {{manifest: object, changes: string[]}} the planned manifest and what changed.
 */
export function planManifest(manifest, pluginDir) {
  const next = structuredClone(manifest)
  const changes = []
  const spec = linkSpec(pluginDir)

  next.dependencies = next.dependencies ?? {}
  if (next.dependencies[PLUGIN_ID] !== spec) {
    changes.push(`dependencies.${PLUGIN_ID} = ${spec}`)
    next.dependencies[PLUGIN_ID] = spec
  }

  next.dsh = next.dsh ?? {}
  next.dsh.profile = next.dsh.profile ?? {}
  const bundles = Array.isArray(next.dsh.profile.bundles) ? [...next.dsh.profile.bundles] : []
  const occurrences = bundles.filter((name) => name === PLUGIN_ID).length
  if (occurrences !== 1) {
    const kept = bundles.filter((name) => name !== PLUGIN_ID)
    kept.push(PLUGIN_ID)
    next.dsh.profile.bundles = kept
    changes.push(`dsh.profile.bundles += ${PLUGIN_ID}${occurrences > 1 ? ` (deduplicated ${occurrences})` : ''}`)
  }

  return { manifest: next, changes }
}

// ---------------------------------------------------------------------------
// cordis.patch.yml
// ---------------------------------------------------------------------------

/**
 * Whether a line is blank or a comment.
 *
 * @param {string} line - one line.
 * @returns {boolean} whether it carries no YAML content.
 */
function isNoise(line) {
  return /^\s*(?:#.*)?$/.test(line)
}

/**
 * Remove one top-level YAML sequence entry whose `id:` matches.
 *
 * The patch file is hand-written YAML with `!!js` expressions and block
 * scalars, so a parser round-trip would reformat it and drop comments. This
 * walks lines instead, tracking indentation and literal blocks, and removes only
 * the exact mapping node — the same approach the 富江 migration used, which is
 * why it is safe on a file a user has edited.
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
    const blank = isNoise(raw)
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
  const out = lines.filter((_, index) => keep[index])
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (!/^\s*-\s+insert:\s*$/.test(out[i])) continue
    const baseIndent = /^ */.exec(out[i])[0].length
    let hasChild = false
    for (let j = i + 1; j < out.length; j += 1) {
      if (/^\s*$/.test(out[j])) continue
      const childIndent = /^ */.exec(out[j])[0].length
      if (childIndent > baseIndent) hasChild = true
      break
    }
    if (!hasChild) out.splice(i, 1)
  }
  return out.join('\n')
}

/**
 * Validate the patch dialect this file uses, without a YAML dependency.
 *
 * Catches the corruption classes that actually take the harness down — a
 * top-level entry that is not a sequence item, tab indentation — because a
 * profile patch that fails to parse stops **every** plugin from mounting, not
 * just this one.
 *
 * Deliberately does *not* try to find unbalanced quotes: a real profile patch
 * mixes plain scalars with embedded quotes, escaped JSON in `args:` arrays and
 * block scalars, and a line-based heuristic flags all of them. A false positive
 * here refuses a legitimate install, which is worse than the class of damage it
 * would catch.
 *
 * @param {string} text - patch file contents.
 * @returns {string[]} human-readable problems; empty when the file looks sound.
 */
export function validatePatch(text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  if (text.trim() === '') return problems

  if (text.charCodeAt(0) === 0xfeff) problems.push('line 1: file starts with a UTF-8 BOM')

  let inScalar = null
  let expectSequence = true
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const where = `line ${index + 1}`
    if (/^\s*\t/.test(line)) problems.push(`${where}: tab indentation`)
    if (isNoise(line)) continue

    const indent = /^ */.exec(line)[0].length
    if (inScalar !== null) {
      if (indent > inScalar) continue
      inScalar = null
    }
    if (/:\s*[>|][+-]?\d*\s*(?:#.*)?$/.test(line)) {
      inScalar = indent
      continue
    }
    if (indent === 0 && expectSequence && !/^-\s+\S/.test(line)) {
      problems.push(`${where}: top-level entry is not a YAML sequence item: ${JSON.stringify(line)}`)
    }
  }
  return problems
}

/**
 * Whether a patch text mounts this plugin through an `- insert:` row.
 *
 * @param {string} text - patch file contents.
 * @returns {boolean} whether such a row exists.
 */
export function hasInsertRow(text) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s+insert:\s*$/.test(lines[i])) continue
    const baseIndent = /^ */.exec(lines[i])[0].length
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isNoise(lines[j])) continue
      const indent = /^ */.exec(lines[j])[0].length
      if (indent <= baseIndent) break
      if (new RegExp(`^\\s*-\\s+id:\\s*['"]?${PLUGIN_ID}['"]?\\s*(?:#.*)?$`).test(lines[j])) return true
    }
  }
  return false
}

/**
 * Count id-targeted rows for this plugin.
 *
 * @param {string} text - patch file contents.
 * @returns {number} how many `- id: feibi-breaker` entries exist at top level.
 */
export function countIdRows(text) {
  const re = new RegExp(`^\\s*-\\s+id:\\s*['"]?${PLUGIN_ID}['"]?\\s*(?:#.*)?$`, 'gm')
  return (text.match(re) ?? []).length
}

/**
 * The config override row the profile carries, if any.
 *
 * A row is only an override: the bundle patch inserts the entry, and this row
 * replaces its `config` block. Keeping it means a user's saved settings survive
 * a reinstall.
 *
 * @returns {string} the YAML block.
 */
export function configRow() {
  return `- id: ${PLUGIN_ID}\n`
}

/**
 * Plan the patch change.
 *
 * - an `- insert:` row for this plugin is legacy (it would mount it twice next
 *   to the bundle) and is replaced by an id-targeted row;
 * - a missing row is appended;
 * - everything else is left byte-for-byte alone.
 *
 * @param {string} text - patch file contents.
 * @returns {{text: string, changes: string[]}} the planned text and what changed.
 */
export function planPatch(text) {
  const changes = []
  let next = text

  if (hasInsertRow(next)) {
    next = stripRows(next, [PLUGIN_ID])
    changes.push('removed legacy `- insert:` row (the bundle already inserts this entry)')
  }

  const count = countIdRows(next)
  if (count === 0) {
    next = `${next.trimEnd()}\n\n${configRow()}`
    changes.push(`appended \`- id: ${PLUGIN_ID}\``)
  } else if (count > 1) {
    // Keep the first row, drop the rest: `applyEntryPatches` would otherwise
    // apply both and leave duplicate entries in the tree.
    let seen = 0
    const lines = next.split(/\r?\n/)
    const keep = []
    for (let i = 0; i < lines.length; i += 1) {
      if (new RegExp(`^\\s*-\\s+id:\\s*['"]?${PLUGIN_ID}['"]?\\s*(?:#.*)?$`).test(lines[i])) {
        seen += 1
        if (seen > 1) {
          // Drop the row and its indented body.
          const indent = /^ */.exec(lines[i])[0].length
          i += 1
          while (i < lines.length && (isNoise(lines[i]) || /^ */.exec(lines[i])[0].length > indent)) i += 1
          i -= 1
          continue
        }
      }
      keep.push(lines[i])
    }
    next = keep.join('\n')
    changes.push(`removed ${count - 1} duplicate \`- id: ${PLUGIN_ID}\` row(s)`)
  }

  if (next !== text && !next.endsWith('\n')) next = `${next}\n`
  return { text: next, changes }
}

// ---------------------------------------------------------------------------
// node_modules
// ---------------------------------------------------------------------------

/** `lstat` that returns undefined instead of throwing. */
export function lstatOf(target) {
  try {
    return fs.lstatSync(target)
  } catch {
    return undefined
  }
}

/** `realpath` that returns undefined instead of throwing. */
export function realpathOf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return undefined
  }
}

/**
 * Whether two paths name the same directory, case-insensitively on Windows.
 *
 * @param {string} left - first path.
 * @param {string} right - second path.
 * @returns {boolean} whether they resolve to the same place.
 */
export function samePath(left, right) {
  const a = realpathOf(left) ?? path.resolve(left)
  const b = realpathOf(right) ?? path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Point `node_modules/<id>` at the plugin directory.
 *
 * A junction is created with `fs.symlinkSync` (no `cmd` quoting layer, so a
 * path with spaces or CJK characters is safe). An existing entry that points
 * elsewhere is renamed aside rather than deleted — it may be another plugin's
 * link, or a user's own checkout.
 *
 * @param {string} profileDir - profile directory.
 * @param {string} pluginDir - absolute plugin directory.
 * @param {{dryRun?: boolean}} [options] - plan only.
 * @returns {{action: 'present' | 'created' | 'replaced', aside?: string}} what happened.
 */
export function ensureJunction(profileDir, pluginDir, { dryRun = false } = {}) {
  const modules = path.join(profileDir, 'node_modules')
  const link = path.join(modules, PLUGIN_ID)
  const stat = lstatOf(link)

  if (stat !== undefined) {
    const target = realpathOf(link)
    if (target !== undefined && samePath(target, pluginDir)) return { action: 'present' }
    const aside = `${link}.old-${stamp()}`
    if (!dryRun) {
      fs.renameSync(link, aside)
      fs.symlinkSync(pluginDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    return { action: 'replaced', aside }
  }

  if (!dryRun) {
    fs.mkdirSync(modules, { recursive: true })
    fs.symlinkSync(pluginDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  return { action: 'created' }
}

/**
 * Which of the profile's declared dependencies still resolve.
 *
 * This is the check the 1.1.x installer never made, and the reason a plugin
 * install could silently take every other plugin down with it.
 *
 * @param {object} manifest - the profile manifest.
 * @param {string} profileDir - profile directory.
 * @returns {{ok: string[], missing: string[]}} resolvable and missing packages.
 */
export function dependencyHealth(manifest, profileDir) {
  const ok = []
  const missing = []
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (fs.existsSync(path.join(profileDir, 'node_modules', name, 'package.json'))) ok.push(name)
    else missing.push(name)
  }
  return { ok, missing }
}

/**
 * Copy this package into the plugin directory.
 *
 * Skips `.git`, `node_modules` and editor debris; never deletes anything that is
 * already there (a stale file is harmless, a deleted one may be the user's).
 * When the destination is a link back to the source, the copy is skipped so the
 * installer cannot write through a junction into the user's checkout.
 *
 * @param {string} sourceDir - the package being installed.
 * @param {string} pluginDir - destination directory.
 * @param {{dryRun?: boolean}} [options] - plan only.
 * @returns {{action: 'copied' | 'linked' | 'same', files: number}} what happened.
 */
export function copyPlugin(sourceDir, pluginDir, { dryRun = false } = {}) {
  if (samePath(sourceDir, pluginDir)) return { action: 'same', files: 0 }
  const existing = lstatOf(pluginDir)
  if (existing !== undefined && existing.isSymbolicLink()) return { action: 'linked', files: 0 }

  const skip = new Set(['.git', 'node_modules', '.vscode', '.idea'])
  let files = 0
  const walk = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const src = path.join(from, entry.name)
      const dst = path.join(to, entry.name)
      if (entry.isDirectory()) {
        if (!dryRun) fs.mkdirSync(dst, { recursive: true })
        walk(src, dst)
      } else if (entry.isFile()) {
        files += 1
        if (!dryRun) fs.copyFileSync(src, dst)
      }
    }
  }
  if (!dryRun) fs.mkdirSync(pluginDir, { recursive: true })
  walk(sourceDir, pluginDir)
  return { action: 'copied', files }
}
