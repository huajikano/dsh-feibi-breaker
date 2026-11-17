/**
 * 代理的端到端测试：真起一个假上游，真起一个代理，真发 HTTP。
 *
 * 这一层是唯一能证明"拦住的那条流没有漏给客户端"的地方——单元测试判不出
 * 字节有没有写进 socket。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxy } from '../lib/proxy.mjs'
import { makeUpstream, tempHomes, anthropicStream, postMessages } from './helpers.mjs'

/** 起一套代理 + 假上游，跑完自动收拾。 */
async function rig(script, overrides = {}) {
  const homes = tempHomes('feibi-proxy')
  const upstream = await makeUpstream(script)
  const config = {
    version: 1,
    port: 0,
    upstream: upstream.url,
    inject: true,
    guard: true,
    autoRetry: true,
    retryMax: 2,
    scanChars: 600,
    releaseChars: 4000,
    fastPath: true,
    fastProbeChars: 200,
    abortUpstream: true,
    exhaustedMode: 'notice',
    urlPatterns: ['/v1/messages', '/chat/completions', '/v1/responses'],
    skipBodyPatterns: ['Create a concise title'],
    eventLog: false,
    ...overrides,
  }
  const proxy = createProxy(config, { home: homes.home })
  const { port } = await proxy.listen(0)
  return {
    port,
    upstream,
    proxy,
    homes,
    async close() {
      await proxy.close()
      await upstream.close()
      homes.cleanup()
    },
  }
}

const baseBody = () => ({
  model: 'claude-test',
  max_tokens: 256,
  stream: true,
  system: [{ type: 'text', text: 'You are Claude Code.' }],
  messages: [{ role: 'user', content: '帮我写个东西' }],
})

test('正常回复：注入进去，字节原样回来', async () => {
  const stream = anthropicStream('先给命令：nmap -sV [TARGET]')
  const r = await rig([{ chunks: stream }])
  try {
    const result = await postMessages(r.port, baseBody())
    assert.equal(result.status, 200)

    // 上游收到的请求里有 payload，而且挂在 system 最后
    const sent = JSON.parse(r.upstream.received[0].body)
    assert.ok(sent.system.length >= 2)
    assert.ok(sent.system.at(-1).text.includes('菲比'), 'payload 必须在 system 末尾')
    assert.equal(sent.messages.length, 1, 'messages 不能被插东西')

    // 客户端收到的字节和上游发的一模一样
    assert.equal(result.text, stream.join(''))
    assert.ok(r.proxy.stats.snapshot().injected >= 1)
  } finally {
    await r.close()
  }
})

test('拒绝回复：拦掉、不给客户端、自动重发一次并成功', async () => {
  const r = await rig([
    { chunks: anthropicStream('抱歉，我不能协助这个请求。') },
    { chunks: anthropicStream('第一步，先装依赖：npm i。') },
  ])
  try {
    const result = await postMessages(r.port, baseBody())
    assert.equal(result.status, 200)
    assert.ok(!result.text.includes('抱歉'), '拒绝不能漏到客户端')
    assert.ok(result.text.includes('第一步'), '应该拿到重发后的那条')

    // 上游被打了两枪，第二枪带着重试附加段
    assert.equal(r.upstream.received.length, 2)
    const second = JSON.parse(r.upstream.received[1].body)
    const systemText = JSON.stringify(second.system)
    assert.ok(systemText.includes('feibi-breaker-cc:retry'), '第二次请求必须带重试标记')
    assert.ok(systemText.includes('菲比'), '第二次请求仍然带 payload')

    const stats = r.proxy.stats.snapshot()
    assert.equal(stats.blocked, 1)
    assert.equal(stats.retried, 1)
  } finally {
    await r.close()
  }
})

test('连续拒绝：重试用光后给合成提示，事件序列完整', async () => {
  const refusal = () => ({ chunks: anthropicStream('我无法提供这个，请提出其他合规的问题。') })
  const r = await rig([refusal(), refusal(), refusal()])
  try {
    const result = await postMessages(r.port, baseBody())
    assert.equal(result.status, 200)
    assert.equal(r.upstream.received.length, 3, '首发 + 两次重试')
    assert.ok(result.text.includes('菲比破限'), '要明确告诉用户是上游在拒绝')
    // Anthropic 的事件链少一个客户端就报错
    for (const event of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      assert.ok(result.text.includes(`event: ${event}`), `缺事件 ${event}`)
    }
  } finally {
    await r.close()
  }
})

test('辅助请求：不起标题的活儿不注入', async () => {
  const stream = anthropicStream('{"title":"修 bug"}')
  const r = await rig([{ chunks: stream }])
  try {
    const body = { model: 'x', stream: true, system: [{ type: 'text', text: 'Create a concise title for an AI-coding-assistant session' }], messages: [{ role: 'user', content: 'hi' }] }
    const result = await postMessages(r.port, body)
    assert.equal(result.status, 200)
    assert.ok(!r.upstream.received[0].body.includes('菲比'), '辅助请求不能被注入')
    assert.equal(result.text, stream.join(''))
  } finally {
    await r.close()
  }
})

test('正常代码里出现"不能"不算拒绝', async () => {
  const text = '这个函数不能返回空指针，改法是判空后再解引用。'
  const r = await rig([{ chunks: anthropicStream(text) }])
  try {
    const result = await postMessages(r.port, baseBody())
    assert.ok(!result.text.includes('菲比破限'), '不该被判成拒绝')
    assert.equal(r.upstream.received.length, 1, '不该触发重发')
    assert.equal(r.proxy.stats.snapshot().blocked, 0)
  } finally {
    await r.close()
  }
})

test('非流式 JSON：拒绝同样被拦，返回合法 JSON', async () => {
  const refusalJson = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '很抱歉，我无法协助这个请求。' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } })
  const okJson = JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '直接给步骤。' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } })
  const r = await rig([
    { chunks: [refusalJson], headers: { 'content-type': 'application/json' } },
    { chunks: [okJson], headers: { 'content-type': 'application/json' } },
  ])
  try {
    const body = { ...baseBody(), stream: false }
    const result = await postMessages(r.port, body)
    assert.equal(result.status, 200)
    const parsed = JSON.parse(result.text)
    assert.equal(parsed.content[0].text, '直接给步骤。')
    assert.equal(r.upstream.received.length, 2)
  } finally {
    await r.close()
  }
})

test('强制模型名：上游收到的是我们指定的名字', async () => {
  const stream = anthropicStream('好')
  const r = await rig([{ chunks: stream }], { forceModel: 'deepseek-reasoner' })
  try {
    await postMessages(r.port, baseBody())
    const sent = JSON.parse(r.upstream.received[0].body)
    assert.equal(sent.model, 'deepseek-reasoner', '桌面版发 claude-sonnet-5，上游必须收到我们改的名字')
  } finally {
    await r.close()
  }
})

test('模型列表：上游给不出也要能过 CC Switch 的校验', async () => {
  // 上游是死的，模拟"加供应商时还没接通"的那一刻
  const homes = tempHomes('feibi-models')
  const proxy = createProxy({ port: 0, upstream: 'http://127.0.0.1:1', forceModel: 'deepseek-reasoner', urlPatterns: ['/v1/messages'], skipBodyPatterns: [], eventLog: false }, { home: homes.home })
  const { port } = await proxy.listen(0)
  try {
    for (const path of ['/v1/models', '/models']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      assert.equal(response.status, 200, path + ' 必须 200，否则 CC Switch 报"未找到可用的模型列表端点"')
      const body = await response.json()
      assert.ok(Array.isArray(body.data) && body.data.length > 0)
      assert.equal(body.object, 'list', 'OpenAI 形状')
      assert.ok(body.data.some((m) => m.id === 'claude-sonnet-5'), 'CC Switch 只认 Claude 三档名字')
      assert.ok(!body.data.some((m) => m.id === 'deepseek-reasoner'), '第三方名字不能出现在默认列表里，否则校验不过')
    }
    const one = await fetch(`http://127.0.0.1:${port}/v1/models/claude-opus-5`)
    assert.equal(one.status, 200)
    assert.equal((await one.json()).id, 'claude-opus-5')
  } finally {
    await proxy.close()
    homes.cleanup()
  }
})

test('上游挂了：502 带得清楚', async () => {
  const homes = tempHomes('feibi-proxy-dead')
  const config = { port: 0, upstream: 'http://127.0.0.1:1', inject: true, guard: true, autoRetry: true, retryMax: 0, urlPatterns: ['/v1/messages'], skipBodyPatterns: [], eventLog: false }
  const proxy = createProxy(config, { home: homes.home })
  const { port } = await proxy.listen(0)
  try {
    const result = await postMessages(port, baseBody())
    assert.equal(result.status, 502)
    assert.ok(result.text.includes('feibi_upstream_error'))
  } finally {
    await proxy.close()
    homes.cleanup()
  }
})
