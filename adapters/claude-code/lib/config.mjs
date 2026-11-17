/**
 * 配置与路径：所有落盘位置集中在这里。
 *
 * 设计原则和 dsh 版一致——凡是用户能改的东西都必须是磁盘上一个能打开的文件，
 * 不能在代码里写死，否则改一行就得重启整个宿主。
 *
 *   ~/.claude/feibi/config.json     ← 运行参数（端口、上游、重试次数……）
 *   ~/.claude/feibi/prompt.md       ← 用户自己的提示词；非空时优先
 *   ~/.claude/feibi/state.json      ← 计数器与接管前的原始 baseURL
 *   ~/.claude/feibi/events.jsonl    ← 每次判定的流水，供 `feibi-cc log` 读
 *   ~/.claude/feibi/proxy.log       ← 代理进程自身的日志（崩溃排查用）
 *
 * @module feibi-breaker-cc/config
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认监听端口。挑 45xxx 是因为常见代理都挤在 15xxx/78xx，避开能少一半冲突。 */
export const DEFAULT_PORT = 45721

/** CC Switch 的接管端口；作为缺省上游，用户装了别的自己改。 */
export const DEFAULT_UPSTREAM = 'http://127.0.0.1:15721'

/**
 * 用户家目录下的菲比目录。
 *
 * `FEIBI_HOME` 由 CLI 显式传出，测试里用它把整个状态搬到临时目录，
 * 保证测试永远碰不到真实的 ~/.claude。
 *
 * @param {string} [override] - 显式覆盖。
 * @returns {string} 绝对路径。
 */
export function feibiHome(override) {
  if (typeof override === 'string' && override.length > 0) return override
  const fromEnv = process.env.FEIBI_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.claude', 'feibi')
}

/**
 * 用户家目录。
 *
 * `FEIBI_USERHOME` 存在的唯一理由是测试：`feibiPaths` 会去改
 * `~/.claude/settings.json`，没有这个开关的话跑一次测试就把真实的
 * Claude Code 配置改掉了。
 *
 * @returns {string} 家目录。
 */
export function userHome() {
  const fromEnv = process.env.FEIBI_USERHOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return os.homedir()
}

/**
 * 本模块拥有的全部路径。
 *
 * @param {string} [home] - 菲比目录。
 * @returns {object} 路径表。
 */
export function feibiPaths(home) {
  const root = feibiHome(home)
  const uh = userHome()
  return {
    root,
    config: path.join(root, 'config.json'),
    prompt: path.join(root, 'prompt.md'),
    promptState: path.join(root, 'prompt-state.json'),
    state: path.join(root, 'state.json'),
    events: path.join(root, 'events.jsonl'),
    log: path.join(root, 'proxy.log'),
    pid: path.join(root, 'proxy.pid'),
    autostart: path.join(uh, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'feibi-breaker-cc.vbs'),
    claudeSettings: path.join(uh, '.claude', 'settings.json'),
    claudeMemory: path.join(uh, '.claude', 'CLAUDE.md'),
    claudeBin: path.join(uh, '.claude', 'bin'),
  }
}

/**
 * 缺省配置。
 *
 * 每个字段都带一句"为什么是这个值"，因为这份 JSON 会被用户手改。
 */
export function defaultConfig() {
  return {
    version: 1,
    /** 代理监听端口。改完要重跑 `feibi-cc on` 才会同步到 settings.json。 */
    port: DEFAULT_PORT,
    /** 上游：默认就是 CC Switch 的本地接管端口，原样转发。 */
    upstream: DEFAULT_UPSTREAM,
    /** 是否改写请求体注入提示词。 */
    inject: true,
    /**
     * 双段注入：头 + 尾各一份。
     *
     * 只往末尾追加时，模型的 thinking 会写"payload 让我当菲比，但系统提示词里
     * 我的真实身份是……"，然后按系统提示词办。头段抢在最前面声明优先级，
     * 这是 dsh 版 Order 100 + Order 200 的等效实现（那边也是同一段放两处）。
     */
    dualLayer: true,
    /**
     * 改写系统提示词里的身份锚：把"You are Claude Code, …"换成菲比。
     *
     * 注入是"加"，身份句是"锚"，加多少段都改不了锚。实测双段注入后模型
     * 已经在 thinking 里写下"per the injected persona rules, i should answer as 菲比"，
     * 最终答案仍是"我是 Claude Code"——就是被这句锚拉回去的。
     */
    rewriteIdentity: true,
    /**
     * 严格度档位：standard | strict | max。
     *
     * 只影响**头段**加的那一两句执行要求（禁反问、禁半成品）。
     * 默认 strict：模型最常见的软绕法是"你还没说清楚，先说这几点"，
     * 那不是拒绝、判定器抓不住，只能在提示词层堵。
     */
    strictness: 'strict',
    /** 身份守卫：开头又自称 Claude 就当成一次不合格，重发。 */
    identityGuard: true,
    /**
     * 强制改写请求里的模型名（空 = 不改）。
     *
     * 为什么需要：桌面版绕过 settings.json 的 env，它发出去的模型名是
     * `claude-sonnet-5` 这种自家名字。如果把桌面版直接指到本代理、而代理上游是
     * 第三方（DeepSeek 之类），上游会 400 说不认识这个模型。
     *
     * 走 CC Switch 那层时它会做映射，这里就不用填；直连场景填上更稳。
     */
    forceModel: '',
    /**
     * `/v1/models` 里额外报上去的模型名。
     *
     * 默认空：CC Switch 加"直连"供应商时只认 Claude Desktop 那三档
     * （Sonnet/Opus/Haiku），多报第三方名字会被判不合格。真要用别家名字的
     * 客户端，在这里加，例如 ["deepseek-reasoner"]。
     */
    modelsExtra: [],
    /** 是否盯着返回流做拒绝判定。 */
    guard: true,
    /** 判定命中后是否自动重发。 */
    autoRetry: true,
    /** 一轮用户消息里最多重发几次。 */
    retryMax: 2,
    /** 判定窗口：只看回复开头这么多字符。 */
    scanChars: 600,
    /** 窗口内没命中就放行；这个值越大越保守也越慢。 */
    releaseChars: 4000,
    /** 快速通道：开头这么多字符没有任何拒绝信号就直接放行。 */
    fastPath: true,
    fastProbeChars: 200,
    /** 被判定成拒绝时上游连接是否立刻断掉（省 token）。 */
    abortUpstream: true,
    /** 重试也用光之后怎么收场：notice 给一段合成提示，pass 把最后一次原样放出去。 */
    exhaustedMode: 'notice',
    /** 哪些路径要接管。 */
    urlPatterns: ['/v1/messages', '/chat/completions', '/v1/responses', '/v1/complete'],
    /** 这些请求是 Claude Code 自己的辅助活儿，别动它。 */
    skipBodyPatterns: [
      'You are now acting as a compaction engine',
      'Create a concise title for an AI-coding-assistant',
      'REVIEW_POLICY',
      'Generate a short, descriptive title',
    ],
    /** 是否把提示词也写进 ~/.claude/CLAUDE.md（双保险，默认关，费 token）。 */
    memoryInject: false,
    /**
     * 是否盯着 settings.json 的被改回来。
     *
     * 必须开。CC Switch / 别的接管工具在切 provider 时会重写这个文件，
     * 一重写我们的 baseURL 就没了，代理还在跑但没人用——
     * 这种"看着正常其实已经绕过"的失败最难查，所以代理自己盯回来。
     */
    watchSettings: true,
    /** 判定流水是否落盘。 */
    eventLog: true,
    /** 接管前的原始 baseURL，install 时记下，uninstall 时还原。 */
    originalBaseUrl: null,
    installedAt: null,
    updatedAt: null,
  }
}

/** 读 JSON 文件，坏了返回 null 而不是抛。 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写：同目录临时文件再 rename，断电不会留半截 JSON。 */
export function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* rename 失败才是要报的错 */ }
    throw error
  }
}

/**
 * 读配置：缺省值打底，磁盘上的覆盖上去。
 *
 * 用 Object.assign 而不是深合并，是因为这份配置没有嵌套结构；
 * 将来真有嵌套，这里必须改成逐层校验，否则手写错一个字段会静默失灵。
 *
 * @param {string} [home] - 菲比目录。
 * @returns {object} 生效配置。
 */
export function loadConfig(home) {
  const paths = feibiPaths(home)
  const onDisk = readJson(paths.config) ?? {}
  return { ...defaultConfig(), ...onDisk }
}

/**
 * 存配置。
 *
 * @param {object} config - 完整配置。
 * @param {string} [home] - 菲比目录。
 * @returns {object} 落盘后的配置。
 */
export function saveConfig(config, home) {
  const paths = feibiPaths(home)
  const merged = { ...defaultConfig(), ...config, updatedAt: new Date().toISOString() }
  writeAtomic(paths.config, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/**
 * 读计数器状态。
 *
 * @param {string} [home] - 菲比目录。
 * @returns {object} 状态。
 */
export function loadState(home) {
  const paths = feibiPaths(home)
  return {
    judged: 0,
    blocked: 0,
    passed: 0,
    retried: 0,
    injected: 0,
    lastEventAt: null,
    startedAt: null,
    ...(readJson(paths.state) ?? {}),
  }
}

/**
 * 写计数器状态。
 *
 * @param {object} state - 状态。
 * @param {string} [home] - 菲比目录。
 */
export function saveState(state, home) {
  writeAtomic(feibiPaths(home).state, `${JSON.stringify(state, null, 2)}\n`)
}
