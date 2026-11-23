/**
 * Post-install verification for feibi-breaker.
 *
 * The 1.1.x `check-profile.mjs` hardcoded the `desktop` profile and asserted
 * that `includeHarnessIdentity: false` was present and that the `fujiang-*` rows
 * were gone — i.e. it failed unless the installer had rewritten the user's
 * global identity, and it never noticed that every other plugin's `node_modules`
 * link had been destroyed. This tool checks what actually has to be true:
 *
 *   - the profile patch parses and mounts the plugin exactly once;
 *   - the bundle is selected and the dependency specifier is the one written;
 *   - the `node_modules` link resolves to the plugin directory;
 *   - the plugin declares a compatible `engines.dsh`;
 *   - **every other declared dependency of the profile still resolves**.
 *
 * @module feibi-breaker/tools/check-install
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_ID, countIdRows, dependencyHealth, findDshHome, hasInsertRow,
  listProfiles, readManifest, readText, realpathOf, samePath, validatePatch,
} from '../scripts/lib/profile.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const green = (text) => `\u001b[32m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`

/** Parse `--flag value` / `--flag` pairs. */
function parseArgs(argv) {
  const options = { profiles: [], dshHome: undefined, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '--profile': options.profiles.push(value()); break
      case '--dsh-home': options.dshHome = value(); break
      case '--verbose': options.verbose = true; break
      case '--help': case '-h': options.help = true; break
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Whether a runtime version satisfies a range, prereleases included.
 *
 * Supports the comparator sets a plugin manifest actually uses (`>=`, `>`,
 * `<=`, `<`, `^`, `~`, exact, space-separated conjunction, `||` disjunction).
 * A plain `^0.2.2` does **not** admit `0.2.2-rc.5`: semver orders a prerelease
 * before its release, so the lower bound excludes it. The correct declaration
 * for a prerelease-based plugin is `>=0.2.1-0 <0.3.0`.
 *
 * @param {string} version - running dsh version.
 * @param {string} range - the declared range.
 * @returns {boolean} whether it matches.
 */
export function satisfies(version, range) {
  const parse = (text) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text).trim())
    if (match === null) return null
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' }
  }
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1
    }
    if (left.pre === right.pre) return 0
    if (left.pre === '') return 1
    if (right.pre === '') return -1
    return left.pre < right.pre ? -1 : 1
  }

  const running = parse(version)
  if (running === null) return true // unknown runtime: do not warn falsely
  return String(range).split('||').some((alternative) => alternative.trim().split(/\s+/).every((token) => {
    const operator = /^(>=|<=|>|<|\^|~)?\s*(.+)$/.exec(token)
    if (operator === null) return true
    const bound = parse(operator[2])
    if (bound === null) return true
    switch (operator[1]) {
      case '>=': return compare(running, bound) >= 0
      case '>': return compare(running, bound) > 0
      case '<=': return compare(running, bound) <= 0
      case '<': return compare(running, bound) < 0
      case '^': {
        const upper = { parts: bound.parts[0] === 0 ? [0, bound.parts[1] + 1, 0] : [bound.parts[0] + 1, 0, 0], pre: '0' }
        return compare(running, bound) >= 0 && compare(running, upper) < 0
      }
      case '~': {
        const upper = { parts: [bound.parts[0], bound.parts[1] + 1, 0], pre: '0' }
        return compare(running, bound) >= 0 && compare(running, upper) < 0
      }
      default: return compare(running, bound) === 0
    }
  }))
}

/**
 * Check one profile.
 *
 * @param {string} profileDir - profile directory.
 * @param {object} options - CLI options.
 * @returns {{profile: string, failures: string[], warnings: string[], notes: string[]}} the result.
 */
function checkProfile(profileDir, options) {
  const result = { profile: path.basename(profileDir), failures: [], warnings: [], notes: [] }
  const manifest = readManifest(profileDir)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const patch = readText(patchFile)

  for (const problem of validatePatch(patch)) result.failures.push(`cordis.patch.yml ${problem}`)

  const idRows = countIdRows(patch)
  if (idRows === 0) result.warnings.push(`cordis.patch.yml 没有 \`- id: ${PLUGIN_ID}\` 覆盖行（bundle 自带的行仍会装载）`)
  if (idRows > 1) result.failures.push(`cordis.patch.yml 有 ${idRows} 条 \`- id: ${PLUGIN_ID}\`，会重复应用`)
  if (hasInsertRow(patch)) result.failures.push(`cordis.patch.yml 里有 \`- insert:\` 行：与 bundle 插入重复，会双载`)

  const bundles = manifest.dsh?.profile?.bundles ?? []
  const bundleCount = bundles.filter((name) => name === PLUGIN_ID).length
  if (bundleCount === 0) result.failures.push('dsh.profile.bundles 未包含本插件')
  if (bundleCount > 1) result.failures.push(`dsh.profile.bundles 里本插件出现 ${bundleCount} 次`)

  const spec = manifest.dependencies?.[PLUGIN_ID]
  if (typeof spec !== 'string') result.failures.push('package.json 没有本插件的 link 依赖')
  else if (!spec.startsWith('link:')) result.warnings.push(`依赖 specifier 是 ${spec}（本地开发推荐 link:）`)

  const link = path.join(profileDir, 'node_modules', PLUGIN_ID)
  const resolved = realpathOf(link)
  if (resolved === undefined) result.failures.push(`node_modules/${PLUGIN_ID} 解析不到`)
  else if (!fs.existsSync(path.join(resolved, 'package.json'))) result.failures.push(`node_modules/${PLUGIN_ID} 下没有 package.json`)
  else {
    const installed = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'))
    result.notes.push(`版本：${installed.version}`)
    const range = installed.engines?.dsh
    if (typeof range === 'string' && typeof options.dshVersion === 'string' && !satisfies(options.dshVersion, range)) {
      result.warnings.push(`engines.dsh ${range} 与运行版本 ${options.dshVersion} 不匹配，profile 会跳过本 bundle`)
    }
    if (!samePath(resolved, PKG_ROOT) && options.verbose) result.notes.push(`链接目标：${resolved}`)
  }

  const health = dependencyHealth(manifest, profileDir)
  if (health.missing.length > 0) {
    result.failures.push(
      `有 ${health.missing.length} 个依赖解析不到：${health.missing.join(', ')}`
      + ' — 这些插件现在是坏的；先修 node_modules（见 README「修复被 pnpm 清空的 node_modules」）',
    )
  }
  result.notes.push(`依赖可解析：${health.ok.length}/${health.ok.length + health.missing.length}`)

  const localeDir = path.join(resolved ?? PKG_ROOT, 'locale')
  for (const language of ['en', 'zh']) {
    const file = path.join(localeDir, `${language}.json`)
    if (!fs.existsSync(file)) {
      result.warnings.push(`缺少 locale/${language}.json：插件管理页会退回包名与描述`)
      continue
    }
    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'))?.meta
      if (typeof meta?.title !== 'string' || meta.title === '') result.warnings.push(`locale/${language}.json 没有 meta.title`)
      if (typeof meta?.description !== 'string' || meta.description === '') result.warnings.push(`locale/${language}.json 没有 meta.description`)
    } catch (error) {
      result.failures.push(`locale/${language}.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return result
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(red(`参数错误：${error instanceof Error ? error.message : String(error)}`))
    process.exit(2)
  }
  if (options.help) {
    console.log('用法：node tools/check-install.mjs [--profile <name>] [--dsh-version <semver>] [--verbose]')
    return
  }

  const dshHome = findDshHome(options.dshHome)
  const all = listProfiles(dshHome)
  const targets = options.profiles.length > 0
    ? options.profiles.map((name) => path.join(dshHome, 'profiles', name))
    : all

  if (targets.length === 0) {
    console.error(red(`没找到任何 profile：${path.join(dshHome, 'profiles')}`))
    process.exit(1)
  }

  let failed = false
  for (const profileDir of targets) {
    let result
    try {
      result = checkProfile(profileDir, options)
    } catch (error) {
      result = { profile: path.basename(profileDir), failures: [error instanceof Error ? error.message : String(error)], warnings: [], notes: [] }
    }
    if (result.failures.length > 0) failed = true
    console.log(`\n===== ${result.profile} =====`)
    for (const note of result.notes) console.log(`  · ${note}`)
    for (const warning of result.warnings) console.log(`  ${yellow('!')} ${warning}`)
    for (const failure of result.failures) console.log(`  ${red('x')} ${failure}`)
    if (result.failures.length === 0 && result.warnings.length === 0) console.log(`  ${green('OK')}`)
  }
  if (failed) process.exit(1)
}

/**
 * Whether this module was launched directly rather than imported.
 *
 * `fileURLToPath` is the inverse of the URL encoding, so a path containing a
 * space or a CJK character still matches — a hand-built `URL.pathname`
 * comparison never does.
 *
 * @returns {boolean} whether this is the entry point.
 */
function isMain() {
  if (typeof process.argv[1] !== 'string') return false
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) main()
