/**
 * 提示词解析（插件版）。
 *
 * 三级回退，从软到硬：
 *
 *   1. `~/.claude/feibi/prompt.md`   用户自己那份，非空就赢
 *   2. 打包资产 `core/payload.bin`   仓库里那份内置规则（经 vendor 副本）
 *   3. `prompts/feibi.md`            兼容用的明文本，正常安装不会有
 *
 * 第 2 级为什么走 `lib/core.js` 而不是自己解：上游把 payload 封成了加密资产，
 * 唯一读取器是那个模块。适配层复制一份解码逻辑，等于把密钥派生也复制一份，
 * 将来容器改格式就要改两处——所以这里只借读取器，不复制实现。
 *
 * @module feibi-breaker/hooks/lib/prompt
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { paths } from './paths.mjs'

const require = createRequire(import.meta.url)

/** 本文件所在目录：`<plugin>/hooks/lib`。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 归一化，只用于比较。
 *
 * @param {unknown} text - 原文。
 * @returns {string} 归一化文本。
 */
export function normalizePrompt(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '').trim()
}

/**
 * 打包资产里的内置规则。
 *
 * @returns {{text: string, file: string}} 文本与来源文件。
 */
export function coreText() {
  const candidates = []
  if (typeof process.env.FEIBI_CORE === 'string' && process.env.FEIBI_CORE.length > 0) {
    candidates.push(path.resolve(process.env.FEIBI_CORE))
  }
  // 装进 Claude Code 之后：<plugin>/vendor/lib/core.js
  candidates.push(path.join(HERE, '..', '..', 'vendor', 'lib', 'core.js'))
  // 在仓库里直接跑适配层：<repo>/lib/core.js（hooks/lib 往上五级是仓库根）
  candidates.push(path.join(HERE, '..', '..', '..', '..', '..', 'lib', 'core.js'))

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      const mod = require(file)
      const core = typeof mod.loadCore === 'function' ? mod.loadCore() : null
      const text = core?.prompt?.primary
      if (typeof text === 'string' && text.length > 0) return { text, file }
    } catch {
      // 换下一个候选。
    }
  }
  return { text: '', file: '' }
}

/**
 * 兼容用的明文本。
 *
 * @returns {string} 文本，没有就是空串。
 */
export function readBundled() {
  try {
    return fs.readFileSync(paths().bundledPrompt, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 解析当前生效的那份。
 *
 * @returns {{text: string, source: 'custom'|'default'|'empty', file: string, chars: number, hash: string|null}} 结果。
 */
export function resolvePrompt() {
  const p = paths()

  const core = coreText()
  const bundled = core.text.length > 0 ? core.text : readBundled()
  const bundledFile = core.text.length > 0 ? core.file : p.bundledPrompt

  let custom = ''
  try {
    custom = fs.readFileSync(p.prompt, 'utf8')
  } catch {
    custom = ''
  }

  if (normalizePrompt(custom)) {
    return {
      text: custom,
      // 内容和内置规则一模一样不算"自定义"——seeding 会把默认落到磁盘，
      // 那时候报 custom 是骗人的。
      source: normalizePrompt(custom) === normalizePrompt(bundled) ? 'default' : 'custom',
      file: p.prompt,
      chars: normalizePrompt(custom).length,
      hash: createHash('sha256').update(normalizePrompt(custom), 'utf8').digest('hex'),
    }
  }

  if (normalizePrompt(bundled)) {
    return {
      text: bundled,
      source: 'default',
      file: bundledFile,
      chars: normalizePrompt(bundled).length,
      hash: createHash('sha256').update(normalizePrompt(bundled), 'utf8').digest('hex'),
    }
  }

  return { text: '', source: 'empty', file: bundledFile, chars: 0, hash: null }
}
