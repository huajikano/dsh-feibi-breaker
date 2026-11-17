#!/usr/bin/env node
/**
 * Anthropic→OpenAI 转换口（命令行入口）。
 *
 * 场景：本地聚合器（如 127.0.0.1:8326）只讲 OpenAI 协议，而 Claude Code 只会说
 * Anthropic 协议。CC Switch 不会替你翻译，它把 /v1/messages 原样转过去，上游 404，
 * 桌面版就显示"Gateway 未能提供 claude-haiku-5-5"。
 *
 * 用法：
 *   node bin/feibi-bridge.mjs --upstream http://127.0.0.1:8326 --key sk-… --model zcode/GLM-5.3-Flash
 *   node bin/feibi-bridge.mjs --port 45731 --quiet      # 用上次记住的配置
 *
 * 然后把客户端（或 CC Switch 的 provider）的 ANTHROPIC_BASE_URL 指到
 * http://127.0.0.1:45731 即可。
 *
 * @module feibi-breaker-cc/bridge-cli
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createBridge, DEFAULT_PORT } from '../lib/anthropic2openai.mjs'

/** 记住上次用的参数，免得每次敲一长串。 */
const CONFIG = path.join(os.homedir(), '.claude', 'feibi', 'bridge.json')

/** 解析 --key value。 */
function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))

let saved = {}
try {
  saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
} catch {
  saved = {}
}

const upstream = typeof flags.upstream === 'string' ? flags.upstream : saved.upstream
const key = typeof flags.key === 'string' ? flags.key : saved.key
const model = typeof flags.model === 'string' ? flags.model : saved.model
const port = Number(flags.port) > 0 ? Number(flags.port) : (saved.port ?? DEFAULT_PORT)

if (!upstream) {
  process.stderr.write('缺少 --upstream（例：--upstream http://127.0.0.1:8326）\n')
  process.exit(1)
}

try {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
  fs.writeFileSync(CONFIG, `${JSON.stringify({ upstream, key, model, port }, null, 2)}\n`, 'utf8')
} catch {
  // 记不住也不影响本次运行
}

const bridge = createBridge({
  upstream,
  key,
  model,
  port,
  // 每个请求都记一行：404 的时候能一眼看出是谁在打什么路径
  log: (line) => {
    const stamp = new Date().toISOString();
    process.stdout.write(`[${stamp}] ${line}\n`);
  },
})
const actual = await bridge.listen()
process.stdout.write(`转换口已启动：http://127.0.0.1:${actual}  →  ${upstream}${model ? `（模型固定为 ${model}）` : ''}\n`)
process.stdout.write('把 ANTHROPIC_BASE_URL 指到上面这个地址即可。\n')

const shutdown = async () => {
  await bridge.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
