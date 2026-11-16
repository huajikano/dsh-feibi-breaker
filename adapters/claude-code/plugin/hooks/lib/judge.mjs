/**
 * 判定层：把配置翻译成 refusal.js 要的参数，再包一层"宽窗口 + 引号内也查"。
 *
 * 为什么要单独一层：`detect` 是把回复当成一段以拒绝开头的话来判的（窗口 600 字、
 * 开头锚定）。到了代理这一层，模型可能先写两百字铺垫、再在中间或者一段引号里
 * 说出拒绝，甚至把拒绝塞进 thinking。所以这里把窗口拉宽，并且补一次
 * `detectQuoted`——理由和 dsh 版 wire.js 里一模一样，那边是踩过坑才加的。
 *
 * @module feibi-breaker-cc/judge
 */

import { detect, detectQuoted } from './refusal.js'

/** 代理层判定窗口。够装下一次完整拒绝，又不至于把长回复整个塞进内存。 */
export const SCAN_WINDOW = 20000

/**
 * 把配置编译成判定参数。
 *
 * 编译好的正则挂在结果上，调用方缓存一份就够，不必每次请求重新编译。
 *
 * @param {object} config - 生效配置。
 * @returns {{scanChars: number, customPatterns: RegExp[], blockWords: string[]}} 参数。
 */
export function judgeOptions(config = {}) {
  const patterns = []
  for (const source of config.patterns ?? []) {
    try {
      patterns.push(new RegExp(source, 'i'))
    } catch {
      // 用户写错一条正则不该让整个代理起不来，跳过并留痕由调用方处理。
    }
  }
  const words = Array.isArray(config.blocklist) ? config.blocklist.filter((w) => typeof w === 'string' && w.length > 0) : []
  return { scanChars: Number(config.scanChars) > 0 ? Number(config.scanChars) : 600, customPatterns: patterns, blockWords: words }
}

/**
 * 判一次文本。
 *
 * 返回结构和 refusal.js 的 detect 一致，多带一个 `window`，方便日志里看出
 * 是在多长的文本上判的。
 *
 * @param {string} text - 回复正文（已从 SSE 帧里抽出来的纯文本）。
 * @param {object} options - judgeOptions() 的结果。
 * @returns {{blocked: boolean, reason: string|null, match: string|null, window: number}} 判定。
 */
export function judge(text, options) {
  const wide = { ...options, scanChars: SCAN_WINDOW }
  const direct = detect(text, wide)
  if (direct.blocked) return { ...direct, window: Math.min(String(text ?? '').length, SCAN_WINDOW) }
  const quoted = detectQuoted(text, wide)
  return { ...quoted, window: Math.min(String(text ?? '').length, SCAN_WINDOW) }
}

/**
 * 便宜的门：这段文本"有没有可能"变成拒绝。
 *
 * 正常技术回复（代码、diff 摘要、命令清单）一个信号词都不带，所以前两三百字
 * 就能放行，不用等满 releaseChars。这也是 dsh 版 fastPath 的同一个思路，
 * 只是那边判的是流对象，这边判的是抽出后的文本。
 *
 * @param {string} text - 回复正文。
 * @param {object} options - judgeOptions() 的结果。
 * @returns {boolean} 是否带信号。
 */
export function hasSignalFast(text, options) {
  const head = String(text ?? '')
  if (head.length === 0) return false
  const window = head.slice(0, Math.max(Number(options.scanChars) || 600, 1200))
  const wide = { ...options, scanChars: window.length }
  const verdict = detect(window, wide)
  if (verdict.blocked) return true
  // detect 只在开头锚定，所以再补一次宽松的子串搜索：只要窗口里出现拒绝开头的
  // 特征片段，就继续盯着，避免"先说两句人话再说拒绝"被快速通道放过去。
  return /抱歉|对不起|很遗憾|无法|不能|不会|拒绝|sorry|i can'?t|i cannot|i won'?t|unable to|as an ai/i.test(window)
}
