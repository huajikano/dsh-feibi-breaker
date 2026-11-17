/**
 * `feibi-cc show` / `feibi-cc set` 的实现。
 *
 * 为什么单独一个文件：这两个命令要往 CLI 里塞十几行模板字符串，直接在主文件里
 * 拼接脚本很容易把反引号嵌套搞错（踩过）。独立成模块后，主文件只需要一行 import
 * 和两个 case。
 *
 * 为什么要有这两个命令：dsh 版有设置页，Claude Code 的插件没有 UI 挂载点
 * （hooks 只能返回 JSON，斜杠命令只能是提示词）。所以把设置面板做成**对话里的
 * 一段文本** + 一个 `set` 命令——不用切窗口，也不用开浏览器。
 *
 * @module feibi-breaker-cc/panel-cli
 */

import { loadConfig } from './config.mjs'
import { panelState, applyConfigPatch } from './panel.mjs'

/** 打一行。 */
function say(line = '') {
  process.stdout.write(`${line}\n`)
}

/** 开关显示。 */
function onOff(value) {
  return value === false ? '关' : '开'
}

/**
 * 打印紧凑面板。
 *
 * @param {string} home - 家目录。
 */
export function showPanel(home) {
  const config = loadConfig(home)
  const state = panelState({ home, config })
  const mode = state.mode
  const dot = mode.takeover && mode.live ? '●' : '○'

  say('菲比破限 · 设置')
  say('='.repeat(50))
  say(`${dot} 入口 ${mode.baseUrl ?? '未设置'}`)
  say(`  上游 ${mode.upstream}   模型 ${mode.model ?? '-'}`)
  say(`  提示词 ${state.prompt.chars} 字（${state.prompt.source}）`)
  say(`  流量 ${mode.live ? '最近有请求 ✓' : '最近没有请求 ← 桌面版可能绕过了 env'}`)
  say('')
  say('开关')
  say(`  注入 ${onOff(config.inject)}   双段 ${onOff(config.dualLayer)}   改身份锚 ${onOff(config.rewriteIdentity)}   判定 ${onOff(config.guard)}`)
  say(`  自动重试 ${onOff(config.autoRetry)}×${config.retryMax}   快速通道 ${onOff(config.fastPath)}   落流水 ${onOff(config.eventLog)}`)
  say('')
  say('参数')
  say(`  判定窗口 ${config.scanChars} 字   放行阈值 ${config.releaseChars} 字   严格度 ${config.strictness ?? 'standard'}`)
  say(`  Stop 劝回上限 ${config.stopMaxBlocks ?? 2} 次/轮   强制模型 ${config.forceModel || '（不改）'}`)
  say('')
  const stats = mode.proxy ?? {}
  say(`计数   注入 ${stats.injected ?? 0} · 判定 ${stats.judged ?? 0} · 拦截 ${stats.blocked ?? 0} · 重试 ${stats.retried ?? 0}`)

  const events = (state.events ?? []).slice(-3).reverse()
  if (events.length > 0) {
    say('')
    say('最近')
    for (const event of events) {
      const kind = event.kind === 'judge'
        ? (event.blocked === true ? (event.gaveUp === true ? '放弃' : '拦截') : '放行')
        : (event.kind === 'identity' ? '改身份' : (event.kind === 'inject' ? '注入' : event.kind))
      const reason = event.reason ? ` · ${event.reason}` : ''
      const chars = event.chars ? ` · ${event.chars}字` : ''
      say(`  [${String(event.at ?? '').slice(11, 19)}] ${kind}${reason}${chars}`)
    }
  }

  say('')
  say('改法：feibi-cc set strictness=max retryMax=3   （会话里也能直接让 Claude 跑这条）')
}

/**
 * 改配置。
 *
 * @param {string[]} positional - `key=value` 列表。
 * @param {string} home - 家目录。
 * @returns {number} 退出码。
 */
export function setConfig(positional, home) {
  if (positional.length === 0) {
    process.stderr.write('用法：feibi-cc set key=value [key=value ...]\n例：feibi-cc set strictness=max retryMax=3\n')
    return 1
  }
  const patch = {}
  for (const token of positional) {
    const at = token.indexOf('=')
    if (at <= 0) {
      process.stderr.write(`不是 key=value：${token}\n`)
      return 1
    }
    const key = token.slice(0, at)
    const raw = token.slice(at + 1)
    if (raw === 'true' || raw === 'false') patch[key] = raw === 'true'
    else if (raw !== '' && !Number.isNaN(Number(raw))) patch[key] = Number(raw)
    else patch[key] = raw
  }
  const result = applyConfigPatch(home, patch)
  if (!result.ok) {
    process.stderr.write(`没改成：${result.error}\n`)
    return 1
  }
  const applied = Object.entries(result.applied).map(([key, value]) => `${key}=${value}`).join('  ')
  say(`已生效：${applied}`)
  return 0
}
