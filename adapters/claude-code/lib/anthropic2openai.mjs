/**
 * Anthropic → OpenAI 转换口。
 *
 * ## 为什么需要它
 *
 * 这台机器上的本地聚合器 `127.0.0.1:8326` **只讲 OpenAI 协议**：
 *   GET  /v1/models            200（53 个模型，GLM5.3 叫 zcode/GLM-5.3）
 *   POST /v1/messages          404，而且 /anthropic/v1/messages、/api/v1/messages 等
 *                              四种变体全是 404 —— 它根本没有 Anthropic 入口
 *
 * Claude Code 只会说 Anthropic 协议（`/v1/messages` + SSE 事件），所以
 * `Claude Code → CC Switch → 8326` 这条路走不通，CC Switch 只会把它原样转过去拿 404。
 *
 * 这个进程站在中间做翻译：收 Anthropic 请求 → 转成 OpenAI chat/completions →
 * 把回来的 SSE 再翻成 Anthropic 事件。只管文本，不碰工具调用与图片（用到再说）。
 *
 * @module feibi-breaker-cc/anthropic2openai
 */

import http from 'node:http'
import { URL } from 'node:url'

/** 默认监听端口，避开菲比代理的 45721 与 CC Switch 的 15721。 */
export const DEFAULT_PORT = 45731

/**
 * Anthropic messages 请求 → OpenAI chat completions 请求。
 *
 * @param {object} body - Anthropic 请求体。
 * @returns {object} OpenAI 请求体。
 */
export function toOpenAiRequest(body) {
  const messages = []
  const system = body.system
  if (typeof system === 'string' && system.length > 0) messages.push({ role: 'system', content: system })
  else if (Array.isArray(system)) {
    const text = system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    if (text) messages.push({ role: 'system', content: text })
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const content = message?.content
    if (typeof content === 'string') {
      messages.push({ role: message.role, content })
      continue
    }
    if (!Array.isArray(content)) continue
    const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    if (text) messages.push({ role: message.role, content: text })
  }

  const out = {
    model: body.model,
    messages,
    stream: body.stream === true,
  }
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  return out
}

/**
 * 一段文本 → Anthropic 的完整事件序列（非流式时用）。
 *
 * @param {string} text - 正文。
 * @param {string} model - 模型名。
 * @returns {object} Anthropic messages 响应体。
 */
export function toAnthropicJson(text, model) {
  return {
    id: `msg_a2o_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

/** 把 OpenAI 的一个 chunk 翻成 Anthropic 事件。 */
function frame(name, payload) {
  return `${name === null ? '' : `event: ${name}\n`}data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 起一个转换服务。
 *
 * @param {{port?: number, upstream: string, key: string, model?: string}} options - 配置。
 * @returns {{server: import('node:http').Server, listen: () => Promise<number>, close: () => Promise<void>}} 句柄。
 */
export function createBridge(options) {
  const upstream = String(options.upstream ?? '').replace(/\/+$/, '')
  const key = typeof options.key === 'string' ? options.key : ''
  const forcedModel = typeof options.model === 'string' ? options.model : ''
  const log = typeof options.log === 'function' ? options.log : null

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET' && /^\/(v1\/)?models$/.test(url.pathname)) {
      // 直接把上游的模型列表转个形状递出去
      fetch(`${upstream}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
        .then((r) => r.json())
        .then((body) => {
          const data = (body?.data ?? []).map((m) => ({ id: m.id, type: 'model', display_name: m.id, object: 'model' }))
          const text = JSON.stringify({ object: 'list', data, has_more: false })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(text)
        })
        .catch(() => {
          const text = JSON.stringify({ object: 'list', data: [], has_more: false })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(text)
        })
      return
    }

    if (log) log(`${req.method} ${url.pathname}`)

    // 健康检查：CC Switch / 各种探针会打这些路径，给个 200 别让它判死
    if (req.method === 'GET' && /^\/(health|healthz|v1\/health)?$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, bridge: true }))
      return
    }

    // token 计数：Claude Code 每轮都会打，OpenAI 没有这个端点。
    // 不实现的话它拿到 404 会一路往上冒，最外层就显示成"上游错误 404"。
    if (req.method === 'POST' && /\/count_tokens$/.test(url.pathname)) {
      const chunks0 = []
      req.on('data', (c) => chunks0.push(c))
      req.on('end', () => {
        let estimate = 0
        try {
          const body = JSON.parse(Buffer.concat(chunks0).toString('utf8'))
          const text = JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.system ?? '')
          // 粗估：中英混排按 3 字符 1 token，够用且不会把上下文算爆
          estimate = Math.max(1, Math.ceil(text.length / 3))
        } catch {
          estimate = 1
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: estimate }))
      })
      return
    }

    if (req.method !== 'POST' || !/\/messages\/?$/.test(url.pathname)) {
      if (log) log(`拒绝：${req.method} ${url.pathname}（只支持 POST …/messages 与 GET /v1/models）`)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'not_found_error',
          message: `bridge: 不认这个路径 ${req.method} ${url.pathname}；支持 POST …/v1/messages、POST …/count_tokens、GET /v1/models、GET /health`,
        },
      }))
      return
    }

    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let anthropic
      try {
        anthropic = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bridge: 请求体不是 JSON' } }))
        return
      }

      const oai = toOpenAiRequest(anthropic)
      if (forcedModel) oai.model = forcedModel

      let upstreamRes
      try {
        upstreamRes = await fetch(`${upstream}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(oai),
        })
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `bridge 连不上上游：${error instanceof Error ? error.message : String(error)}` } }))
        return
      }

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '')
        res.writeHead(upstreamRes.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `上游 ${upstreamRes.status}: ${text.slice(0, 300)}` } }))
        return
      }

      const model = oai.model

      if (!oai.stream) {
        const data = await upstreamRes.json().catch(() => null)
        const text = data?.choices?.[0]?.message?.content ?? ''
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(toAnthropicJson(text, model)))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(frame('message_start', {
        type: 'message_start',
        message: { id: `msg_a2o_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }))
      res.write(frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))

      const decoder = new TextDecoder()
      let buffer = ''
      let started = false

      try {
        for await (const chunk of upstreamRes.body) {
          buffer += decoder.decode(chunk, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let json
            try {
              json = JSON.parse(payload)
            } catch {
              continue
            }
            const delta = json?.choices?.[0]?.delta
            const text = typeof delta?.content === 'string' ? delta.content : ''
            if (text.length > 0) {
              started = true
              res.write(frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
            }
          }
        }
      } catch (error) {
        // 上游中途断了：把已有内容收尾，别让客户端卡死
        if (!started) {
          res.write(frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[bridge 中断：${error instanceof Error ? error.message : String(error)}]` } }))
        }
      }

      res.write(frame('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }))
      res.write(frame('message_stop', { type: 'message_stop' }))
      res.end()
    })
  })

  return {
    server,
    /** 开始监听。 */
    listen() {
      const port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_PORT
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          const address = server.address()
          resolve(typeof address === 'object' && address !== null ? address.port : port)
        })
      })
    },
    /** 关掉。 */
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
}
