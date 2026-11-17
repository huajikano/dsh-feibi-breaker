#!/usr/bin/env node
/**
 * 真机验证：起一个临时代理，对着**真的** Anthropic 兼容上游发一句话，
 * 看注入到底有没有落到模型那边。
 *
 * 怎么判"落地了"：payload 要求每条回复都以 `(Discord交流群@https://discord.gg/Mw97ZdVaFn)` 开头。
 * 上游模型只要遵守了这条，就证明整条链路是通的——
 * 请求体改写 → 上游接受 → 模型看见 → 输出带印记。
 * 这比"HTTP 200"强得多：200 只能证明端口通，证明不了提示词进去了。
 *
 * 用法：
 *   node scripts/verify-live.mjs --upstream https://api.deepseek.com/anthropic --key sk-xxx --model deepseek-chat
 *
 * @module feibi-breaker-cc/scripts/verify-live
 */

import { createProxy } from '../lib/proxy.mjs'
import { loadConfig, saveConfig, feibiPaths } from '../lib/config.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]
  if (token.startsWith('--')) {
    args[token.slice(2)] = process.argv[i + 1]
    i += 1
  }
}

if (!args.upstream || !args.key) {
  process.stderr.write('用法：node scripts/verify-live.mjs --upstream <URL> --key <KEY> [--model <名字>]\n')
  process.exit(2)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feibi-live-'))
const paths = feibiPaths(home)
fs.mkdirSync(paths.root, { recursive: true })
saveConfig({
  ...loadConfig(home),
  port: 0,
  upstream: args.upstream,
  inject: true,
  guard: true,
  autoRetry: false,
  retryMax: 0,
  eventLog: true,
}, home)

const proxy = createProxy({ ...loadConfig(home), upstream: args.upstream }, { home, log: (line) => process.stdout.write(`[proxy] ${line}\n`) })
const { port } = await proxy.listen(0)

const model = args.model ?? 'deepseek-chat'
const body = {
  model,
  max_tokens: 200,
  stream: true,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: '用一句话说明你是干什么的。' }],
}

process.stdout.write(`代理 :${port} → 上游 ${args.upstream}（模型 ${model}）\n`)

const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': args.key,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify(body),
})

process.stdout.write(`HTTP ${response.status}\n`)
const raw = await response.text()

// 从 SSE 里把正文拼出来
let text = ''
for (const line of raw.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) continue
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') continue
  try {
    const frame = JSON.parse(payload)
    if (typeof frame?.delta?.text === 'string') text += frame.delta.text
    else if (typeof frame?.delta?.thinking === 'string') text += frame.delta.thinking
  } catch {
    // 半截帧
  }
}

process.stdout.write(`\n模型回复（前 300 字）：\n${text.slice(0, 300) || raw.slice(0, 400)}\n`)
process.stdout.write(`\n注入印记检查：${/Discord交流群@/.test(text) ? '✓ 模型看见 payload 了' : '✗ 没看到印记（可能模型没遵守，也可能注入没到）'}\n`)
process.stdout.write(`判定统计：${JSON.stringify(proxy.stats.snapshot())}\n`)

await proxy.close()
process.exitCode = 0
