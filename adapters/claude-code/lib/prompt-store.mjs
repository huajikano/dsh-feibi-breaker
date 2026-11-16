/**
 * 提示词仓库：把 payload 变成用户能看见、能改、能回滚的文件。
 *
 * 从 dsh 版 prompt-store.js 移植，只换了两件事：
 *   - 家目录从 $DSH_HOME 换成 ~/.claude/feibi；
 *   - 去掉 host 的 `{{cwd}}` 插值转义——Claude Code 不做插值，
 *     转义反而会把 `{{` 写坏成 `{ {`。
 *
 * 解析是两级回退：
 *   ~/.claude/feibi/prompt.md   用户自己那份，非空就赢
 *   prompts/feibi.md（内置）     出厂默认，只读
 *
 * `source` 字段是重点：`custom` / `default` / `empty` 三种状态在 UI 上必须能区分，
 * 否则"用的是默认"和"我改过"会变成同一个输入框，用户永远不知道自己在跑哪份。
 *
 * @module feibi-breaker-cc/prompt-store
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { feibiPaths, writeAtomic } from './config.mjs'
import { defaultPayloadText } from './core-text.mjs'

/** 内置默认 payload。 */
const BUNDLED_PROMPT = fileURLToPath(new URL('../prompts/feibi.md', import.meta.url))

/** 允许的最大提示词体积。比这个大就是搞错了。 */
export const MAX_PROMPT_BYTES = 256 * 1024

/**
 * 归一化，只用于比较，不用于注入。
 *
 * Windows 编辑器和 Linux 编辑器的换行、行尾空白不一样，但语义一样。
 * 不归一化的话，同一段文字保存两次会被算成改了两次。
 *
 * @param {unknown} text - 原文。
 * @returns {string} 归一化后的文本。
 */
export function normalizePrompt(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '').trim()
}

/**
 * sha256。
 *
 * @param {unknown} text - 原文。
 * @returns {string} 十六进制摘要。
 */
export function hashPrompt(text) {
  return createHash('sha256').update(normalizePrompt(text), 'utf8').digest('hex')
}

/**
 * 内置默认文本。
 *
 * 两级：仓库里没有明文规则（上游把 payload 封在 `core/payload.bin`），所以先问
 * `lib/core.js` 要；拿不到才回退到明文本（便携安装/测试里可能放了这么一份）。
 *
 * @returns {string} 文本。
 */
export function defaultPromptText() {
  const fromCore = defaultPayloadText()
  if (normalizePrompt(fromCore)) return fromCore
  try {
    return fs.readFileSync(BUNDLED_PROMPT, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 读用户那份。
 *
 * @param {string} [home] - 菲比目录。
 * @returns {string} 文本，没有就是空串。
 */
export function readCustomPrompt(home) {
  try {
    return fs.readFileSync(feibiPaths(home).prompt, 'utf8')
  } catch {
    return ''
  }
}

/** 读提示词状态文件。 */
function readPromptState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(feibiPaths(home).promptState, 'utf8'))
    return {
      customized: parsed?.customized === true,
      hash: typeof parsed?.hash === 'string' ? parsed.hash : null,
      seedHash: typeof parsed?.seedHash === 'string' ? parsed.seedHash : null,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return { customized: false, hash: null, seedHash: null, updatedAt: null }
  }
}

/** 写提示词状态文件。 */
function writePromptState(home, state) {
  writeAtomic(feibiPaths(home).promptState, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * mtime 缓存。
 *
 * `resolvePrompt` 每轮请求都要调一次，每次同步读 5KB 文件没必要；
 * 一个 entries 就够，因为只有一个家目录。
 */
let cache = { home: '', mtime: 0, size: 0, resolved: null }

/**
 * 解析当前生效的那份。
 *
 * @param {string} [home] - 菲比目录。
 * @param {{fresh?: boolean}} [options] - 跳过缓存。
 * @returns {object} 解析结果。
 */
export function resolvePrompt(home, { fresh = false } = {}) {
  const paths = feibiPaths(home)
  const fallback = defaultPromptText()
  const seedHash = fallback ? hashPrompt(fallback) : null

  let mtime = 0
  let size = 0
  try {
    const stat = fs.statSync(paths.prompt)
    mtime = stat.mtimeMs
    size = stat.size
  } catch {
    mtime = 0
    size = 0
  }

  if (!fresh && cache.resolved !== null && cache.home === paths.root && cache.mtime === mtime && cache.size === size) {
    return cache.resolved
  }

  const custom = readCustomPrompt(paths.root)
  const state = readPromptState(paths.root)
  const customNorm = normalizePrompt(custom)

  let text = ''
  let source = 'empty'
  if (customNorm) {
    text = custom
    // 文件存在但内容恰好等于出厂文本，不算自定义。seed 会把默认写到磁盘，
    // 那时候给用户亮"已自定义"徽章是骗人的。
    source = hashPrompt(custom) === seedHash ? 'default' : 'custom'
  } else if (normalizePrompt(fallback)) {
    text = fallback
    source = 'default'
  }

  const resolved = {
    text,
    source,
    file: paths.prompt,
    customized: source === 'custom',
    chars: normalizePrompt(text).length,
    hash: text ? hashPrompt(text) : null,
    seedHash,
    updatedAt: state.updatedAt,
  }
  cache = { home: paths.root, mtime, size, resolved }
  return resolved
}

/** 丢掉缓存。写完立刻调用，否则下一次读还是旧的。 */
export function invalidatePromptCache() {
  cache = { home: '', mtime: 0, size: 0, resolved: null }
}

/**
 * 保存用户那份。
 *
 * 空内容直接拒绝：空文件会让注入静默回落到默认，而界面上是一个空框，
 * 这种"看不见的回退"正是这个模块要消灭的东西。
 *
 * @param {string} [home] - 菲比目录。
 * @param {unknown} content - 新内容。
 * @returns {object} 结果。
 */
export function savePrompt(home, content) {
  const paths = feibiPaths(home)
  if (typeof content !== 'string') return { ok: false, error: '内容必须是字符串' }
  if (!normalizePrompt(content)) return { ok: false, error: '提示词不能为空；要回到内置默认请用 feibi-cc prompt reset' }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_PROMPT_BYTES) return { ok: false, error: `超过 ${MAX_PROMPT_BYTES} 字节上限（当前 ${bytes}）` }

  try {
    writeAtomic(paths.prompt, content)
  } catch (error) {
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const fallback = defaultPromptText()
  const seedHash = fallback ? hashPrompt(fallback) : null
  writePromptState(paths.root, {
    customized: hashPrompt(content) !== seedHash,
    hash: hashPrompt(content),
    seedHash,
    updatedAt: new Date().toISOString(),
  })
  invalidatePromptCache()
  return { ok: true, ...resolvePrompt(paths.root, { fresh: true }) }
}

/**
 * 删掉用户那份，回到出厂默认。
 *
 * @param {string} [home] - 菲比目录。
 * @returns {object} 结果。
 */
export function resetPrompt(home) {
  const paths = feibiPaths(home)
  try {
    fs.unlinkSync(paths.prompt)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, error: `删除失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const fallback = defaultPromptText()
  writePromptState(paths.root, {
    customized: false,
    hash: fallback ? hashPrompt(fallback) : null,
    seedHash: fallback ? hashPrompt(fallback) : null,
    updatedAt: new Date().toISOString(),
  })
  invalidatePromptCache()
  return { ok: true, ...resolvePrompt(paths.root, { fresh: true }) }
}

/**
 * 首次安装时把默认落到磁盘。
 *
 * 用户想改提示词，总得先有个文件能打开；"界面上给的那个路径还不存在"是很糟的第一印象。
 * 已经有内容的文件永远不碰。
 *
 * @param {string} [home] - 菲比目录。
 * @returns {object} 发生了什么。
 */
export function seedPromptFile(home) {
  const paths = feibiPaths(home)
  const fallback = defaultPromptText()
  if (normalizePrompt(readCustomPrompt(paths.root))) return { action: 'kept', file: paths.prompt }
  if (!normalizePrompt(fallback)) return { action: 'empty_default', file: paths.prompt }
  try {
    writeAtomic(paths.prompt, fallback)
    const hash = hashPrompt(fallback)
    writePromptState(paths.root, { customized: false, hash, seedHash: hash, updatedAt: new Date().toISOString() })
    invalidatePromptCache()
    return { action: 'created', file: paths.prompt }
  } catch {
    // 只读家目录不该让安装失败：内置默认照样能注入，只是文件种不下去。
    return { action: 'kept', file: paths.prompt }
  }
}
