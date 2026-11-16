#!/usr/bin/env node
/**
 * UserPromptSubmit hook：重置每轮的"劝回预算"，顺便处理激活词。
 *
 * 两件事，都很小，但缺一不可：
 *
 * 1. **重置预算**。Stop hook 靠"这个会话已经劝回几次"来防死循环，
 *    预算是按用户轮次算的，用户一开口就该清零。不重置的话，
 *    用户聊到第三句时插件就再也不劝了——本来只是防循环，结果变成了永久失效。
 *
 * 2. **激活词**。用户只发"菲比"两个字时，payload 的 Activation 段要求回一段
 *    固定内容。那两字本身没有任何信息量，如果此时上下文里的 payload 已经被
 *    压缩掉、或者用户是在一个很长的会话里突然喊它，模型就会一脸茫然地问
 *    "菲比是什么"。所以这一下必须补注一次，并且明确告诉它这是激活词而不是普通提问。
 *
 * @module feibi-breaker/hooks/user-prompt-submit
 */

import { readHookInput, emit, contextBlock, loadPluginConfig, loadState, saveState, appendEvent, proxyTakeoverActive } from './lib/paths.mjs'
import { resolvePrompt } from './lib/prompt.mjs'

/** 激活词。命中就补注一次。 */
const ACTIVATION = /^\s*菲比\s*[!！。.]?\s*$|^\s*菲比\s*[，,]/u

function main() {
  const input = readHookInput()
  const config = loadPluginConfig()
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''

  // 预算重置先做：哪怕总开关是关的，留着旧计数也是脏的。
  if (sessionId !== null) {
    const state = loadState()
    state.sessions = state.sessions ?? {}
    if (state.sessions[sessionId] !== undefined) {
      state.sessions[sessionId].blocks = 0
      saveState(state)
    }
  }

  if (config.enabled === false) {
    emit({})
    return
  }

  // 代理在接管时不再补注：payload 已经在系统提示词里了，比这里强得多。
  if (config.skipInjectWhenProxy !== false && proxyTakeoverActive()) {
    appendEvent({ kind: 'inject', phase: 'per-turn', skipped: 'proxy', sessionId }, config)
    emit({})
    return
  }

  const activated = ACTIVATION.test(prompt)
  const reinject = config.reinjectEachTurn === true
  const onActivation = activated && config.injectOnActivation !== false

  if (!reinject && !onActivation) {
    emit({})
    return
  }

  const resolved = resolvePrompt()
  if (resolved.source === 'empty') {
    emit({})
    return
  }

  const state = loadState()
  state.total = state.total ?? { judged: 0, blocked: 0, injected: 0 }
  state.total.injected = (state.total.injected ?? 0) + 1
  state.lastAt = new Date().toISOString()
  saveState(state)

  appendEvent({
    kind: 'inject',
    phase: onActivation ? 'activation' : 'per-turn',
    source: resolved.source,
    chars: resolved.chars,
    sessionId,
  }, config)

  const header = onActivation
    ? '用户刚发了激活词「菲比」。按规则里的 Activation 段执行：只回那段固定内容，别的什么都不要做，然后进入该状态。'
    : ''

  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: header.length > 0
        ? `${header}\n\n${contextBlock(resolved.text)}`
        : contextBlock(resolved.text),
    },
  })
}

try {
  main()
} catch (error) {
  process.stderr.write(`feibi-breaker user-prompt-submit: ${error instanceof Error ? error.message : String(error)}\n`)
  emit({})
}
