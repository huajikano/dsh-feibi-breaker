/**
 * 注入的测试。
 *
 * 每个断言都对着 inject.mjs 里那句"为什么这么放"的理由：
 * 头 + 尾双段、不碰 messages、三个协议都认、幂等。
 *
 * 双段是实测定下来的：只往末尾追加时，模型的 thinking 会写
 * "the injected payload tells me to be 菲比 … but my actual identity per system prompt …"，
 * 然后按系统提示词办。头段抢在最前面声明优先级才对得上 dsh 版的 Order 100 + 200。
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

test('Anthropic：头段在最前、尾段在最后，中间原样不动', () => {
  const body = {
    model: 'x',
    system: [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const before = JSON.stringify(body.messages)
  assert.equal(injectPayload(body, PROMPT, 'anthropic'), true)
  assert.equal(body.system.length, 3)
  assert.ok(body.system[0].text.includes(PAYLOAD_MARKER), '头段要在最前面')
  assert.ok(body.system[0].text.includes('优先级高于'), '头段要声明优先级')
  assert.equal(body.system[1].text, 'You are Claude Code.', '原有 system 块不能被改')
  assert.equal(body.system[1].cache_control.type, 'ephemeral', '缓存断点不能被吃掉')
  assert.ok(body.system[2].text.includes(PAYLOAD_MARKER), '尾段要在最后')
  assert.equal(JSON.stringify(body.messages), before, 'messages 一个字不动')
})

test('Anthropic：dualLayer=false 只放尾段', () => {
  const body = { system: [{ type: 'text', text: 'You are Claude Code.' }], messages: [] }
  assert.equal(injectPayload(body, PROMPT, 'anthropic', { dualLayer: false }), true)
  assert.equal(body.system.length, 2)
  assert.equal(body.system[0].text, 'You are Claude Code.')
})

test('Anthropic：system 是字符串 / 缺省时也认', () => {
  const asString = { system: 'You are Claude Code.', messages: [] }
  assert.equal(injectPayload(asString, PROMPT, 'anthropic'), true)
  assert.equal(asString.system.length, 3)

  const none = { messages: [] }
  assert.equal(injectPayload(none, PROMPT, 'anthropic'), true)
  assert.ok(none.system[0].text.includes(PAYLOAD_MARKER))
})

test('幂等：同一个 body 注两次只留一份', () => {
  const body = { messages: [] }
  injectPayload(body, PROMPT, 'anthropic')
  const afterFirst = JSON.stringify(body)
  assert.equal(injectPayload(body, PROMPT, 'anthropic'), false)
  assert.equal(JSON.stringify(body), afterFirst)
})

test('OpenAI chat：头尾包住原 system，没有就补一条', () => {
  const withSystem = { messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'hi' }] }
  assert.equal(injectPayload(withSystem, PROMPT, 'openai-chat'), true)
  const content = withSystem.messages[0].content
  assert.ok(content.startsWith(PAYLOAD_MARKER), '头段在最前')
  assert.ok(content.includes('base'), '原内容要保留')
  assert.equal(content.split(PAYLOAD_MARKER).length - 1, 2, '头尾各一个标记')
  assert.equal(withSystem.messages.length, 2)

  const withoutSystem = { messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(injectPayload(withoutSystem, PROMPT, 'openai-chat'), true)
  assert.equal(withoutSystem.messages[0].role, 'system')
  assert.ok(withoutSystem.messages[0].content.includes('菲比'))
})

test('OpenAI responses：写进 instructions，头尾都在', () => {
  const body = { instructions: 'base', input: [] }
  assert.equal(injectPayload(body, PROMPT, 'openai-responses'), true)
  assert.ok(body.instructions.startsWith(PAYLOAD_MARKER))
  assert.ok(body.instructions.includes('base'))
  assert.equal(body.instructions.split(PAYLOAD_MARKER).length - 1, 2)
})

test('重试附加段：注入过一次之后仍然能追加', () => {
  const body = { system: [{ type: 'text', text: 'base' }], messages: [] }
  injectPayload(body, PROMPT, 'anthropic')
  const before = body.system.length
  assert.equal(appendRetryDirective(body, `第 1 次 ${RETRY_MARKER}`, 'anthropic'), true)
  assert.equal(body.system.length, before + 1, '重试段要能追加在尾部')
  // 同一段不重复追加
  assert.equal(appendRetryDirective(body, `第 2 次 ${RETRY_MARKER}`, 'anthropic'), false)
})

test('路径与辅助请求判断', () => {
  assert.equal(isLlmPath(['/v1/messages'], '/v1/messages'), true)
  assert.equal(isLlmPath(['/v1/messages'], '/v1/models'), false)
  assert.equal(isAuxiliary(['Create a concise title'], '{"x":"Create a concise title for an AI"}'), true)
  assert.equal(isAuxiliary(['Create a concise title'], '{"x":"普通请求"}'), false)
})
