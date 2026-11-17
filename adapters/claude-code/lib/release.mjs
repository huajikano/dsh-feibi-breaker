/**
 * 交还控制权。
 *
 * ## 为什么需要这个命令
 *
 * "关掉破限插件"和"关掉代理"是两件事：插件是 hook（不启用就不跑），
 * 但代理是**开机自启的独立进程**，而且带巡检——它每 3 秒确认 settings.json 的
 * ANTHROPIC_BASE_URL 指向自己，被别的工具改回去就再改回来。
 *
 * 于是用户切到别的供应商（CC Switch 写自己的地址）之后，会看到
 * "Claude 的地址和 CC Switch 的地址不一样"——因为我们在跟他抢同一个字段。
 *
 * 这个命令把抢过来的东西全部还回去：停进程、去自启、还原 env、关掉巡检。
 *
 * @module feibi-breaker-cc/release
 */

import fs from 'node:fs'
import { feibiPaths, loadConfig, saveConfig, readJson } from './config.mjs'

/** 本插件自己写进去的 env 键，交还时全删。 */
const OWN_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

/**
 * 把 settings.json 还原成"别的工具说了算"的状态。
 *
 * @param {{home?: string, targetBaseUrl?: string}} [options] - 目标地址。
 * @returns {{ok: boolean, baseUrl?: string|null, removed?: string[], error?: string}} 结果。
 */
export function releaseSettings(options = {}) {
  const home = options.home
  const paths = feibiPaths(home)
  const config = loadConfig(home)
  const settings = readJson(paths.claudeSettings)
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, error: 'settings.json 读不了或不是 JSON 对象' }
  }

  const env = settings.env !== null && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {}
  const target = options.targetBaseUrl
    ?? (typeof config.originalBaseUrl === 'string' && config.originalBaseUrl.length > 0 ? config.originalBaseUrl : null)
    ?? (typeof env.ANTHROPIC_BASE_URL === 'string' && !env.ANTHROPIC_BASE_URL.includes(`127.0.0.1:${config.port}`) ? env.ANTHROPIC_BASE_URL : null)
    ?? 'http://127.0.0.1:15721'

  if (target.includes(`127.0.0.1:${config.port}`)) {
    return { ok: false, error: `目标地址还是本代理（${target}），先给一个真正要交还的地址` }
  }

  const removed = []
  for (const key of OWN_ENV) {
    if (env[key] !== undefined) {
      delete env[key]
      removed.push(key)
    }
  }
  env.ANTHROPIC_BASE_URL = target
  settings.env = env

  try {
    fs.writeFileSync(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 关掉巡检与直连记录：从这一刻起，settings.json 归别人管，我们不再改它。
  config.watchSettings = false
  delete config.direct
  saveConfig(config, home)

  return { ok: true, baseUrl: target, removed }
}
