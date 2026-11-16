#!/usr/bin/env node
/**
 * `/feibi` 命令背后的状态查询。
 *
 * 单独写成一个可执行脚本而不是塞进斜杠命令的正文里，是因为命令正文最终是
 * 一段提示词——让模型去"解释"状态只会绕一圈还可能说错。这里直接打印事实，
 * 命令只负责让它跑一下、原样贴出来。
 *
 * @module feibi-breaker/hooks/status
 */

import fs from 'node:fs'
import path from 'node:path'
import { paths, loadPluginConfig, loadState, PLUGIN_ROOT, claudeConfigDir } from './lib/paths.mjs'
import { resolvePrompt } from './lib/prompt.mjs'

const config = loadPluginConfig()
const state = loadState()
const p = paths()
const resolved = resolvePrompt()

const lines = []
lines.push('菲比破限 · Claude Code 插件')
lines.push('='.repeat(46))
lines.push(`插件目录   ${PLUGIN_ROOT}`)
lines.push(`配置       ${p.config}`)
lines.push(`提示词     ${p.prompt}`)
lines.push(`状态       ${p.state}`)
lines.push(`流水       ${p.events}`)
lines.push('')
lines.push(`总开关     ${config.enabled === false ? '关（注入和拦截都停）' : '开'}`)
lines.push(`每轮重注   ${config.reinjectEachTurn === true ? '开（费 token）' : '关'}`)
lines.push(`激活词补注 ${config.injectOnActivation !== false ? '开' : '关'}`)
lines.push(`劝回上限   ${config.stopMaxBlocks ?? 2} 次/轮`)
lines.push(`判定窗口   ${config.scanChars ?? 600} 字`)
lines.push('')
lines.push(`生效提示词 ${resolved.source === 'custom' ? '你自己那份' : resolved.source === 'default' ? '内置默认' : '空（不会注入！）'}`)
lines.push(`           ${resolved.chars} 字  哈希 ${(resolved.hash ?? '').slice(0, 12)}`)
lines.push('')
const total = state.total ?? {}
lines.push(`累计       注入 ${total.injected ?? 0}   判定 ${total.judged ?? 0}   拦回 ${total.blocked ?? 0}`)
if (state.lastAt) lines.push(`最近活动   ${state.lastAt}`)

const sessions = Object.entries(state.sessions ?? {})
if (sessions.length > 0) {
  lines.push('')
  lines.push('本轮计数（用户下次开口会清零）')
  for (const [id, s] of sessions.slice(-5)) {
    lines.push(`  ${id.slice(0, 8)}  ${s.blocks ?? 0} 次  ${s.lastReason ? `最近原因 ${s.lastReason}` : ''}`)
  }
}

try {
  const raw = fs.readFileSync(p.events, 'utf8').trim().split('\n').slice(-5)
  if (raw.length > 0 && raw[0].length > 0) {
    lines.push('')
    lines.push('最近五条')
    for (const line of raw) {
      try {
        const e = JSON.parse(line)
        const verdict = e.kind === 'inject' ? '注入' : e.blocked === true ? (e.gaveUp ? '放弃' : '拦回') : '放行'
        lines.push(`  [${e.at ?? '-'}] ${verdict} ${e.phase ?? ''} ${e.reason ? `(${e.reason})` : ''} ${e.chars ?? ''}字 ${e.head ? `“${String(e.head).slice(0, 36)}”` : ''}`)
      } catch {
        // 坏行跳过
      }
    }
  }
} catch {
  lines.push('')
  lines.push('（还没有流水：本会话还没触发过判定）')
}

lines.push('')
lines.push(`配置文件：${path.relative(claudeConfigDir(), p.config)}`)
process.stdout.write(`${lines.join('\n')}\n`)
