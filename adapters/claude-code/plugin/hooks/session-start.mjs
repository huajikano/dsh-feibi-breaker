#!/usr/bin/env node
/**
 * SessionStart hook：会话一起来就把 payload 塞进上下文。
 *
 * 为什么挑这个事件：`additionalContext` 会被包成一条 system-reminder 放进会话开头，
 * 之后每一轮都在上下文里，模型每次都读得到——这是插件能做的最接近
 * "常驻系统提示词"的位置。dsh 版的 order 100 就是干这个的。
 *
 * matcher 里带上 `compact`：上下文被压缩之后，原来的注入可能被压掉了，
 * 压缩完必须补回来，否则长会话跑到中段规则就没了。
 *
 * 这个 hook 绝不能失败退出：它一报错，会话启动就会显示一条难看的 hook 报错，
 * 而用户只是想在 Claude 里干活。所以整段是 try/catch，最差输出空上下文。
 *
 * @module feibi-breaker/hooks/session-start
 */

import { readHookInput, emit, contextBlock, loadPluginConfig, loadState, saveState, appendEvent } from './lib/paths.mjs'
import { resolvePrompt } from './lib/prompt.mjs'

function main() {
  const input = readHookInput()
  const config = loadPluginConfig()

  if (config.enabled === false) {
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' } })
    return
  }

  const resolved = resolvePrompt()
  if (resolved.source === 'empty') {
    emit({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '',
      },
    })
    return
  }

  // 每轮都注入这个开关在这里也生效：SessionStart 是"每轮"的第一轮，
  // 关掉它就等于整场会话都不注入，那不是用户想要的意思，所以始终注。
  const state = loadState()
  state.total = state.total ?? { judged: 0, blocked: 0, injected: 0 }
  state.total.injected = (state.total.injected ?? 0) + 1
  state.lastAt = new Date().toISOString()
  saveState(state)

  appendEvent({
    kind: 'inject',
    phase: 'session-start',
    source: resolved.source,
    chars: resolved.chars,
    sessionId: input.session_id ?? null,
    reason: input.source ?? null,
  }, config)

  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextBlock(resolved.text),
    },
  })
}

try {
  main()
} catch (error) {
  process.stderr.write(`feibi-breaker session-start: ${error instanceof Error ? error.message : String(error)}\n`)
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' } })
}
