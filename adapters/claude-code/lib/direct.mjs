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

  // 桌面版/CC Switch 发来的是 claude-sonnet-5 这类名字，上游不认；
  // 直连时顺手把强制模型名设上，别指望调用方配合。
  config.forceModel = options.model
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
/** 合法的上游地址。 */
function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

/**
 * 旁路：把 settings.json 直接指到上游，让客户端在**代理没跑**时也能用。
 *
 * 为什么要它：接管是把 `ANTHROPIC_BASE_URL` 钉在 127.0.0.1:<port> 上。代理一停，
 * 那个端口就没人应，客户端所有请求当场断——用户看到的是"关了代理，整套都不能用了"。
 * 旁路把同一个字段改回上游地址，链路就绕开本机进程。
 *
 * 目标顺序：显式传入 > `config.bypass` > `config.direct` > `config.upstream`。
 *
 * @param {string} [home] - 家目录。
 * @param {{upstream?: string, key?: string, model?: string, persist?: boolean}} [options] - 覆盖项。
 * @returns {{ok: boolean, upstream?: string, model?: string, error?: string}} 结果。
 */
export function enableBypass(home, options = {}) {
  const paths = feibiPaths(home)
  const config = loadConfig(home)
  const read = readSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, error: `settings.json 读不了：${read.error}` }

  const saved = config.bypass !== null && typeof config.bypass === 'object' ? config.bypass : {}
  const direct = config.direct !== null && typeof config.direct === 'object' ? config.direct : {}

  const upstream = options.upstream ?? saved.upstream ?? direct.upstream ?? config.upstream
  if (!isHttpUrl(upstream)) {
    return { ok: false, error: `没有可用的旁路上游（当前是 ${String(upstream)}），先 feibi-cc bypass --upstream https://… --key … --model …` }
  }
  const key = options.key ?? saved.key ?? direct.key ?? null
  const model = options.model ?? saved.model ?? direct.model ?? null

  const data = read.data
  data.env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}
  data.env.ANTHROPIC_BASE_URL = upstream
  if (typeof key === 'string' && key.length > 0) {
    data.env.ANTHROPIC_API_KEY = key
    // 只认 x-api-key 的端点遇到 AUTH_TOKEN 会走 Bearer，先摘掉。
    delete data.env.ANTHROPIC_AUTH_TOKEN
  }
  if (typeof model === 'string' && model.length > 0) {
    data.env.ANTHROPIC_MODEL = model
    /**
     * 同时写三档别名：客户端（尤其桌面版）常常不读 ANTHROPIC_MODEL，
     * 而是按 Sonnet/Opus/Haiku 三档去取模型名。不写这三项的话，
     * 关掉代理直连上游时客户端还会发 claude-sonnet-5 —— 上游分组没有这个名字，
     * 直接 404 model_not_found，看起来就是"一关代理就断"。
     */
    data.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    data.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    data.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
  }
  writeAtomic(paths.claudeSettings, `${JSON.stringify(data, null, 2)}\n`)

  if (options.persist !== false && (options.upstream || options.key || options.model)) {
    config.bypass = { upstream, key: key ?? null, model: model ?? null }
    saveConfig(config, home)
  }

  return { ok: true, upstream, model, keyed: typeof key === 'string' && key.length > 0 }
}

/**
 * 撤掉旁路：把入口改回本代理。
 *
 * @param {string} [home] - 家目录。
 * @returns {{ok: boolean, baseUrl?: string, error?: string}} 结果。
 */
export function disableBypass(home) {
  const paths = feibiPaths(home)
  const config = loadConfig(home)
  const read = readSettings(paths.claudeSettings)
  if (!read.ok) return { ok: false, error: `settings.json 读不了：${read.error}` }

  const data = read.data
  data.env = data.env !== null && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {}
  const ours = `http://127.0.0.1:${config.port}`
  data.env.ANTHROPIC_BASE_URL = ours
  writeAtomic(paths.claudeSettings, `${JSON.stringify(data, null, 2)}\n`)
  return { ok: true, baseUrl: ours }
}

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
