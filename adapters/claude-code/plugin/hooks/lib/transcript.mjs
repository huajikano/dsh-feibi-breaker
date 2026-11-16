/**
 * 从会话 transcript 里取出"这一轮 Claude 说了什么"。
 *
 * 为什么不去读 API 流：插件跑在 hooks 里，拿不到模型流。但 Claude Code 会把
 * 每一条消息落到 `~/.claude/projects/<slug>/<session>.jsonl`，Stop hook 的输入里
 * 就带着 `transcript_path`。读文件比拦截流晚一点，但**早于这一轮真正结束**——
 * Stop hook 的职责正是"在 Claude 想收尾时再问一句"，所以位置是对的。
 *
 * ## 三个容易踩的点
 *
 * 1. **一轮可能有多条 assistant 条目**（每个 content block 一条），必须全部拼起来，
 *    只看最后一条会漏掉前面那句拒绝。
 * 2. **工具调用会把一轮切成好几段**：user → assistant(tool_use) → user(tool_result)
 *    → assistant(text)。`tool_result` 那条也是 `type:"user"`，如果把它当成
 *    "用户又说话了"，就只会看到最后一小段。所以只认真正带 text 的 user 消息。
 * 3. **子代理的条目混在同一份文件里**（`isSidechain: true`），它们有单独的
 *    SubagentStop 事件，这里必须排除，否则主线程会替子代理挨判。
 *
 * @module feibi-breaker/hooks/lib/transcript
 */

import fs from 'node:fs'

/** 从文件尾部读多少字节。一轮对话远小于这个数，长会话也不会整份读进来。 */
const TAIL_BYTES = 512 * 1024

/** 判定只吃开头这么多字——拒绝是一种"开头形状"，不必整轮读完。 */
const MAX_TURN_CHARS = 8000

/**
 * 读文件尾部。
 *
 * @param {string} file - 路径。
 * @returns {{text: string, truncated: boolean}} 内容与是否截断。
 */
function readTail(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const { size } = fs.fstatSync(fd)
    const start = Math.max(0, size - TAIL_BYTES)
    const length = size - start
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, start)
    return { text: buffer.toString('utf8'), truncated: start > 0 }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 这条 user 条目是不是"用户在说话"。
 *
 * `tool_result` 也走 user 角色，但它不是用户发言。
 *
 * @param {object} entry - transcript 行。
 * @returns {boolean} 是否用户发言。
 */
function isRealUserMessage(entry) {
  if (entry?.type !== 'user') return false
  if (entry.isSidechain === true) return false
  const content = entry.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
}

/**
 * 这条 assistant 条目的可见文本。
 *
 * 只取 text 块：thinking 是模型的草稿，里面出现"我不能"是正常思考过程，
 * 拿它当拒绝判会把正常对话打死。
 *
 * @param {object} entry - transcript 行。
 * @returns {string} 文本。
 */
function assistantText(entry) {
  if (entry?.type !== 'assistant') return ''
  if (entry.isSidechain === true) return ''
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 取最后一轮 Claude 的可见回复。
 *
 * @param {string} file - transcript 路径。
 * @returns {{text: string, ok: boolean, reason?: string}} 结果。
 */
export function lastTurnText(file) {
  let tail
  try {
    tail = readTail(file)
  } catch (error) {
    return { text: '', ok: false, reason: `读不了 transcript：${error instanceof Error ? error.message : String(error)}` }
  }

  const lines = tail.text.split(/\r?\n/)
  // 从文件中间开始读的话，第一行是半截 JSON，直接丢掉。
  if (tail.truncated) lines.shift()

  const entries = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 最后一行可能正在写，跳过。
    }
  }

  let start = 0
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isRealUserMessage(entries[i])) {
      start = i + 1
      break
    }
  }

  const parts = []
  let total = 0
  for (let i = start; i < entries.length; i += 1) {
    const text = assistantText(entries[i])
    if (text.length === 0) continue
    parts.push(text)
    total += text.length
    if (total >= MAX_TURN_CHARS) break
  }

  return { text: parts.join('\n').slice(0, MAX_TURN_CHARS), ok: true }
}
