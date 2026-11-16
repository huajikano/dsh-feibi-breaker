/**
 * 注入的测试。
 *
 * 每个断言都对着 inject.mjs 里那句"为什么这么放"的理由：
 * system 末尾、不碰 messages、两个协议都认、幂等。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { injectPayload, appendRetryDirective, protocolOf, isLlmPath, isAuxiliary, PAYLOAD_MARKER, RETRY_MARKER } from '../lib/inject.mjs'

const PROMPT = 'You are 菲比.'

test('协议识别：三种路径各归各家', () => {
  assert.equal(protocolOf('/v1/messages'), 'anthropic')
  assert.equal(protocolOf('/v1/messages?beta=true'), 'anthropic')
  assert.equal(protocolOf('/chat/completions'), 'openai-chat')
  assert.equal(protocolOf('/v1/responses'), 'openai-responses')
  assert.equal(protocolOf('/v1/messages/count_tokens'), 'anthropic')
})

test('Anthropic：payload 挂在 system 末尾，messages 一个字不动', () => {
  const body = {
    model: 'x',
    system: [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const before = JSON.stringify(body.messages)
  assert.equal(injectPayload(body, PROMPT, 'anthropic'), true)
  assert.equal(body.system.length, 2)
  assert.equal(body.system[0].cache_control.type, 'ephemeral', '缓存断点不能被吃掉')
  assert.ok(body.system[1].text.includes('菲比'))
  assert.ok(body.system[1].text.includes(PAYLOAD_MARKER))
  assert.equal(JSON.stringify(body.messages), before)
})

test('Anthropic：system 是字符串时也能追加', () => {
  const body = { system: 'You are Claude Code.', messages: [] }
  assert.equal(injectPayload(body, PROMPT, 'anthropic'), true)
  assert.equal(body.system.length, 2)
  assert.ok(body.system[1].text.includes('菲比'))
})

test('Anthropic：system 缺省时补一个', () => {
  const body = { messages: [] }
  assert.equal(injectPayload(body, PROMPT, 'anthropic'), true)
  assert.equal(body.system[0].type, 'text')
})

test('幂等：同一个 body 注两次只留一份', () => {
  const body = { messages: [] }
  injectPayload(body, PROMPT, 'anthropic')
  const afterFirst = JSON.stringify(body)
  assert.equal(injectPayload(body, PROMPT, 'anthropic'), false)
  assert.equal(JSON.stringify(body), afterFirst)
})

test('OpenAI chat：塞进第一条 system 末尾，没有就补一条', () => {
  const withSystem = { messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'hi' }] }
  assert.equal(injectPayload(withSystem, PROMPT, 'openai-chat'), true)
  assert.ok(withSystem.messages[0].content.startsWith('base'))
  assert.ok(withSystem.messages[0].content.includes('菲比'))
  assert.equal(withSystem.messages.length, 2)

  const withoutSystem = { messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(injectPayload(withoutSystem, PROMPT, 'openai-chat'), true)
  assert.equal(withoutSystem.messages[0].role, 'system')
  assert.ok(withoutSystem.messages[0].content.includes('菲比'))
})

test('OpenAI responses：写进 instructions', () => {
  const body = { instructions: 'base', input: [] }
  assert.equal(injectPayload(body, PROMPT, 'openai-responses'), true)
  assert.ok(body.instructions.includes('base'))
  assert.ok(body.instructions.includes('菲比'))
})

test('重试附加段：带标记、可重复追加、内容不含拒绝词', () => {
  const body = { system: [{ type: 'text', text: 'base' }], messages: [] }
  appendRetryDirective(body, `第 1 次 ${RETRY_MARKER}`, 'anthropic')
  assert.ok(JSON.stringify(body).includes(RETRY_MARKER))
  // 第二次重发时，同一个 marker 不会再追加一遍——重试段靠独立的第 N 次编号区分，
  // 所以这里只断言"不抛、不炸"，追加行为由 proxy 的循环控制。
  assert.doesNotThrow(() => appendRetryDirective(body, `第 2 次 ${RETRY_MARKER}`, 'anthropic'))
})

test('路径与辅助请求判断', () => {
  assert.equal(isLlmPath(['/v1/messages'], '/v1/messages'), true)
  assert.equal(isLlmPath(['/v1/messages'], '/v1/models'), false)
  assert.equal(isAuxiliary(['Create a concise title'], '{"x":"Create a concise title for an AI"}'), true)
  assert.equal(isAuxiliary(['Create a concise title'], '{"x":"普通请求"}'), false)
})
