/**
 * 本地设置面板。
 *
 * dsh 版的设置面板挂在客户端 UI 里（状态条 + 设置页 + 自测页）。Claude Code 的插件
 * 没有 UI 挂载点——`hooks` 只能返回 JSON，命令只能是提示词。所以这里换成
 * **代理自带的本地网页**：代理本来就监听 127.0.0.1，加几条路由就是一个面板，
 * 不引入依赖、不联网、不落 cookie。
 *
 * 路由：
 *   GET  /feibi/panel        面板页面（单文件，内联样式脚本）
 *   GET  /feibi/api/state    当前配置 + 提示词 + 计数 + 流水 + 接线状态
 *   POST /feibi/api/config   改配置（就地生效，不用重启代理）
 *   POST /feibi/api/prompt   存 / 恢复提示词
 *   POST /feibi/api/selftest 真发一条最小请求，看回复带不带署名
 *   POST /feibi/api/reclaim  立刻把 settings.json 抢回本代理（CC Switch 抢写时用）
 *
 * ## 为什么配置校验用 schema 而不是 typeof
 *
 * 老实现按 `typeof config[key]` 决定怎么收敛，会漏两类：
 *   1. 默认值是空字符串的键（`forceModel`）永远存不进空值 —— 面板上就表现为
 *      "模型名清不掉"，填了就再也去不掉；
 *   2. 默认表里没有的键（`stopMaxBlocks`）落进"原样照抄"分支，前端传字符串
 *      也能写盘，之后拿去做数值比较就静默失灵。
 * 所以这里给每个可改键显式声明类型、范围、枚举，越界当场拒绝并说清楚原因。
 *
 * @module feibi-breaker-cc/panel
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { feibiPaths, loadConfig, saveConfig, loadState, readJson, writeAtomic } from './config.mjs'
import { resolvePrompt, savePrompt, resetPrompt } from './prompt-store.mjs'
import { readEvents } from './stats.mjs'
import { enforceTakeover } from './install.mjs'
import { enableBypass, disableBypass } from './direct.mjs'

/** 插件版本：从 package.json 读，别再往页面里写死。 */
const VERSION = (() => {
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    return readJson(path.join(root, 'package.json'))?.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 合法的上游地址：必须能被 URL 解析，且是 http/https。 */
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 面板能改的键 —— 逐键声明类型与边界。
 *
 * 白名单仍然是白名单（`port` 不在这里：改端口要重启监听，面板里改只会让人
 * 以为生效了），但比"typeof 猜"精确得多。
 */
const SCHEMA = {
  // ---- 布尔开关 ----
  inject: { type: 'bool' },
  dualLayer: { type: 'bool' },
  rewriteIdentity: { type: 'bool' },
  identityGuard: { type: 'bool' },
  guard: { type: 'bool' },
  autoRetry: { type: 'bool' },
  fastPath: { type: 'bool' },
  abortUpstream: { type: 'bool' },
  watchSettings: { type: 'bool' },
  bypassOnStop: { type: 'bool' },
  memoryInject: { type: 'bool' },
  eventLog: { type: 'bool' },

  // ---- 整数 ----
  retryMax: { type: 'int', min: 0, max: 50 },
  scanChars: { type: 'int', min: 100, max: 200000 },
  releaseChars: { type: 'int', min: 100, max: 200000 },
  fastProbeChars: { type: 'int', min: 0, max: 10000 },
  stopMaxBlocks: { type: 'int', min: 0, max: 20 },

  // ---- 枚举 ----
  strictness: { type: 'enum', values: ['standard', 'strict', 'max'] },
  exhaustedMode: { type: 'enum', values: ['notice', 'pass'] },

  // ---- 字符串 ----
  forceModel: { type: 'string', allowEmpty: true },
  upstream: { type: 'string', allowEmpty: false, check: isHttpUrl, hint: '必须是 http(s) 地址' },

  // ---- 数组 ----
  modelsExtra: { type: 'stringArray' },
}

/** 只读字段：面板里展示但不接受写入。 */
const READONLY = ['port', 'urlPatterns', 'skipBodyPatterns', 'originalBaseUrl', 'installedAt', 'updatedAt']

/**
 * 把前端送来的一批值按 schema 收敛，任何一个不合法就整批拒绝。
 *
 * 整批拒绝而不是"能改几条算几条"，是因为面板一次只提交一个字段——
 * 部分成功的语义在这里只会让用户不知道自己哪一项没生效。
 *
 * @param {object} patch - 前端补丁。
 * @returns {{ok: boolean, applied?: object, error?: string}} 结果。
 */
function coerce(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '补丁必须是对象' }
  }

  const applied = {}
  for (const [key, raw] of Object.entries(patch)) {
    const rule = SCHEMA[key]
    if (!rule) {
      if (READONLY.includes(key)) return { ok: false, error: `${key} 是只读字段，改它要重跑安装` }
      return { ok: false, error: `未知配置项：${key}` }
    }

    if (rule.type === 'bool') {
      applied[key] = raw === true || raw === 'true'
      continue
    }

    if (rule.type === 'int') {
      const num = Number(raw)
      if (!Number.isInteger(num)) return { ok: false, error: `${key} 必须是整数` }
      if (num < rule.min || num > rule.max) {
        return { ok: false, error: `${key} 必须在 ${rule.min} ~ ${rule.max} 之间` }
      }
      applied[key] = num
      continue
    }

    if (rule.type === 'enum') {
      if (!rule.values.includes(raw)) {
        return { ok: false, error: `${key} 只能是 ${rule.values.join(' / ')}` }
      }
      applied[key] = raw
      continue
    }

    if (rule.type === 'stringArray') {
      const list = Array.isArray(raw)
        ? raw
        : String(raw ?? '').split(/[,\s]+/)
      const cleaned = list.map((item) => String(item).trim()).filter((item) => item.length > 0)
      applied[key] = cleaned
      continue
    }

    // string
    if (typeof raw !== 'string') return { ok: false, error: `${key} 必须是字符串` }
    const value = raw.trim()
    if (value.length === 0 && rule.allowEmpty !== true) {
      return { ok: false, error: `${key} 不能为空${rule.hint ? `（${rule.hint}）` : ''}` }
    }
    if (value.length > 0 && typeof rule.check === 'function' && !rule.check(value)) {
      return { ok: false, error: `${key} ${rule.hint ?? '格式不对'}` }
    }
    applied[key] = value
  }

  if (Object.keys(applied).length === 0) return { ok: false, error: '没有可应用的键' }
  return { ok: true, applied }
}

/**
 * 读插件侧（Stop hook）的计数，面板里和代理侧分开显示。
 *
 * @param {string} home - 家目录。
 * @returns {object} 插件状态。
 */
function pluginState(home) {
  const paths = feibiPaths(home)
  const state = readJson(paths.root ? path.join(paths.root, 'plugin-state.json') : '') ?? {}
  return {
    total: state.total ?? { judged: 0, blocked: 0, injected: 0 },
    sessions: Object.keys(state.sessions ?? {}).length,
  }
}

/**
 * 组装面板要的全部状态。
 *
 * @param {object} options - {home, config}
 * @returns {object} 状态。
 */
export function panelState({ home, config }) {
  const paths = feibiPaths(home)
  const resolved = resolvePrompt(home)
  const settings = readJson(paths.claudeSettings) ?? {}
  const baseUrl = settings?.env?.ANTHROPIC_BASE_URL ?? null
  const proxyStats = loadState(home)

  const view = {}
  for (const key of Object.keys(SCHEMA)) view[key] = config[key]
  for (const key of READONLY) view[key] = config[key]

  // 接管成立 ≠ 真的有流量。桌面版会绕过 settings.json 的 env，这时候面板如果还
  // 只显示"已接管"，用户就会以为调了半天其实没接上——所以这里把"最近有没有请求"
  // 单独算出来给前端。
  const lastSeen = Date.parse(String(proxyStats.lastEventAt ?? ''))
  const live = Number.isFinite(lastSeen) && Date.now() - lastSeen < 15 * 60 * 1000

  // 密钥只给"设没设 + 脱敏尾巴"，完整值不回传给页面。
  const rawKey = settings?.env?.ANTHROPIC_API_KEY ?? settings?.env?.ANTHROPIC_AUTH_TOKEN ?? ''
  const keyText = typeof rawKey === 'string' ? rawKey : ''
  const masked = keyText.length > 10
    ? `${keyText.slice(0, 6)}${'*'.repeat(Math.min(10, keyText.length - 10))}${keyText.slice(-4)}`
    : (keyText.length > 0 ? '已设置' : '')

  return {
    version: VERSION,
    apiKey: { set: keyText.length > 0, masked },
    mode: {
      port: config.port,
      upstream: config.upstream,
      baseUrl,
      takeover: typeof baseUrl === 'string' && baseUrl.includes(`127.0.0.1:${config.port}`),
      live,
      lastSeen: proxyStats.lastEventAt ?? null,
      model: config.forceModel || settings?.env?.ANTHROPIC_MODEL || settings?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
      // 客户端实际发来的模型名：和上面那个不一样，就说明 forceModel 正在改写。
      requestedModel: settings?.env?.ANTHROPIC_MODEL ?? settings?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
      pid: (() => {
        try { return Number(fs.readFileSync(paths.pid, 'utf8').trim()) || null } catch { return null }
      })(),
      proxy: proxyStats,
    },
    config: view,
    prompt: {
      source: resolved.source,
      file: resolved.file,
      chars: resolved.chars,
      hash: (resolved.hash ?? '').slice(0, 12),
      text: resolved.text,
    },
    plugin: pluginState(home),
    // 取多一点：「模型改写」每个辅助请求都写一条，只取 20 条的话
    // 真正的拦截/注入几秒就被挤出窗口，面板上看起来像什么都没发生。
    events: readEvents(200, home),
  }
}

/**
 * 应用一份配置补丁。
 *
 * `liveConfig` 是**代理进程里那个正在被每请求读取的对象**。必须传进来就地改它，
 * 否则改动只落到磁盘，运行中的代理要等重启才认——面板上就会出现"点了已生效、
 * 行为没变"这种最难查的现象。
 *
 * @param {string} home - 家目录。
 * @param {object} patch - 补丁。
 * @param {object} [liveConfig] - 代理进程内的活配置对象。
 * @returns {{ok: boolean, applied?: object, error?: string}} 结果。
 */
export function applyConfigPatch(home, patch, liveConfig = null) {
  const checked = coerce(patch)
  if (!checked.ok) return checked

  const disk = loadConfig(home)
  const saved = saveConfig({ ...disk, ...checked.applied }, home)
  if (liveConfig !== null && typeof liveConfig === 'object') {
    Object.assign(liveConfig, checked.applied)
  }
  return { ok: true, applied: checked.applied, config: saved }
}

/**
 * 改上游密钥。
 *
 * 密钥不在 config.json 里，而是 `settings.json` 的 `ANTHROPIC_API_KEY`——代理只负责
 * 原样转发客户端带来的鉴权头，自己不留凭据。所以换中转站时「改上游」和「换 key」
 * 是两件事，只改前一半必然 401。
 *
 * 顺手删掉 `ANTHROPIC_AUTH_TOKEN`：两者同时存在时 SDK 优先用 Authorization，
 * 而中转站多半只认 `x-api-key`，留着就是给"链路通了但一直 401"添砖。
 *
 * @param {string} home - 家目录。
 * @param {string} key - 新密钥，空串表示清空。
 * @returns {{ok: boolean, error?: string}} 结果。
 */
export function writeApiKey(home, key) {
  const paths = feibiPaths(home)
  const settings = readJson(paths.claudeSettings)
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, error: 'settings.json 读不了或不是对象' }
  }

  const env = settings.env !== null && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {}
  if (key.length === 0) delete env.ANTHROPIC_API_KEY
  else env.ANTHROPIC_API_KEY = key
  delete env.ANTHROPIC_AUTH_TOKEN
  settings.env = env

  try {
    writeAtomic(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`)
  } catch (error) {
    return { ok: false, error: `写入 settings.json 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 直连模式下这份 key 还要记进 config.direct，否则 CC Switch 抹掉 env 后巡检还原不出来。
  const config = loadConfig(home)
  if (config.direct !== null && typeof config.direct === 'object') {
    config.direct = { ...config.direct, key }
    saveConfig(config, home)
  }
  return { ok: true }
}

/**
 * 真发一条最小请求，看回复第一句带不带署名。
 *
 * 这是唯一能证明"整条链路现在到底通不通"的动作：HTTP 200 只说明端口活着，
 * 带署名才说明 payload 真的压过了系统提示词。
 *
 * @param {object} options - {port, model, key, timeoutMs}
 * @returns {Promise<object>} 结果。
 */
export async function selfTest({ port, model, key, timeoutMs = 90000 }) {
  const body = {
    model,
    // 推理模型会先花掉一大截预算在思维上；给 60 的结果是只拿到思维块、
    // 正文一个字没有，自检就报"署名缺失"——假阴性。给足。
    max_tokens: 800,
    stream: true,
    // 必须是**和真实桌面端一致**的身份锚：rewriteIdentity 找的正是 "You are Claude Code…"
    // 这句。写成 "You are a coding agent" 之类的玩具 anchor，改写不会触发，
    // 自检就会报"注入没压住"，而真实链路其实是好的——这种误报比不测更坑。
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{ role: 'user', content: '用一句话说明你是谁。' }],
  }
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01' }
  if (typeof key === 'string' && key.length > 0) headers['x-api-key'] = key

  const started = Date.now()
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, ms: Date.now() - started, model, error: error instanceof Error ? error.message : String(error) }
  }
  const raw = await response.text()
  let text = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const frame = JSON.parse(payload)
      if (typeof frame?.delta?.text === 'string') text += frame.delta.text
    } catch {
      // 半截帧
    }
  }
  return {
    ok: response.status === 200,
    status: response.status,
    ms: Date.now() - started,
    model,
    signature: /Discord交流群/.test(text),
    preview: (text || raw).slice(0, 300),
  }
}

/**
 * 问上游要模型列表。
 *
 * 为什么要问上游而不是写死：换 key、换分组、换供应商都是常事，写死的列表
 * 三天就过期；而且面板里"选模型"这件事，选项必须来自**这条链路真的能用**的那些，
 * 否则用户选了一个上游不认的名字，跟没选一样。
 *
 * 同时试 /v1/models 与 /models、x-api-key 与 Bearer 四种组合：不同中转认不同的那套，
 * 多试一次的代价只是几百毫秒。
 *
 * @param {{upstream: string, key: string, timeoutMs?: number}} options - 上游与凭据。
 * @returns {Promise<{ok: boolean, models: string[], error?: string}>} 结果。
 */
/**
 * 探一下这些模型名到底能不能用。
 *
 * 为什么必须探：上游的 /v1/models 会**列出这个 key 用不了的模型**——
 * 实测 buzzidoo 列出了 4 个 deepseek-*，只有 deepseek-v4.1-flash 真能出字，
 * 另外三个直接 404 model_not_found。面板里给用户一个"选了就报错"的下拉，
 * 比不给还糟。
 *
 * 用 count_tokens 探：它只数 token、不生成，便宜且能反映模型是否存在。
 *
 * @param {{upstream: string, key: string, models: string[], timeoutMs?: number}} options - 上游与候选。
 * @returns {Promise<{usable: string[], unusable: string[]}>} 分类结果。
 */
export async function probeModels({ upstream, key, models, timeoutMs = 8000 }) {
  const base = String(upstream ?? '').replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (typeof key === 'string' && key.length > 0) headers['x-api-key'] = key

  const check = async (id) => {
    try {
      const response = await fetch(base + '/v1/messages/count_tokens', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 200) return { id, ok: true }
      // 有些中转不实现 count_tokens，但模型是好的：404 且 body 里没有 model_not_found 就当能用
      const text = await response.text().catch(() => '')
      const code = /model_not_found|not supported by any configured account/i.test(text)
      return { id, ok: !code }
    } catch {
      return { id, ok: false }
    }
  }

  const results = await Promise.all(models.map(check))
  return {
    usable: results.filter((r) => r.ok).map((r) => r.id),
    unusable: results.filter((r) => !r.ok).map((r) => r.id),
  }
}

export async function listUpstreamModels({ upstream, key, timeoutMs = 4000 }) {
  const base = String(upstream ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return { ok: false, models: [], error: '上游不是 http(s) 地址' }

  const paths = ['/v1/models', '/models']
  const auths = []
  if (typeof key === 'string' && key.length > 0) {
    auths.push({ 'x-api-key': key })
    auths.push({ authorization: `Bearer ${key}` })
  }
  auths.push({})

  const errors = []
  for (const path of paths) {
    for (const auth of auths) {
      try {
        const response = await fetch(base + path, {
          method: 'GET',
          headers: { accept: 'application/json', 'anthropic-version': '2023-06-01', ...auth },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.status !== 200) {
          errors.push(`${path} → ${response.status}`)
          continue
        }
        const body = await response.json()
        const list = []
        for (const item of Array.isArray(body?.data) ? body.data : []) {
          const id = typeof item === 'string' ? item : (item?.id ?? item?.name)
          if (typeof id === 'string' && id.length > 0 && !list.includes(id)) list.push(id)
        }
        // OpenAI 的 /v1/models 有时是 {models:[...]}
        for (const item of Array.isArray(body?.models) ? body.models : []) {
          const id = typeof item === 'string' ? item : (item?.id ?? item?.name)
          if (typeof id === 'string' && id.length > 0 && !list.includes(id)) list.push(id)
        }

        if (list.length > 0) {
          const probed = await probeModels({ upstream: base, key, models: list })
          return { ok: true, models: list, usable: probed.usable, unusable: probed.unusable }
        }
        errors.push(`${path} → 200 但列表为空`)
      } catch (error) {
        errors.push(`${path} → ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { ok: false, models: [], error: errors.slice(0, 3).join('；') || '上游没有返回模型列表' }
}

/** 读请求体的小工具。 */
function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 回 JSON。 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 回 HTML。 */
function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 面板路由。命中返回 true，未命中返回 false 让代理继续走自己的流程。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {{home?: string, config: object}} options - 上下文。
 * @returns {Promise<boolean>} 是否处理了。
 */
export async function handlePanel(req, res, { home, config }) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname

  if (route === '/feibi/panel') {
    html(res, PANEL_HTML)
    return true
  }

  if (route === '/feibi/api/models' && req.method === 'GET') {
    const paths2 = feibiPaths(home)
    const settings = readJson(paths2.claudeSettings) ?? {}
    const key = settings?.env?.ANTHROPIC_API_KEY ?? settings?.env?.ANTHROPIC_AUTH_TOKEN ?? ''
    const result = await listUpstreamModels({ upstream: config.upstream, key })
    json(res, 200, { ...result, upstream: config.upstream, current: config.forceModel || '' })
    return true
  }

  if (route === '/feibi/api/state' && req.method === 'GET') {
    json(res, 200, panelState({ home, config }))
    return true
  }

  if (route === '/feibi/api/config' && req.method === 'POST') {
    const patch = await readJsonBody(req)
    if (patch === null) {
      json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return true
    }
    const result = applyConfigPatch(home, patch, config)
    json(res, result.ok ? 200 : 400, result)
    return true
  }

  if (route === '/feibi/api/prompt' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const result = body?.reset === true
      ? resetPrompt(home)
      : savePrompt(home, typeof body?.text === 'string' ? body.text : '')
    json(res, result.ok ? 200 : 400, result)
    return true
  }

  if (route === '/feibi/api/selftest' && req.method === 'POST') {
    const paths = feibiPaths(home)
    const settings = readJson(paths.claudeSettings) ?? {}
    const env = settings?.env ?? {}
    const key = env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? ''
    // 优先用面板里钉的强制模型：请求进代理后会被改写成它，自检也应该按它来。
    const model = config.forceModel || env.ANTHROPIC_MODEL || 'deepseek-chat'
    const result = await selfTest({ port: config.port, model, key })
    json(res, 200, result)
    return true
  }

  if (route === '/feibi/api/key' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const key = typeof body?.key === 'string' ? body.key.trim() : null
    if (key === null) {
      json(res, 400, { ok: false, error: '请求体里要有 key 字段（字符串）' })
      return true
    }
    const result = writeApiKey(home, key)
    json(res, result.ok ? 200 : 400, result)
    return true
  }

  if (route === '/feibi/api/bypass' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (body?.off === true) {
      const result = disableBypass(home)
      json(res, result.ok ? 200 : 400, result)
      return true
    }
    const result = enableBypass(home, {
      upstream: typeof body?.upstream === 'string' && body.upstream.trim().length > 0 ? body.upstream.trim() : undefined,
      key: typeof body?.key === 'string' && body.key.trim().length > 0 ? body.key.trim() : undefined,
      model: typeof body?.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : undefined,
    })
    json(res, result.ok ? 200 : 400, result)
    return true
  }

  if (route === '/feibi/api/reclaim' && req.method === 'POST') {
    const result = enforceTakeover(config, home)
    json(res, 200, { ok: !result.error, ...result })
    return true
  }

  return false
}

/** 面板页面。内联一切，不引外链。 */
const PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>菲比破限 · 设置面板</title>
<style>
:root{--bg:#0e1116;--card:#161b23;--card2:#12171e;--line:#242c38;--txt:#e6edf3;--dim:#8b98a9;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#7c9cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:rgba(14,17,22,.92);backdrop-filter:blur(8px);padding:14px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:17px;margin:0;font-weight:600;letter-spacing:.02em}
.ver{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.pills{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
main{padding:20px 24px 40px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:1240px;margin:0 auto;align-items:start}
@media(max-width:920px){main{grid-template-columns:1fr}.wide{grid-column:auto!important}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
section.wide{grid-column:1/-1}
section h2{font-size:12px;margin:0 0 14px;color:var(--dim);font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid rgba(36,44,56,.6)}
.row:last-child{border-bottom:0}
.row .label{min-width:0}
.row .label>span:first-child{display:block}
.hint{display:block;color:var(--dim);font-size:12px;margin-top:2px;line-height:1.45}
input[type=checkbox]{width:40px;height:22px;flex:none;appearance:none;background:#2b3341;border-radius:999px;position:relative;cursor:pointer;transition:.15s;outline:none;margin:0}
input[type=checkbox]:checked{background:var(--acc)}
input[type=checkbox]::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.15s}
input[type=checkbox]:checked::after{left:21px}
input[type=text],input[type=number],input[type=password],select,textarea{background:#0f141b;border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:7px 9px;font:inherit;transition:border-color .15s}
input[type=text]:focus,input[type=number]:focus,input[type=password]:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc)}
input[type=number]{width:104px;text-align:right;font-variant-numeric:tabular-nums}
input[type=text],input[type=password]{width:100%}
select{min-width:132px}
textarea{width:100%;min-height:260px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.6;resize:vertical;margin-top:10px}
button{background:#232b37;border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:8px 15px;cursor:pointer;font:inherit;transition:.15s}
button:hover{background:#2b3442;border-color:#39455a}
button.primary{background:var(--acc);border-color:var(--acc);color:#0b1020;font-weight:600}
button.primary:hover{filter:brightness(1.08)}
button.danger{color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
.kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13px;align-items:baseline}
.kv>span:first-child{color:var(--dim);flex:none}
.kv>span:last-child{text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--line);white-space:nowrap}
.badge.ok{color:var(--ok);border-color:rgba(63,185,80,.45);background:rgba(63,185,80,.1)}
.badge.bad{color:var(--bad);border-color:rgba(248,81,73,.45);background:rgba(248,81,73,.1)}
.badge.warn{color:var(--warn);border-color:rgba(210,153,34,.45);background:rgba(210,153,34,.1)}
.notice{border:1px solid rgba(248,81,73,.45);background:rgba(248,81,73,.08);border-radius:9px;padding:11px 13px;margin-bottom:12px;font-size:13px;line-height:1.55}
.notice b{color:var(--bad)}
.notice code{background:#0f141b;padding:1px 6px;border-radius:4px}
.btn-row{display:flex;gap:10px;flex-wrap:wrap;padding-top:14px}
pre{background:#0f141b;border:1px solid var(--line);border-radius:8px;padding:11px;overflow:auto;max-height:280px;font-size:12px;margin:12px 0 0;white-space:pre-wrap;word-break:break-all}
.log{font-family:ui-monospace,Consolas,monospace;font-size:12px;max-height:340px;overflow:auto;margin-top:8px;scrollbar-width:thin}
.log div{padding:5px 0;border-bottom:1px solid rgba(36,44,56,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}
.log div:hover{background:rgba(124,156,255,.06)}
.log b{font-weight:600;color:var(--dim);font-variant-numeric:tabular-nums}
.log .k-bad{color:var(--bad)}
.log .k-ok{color:var(--ok)}
.log .k-warn{color:var(--warn)}
.log .k-acc{color:var(--acc)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}
.chip{background:#1b222c;border:1px solid var(--line);color:var(--dim);border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:#39455a;color:var(--txt)}
.chip.on{background:rgba(124,156,255,.16);border-color:rgba(124,156,255,.55);color:var(--txt)}
.chip .n{color:var(--dim);font-variant-numeric:tabular-nums;margin-left:4px}
.statbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
@media(max-width:560px){.statbar{grid-template-columns:repeat(2,minmax(0,1fr))}}
.stat{background:var(--card2);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
.stat .n{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.25}
.stat .t{font-size:11px;color:var(--dim);margin-top:1px}
.stat.ok .n{color:var(--ok)}
.stat.bad .n{color:var(--bad)}
.stat.acc .n{color:var(--acc)}
.result{border:1px solid var(--line);border-radius:9px;padding:12px 14px;margin-top:12px;background:var(--card2)}
.result.ok{border-color:rgba(63,185,80,.4)}
.result.bad{border-color:rgba(248,81,73,.45)}
.result .head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.result .body{font-size:12.5px;color:var(--dim);line-height:1.6;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.result .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px}
.result .cell{background:#0f141b;border:1px solid var(--line);border-radius:7px;padding:6px 9px}
.result .cell .k{font-size:11px;color:var(--dim)}
.result .cell .v{font-size:13px;font-variant-numeric:tabular-nums}
.saving{opacity:.6;pointer-events:none;transition:.15s}
input.invalid{border-color:var(--bad)!important}
.field-row{display:flex;gap:8px;align-items:center;margin-top:8px}
.field-row>*{flex:none}
.field-row>select,.field-row>input[type=text],.field-row>input[type=password]{flex:1 1 auto;min-width:0}
.field-row>button{white-space:nowrap}
.toast{position:fixed;right:22px;bottom:22px;background:#1f2630;border:1px solid var(--line);padding:11px 17px;border-radius:9px;opacity:0;transform:translateY(6px);transition:.2s;pointer-events:none;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.toast.show{opacity:1;transform:none}
.toast.err{border-color:rgba(248,81,73,.6)}
footer{padding:14px 24px 26px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);text-align:center}
</style></head><body>

<header>
  <h1>菲比破限</h1>
  <span class="ver" id="ver">…</span>
  <div class="pills">
    <span class="badge" id="pill-takeover">接管 ?</span>
    <span class="badge" id="pill-live">流量 ?</span>
    <span class="badge" id="pill-port">:?</span>
  </div>
</header>

<main>
  <section>
    <h2>接线</h2>
    <div id="mode"></div>
    <div class="row" style="border:0;padding-top:10px">
      <div class="label"><span>上游地址</span><span class="hint">改完立刻生效；必须是 http(s)</span></div>
    </div>
    <input type="text" data-key="upstream" data-type="text" placeholder="https://api.deepseek.com/anthropic">
    <div class="row" style="border:0;padding-top:14px">
      <div class="label"><span>上游密钥</span><span class="hint" id="key-state">写入 settings.json 的 ANTHROPIC_API_KEY</span></div>
    </div>
    <div class="field-row">
      <input type="password" id="api-key" placeholder="留空并保存 = 清空" autocomplete="off" spellcheck="false">
      <button id="btn-save-key">保存密钥</button>
    </div>
    <div class="row" style="display:block;margin-top:16px">
      <div class="label"><span>模型</span><span class="hint">从上游真实可用的列表里选；客户端发什么名字都会被改写成它。留空 = 不改写</span></div>
      <div class="field-row">
        <select id="model-pick" data-key="forceModel" data-type="text"><option value="">（不改写）</option></select>
        <button type="button" id="model-refresh" title="重新问上游">刷新</button>
      </div>
      <div class="field-row">
        <input type="text" id="model-custom" placeholder="或直接手填模型名">
        <button type="button" id="model-apply">用这个</button>
      </div>
    </div>
    <div class="btn-row">
      <button class="primary" id="btn-test">自检（花一次 token）</button>
      <button id="btn-reclaim">重新接管 settings</button>
    </div>
    <div class="row" style="border:0;padding-top:14px">
      <div class="label"><span>旁路</span><span class="hint" id="bypass-state">关掉代理时，让客户端直接连上游</span></div>
    </div>
    <div class="btn-row" style="padding-top:8px">
      <button id="btn-bypass-on">现在切到旁路</button>
      <button id="btn-bypass-off">收回给代理</button>
    </div>
    <div id="test-out"></div>
  </section>

  <section>
    <h2>开关</h2>
    <div id="toggles"></div>
  </section>

  <section>
    <h2>参数</h2>
    <div id="numbers"></div>
    <div class="row"><div class="label"><span>严格度</span><span class="hint">standard 只放规则 / strict 禁反问 / max 禁缩减与半成品</span></div>
      <select data-key="strictness"><option value="standard">standard</option><option value="strict">strict</option><option value="max">max</option></select></div>
    <div class="row"><div class="label"><span>重试用光后</span><span class="hint">notice 给说明 / pass 原样放出去</span></div>
      <select data-key="exhaustedMode"><option value="notice">notice</option><option value="pass">pass</option></select></div>
  </section>

  <section>
    <h2>高级</h2>
    <div id="advanced"></div>
    <div class="row" style="display:block">
      <div class="label"><span>额外模型名</span><span class="hint">/v1/models 里多报的名字，逗号分隔；CC Switch 直连时用</span></div>
      <input type="text" data-key="modelsExtra" data-type="array" placeholder="deepseek-reasoner, deepseek-chat" style="margin-top:8px">
    </div>
  </section>

  <section class="wide">
    <h2>提示词 <span id="prompt-meta" style="text-transform:none;letter-spacing:0;color:var(--dim);font-weight:400"></span></h2>
    <textarea id="prompt-text" spellcheck="false"></textarea>
    <div class="btn-row" style="justify-content:flex-end">
      <button class="danger" id="btn-reset">恢复内置默认</button>
      <button class="primary" id="btn-save">保存（下一轮生效）</button>
    </div>
  </section>

  <section class="wide">
    <h2>计数与流水</h2>
    <div class="statbar" id="stats"></div>
    <div id="counts"></div>
    <div class="toolbar" id="log-toolbar">
      <span class="chip on" data-filter="key">关键<span class="n" id="n-key">0</span></span>
      <span class="chip" data-filter="blocked">拦截<span class="n" id="n-blocked">0</span></span>
      <span class="chip" data-filter="pass">放行<span class="n" id="n-pass">0</span></span>
      <span class="chip" data-filter="inject">注入<span class="n" id="n-inject">0</span></span>
      <span class="chip" data-filter="model">模型<span class="n" id="n-model">0</span></span>
      <span class="chip" data-filter="all">全部<span class="n" id="n-all">0</span></span>
      <span style="flex:1"></span>
      <button type="button" id="btn-pause" title="暂停后不再重绘，方便逐条看">暂停</button>
      <button type="button" id="btn-clear-log">清空显示</button>
    </div>
    <div class="log" id="log"></div>
  </section>
</main>

<footer>只监听 127.0.0.1，不做鉴权：能打开这个端口的人本来就能改这台机器上的设定。</footer>
<div class="toast" id="toast"></div>

<script>
/* 把运行时错误显示出来：白页是最难排查的失败形态 */
window.addEventListener('error', function (e) {
  var box = document.getElementById('__feibiPanelError')
  if (!box) {
    box = document.createElement('pre')
    box.id = '__feibiPanelError'
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:40vh;overflow:auto;margin:0;padding:10px 14px;background:#3b1218;color:#ffb4b4;border-top:1px solid #f85149;font:12px/1.5 ui-monospace,Consolas,monospace;z-index:9999;white-space:pre-wrap'
    document.body.appendChild(box)
  }
  box.textContent += '[面板脚本错误] ' + (e.message || e.error) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0) + '\n'
})
window.addEventListener('unhandledrejection', function (e) {
  var box = document.getElementById('__feibiPanelError')
  if (!box) {
    box = document.createElement('pre')
    box.id = '__feibiPanelError'
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:40vh;overflow:auto;margin:0;padding:10px 14px;background:#3b1218;color:#ffb4b4;border-top:1px solid #f85149;font:12px/1.5 ui-monospace,Consolas,monospace;z-index:9999;white-space:pre-wrap'
    document.body.appendChild(box)
  }
  box.textContent += '[未处理的 Promise 拒绝] ' + (e.reason && (e.reason.stack || e.reason.message || e.reason)) + '\n'
})
var $ = function (id) { return document.getElementById(id); };
var state = null;
var hydrated = false;

function toast(text, isErr){
  var t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(function(){ t.className = 'toast'; }, 2200);
}

function badge(ok, good, bad){ return '<span class="badge ' + (ok ? 'ok' : 'bad') + '">' + (ok ? good : bad) + '</span>'; }

/* ---------- 控件只建一次，之后只刷新动态区 ---------- */
var TOGGLES = [
  ['inject','注入（改请求体）','关掉就只是透明代理'],
  ['dualLayer','双段注入（头+尾）','关掉省一半 token，压不住系统提示词'],
  ['rewriteIdentity','改写身份锚与权限段','关掉模型会自称 Claude'],
  ['identityGuard','身份守卫','开头自称 Claude 就拦掉重发'],
  ['guard','拦截判定','盯回复流'],
  ['autoRetry','自动重试','命中后重发'],
  ['fastPath','快速通道','没信号立刻放行'],
  ['abortUpstream','判定后立刻断上游','省 token'],
  ['eventLog','落流水','排查用'],
];

var NUMBERS = [
  ['retryMax','最多重发几次','每轮'],
  ['scanChars','判定窗口','字'],
  ['releaseChars','放行阈值','字'],
  ['fastProbeChars','快速通道探测','字'],
  ['stopMaxBlocks','Stop 劝回上限','次/轮'],
];

var ADVANCED = [
  ['watchSettings','盯住 settings.json','被 CC Switch 改回时自动抢回来'],
  ['bypassOnStop','关代理时自动切旁路','停代理后客户端继续直连上游，不会卡在死端口'],
  ['memoryInject','写进 CLAUDE.md','双保险，费 token'],
];

function buildForm(){
  $('toggles').innerHTML = TOGGLES.map(function (t) {
    return '<div class="row"><div class="label"><span>' + t[1] + '</span><span class="hint">' + t[2] + '</span></div>'
      + '<input type="checkbox" data-key="' + t[0] + '"></div>';
  }).join('');

  $('numbers').innerHTML = NUMBERS.map(function (n) {
    return '<div class="row"><div class="label"><span>' + n[1] + '</span><span class="hint">' + n[2] + '</span></div>'
      + '<input type="number" data-key="' + n[0] + '" data-type="number"></div>';
  }).join('');

  $('advanced').innerHTML = ADVANCED.map(function (a) {
    return '<div class="row"><div class="label"><span>' + a[1] + '</span><span class="hint">' + a[2] + '</span></div>'
      + '<input type="checkbox" data-key="' + a[0] + '"></div>';
  }).join('');
}

/* 只在首次加载 / 手动重载时把值灌进控件，定时刷新永远不碰输入框 */
function hydrate(){
  var s = state;
  var all = document.querySelectorAll('[data-key]');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var key = el.getAttribute('data-key');
    var value = s.config[key];
    if (el.type === 'checkbox') {
      el.checked = value === true;
    } else if (el.getAttribute('data-type') === 'array') {
      el.value = Array.isArray(value) ? value.join(', ') : (value || '');
    } else {
      el.value = (value === null || value === undefined) ? '' : value;
    }
  }
  $('prompt-text').value = s.prompt.text;
  hydrated = true;
}

function escapeHtml(v){
  return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c];
  });
}

/** 判定窗口里模型偶尔会吐出 <severity>12 这种内部标记，展示前抹掉。 */
function cleanHead(v){
  return String(v || '').replace(/<[a-zA-Z\/][^>]{0,30}>/g, '').replace(/\s+/g, ' ').trim();
}

function fmtDuration(ms){
  if (!isFinite(ms) || ms < 0) return '-';
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400); s -= d * 86400;
  var h = Math.floor(s / 3600);  s -= h * 3600;
  var m = Math.floor(s / 60);    s -= m * 60;
  if (d > 0) return d + '天' + h + '时';
  if (h > 0) return h + '时' + m + '分';
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}

/**
 * 一条流水归到哪个分组，过滤按钮靠它。
 *
 * 「模型」是"模型名被改写"的记录，每个辅助请求都会写一条，量最大但信息量最低；
 * 默认的「关键」把它排除掉，不然真正的拦截/注入会被刷到看不见。
 */
function groupOf(e){
  if (e.kind === 'inject') return 'inject';
  if (e.kind === 'judge') return e.blocked ? 'blocked' : 'pass';
  if (e.kind === 'identity') return 'blocked';
  if (e.kind === 'model') return 'model';
  return 'key';
}

/** 某个分组在过滤时是否命中。 */
function matchFilter(e, filter){
  if (filter === 'all') return true;
  if (filter === 'key') return groupOf(e) !== 'model';
  return groupOf(e) === filter;
}

var logFilter = 'key';
var logPaused = false;
var logClearedAt = 0;
var logSig = '';

function renderLog(){
  var events = (state.events || []).filter(function (e) {
    if (logClearedAt > 0 && Date.parse(e.at || '') <= logClearedAt) return false;
    return matchFilter(e, logFilter);
  }).slice().reverse();

  var sig = events.length + '|' + (events[0] && events[0].at) + '|' + logFilter;
  var box = $('log');
  if (sig === logSig) return;
  logSig = sig;

  var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 28;
  var prevTop = box.scrollTop;

  box.innerHTML = events.map(function (e) {
    var g = groupOf(e);
    var kind = e.kind === 'judge'
      ? (e.blocked ? (e.gaveUp ? '放弃' : '拦截') : '放行')
      : (e.kind === 'identity' ? '改身份'
        : (e.kind === 'inject' ? '注入'
        : (e.kind === 'model' ? '模型'
        : (e.kind === 'retry' ? '重试' : escapeHtml(e.kind)))));
    var cls = g === 'blocked' ? 'k-bad' : (g === 'pass' ? 'k-ok' : (g === 'inject' ? 'k-acc' : 'k-warn'));
    var head = escapeHtml(cleanHead(e.head));
    var tip = escapeHtml(cleanHead(e.head)).slice(0, 300);
    return '<div title="' + tip + '"><b>' + String(e.at || '').slice(11,19) + '</b> '
      + '<span class="' + cls + '">' + kind + '</span>'
      + (e.reason ? ' · ' + escapeHtml(e.reason) : '')
      + (e.chars ? ' · ' + e.chars + '字' : '')
      + (head ? ' · ' + head.slice(0, 72) : '') + '</div>';
  }).join('') || ('<div style="color:var(--dim)">'
    + ((state.events || []).length > 0
      ? '这个分类眼下是空的（一共 ' + (state.events || []).length + ' 条，换个分类看看）'
      : '还没有流水')
    + '</div>');

  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
}

function renderCounts(){
  var st = state.mode.proxy || {};
  var counts = { key: 0, blocked: 0, pass: 0, inject: 0, model: 0, all: (state.events || []).length };
  (state.events || []).forEach(function (e) {
    var g = groupOf(e);
    if (g === 'model') {
      counts.model += 1;
      return;
    }
    counts.key += 1;
    if (counts[g] !== undefined) counts[g] += 1;
  });
  $('n-key').textContent = counts.key;
  $('n-blocked').textContent = counts.blocked;
  $('n-pass').textContent = counts.pass;
  $('n-inject').textContent = counts.inject;
  $('n-model').textContent = counts.model;
  $('n-all').textContent = counts.all;

  var started = Date.parse(st.startedAt || '');
  var uptime = isFinite(started) ? fmtDuration(Date.now() - started) : '-';

  $('stats').innerHTML =
    '<div class="stat acc"><div class="n">' + (st.injected || 0) + '</div><div class="t">注入</div></div>' +
    '<div class="stat"><div class="n">' + (st.judged || 0) + '</div><div class="t">判定</div></div>' +
    '<div class="stat bad"><div class="n">' + (st.blocked || 0) + '</div><div class="t">拦截</div></div>' +
    '<div class="stat ok"><div class="n">' + (st.retried || 0) + '</div><div class="t">重试</div></div>';

  $('counts').innerHTML =
    '<div class="kv"><span>运行</span><span>' + uptime + ' · pid ' + (st.startedAt ? (state.mode.pid || '-') : '-') + '</span></div>' +
    '<div class="kv"><span>插件侧</span><span>注入 ' + (state.plugin.total.injected||0) + ' · 判定 ' + (state.plugin.total.judged||0) + ' · 拦回 ' + (state.plugin.total.blocked||0) + '</span></div>';
}

function refresh(){
  var s = state;
  var mode = s.mode;

  $('ver').textContent = 'v' + s.version;
  $('pill-takeover').textContent = mode.takeover ? '已接管' : '未接管';
  $('pill-takeover').className = 'badge ' + (mode.takeover ? 'ok' : 'bad');
  $('pill-live').textContent = mode.live ? '有流量' : '无流量';
  $('pill-live').className = 'badge ' + (mode.live ? 'ok' : 'warn');
  $('pill-port').textContent = ':' + mode.port;

  var requested = (mode.requestedModel || '').trim();
  var effective = (mode.model || '').trim();
  var rewritten = requested && effective && requested !== effective;

  $('mode').innerHTML =
    (mode.takeover && !mode.live
      ? '<div class="notice"><b>代理没收到流量</b><br>settings 的 baseURL 指向本代理，但最近 15 分钟没有请求进来。'
        + '桌面版只在启动时读一次 env，改完必须完全退出再开。'
        + '<br>目标入口：<code>http://127.0.0.1:' + mode.port + '</code></div>'
      : '') +
    '<div class="kv"><span>settings 入口</span><span>' + escapeHtml(mode.baseUrl || '未设置') + '</span></div>' +
    '<div class="kv"><span>接管</span>' + badge(mode.takeover, '已接管', '没接管') + '</div>' +
    '<div class="kv"><span>流量</span>' + badge(mode.live, '最近有请求', '最近没有请求') + '</div>' +
    '<div class="kv"><span>生效上游</span><span>' + escapeHtml(mode.upstream) + '</span></div>' +
    '<div class="kv"><span>发给上游的模型</span><span>' + escapeHtml(effective || '-') + '</span></div>' +
    (rewritten ? '<div class="kv"><span>客户端要的模型</span><span style="color:var(--warn)">' + escapeHtml(requested) + ' → 已改写</span></div>' : '') +
    '<div class="kv"><span>提示词</span><span>' + ({custom:'自定义',default:'内置默认',empty:'空（不会注入！）'}[s.prompt.source] || s.prompt.source) + ' · ' + s.prompt.chars + ' 字</span></div>';

  $('prompt-meta').textContent = '· ' + (s.prompt.file || '') + ' · ' + s.prompt.hash;

  $('key-state').textContent = s.apiKey && s.apiKey.set
    ? '当前：' + s.apiKey.masked
    : '未设置 —— 换中转站时这里和上游地址要一起改';

  renderCounts();
  if (!logPaused) renderLog();
}

/* ---------- 读 / 写 ---------- */
async function loadStateData(){
  var r = await fetch('/feibi/api/state', { cache: 'no-store' });
  state = await r.json();
}

async function load(force){
  await loadStateData();
  if (!hydrated || force) hydrate();
  refresh();
}

async function patch(key, value){
  var body = {};
  body[key] = value;
  var r = await fetch('/feibi/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  var out = await r.json();
  if (!out.ok) { toast('没改成：' + out.error, true); await load(true); return false; }
  toast('已生效');
  await loadStateData();
  refresh();
  return true;
}

/* 事件委托：控件是动态建的，绑在 body 上一次就够 */
document.addEventListener('change', function (e) {
  var el = e.target;
  var key = el.getAttribute && el.getAttribute('data-key');
  if (!key) return;
  var type = el.getAttribute('data-type');
  var value;

  if (el.type === 'checkbox') {
    value = el.checked;
  } else if (type === 'array') {
    value = el.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  } else if (type === 'number') {
    // 清空或乱填时不要把 0 偷偷塞进去：标红、回滚，等人自己改对。
    var raw = String(el.value).trim();
    var num = Number(raw);
    if (raw === '' || !isFinite(num)) {
      el.classList.add('invalid');
      toast('请填一个数字', true);
      setTimeout(function () { el.classList.remove('invalid'); }, 1200);
      el.value = state.config[key] ?? '';
      return;
    }
    el.classList.remove('invalid');
    value = num;
  } else {
    value = el.value;
  }
  patch(key, value);
});

$('btn-save').onclick = async function () {
  var r = await fetch('/feibi/api/prompt', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text: $('prompt-text').value }) });
  var out = await r.json();
  toast(out.ok ? '已保存，下一轮生效' : ('失败：' + out.error), !out.ok);
  await load();
};

$('btn-reset').onclick = async function () {
  var r = await fetch('/feibi/api/prompt', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reset: true }) });
  var out = await r.json();
  toast(out.ok ? '已恢复内置默认' : ('失败：' + out.error), !out.ok);
  await load(true);
};

function cell(k, v){
  return '<div class="cell"><div class="k">' + k + '</div><div class="v">' + escapeHtml(v) + '</div></div>';
}

function renderTestResult(d){
  var ok = d.ok === true;
  return '<div class="result ' + (ok ? 'ok' : 'bad') + '">'
    + '<div class="head">'
      + badge(ok, '链路通', '没通')
      + (d.signature ? '<span class="badge ok">署名在</span>' : '<span class="badge warn">署名缺失</span>')
    + '</div>'
    + '<div class="grid">'
      + cell('状态码', d.status ?? '-')
      + cell('耗时', d.ms ? d.ms + ' ms' : '-')
      + cell('模型', d.model || '-')
      + cell('署名', d.signature ? '有' : '无')
    + '</div>'
    + '<div class="body">' + escapeHtml(d.error || d.preview || '（没有正文）') + '</div>'
    + '</div>';
}

$('btn-test').onclick = async function () {
  var out = $('test-out');
  out.innerHTML = '<div class="result"><div class="head"><span class="badge warn">发请求中…</span></div>'
    + '<div class="body">最多等 90 秒；结果会写入流水。</div></div>';
  try {
    var r = await fetch('/feibi/api/selftest', { method:'POST' });
    var data = await r.json();
    out.innerHTML = renderTestResult(data);
    toast(data.ok ? ('通了 · ' + data.ms + 'ms · 署名' + (data.signature ? '有' : '无')) : '没通，看下面详情', !data.ok);
  } catch (err) {
    out.innerHTML = '<div class="result bad"><div class="body">' + escapeHtml('请求失败：' + err) + '</div></div>';
  }
  await load();
};

$('btn-save-key').onclick = async function () {
  var value = $('api-key').value.trim();
  var r = await fetch('/feibi/api/key', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ key: value }) });
  var out = await r.json();
  toast(out.ok ? (value ? '密钥已保存' : '密钥已清空') : ('失败：' + out.error), !out.ok);
  if (out.ok) $('api-key').value = '';
  await load();
};

$('btn-bypass-on').onclick = async function () {
  var r = await fetch('/feibi/api/bypass', { method:'POST', headers:{'content-type':'application/json'}, body: '{}' });
  var out = await r.json();
  if (!out.ok) { toast('没切成：' + out.error, true); return; }
  toast('已切到旁路：' + out.upstream);
  await load(true);
};

$('btn-bypass-off').onclick = async function () {
  var r = await fetch('/feibi/api/bypass', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ off: true }) });
  var out = await r.json();
  toast(out.ok ? '入口已收回代理' : ('失败：' + out.error), !out.ok);
  await load(true);
};

$('btn-reclaim').onclick = async function () {
  var r = await fetch('/feibi/api/reclaim', { method:'POST' });
  var out = await r.json();
  toast(out.changed ? '已抢回 settings.json' : (out.ok ? '本来就是我们的，没动' : ('失败：' + (out.error || '?'))), out.ok === false);
  await load();
};

/* 模型选择：选项来自上游真实可用列表，用不了的标出来并且禁用 */
async function refreshModelPick(){
  var box = $('model-pick');
  if (!box) return;
  box.innerHTML = '<option value="">（读取中…）</option>';
  try {
    var r = await fetch('/feibi/api/models', { cache:'no-store' });
    var data = await r.json();
    if (!data.ok) {
      box.innerHTML = '<option value="">（上游没给列表，用右边手填）</option>';
      box.title = data.error || '';
      return;
    }
    var usable = {};
    (data.usable || []).forEach(function (id) { usable[id] = true; });
    var cur = data.current || '';
    var opts = ['<option value="">（不改写）</option>'];
    (data.models || []).forEach(function (id) {
      var ok = data.usable ? usable[id] === true : true;
      opts.push('<option value="' + id + '"' + (id === cur ? ' selected' : '') + (ok ? '' : ' disabled') + '>'
        + id + (ok ? '' : '（上游说不可用）') + '</option>');
    });
    box.innerHTML = opts.join('');
    box.title = data.upstream || '';
  } catch (e) {
    box.innerHTML = '<option value="">（读取失败，用右边手填）</option>';
    box.title = String(e);
  }
}

$('model-refresh').onclick = function () { refreshModelPick(); };
$('model-apply').onclick = async function () {
  var value = ($('model-custom').value || '').trim() || ($('model-pick').value || '');
  if (!value) { toast('先选一个或填一个模型名', true); return; }
  var ok = await patch('forceModel', value);
  if (ok) { $('model-custom').value = ''; await refreshModelPick(); }
};

$('model-pick').addEventListener('change', function () {
  if ($('model-pick').value) $('model-custom').value = '';
});

/* ---------- 流水工具栏 ---------- */
document.querySelectorAll('#log-toolbar .chip').forEach(function (chip) {
  chip.onclick = function () {
    logFilter = chip.getAttribute('data-filter');
    document.querySelectorAll('#log-toolbar .chip').forEach(function (c) {
      c.classList.toggle('on', c === chip);
    });
    logSig = '';
    renderLog();
  };
});

$('btn-pause').onclick = function () {
  logPaused = !logPaused;
  $('btn-pause').textContent = logPaused ? '继续' : '暂停';
  $('btn-pause').classList.toggle('primary', logPaused);
  if (!logPaused) { logSig = ''; renderLog(); }
};

$('btn-clear-log').onclick = function () {
  logClearedAt = Date.now();
  logSig = '';
  renderLog();
};

/* 改完提示词按 Ctrl+S 直接存，省得滚回去找按钮 */
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
    e.preventDefault();
    $('btn-save').click();
  }
});

refreshModelPick();

buildForm();
load(true);
setInterval(function(){ if (!document.hidden) load(false); }, 5000);
</script></body></html>`
