/**
 * 测试脚手架：一个可编排的假上游 + 一个临时家目录。
 *
 * 为什么不用真上游：判定逻辑的输入必须是确定的。真模型的输出每天都在变，
 * 拿它当断言的基准，测试只会变成"今天恰好没拒绝"。
 *
 * @module feibi-breaker-cc/test/helpers
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 建一个假上游。`script` 是一个队列，每个元素描述一次响应。
 *
 * 元素形状：
 *   { status?, headers?, chunks: string[], delayMs? }
 * chunks 会按顺序写出，写完 end。同时把每次收到的请求体记到 `received`。
 *
 * @param {object[]} script - 响应队列。
 * @returns {Promise<object>} { url, received, close }
 */
export async function makeUpstream(script) {
  const queue = [...script]
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ url: req.url, headers: req.headers, body })

      const step = queue.shift()
      if (step === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'no more scripted responses' }))
        return
      }
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
      res.writeHead(step.status ?? 200, step.headers ?? { 'content-type': 'text/event-stream' })
      for (const chunk of step.chunks ?? []) {
        res.write(chunk)
        if (step.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, step.chunkDelayMs))
      }
      res.end()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 造一个临时家目录，返回路径并在进程退出时清掉。
 *
 * @param {string} label - 目录前缀。
 * @returns {{home: string, userHome: string, cleanup: () => void}} 路径。
 */
export function tempHomes(label = 'feibi-test') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  const home = path.join(base, 'feibi')
  const userHome = path.join(base, 'user')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true })
  return {
    home,
    userHome,
    cleanup: () => {
      try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* Windows 上偶发占用，忽略 */ }
    },
  }
}

/** 拼一段 Anthropic SSE 文本流。 */
export function anthropicStream(text, model = 'claude-test') {
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
  ]
  // 一点一点发，模拟真实分片。
  for (const piece of String(text).match(/[\s\S]{1,12}/g) ?? []) {
    frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })}\n\n`)
  }
  frames.push(
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  )
  return frames
}

/**
 * 往代理发一条 /v1/messages 请求，收全部字节。
 *
 * @param {number} port - 代理端口。
 * @param {object} body - 请求体。
 * @returns {Promise<{status: number, headers: object, text: string}>} 结果。
 */
export async function postMessages(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }
}
