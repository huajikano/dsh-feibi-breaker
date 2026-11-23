/**
 * feibi-breaker installer for DeepSeek-Harness 0.2.x.
 *
 * What it does, in order, per profile:
 *
 *   1. read `package.json` and `cordis.patch.yml` and **validate them before
 *      writing anything** — a broken profile patch stops every plugin from
 *      mounting, so a half-checked write is worse than no install;
 *   2. copy this package to `$DSH_HOME/plugins/feibi-breaker`;
 *   3. back up the profile into `$DSH_HOME/backups/feibi-breaker/<stamp>/`;
 *   4. add one `link:` dependency and one `dsh.profile.bundles` entry;
 *   5. make sure the profile patch carries at most one `- id: feibi-breaker`
 *      override and no `- insert:` row (the bundle inserts the entry);
 *   6. create `node_modules/feibi-breaker` as a junction;
 *   7. report which of the profile's dependencies still resolve — the check the
 *      1.1.x installer never made.
 *
 * What it never does: patch the host, run a package manager, delete a
 * directory, or touch another plugin's row.
 *
 * @module feibi-breaker/scripts/install
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_ID, PLUGIN_LABEL, REASON_LABEL,
  backupProfile, copyPlugin, countIdRows, dependencyHealth, ensureJunction,
  findDshHome, formatManifest, linkSpec, listProfiles, planManifest, planPatch,
  readManifest, readText, resolveTargetProfiles, validatePatch, writeTextAtomic,
} from './lib/profile.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const cyan = (text) => `\u001b[36m${text}\u001b[0m`
const green = (text) => `\u001b[32m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`

/** Parse `--flag value` and `--flag` pairs. */
function parseArgs(argv) {
  const options = { profiles: [], all: false, dryRun: false, copy: true, dshHome: undefined, pluginsDir: undefined }
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
      case '--no-copy': options.copy = false; break
      case '--dsh-home': options.dshHome = value(); break
      case '--plugins-dir': options.pluginsDir = value(); break
      case '--help': case '-h': options.help = true; break
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** Print the help text. */
function usage() {
  console.log(`用法 / usage:
  node scripts/install.mjs --profile <name> [--dry-run]
  node scripts/install.mjs --all [--dry-run]

选项 / options:
  --profile <name>   只安装到指定 profile（可重复）
  --all              安装到所有活动 profile
  --dry-run          只打印将要做的改动，不落盘
  --no-copy          跳过复制插件目录（已经在 $DSH_HOME/plugins/${PLUGIN_ID} 时用）
  --plugins-dir <p>  插件安装目录，默认 $DSH_HOME/plugins/${PLUGIN_ID}
  --dsh-home <p>     DSH home，默认 $DSH_HOME 或 ~/.dsh

不传 --profile / --all 时按顺序自动选择，从不提问：
  $DSH_PROFILE（当前运行的 profile）→ 唯一的 profile → 所有活动 profile。
  快照目录（desktop-backup-*、node_modules.stale-* 等）始终排除。`)
}

/**
 * Install into one profile.
 *
 * @param {string} profileDir - profile directory.
 * @param {object} context - resolved options.
 * @returns {object} a report row.
 */
function installProfile(profileDir, context) {
  const name = path.basename(profileDir)
  const report = { profile: name, ok: false, changes: [], warnings: [], errors: [] }

  const manifest = readManifest(profileDir)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const patchBefore = readText(patchFile)

  const problems = validatePatch(patchBefore)
  if (problems.length > 0) {
    report.errors.push(...problems.map((problem) => `cordis.patch.yml ${problem}`))
    return report
  }

  const plannedManifest = planManifest(manifest, context.pluginsDir)
  const plannedPatch = planPatch(patchBefore)
  report.changes.push(...plannedManifest.changes, ...plannedPatch.changes)

  // The bundle list is the load path; a profile-level `- insert:` would mount
  // the plugin a second time. Refuse rather than guess.
  if (plannedPatch.changes.some((change) => change.includes('duplicate'))) {
    report.warnings.push('profile patch carried duplicate rows; only the first one is kept')
  }

  if (context.dryRun) {
    report.ok = true
    report.diff = {
      'package.json': formatManifest(plannedManifest.manifest, readText(path.join(profileDir, 'package.json'))),
      'cordis.patch.yml': plannedPatch.text,
    }
    return report
  }

  if (context.copy) {
    const copied = copyPlugin(PKG_ROOT, context.pluginsDir, { dryRun: false })
    if (copied.action === 'linked') report.warnings.push(`${context.pluginsDir} 是指向源码的链接，已跳过复制`)
  }

  const backup = backupProfile(context.dshHome, profileDir, ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'])
  if (backup !== null) report.backup = backup

  if (plannedManifest.changes.length > 0) {
    const manifestPath = path.join(profileDir, 'package.json')
    writeTextAtomic(manifestPath, formatManifest(plannedManifest.manifest, readText(manifestPath)))
  }

  if (plannedPatch.text !== patchBefore) {
    const after = validatePatch(plannedPatch.text)
    if (after.length > 0) {
      report.errors.push(...after.map((problem) => `拒绝写入，生成的 cordis.patch.yml ${problem}`))
      return report
    }
    writeTextAtomic(patchFile, plannedPatch.text)
  }

  const junction = ensureJunction(profileDir, context.pluginsDir)
  report.junction = junction.action

  // --- verify ---------------------------------------------------------------
  const after = readManifest(profileDir)
  if (after.dependencies?.[PLUGIN_ID] !== linkSpec(context.pluginsDir)) {
    report.errors.push(`package.json 依赖未生效：期望 ${linkSpec(context.pluginsDir)}`)
  }
  if (!Array.isArray(after.dsh?.profile?.bundles) || !after.dsh.profile.bundles.includes(PLUGIN_ID)) {
    report.errors.push('dsh.profile.bundles 未包含本插件，重启后不会装载')
  }
  const idRows = countIdRows(readText(patchFile))
  if (idRows > 1) report.errors.push(`cordis.patch.yml 仍有 ${idRows} 条同名行`)
  if (!fs.existsSync(path.join(profileDir, 'node_modules', PLUGIN_ID, 'package.json'))) {
    report.errors.push(`node_modules/${PLUGIN_ID} 解析不到 package.json`)
  }

  const health = dependencyHealth(after, profileDir)
  report.dependencies = health
  if (health.missing.length > 0) {
    report.warnings.push(
      `有 ${health.missing.length} 个依赖解析不到：${health.missing.join(', ')} — 这些插件现在是坏的。`
      + ' 本安装器不会替你跑 pnpm（那正是把它们弄没的原因）；先修复 node_modules 再重装。',
    )
  }

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
  const pluginsDir = options.pluginsDir ?? path.join(dshHome, 'plugins', PLUGIN_ID)

  if (listProfiles(dshHome).length === 0) {
    console.error(red(`没找到任何 profile：${path.join(dshHome, 'profiles')}`))
    console.error('请先安装并启动过一次 DeepSeek-Harness。')
    process.exit(1)
  }

  // Never prompt: a one-click launcher that asks which profile is not one click.
  const { targets, reason } = resolveTargetProfiles(dshHome, { profiles: options.profiles, all: options.all })

  console.log(cyan(`\n==== ${PLUGIN_LABEL} 安装（DSH 0.2.x） ====`))
  console.log(`插件目录：${pluginsDir}`)
  console.log(`目标 profile：${targets.map((dir) => path.basename(dir)).join(', ')}${options.dryRun ? yellow('  [演练模式]') : ''}`)
  console.log(`选择方式：${REASON_LABEL[reason]}`)
  if (targets.length > 1) console.log(yellow('  多个 profile 都会被写入；每个都只改本插件自己的一行，可重复执行。'))

  const context = { dshHome, pluginsDir, dryRun: options.dryRun, copy: options.copy }
  const reports = []
  let failed = false

  for (const profileDir of targets) {
    let report
    try {
      report = installProfile(profileDir, context)
    } catch (error) {
      report = { profile: path.basename(profileDir), ok: false, changes: [], warnings: [], errors: [error instanceof Error ? error.message : String(error)] }
    }
    reports.push(report)
    if (!report.ok) failed = true

    console.log(`\n--- ${report.profile} ---`)
    if (report.backup !== undefined) console.log(`备份：${report.backup}`)
    for (const change of report.changes) console.log(`  ${green('+')} ${change}`)
    for (const warning of report.warnings) console.log(`  ${yellow('!')} ${warning}`)
    for (const error of report.errors) console.log(`  ${red('x')} ${error}`)
    if (report.changes.length === 0 && report.errors.length === 0) console.log(`  ${green('已是最新，无需改动')}`)
    if (report.junction !== undefined) console.log(`  node_modules 链接：${report.junction}`)
    if (report.diff !== undefined) {
      for (const [file, text] of Object.entries(report.diff)) {
        console.log(`\n  --- ${file} (预览) ---`)
        console.log(text.split('\n').map((line) => `  | ${line}`).join('\n'))
      }
    }
  }

  console.log('')
  if (options.dryRun) {
    console.log(yellow('演练结束，没有改动任何文件。去掉 --dry-run 再跑一次才会真正安装。'))
    return
  }
  if (failed) {
    console.log(red('安装未完全成功，见上面的错误。'))
    process.exit(1)
  }
  console.log(green(`${PLUGIN_LABEL} 已安装。`))
  console.log('下一步：完全退出并重启 DeepSeek-Harness（桌面版重新打开 / Web 版刷新页面）。')
  console.log(`验收：node tools/check-install.mjs --profile ${reports[0]?.profile ?? '<name>'}`)
}

main()
