/**
 * 直连模式：绕开中间那层代理，把 model 调用直接打到一个 Anthropic 兼容端点上。
 *
 * ## 为什么需要它
 *
 * 桌面版的常见链路是 `Claude Code → CC Switch → 供应商`。CC Switch 同时管着
 * 提示词、MCP、skill 和 settings.json，是这一整套的"配置主人"。问题在于：
 * **它选中的 provider 一旦挂掉，链路上游就整段不通**，而这时你从外面看不出是
 * 谁的错——两边都只是"502 上游连接被拒绝"。
 *
 * 所以这里给一条可验证的旁路：代理的上游直接指向一个确定能用的端点，
 * 需要的几个 env 一起改掉（baseURL、密钥、默认模型），全部记进 config.json，
 * 一条命令就能还原。
 *
 * ## 为什么要改 env 里的模型名
 *
 * 直连之后已经没有 CC Switch 那层映射了：它原本负责把 `claude-sonnet-5` 翻成
 * `cn:deepseek-v4.1-flash`。旁路必须自己给出端点认得的模型名，否则请求 400。
 *
 * @module feibi-breaker-cc/direct
 */

import fs from 'node:fs'
import { feibiPaths, loadConfig, saveConfig, writeAtomic } from './config.mjs'

/** 要接管的 env 键。直连撤销时只还原这些，别的一概不碰。 */
const MANAGED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
]

/**
 * 读 settings.json。
 *
 * @param {string} file - 路径。
 * @returns {{ok: boolean, data?: object, error?: string}} 结果。
 */
function readSettings(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '不是 JSON 对象' }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 切到直连。
 *
 * @param {{home?: string, upstream: string, key: string, model: string, port?: number}} options - 目标端点与凭据。
 * @returns {object} 结果。
 */
export function enableDirect(options) {
  const home = options.home
  const paths = feibiPaths(home)
  const config = loadConfig(home)

  if (typeof options.upstream !== 'string' || !/^https?:\/\//i.test(options.upstream)) {
    return { ok: false, error: 'upstream 必须是 http(s) 地址' }
  }
  if (typeof options.key !== 'string' || options.key.length < 8) {
    return { ok: false, error: '需要一份能用的 API key' }
  }
  if (typeof options.model !== 'string' || options.model.length === 0) {
    return { ok: false, error: '需要端点认得的模型名，例如 deepseek-chat' }
  }

  const read = readSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, error: `settings.json 读不了：${read.error}` }

  const data = read.data
  data.env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}

  // 第一次进直连才记备份；反复执行不能把备份覆盖成"已经改过的样子"。
  if (config.directBackup === undefined || config.directBackup === null) {
    const snapshot = {}
    for (const name of MANAGED_ENV) {
      snapshot[name] = typeof data.env[name] === 'string' ? data.env[name] : null
    }
    config.directBackup = snapshot
  }

  const port = Number(options.port) > 0 ? Number(options.port) : config.port
  data.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  data.env.ANTHROPIC_API_KEY = options.key
  // AUTH_TOKEN 和 API_KEY 同时存在时 SDK 用 Authorization，很多第三方端点只认 x-api-key。
  delete data.env.ANTHROPIC_AUTH_TOKEN
  data.env.ANTHROPIC_MODEL = options.model

  const backup = (() => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = `${paths.claudeSettings}.direct-backup.${stamp}`
      fs.copyFileSync(paths.claudeSettings, target)
      return target
    } catch {
      return null
    }
  })()

  writeAtomic(paths.claudeSettings, `${JSON.stringify(data, null, 2)}\n`)

  config.upstream = options.upstream
  config.port = port
  // key 也要记：CC Switch 之类会把 settings.json 里的 API_KEY 抹掉，
  // 巡检要用它把 env 还原（见 install.mjs 的 enforceDirectEnv）。
  config.direct = { upstream: options.upstream, model: options.model, key: options.key, enabledAt: new Date().toISOString() }
  saveConfig(config, home)

  return { ok: true, port, upstream: options.upstream, model: options.model, backup, settings: paths.claudeSettings }
}

/**
 * 撤掉直连，env 还原成进直连之前的样子。
 *
 * @param {{home?: string}} [options] - 家目录。
 * @returns {object} 结果。
 */
export function disableDirect(options = {}) {
  const home = options.home
  const paths = feibiPaths(home)
  const config = loadConfig(home)
  const snapshot = config.directBackup
  if (snapshot === undefined || snapshot === null) return { ok: false, error: '没有直连记录，本来就不是直连模式' }

  const read = readSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, error: `settings.json 读不了：${read.error}` }
  const data = read.data
  data.env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}

  for (const name of MANAGED_ENV) {
    const value = snapshot[name]
    if (typeof value === 'string' && value.length > 0) data.env[name] = value
    else delete data.env[name]
  }

  writeAtomic(paths.claudeSettings, `${JSON.stringify(data, null, 2)}\n`)

  config.upstream = typeof snapshot.ANTHROPIC_BASE_URL === 'string' ? snapshot.ANTHROPIC_BASE_URL : config.upstream
  delete config.direct
  delete config.directBackup
  saveConfig(config, home)

  return { ok: true, restored: data.env.ANTHROPIC_BASE_URL ?? null, upstream: config.upstream }
}
