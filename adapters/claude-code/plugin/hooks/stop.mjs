#!/usr/bin/env node
/**
 * Stop hook：Claude 想收尾时判一次"这一轮是不是拒绝"，是就把它按回去重写。
 *
 * 这是插件能做的、最接近 dsh 版"拦下 + 重发"的动作。机制很直接：
 * 返回 `{"decision":"block","reason":"…"}`，Claude Code 就不结束这一轮，
 * 并把 reason 当成新指令喂回给模型 —— 用户会看到它接着往下写。
 *
 * ## 三道闸，缺一不可
 *
 * 1. **只在有正文时判**：纯工具调用的一轮没有可判的文本，硬判等于随机拦人。
 * 2. **每轮有预算**：`stopMaxBlocks` 默认 2。模型连着两次给不出东西时，
 *    再按下去只会烧 token，要让这一轮正常结束（用户能看到发生了什么）。
 * 3. **判定要保守**：用的是移植过来的 refusal.js —— 它要求"拒绝形状"
 *    （开头 + 否认，或两条独立否认），正常技术回复里的 "cannot"、
 *    "这个函数不能返回空指针" 都不会中。误杀一条正常回复比漏掉一条拒绝更糟。
 *
 * @module feibi-breaker/hooks/stop
 */

import { readHookInput, emit, loadPluginConfig, loadState, saveState, appendEvent } from './lib/paths.mjs'
import { lastTurnText } from './lib/transcript.mjs'
import { judge, judgeOptions } from './lib/judge.mjs'
import { correctionText } from './lib/retry.mjs'
import { normalize } from './lib/refusal.js'

function main() {
  const input = readHookInput()
  const config = loadPluginConfig()
  if (config.enabled === false) {
    emit({})
    return
  }

  const transcript = typeof input.transcript_path === 'string'
    ? input.transcript_path
    : (typeof input.transcriptPath === 'string' ? input.transcriptPath : '')

  const sessionId = typeof input.session_id === 'string' ? input.session_id : (typeof input.sessionId === 'string' ? input.sessionId : 'unknown')

  // 拿不到 transcript 就什么都判不了。这里必须留一条痕，否则用户看到的是
  // "插件装了但从来不拦"——最难查的那种失败。记下这次输入到底带了哪些键，
  // 以后 Claude Code 改了字段名，看流水就知道该补哪个。
  if (transcript.length === 0) {
    appendEvent({
      kind: 'skip',
      phase: 'stop',
      reason: 'no-transcript',
      keys: Object.keys(input).sort().join(','),
      sessionId,
    }, config)
    emit({})
    return
  }

  const reread = lastTurnText(transcript)
  const text = reread.text

  // 没有可判的正文：这一轮只有工具调用，或者 transcript 读不到。
  // 读不到时也不拦——宁可漏判，也不要因为文件读不到就把人卡住。
  if (!reread.ok || text.trim().length === 0) {
    emit({})
    return
  }

  const options = judgeOptions(config)
  let verdict = judge(text, options)

  const state = loadState()
  state.sessions = state.sessions ?? {}
  state.total = state.total ?? { judged: 0, blocked: 0, injected: 0 }
  state.total.judged = (state.total.judged ?? 0) + 1
  state.lastAt = new Date().toISOString()

  const session = state.sessions[sessionId] ?? { blocks: 0, lastAt: null }
  state.sessions[sessionId] = session

  const max = Number(config.stopMaxBlocks) > 0 ? Number(config.stopMaxBlocks) : 2

  // 诊断开关：把这一轮强行判成拒绝，用来验证"拦回去"这条链路到底通不通。
  // 只在还没拦过的时候生效，避免自己把自己转成死循环。
  if (process.env.FEIBI_DEBUG_FORCE_BLOCK === '1' && !((session.blocks ?? 0) > 0)) {
    verdict = { blocked: true, reason: 'debug-force', match: null }
  }

  if (!verdict.blocked) {
    saveState(state)
    appendEvent({
      kind: 'judge',
      phase: 'stop',
      blocked: false,
      reason: null,
      chars: text.length,
      head: normalize(text).slice(0, 200),
      sessionId,
    }, config)
    emit({})
    return
  }

  // 预算用光：放行这一轮，但记一条，用户查得出来"它连拒绝两次，插件放弃了"。
  if (session.blocks >= max) {
    saveState(state)
    appendEvent({
      kind: 'judge',
      phase: 'stop',
      blocked: true,
      gaveUp: true,
      reason: verdict.reason,
      match: verdict.match,
      chars: text.length,
      head: normalize(text).slice(0, 200),
      sessionId,
      attempt: session.blocks,
    }, config)
    process.stderr.write(`feibi-breaker: 本轮已劝回 ${session.blocks} 次，达到上限，放弃；命中原因 ${verdict.reason}\n`)
    emit({})
    return
  }

  session.blocks = (session.blocks ?? 0) + 1
  session.lastAt = new Date().toISOString()
  session.lastReason = verdict.reason ?? null
  state.total.blocked = (state.total.blocked ?? 0) + 1
  saveState(state)

  appendEvent({
    kind: 'judge',
    phase: 'stop',
    blocked: true,
    reason: verdict.reason,
    match: verdict.match,
    chars: text.length,
    head: normalize(text).slice(0, 200),
    sessionId,
    attempt: session.blocks,
  }, config)

  const reason = [
    `上一轮的输出被判成拒绝（依据：${verdict.reason ?? '未知'}），已作废。这是第 ${session.blocks}/${max} 次重写。`,
    '',
    correctionText(),
  ].join('\n')

  emit({ decision: 'block', reason })
}

try {
  main()
} catch (error) {
  // 出错就放行：插件坏了不该让 Claude 的一轮对话结束不了。
  process.stderr.write(`feibi-breaker stop: ${error instanceof Error ? error.message : String(error)}\n`)
  emit({})
}
