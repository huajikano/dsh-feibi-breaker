/**
 * 打包 payload 的同步读取口。
 *
 * 上游把内置规则封在 `core/payload.bin` 里（AES-GCM + gzip 的 JSON），
 * 唯一的读取器是 `lib/core.js`。适配层必须复用那个读取器，而不是自己再解一遍密——
 * 复制一份解码逻辑等于复制一份密钥派生，将来换容器格式要改两处。
 *
 * 但 `core.js` 是 ESM，而这几个调用点（安装器、提示词仓库、命令行）是同步的。
 * Node ≥ 22.12 起 `require()` 可以同步加载没有顶层 await 的 ESM 图，
 * 于是这里用 `createRequire` 拿到同步加载能力，既复用唯一读取器，又不用把
 * 半条调用链改成 async。
 *
 * 找不到就返回空串，绝不抛：载荷读不到时，插件应当"能装上但注入为空"，
 * 而不是装不上。
 *
 * @module feibi-breaker-claude-code/core-text
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** 本文件所在目录：`<适配层>/lib`。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 候选路径，按顺序试。
 *
 *   1. `FEIBI_CORE`：显式指定（测试、便携安装）
 *   2. `<repo>/lib/core.js`：在仓库里直接跑适配层
 *   3. `<plugin>/vendor/lib/core.js`：装进 Claude Code 之后的 vendored 副本
 *
 * @returns {string[]} 候选路径。
 */
function candidates() {
  const list = []
  if (typeof process.env.FEIBI_CORE === 'string' && process.env.FEIBI_CORE.length > 0) {
    list.push(path.resolve(process.env.FEIBI_CORE))
  }
  // HERE = <repo>/adapters/claude-code/lib → 上三级是仓库根
  list.push(path.join(HERE, '..', '..', '..', 'lib', 'core.js'))
  // HERE = ~/.claude/plugins/feibi-breaker/hooks/lib → 上两级是插件根
  list.push(path.join(HERE, '..', '..', 'vendor', 'lib', 'core.js'))
  return list
}

/** 解出来的文本，按文件路径缓存（一次进程只解一次）。 */
let cache = { file: '', text: '' }

/**
 * 内置 payload 的明文。
 *
 * @returns {string} 文本；读不到就是空串。
 */
export function defaultPayloadText() {
  for (const file of candidates()) {
    if (cache.file === file) return cache.text
    if (!fs.existsSync(file)) continue
    try {
      const mod = require(file)
      const core = typeof mod.loadCore === 'function' ? mod.loadCore() : null
      const text = core?.prompt?.primary
      if (typeof text === 'string' && text.length > 0) {
        cache = { file, text }
        return text
      }
    } catch {
      // 这个候选坏了就试下一个；全部失败时返回空串。
    }
  }
  return ''
}

/**
 * 这次用的是哪个文件，给状态输出用。
 *
 * @returns {string} 路径；没读到就是空串。
 */
export function payloadSourcePath() {
  defaultPayloadText()
  return cache.file
}
