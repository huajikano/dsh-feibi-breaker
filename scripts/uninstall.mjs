/**
 * feibi-breaker uninstaller.
 *
 * Removes exactly three things and nothing else:
 *
 *   - this plugin's `link:` dependency and `dsh.profile.bundles` entry;
 *   - this plugin's own `- id: feibi-breaker` row in the profile patch;
 *   - the `node_modules/feibi-breaker` junction.
 *
 * The plugin directory is **moved** into `$DSH_HOME/backups/feibi-breaker/`,
 * never deleted: a plugin directory is often a junction back to a checkout, and
 * `Remove-Item -Recurse` on a reparse point has deleted users' source trees
 * before. Another plugin's row, another plugin's link and the lockfile are left
 * untouched.
 *
 * @module feibi-breaker/scripts/uninstall
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  PLUGIN_ID, PLUGIN_LABEL, REASON_LABEL,
  backupProfile, findDshHome, formatManifest, lstatOf, readManifest, readText,
  realpathOf, resolveTargetProfiles, stamp, stripRows, validatePatch, writeTextAtomic,
} from './lib/profile.js'

const green = (text) => `\u001b[32m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`

/** Parse `--flag value` and `--flag` pairs. */
function parseArgs(argv) {
  const options = { profiles: [], all: false, dryRun: false, dshHome: undefined, keepPluginDir: false }
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
      case '--all': options.all = true; break
      case '--dry-run': case '-DryRun': options.dryRun = true; break
      case '--dsh-home': options.dshHome = value(); break
      case '--keep-plugin-dir': options.keepPluginDir = true; break
      case '--help': case '-h': options.help = true; break
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** Print the help text. */
function usage() {
  console.log(`用法 / usage:
  node scripts/uninstall.mjs --profile <name> [--dry-run]
  node scripts/uninstall.mjs --all [--dry-run]

选项 / options:
  --profile <name>    只从指定 profile 卸载（可重复）
  --all               从所有活动 profile 卸载
  --dry-run           只打印将要做的改动
  --keep-plugin-dir   保留 $DSH_HOME/plugins/${PLUGIN_ID}
  --dsh-home <p>      DSH home，默认 $DSH_HOME 或 ~/.dsh

不传 --profile / --all 时按顺序自动选择，从不提问：
  $DSH_PROFILE（当前运行的 profile）→ 唯一的 profile → 所有活动 profile。`)
}

/**
 * Uninstall from one profile.
 *
 * @param {string} profileDir - profile directory.
 * @param {object} context - resolved options.
 * @returns {object} a report row.
 */
function uninstallProfile(profileDir, context) {
  const report = { profile: path.basename(profileDir), ok: false, changes: [], warnings: [], errors: [] }
  const manifest = readManifest(profileDir)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const patchBefore = readText(patchFile)

  const nextManifest = structuredClone(manifest)
  if (nextManifest.dependencies?.[PLUGIN_ID] !== undefined) {
    delete nextManifest.dependencies[PLUGIN_ID]
    report.changes.push(`dependencies.${PLUGIN_ID} 已移除`)
  }
  if (Array.isArray(nextManifest.dsh?.profile?.bundles) && nextManifest.dsh.profile.bundles.includes(PLUGIN_ID)) {
    nextManifest.dsh.profile.bundles = nextManifest.dsh.profile.bundles.filter((name) => name !== PLUGIN_ID)
    report.changes.push(`dsh.profile.bundles 已移除 ${PLUGIN_ID}`)
  }

  const nextPatch = stripRows(patchBefore, [PLUGIN_ID])
  if (nextPatch !== patchBefore) report.changes.push(`cordis.patch.yml 已移除本插件的行为`)
  const problems = validatePatch(nextPatch)
  if (problems.length > 0) {
    report.errors.push(...problems.map((problem) => `卸载后会写坏 cordis.patch.yml：${problem}`))
    return report
  }

  const link = path.join(profileDir, 'node_modules', PLUGIN_ID)
  if (lstatOf(link) !== undefined) report.changes.push(`node_modules/${PLUGIN_ID} 链接已移除`)

  if (context.dryRun) {
    report.ok = true
    return report
  }

  const backup = backupProfile(context.dshHome, profileDir, ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'])
  if (backup !== null) report.backup = backup

  if (nextPatch !== patchBefore) writeTextAtomic(patchFile, nextPatch)
  if (JSON.stringify(nextManifest) !== JSON.stringify(manifest)) {
    const manifestPath = path.join(profileDir, 'package.json')
    writeTextAtomic(manifestPath, formatManifest(nextManifest, readText(manifestPath)))
  }
  if (lstatOf(link) !== undefined) fs.rmSync(link, { force: true, recursive: false })

  report.ok = report.errors.length === 0
  return report
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(red(`参数错误：${error instanceof Error ? error.message : String(error)}`))
    usage()
    process.exit(2)
  }
  if (options.help) {
    usage()
    return
  }

  const dshHome = findDshHome(options.dshHome)
  const pluginsDir = path.join(dshHome, 'plugins', PLUGIN_ID)

  // Same zero-input rule as the installer: `--profile` wins, otherwise the
  // running profile, otherwise every live profile. Uninstalling only removes
  // this plugin's own row/dependency/link, so applying it everywhere is safe.
  const { targets, reason } = resolveTargetProfiles(dshHome, { profiles: options.profiles, all: options.all })

  console.log(`\n==== ${PLUGIN_LABEL} 卸载 ====`)
  console.log(`目标 profile：${targets.map((dir) => path.basename(dir)).join(', ') || '（无）'}`)
  console.log(`选择方式：${REASON_LABEL[reason]}`)
  const context = { dshHome, dryRun: options.dryRun }
  let failed = false
  for (const profileDir of targets) {
    let report
    try {
      report = uninstallProfile(profileDir, context)
    } catch (error) {
      report = { profile: path.basename(profileDir), ok: false, changes: [], warnings: [], errors: [error instanceof Error ? error.message : String(error)] }
    }
    if (!report.ok) failed = true
    console.log(`\n--- ${report.profile} ---`)
    for (const change of report.changes) console.log(`  ${green('-')} ${change}`)
    for (const error of report.errors) console.log(`  ${red('x')} ${error}`)
    if (report.changes.length === 0 && report.errors.length === 0) console.log('  未安装，无需改动')
  }

  if (options.dryRun) {
    console.log(yellow('\n演练结束，没有改动任何文件。'))
    return
  }

  // The plugin directory is moved, not deleted: it may be a junction back to a
  // checkout, and recursively deleting a reparse point has eaten source trees.
  if (!options.keepPluginDir && fs.existsSync(pluginsDir)) {
    const real = realpathOf(pluginsDir)
    const stat = lstatOf(pluginsDir)
    const root = path.join(dshHome, 'backups', PLUGIN_ID)
    fs.mkdirSync(root, { recursive: true })
    const aside = path.join(root, `removed-${stamp()}`)
    try {
      fs.renameSync(pluginsDir, aside)
      console.log(`\n插件目录已移动到：${aside}`)
    } catch (error) {
      console.log(`\n${yellow('插件目录未能移动（可能被占用）：')}${error instanceof Error ? error.message : String(error)}`)
      console.log(`  真实路径：${real ?? pluginsDir}${stat?.isSymbolicLink() === true ? '（链接，未删除目标）' : ''}`)
    }
  }

  console.log(failed ? red('\n卸载未完全成功，见上面的错误。') : green('\n已卸载。完全退出并重启 DeepSeek-Harness 生效。'))
  if (failed) process.exit(1)
}

main()
