/**
 * 状态条：Claude Code 输入框下面那一行。
 *
 * dsh 版在输入框上方挂一条状态条（激活状态、命中域、最近一次判定）。Claude Code
 * 有一个对应的东西：`settings.json` 的 `statusLine` —— 一条命令、一行输出，
 * 事件驱动重算，也可以按 `refreshInterval` 定时重算。
 *
 * 这一行的原则是**一眼能判断"现在到底通没通"**，所以只放四件事：
 *   1. 接管状态（settings 指向代理 + 代理进程活着）
 *   2. 关键开关（双段 / 改身份 / 判定）
 *   3. 计数（注入 / 判定 / 拦）
 *   4. 最近一次判定
 *
 * 不读网络、不起子进程，只读几个小 JSON —— 它会被频繁重算，不能慢。
 *
 * @module feibi-breaker-cc/statusline
 */

import fs from 'node:fs'
import { feibiPaths, loadConfig, loadState, readJson } from './config.mjs'
import { readEvents } from './stats.mjs'

/** 一行最多这么宽，超了截断。状态条被折行会很难看。 */
const MAX_WIDTH = 150

/**
 * 代理进程是否活着（pid 文件 + kill(0)）。
 *
 * @param {string} pidFile - pid 文件路径。
 * @returns {boolean} 是否活着。
 */
function proxyAlive(pidFile) {
  try {
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim())
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 组装状态条文本。
 *
 * @param {{home?: string}} [options] - 家目录。
 * @returns {string} 单行文本。
 */
export function statusLine(options = {}) {
  const home = options.home
  const paths = feibiPaths(home)
  const config = loadConfig(home)
  const state = loadState(home)
  const settings = readJson(paths.claudeSettings) ?? {}
  const baseUrl = settings?.env?.ANTHROPIC_BASE_URL ?? ''
  const plugin = readJson(fs.existsSync(paths.root) ? `${paths.root}/plugin-state.json` : '') ?? {}
  const events = readEvents(1, home)
  const last = events[0]

  const takeover = typeof baseUrl === 'string' && baseUrl.includes(`127.0.0.1:${config.port}`)
  const alive = proxyAlive(paths.pid)

  // "接管了"和"真的有流量进来"是两件事。桌面版会绕过 settings.json 里的 env，
  // 这时接管成立、进程活着、可是代理一条请求都收不到。状态条必须把这个区分开，
  // 否则用户看到绿灯却在用一个没接上的管道。
  const lastSeen = Date.parse(String(state.lastEventAt ?? ''))
  const live = Number.isFinite(lastSeen) && Date.now() - lastSeen < 15 * 60 * 1000

  const dot = takeover && alive ? '●' : '○'
  const flags = [
    config.dualLayer !== false ? '双段' : '单段',
    config.rewriteIdentity !== false ? '改锚' : '原锚',
    config.guard !== false ? '判定' : '只注',
  ].join('/')

  const counts = `注入 ${state.injected ?? 0} · 判定 ${state.judged ?? 0} · 拦 ${state.blocked ?? 0}`
  const pluginPart = (plugin?.total?.blocked ?? 0) > 0 ? ` · 插件拦回 ${plugin.total.blocked}` : ''

  const verdict = last === undefined
    ? '最近 —'
    : `最近 ${last.kind === 'judge' ? (last.blocked === true ? '拦截' : '放行') : (last.kind === 'identity' ? '改身份' : last.kind)}`

  const line = `菲比 ${dot} ${flags} · ${counts}${pluginPart} · ${verdict} · 严 ${config.strictness ?? 'standard'}`

  if (!takeover) {
    return `${line} · 未接管（feibi-cc on）`.slice(0, MAX_WIDTH)
  }
  if (!alive) {
    return `${line} · 代理没跑（feibi-cc start）`.slice(0, MAX_WIDTH)
  }
  if (!live) {
    return `${line} · 代理没收到流量（桌面版绕过 env，改用插件注入）`.slice(0, MAX_WIDTH)
  }
  return line.slice(0, MAX_WIDTH)
}
