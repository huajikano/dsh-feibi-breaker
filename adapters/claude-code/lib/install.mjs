/**
 * 安装层：接管 `~/.claude/settings.json`，让 Claude Code Desktop 的流量走本代理。
 *
 * ## 接管点为什么是 settings.json
 *
 * Claude Code（含桌面版里跑的那份 CLI）在启动时把 `settings.json` 的 `env`
 * 合并进进程环境。`ANTHROPIC_BASE_URL` 就是 SDK 构造客户端时用的 baseURL，
 * 所以改这一个键，等于改掉所有模型的出口——不动二进制、不碰 asar、
 * 桌面版升级也不失效。
 *
 * 三件事必须做到，否则这个安装器就是个坑：
 *   1. **可逆**：接管前把原值记进 config.json，卸载时写回去；
 *   2. **可读**：原文件先备份成 `settings.json.feibi-backup.<时间>`，
 *      用户手改坏了能自己捞回来；
 *   3. **不静默失败**：JSON 解析不了就停下来说清楚，绝不半覆盖。
 *
 * @module feibi-breaker-cc/install
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { feibiPaths, loadConfig, saveConfig, writeAtomic, readJson } from './config.mjs'
import { seedPromptFile, resolvePrompt } from './prompt-store.mjs'

/** 本项目的根目录，用来写自启命令里的绝对路径。 */
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** CLAUDE.md 里那段注入的起止标记。 */
const MEMORY_BEGIN = '<!-- feibi-breaker-cc:begin -->'
const MEMORY_END = '<!-- feibi-breaker-cc:end -->'

/**
 * 读 Claude Code 的 settings.json。
 *
 * @param {string} file - 路径。
 * @returns {{ok: boolean, data?: object, error?: string}} 结果。
 */
export function readClaudeSettings(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, data: {} }
    return { ok: false, error: `读不了 ${file}：${error instanceof Error ? error.message : String(error)}` }
  }
  const cleaned = raw.replace(/^\uFEFF/, '')
  try {
    const data = JSON.parse(cleaned)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: `${file} 不是 JSON 对象，先手动看一下` }
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: `${file} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），没有改动它` }
  }
}

/**
 * 备份一个文件。已经备份过同内容的就不重复。
 *
 * @param {string} file - 文件。
 * @returns {string|null} 备份路径。
 */
function backupFile(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${file}.feibi-backup.${stamp}`
    fs.copyFileSync(file, target)
    return target
  } catch {
    return null
  }
}

/**
 * 写回 settings.json。
 *
 * @param {string} file - 路径。
 * @param {object} data - 内容。
 */
function writeClaudeSettings(file, data) {
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * 把 settings.json 的 baseURL 指向本代理。
 *
 * 认得出"已经是我们"的状态，重复执行不会把原值覆盖成自己的端口——
 * 那会让卸载时把 45721 写回去，用户就永远解不开了。
 *
 * @param {object} config - 配置（会被修改）。
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, changed: boolean, baseUrl?: string, backup?: string|null, error?: string}} 结果。
 */
export function pointSettingsAtProxy(config, home) {
  const paths = feibiPaths(home)
  const read = readClaudeSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, changed: false, error: read.error }

  const data = read.data
  const env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}
  const current = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : null
  const ours = `http://127.0.0.1:${config.port}`

  if (config.originalBaseUrl === null && current !== null && !current.includes(`127.0.0.1:${config.port}`)) {
    config.originalBaseUrl = current
  }
  if (config.originalBaseUrl === null) config.originalBaseUrl = current

  if (current === ours) {
    return { ok: true, changed: false, baseUrl: ours }
  }

  const backup = backupFile(paths.claudeSettings)
  env.ANTHROPIC_BASE_URL = ours
  data.env = env
  writeClaudeSettings(paths.claudeSettings, data)
  return { ok: true, changed: true, baseUrl: ours, backup }
}

/**
 * 把 baseURL 还原回接管前的样子。
 *
 * @param {object} config - 配置。
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, restored?: string|null, error?: string}} 结果。
 */
export function restoreSettings(config, home) {
  const paths = feibiPaths(home)
  const read = readClaudeSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, error: read.error }

  const data = read.data
  const env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}
  const current = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : null
  // 记下来的"原值"如果本身就是我们的地址，那它不是原值——是我们自己写进去的。
  // 这种情况还原成"删掉这个键"，绝不能把 45721 写回去：那个端口一旦没进程，
  // Claude Code 就整个连不上了。
  const recorded = typeof config.originalBaseUrl === 'string' ? config.originalBaseUrl : null
  const original = recorded !== null && !recorded.includes(`127.0.0.1:${config.port}`) ? recorded : null

  if (original !== null) {
    env.ANTHROPIC_BASE_URL = original
  } else {
    delete env.ANTHROPIC_BASE_URL
  }
  data.env = env
  writeClaudeSettings(paths.claudeSettings, data)
  return { ok: true, restored: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : null }
}

/**
 * 写 `feibi-cc` 命令垫片到 `~/.claude/bin`。
 *
 * 这个目录本来就在 PATH 上（claude.cmd 就在那儿），所以写完立刻能用，
 * 不用教用户改环境变量。
 *
 * **只写 .cmd，不写 .ps1**：PowerShell 在 PATH 里同时看到 `feibi-cc.ps1` 和
 * `feibi-cc.cmd` 时会优先选 .ps1，而这台机器上执行策略是禁运脚本的
 * （npm.ps1 也栽在同一个地方），写个 .ps1 等于把命令弄坏。
 *
 * @param {string} [home] - 家目录。
 * @returns {{written: string[], dir: string, onPath: boolean}} 结果。
 */
export function writeShim(home) {
  const paths = feibiPaths(home)
  const entry = path.join(PROJECT_ROOT, 'bin', 'feibi-cc.mjs')
  const written = []
  try {
    fs.mkdirSync(paths.claudeBin, { recursive: true })
    const cmd = `@echo off\r\nnode "${entry}" %*\r\n`
    fs.writeFileSync(path.join(paths.claudeBin, 'feibi-cc.cmd'), cmd, 'utf8')
    written.push(path.join(paths.claudeBin, 'feibi-cc.cmd'))
    // 旧版本留下的 .ps1 会抢优先级，顺手清掉。
    try { fs.unlinkSync(path.join(paths.claudeBin, 'feibi-cc.ps1')) } catch { /* 没有就算了 */ }
  } catch {
    // 写不进去也不致命：直接 node bin/feibi-cc.mjs 一样能用。
  }
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir.toLowerCase() === paths.claudeBin.toLowerCase())
  return { written, dir: paths.claudeBin, onPath }
}

/**
 * 装开机自启：Startup 里一个隐藏窗口的 vbs。
 *
 * 选它而不是计划任务，是因为它不需要管理员、删文件就卸载干净；
 * 窗口隐藏用 `Run(..., 0, False)`，不会每次开机弹一个黑框。
 *
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, file: string}} 结果。
 */
export function installAutostart(home) {
  const paths = feibiPaths(home)
  const entry = path.join(PROJECT_ROOT, 'bin', 'feibi-cc.mjs')
  const node = process.execPath
  const script = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${node}"" ""${entry}"" serve --supervise --quiet", 0, False`,
    '',
  ].join('\r\n')
  try {
    fs.mkdirSync(path.dirname(paths.autostart), { recursive: true })
    fs.writeFileSync(paths.autostart, script, 'utf8')
    return { ok: true, file: paths.autostart }
  } catch (error) {
    return { ok: false, file: paths.autostart, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 删开机自启。
 *
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean}} 结果。
 */
export function removeAutostart(home) {
  const paths = feibiPaths(home)
  try {
    fs.unlinkSync(paths.autostart)
    return { ok: true }
  } catch {
    return { ok: true }
  }
}

/**
 * 往 CLAUDE.md 里塞一段 payload（双保险）。
 *
 * 用标记包起来，重复执行只替换自己那一段，绝不会动用户原本的规则。
 *
 * @param {string} promptText - payload。
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, changed: boolean, error?: string}} 结果。
 */
export function injectMemory(promptText, home) {
  const paths = feibiPaths(home)
  const text = String(promptText ?? '').trim()
  if (text.length === 0) return { ok: false, changed: false, error: '提示词是空的' }
  let current = ''
  try {
    current = fs.readFileSync(paths.claudeMemory, 'utf8')
  } catch {
    current = ''
  }
  const block = `${MEMORY_BEGIN}\n${text}\n${MEMORY_END}\n`
  let next
  const begin = current.indexOf(MEMORY_BEGIN)
  const end = current.indexOf(MEMORY_END)
  if (begin >= 0 && end > begin) {
    next = `${current.slice(0, begin)}${block}${current.slice(end + MEMORY_END.length).replace(/^\r?\n/, '')}`
  } else {
    const trimmed = current.replace(/\s+$/, '')
    next = `${trimmed}${trimmed.length > 0 ? '\n\n' : ''}${block}`
  }
  if (next === current) return { ok: true, changed: false }
  try {
    if (current.length > 0 && !(begin >= 0 && end > begin)) backupFile(paths.claudeMemory)
    writeAtomic(paths.claudeMemory, next)
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, changed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 从 CLAUDE.md 里删掉自己那一段。
 *
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, changed: boolean}} 结果。
 */
export function removeMemory(home) {
  const paths = feibiPaths(home)
  let current
  try {
    current = fs.readFileSync(paths.claudeMemory, 'utf8')
  } catch {
    return { ok: true, changed: false }
  }
  const begin = current.indexOf(MEMORY_BEGIN)
  const end = current.indexOf(MEMORY_END)
  if (begin < 0 || end <= begin) return { ok: true, changed: false }
  const next = `${current.slice(0, begin)}${current.slice(end + MEMORY_END.length).replace(/^\r?\n/, '')}`.replace(/\n{3,}/g, '\n\n')
  try {
    writeAtomic(paths.claudeMemory, next)
    return { ok: true, changed: true }
  } catch {
    return { ok: true, changed: false }
  }
}

/**
 * 完整安装。
 *
 * @param {object} options - {port, upstream, autostart, memoryInject, forceUpstream}
 * @returns {object} 结果。
 */
export function install(options = {}) {
  const home = options.home
  const paths = feibiPaths(home)
  const config = loadConfig(home)

  if (Number(options.port) > 0) config.port = Number(options.port)
  if (typeof options.upstream === 'string' && options.upstream.length > 0) config.upstream = options.upstream
  if (typeof options.memoryInject === 'boolean') config.memoryInject = options.memoryInject

  fs.mkdirSync(paths.root, { recursive: true })
  const seeded = seedPromptFile(home)

  // 上游没指定就跟着当前 settings.json 走：用户装了别的接管工具也不会被改成死地址。
  if (typeof options.upstream !== 'string') {
    const read = readClaudeSettings(paths.claudeSettings)
    const current = read.ok ? read.data?.env?.ANTHROPIC_BASE_URL : null
    if (typeof current === 'string' && current.length > 0 && !current.includes(`127.0.0.1:${config.port}`)) {
      config.upstream = current
    }
  }

  // 重新接管时把巡检开回来（release 会把它关掉）
  config.watchSettings = true
  config.installedAt = config.installedAt ?? new Date().toISOString()
  const pointed = pointSettingsAtProxy(config, home)
  if (!pointed.ok) return { ok: false, error: pointed.error, home: paths.root }

  const saved = saveConfig(config, home)
  const shim = writeShim(home)

  let autostart = null
  if (options.autostart === true) autostart = installAutostart(home)

  let memory = null
  if (saved.memoryInject === true) {
    const resolved = resolvePrompt(home)
    memory = injectMemory(resolved.text, home)
  }

  // 状态条默认装：dsh 版那条输入框上方的状态条，在 Claude Code 里对应 statusLine。
  const statusline = options.statusline === false ? null : installStatusLine(home)

  return {
    ok: true,
    home: paths.root,
    configFile: paths.config,
    promptFile: paths.prompt,
    settings: paths.claudeSettings,
    port: saved.port,
    upstream: saved.upstream,
    baseUrl: pointed.baseUrl,
    settingsChanged: pointed.changed,
    settingsBackup: pointed.backup ?? null,
    promptSeeded: seeded.action,
    shim,
    autostart,
    memory,
    statusline,
  }
}

/**
 * 完整卸载：还原 baseURL、删自启、删垫片、删 CLAUDE.md 段。
 *
 * 不删 config.json 和 prompt.md —— 用户改过的提示词不该在卸载时凭空消失。
 *
 * @param {object} options - {home}
 * @returns {object} 结果。
 */
export function uninstall(options = {}) {
  const home = options.home
  const config = loadConfig(home)
  const restored = restoreSettings(config, home)
  removeAutostart(home)
  const memory = removeMemory(home)
  saveConfig({ ...config, originalBaseUrl: null }, home)
  removeStatusLine(home)
  return { ok: restored.ok, restored: restored.restored, memory, error: restored.error }
}

/**
 * 只把流量指过来 / 指回去，不碰别的。
 *
 * @param {boolean} on - true 指向代理，false 还原。
 * @param {object} options - {home}
 * @returns {object} 结果。
 */
export function toggle(on, options = {}) {
  const home = options.home
  const config = loadConfig(home)
  if (on) {
    config.watchSettings = true
    const pointed = pointSettingsAtProxy(config, home)
    saveConfig(config, home)
    return { ok: pointed.ok, baseUrl: pointed.baseUrl, error: pointed.error }
  }
  const restored = restoreSettings(config, home)
  return { ok: restored.ok, restored: restored.restored, error: restored.error }
}

/**
 * 装状态条：往 settings.json 写 `statusLine`。
 *
 * Claude Code 的 statusLine 是 `{type:"command", command, padding?}`：一条命令、
 * 一行输出，事件驱动重算。这就是 dsh 版输入框上方那条状态条的对应物。
 *
 * 已经是我们自己写的那份就不重复处理；别人写的（用户自己的状态条脚本）
 * 会被**备份后再替换**，卸载时按记录还原。
 *
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, changed: boolean, command?: string, error?: string}} 结果。
 */
export function installStatusLine(home) {
  const paths = feibiPaths(home)
  const read = readClaudeSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, changed: false, error: read.error }

  const entry = path.join(PROJECT_ROOT, 'bin', 'feibi-cc.mjs')
  const command = `node "${entry}" statusline`

  const data = read.data
  if (data.statusLine?.command === command) return { ok: true, changed: false, command }

  const backup = backupFile(paths.claudeSettings)
  data.statusLine = { type: 'command', command, padding: 0, refreshInterval: 10 }
  writeClaudeSettings(paths.claudeSettings, data)
  return { ok: true, changed: true, command, backup }
}

/**
 * 撤掉状态条（只撤我们自己那条）。
 *
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, changed: boolean}} 结果。
 */
export function removeStatusLine(home) {
  const paths = feibiPaths(home)
  const read = readClaudeSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, changed: false }
  const data = read.data
  if (data.statusLine?.command === undefined) return { ok: true, changed: false }
  if (!String(data.statusLine.command).includes('feibi-cc')) return { ok: true, changed: false }
  delete data.statusLine
  writeClaudeSettings(paths.claudeSettings, data)
  return { ok: true, changed: true }
}

/**
 * 读当前 settings.json 里的 baseURL，给 status 用。
 *
 * @param {string} [home] - 家目录。
 * @returns {string|null} baseURL。
 */
export function currentBaseUrl(home) {
  const paths = feibiPaths(home)
  const read = readClaudeSettings(paths.claudeSettings)
  if (!read.ok) return null
  const value = read.data?.env?.ANTHROPIC_BASE_URL
  return typeof value === 'string' ? value : null
}

/**
 * 把被第三方改掉的接管补回来。
 *
 * CC Switch 在切换 provider 时会整份重写 settings.json，`ANTHROPIC_BASE_URL`
 * 被写回它自己的端口 15721 —— 代理还在跑，但流量已经绕过去了。这种失败
 * 表面上一切正常（能聊天），只是判断永远不命中，最难查。
 *
 * 处理方式不只是"改回来"：被写进去的那个地址就是用户此刻真正想去的上游，
 * 所以先把它记成新的 upstream，再把入口指向自己。这样用户换 provider
 * 不需要重跑任何命令。
 *
 * @param {object} config - 配置（会被修改）。
 * @param {string} [home] - 家目录。
 * @returns {{changed: boolean, from?: string, upstream?: string, error?: string}} 结果。
 */
export function enforceTakeover(config, home) {
  const current = currentBaseUrl(home)
  if (typeof current !== 'string' || current.length === 0) return { changed: false }
  if (current.includes(`127.0.0.1:${config.port}`)) return { changed: false }

  const next = { ...config }
  /**
   * 只在**链路模式**（上游是别人的中转）下跟随漂移。
   *
   * 直连模式下上游是刻意钉死的：CC Switch 一类工具切 provider 时会把这个文件
   * 改成它自己的端口，跟着改 upstream 会把"直连 DeepSeek"变成"绕回一个已经
   * 挂掉的中转"。真机踩过：所有请求 502，而上游显示成一个莫名其妙的本地端口。
   */
  const chained = config.direct === undefined || config.direct === null
  if (chained && /^https?:\/\//i.test(current)) next.upstream = current
  const pointed = pointSettingsAtProxy(next, home)
  if (!pointed.ok) return { changed: false, error: pointed.error }
  saveConfig(next, home)
  return { changed: pointed.changed, from: current, upstream: next.upstream }
}

/**
 * 直连模式的 env 守护。
 *
 * CC Switch 会把 settings.json 整份重写：不只是 baseURL，连 `ANTHROPIC_API_KEY`
 * 和 `ANTHROPIC_MODEL` 都会被抹掉（换回它自己的 `ANTHROPIC_AUTH_TOKEN`）。
 * 只守 baseURL 是不够的——真机表现是：地址还是我们，但上游一直 401。
 *
 * @param {object} config - 配置。
 * @param {string} [home] - 家目录。
 * @returns {{changed: boolean, error?: string}} 结果。
 */
export function enforceDirectEnv(config, home) {
  const direct = config.direct
  if (direct === undefined || direct === null) return { changed: false }
  const paths = feibiPaths(home)
  const read = readClaudeSettings(paths.claudeSettings)
  if (!read.ok) return { changed: false, error: read.error }

  const data = read.data
  data.env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}
  const want = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    ANTHROPIC_API_KEY: typeof direct.key === 'string' ? direct.key : undefined,
    ANTHROPIC_MODEL: typeof direct.model === 'string' ? direct.model : undefined,
  }

  let changed = false
  for (const [key, value] of Object.entries(want)) {
    if (value === undefined) continue
    if (data.env[key] !== value) {
      data.env[key] = value
      changed = true
    }
  }
  // AUTH_TOKEN 与 API_KEY 同时存在时 SDK 走 Bearer，第三方端点常在 Bearer 上 401。
  if (data.env.ANTHROPIC_AUTH_TOKEN !== undefined && typeof direct.key === 'string') {
    delete data.env.ANTHROPIC_AUTH_TOKEN
    changed = true
  }

  if (!changed) return { changed: false }
  writeClaudeSettings(paths.claudeSettings, data)
  return { changed: true }
}

export { PROJECT_ROOT, MEMORY_BEGIN, MEMORY_END }
