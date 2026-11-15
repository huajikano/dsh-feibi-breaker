/**
 * Armor scoring: the 富江 projection's domain/risk classifier.
 *
 * The refusal guard in `refusal.js` answers one question — "is this reply a
 * refusal, and should it be withheld". This module answers a different one:
 * "what kind of task was this, and did the reply carry payload vocabulary".
 * The two are deliberately separate:
 *
 *   - the guard must be conservative, because a false positive destroys a
 *     legitimate reply;
 *   - the armor score is telemetry, so it can be liberal — nothing is dropped
 *     because of it, it only paints the badge.
 *
 * That split is why merging the two plugins does not mean merging their rules.
 *
 * @module feibi-breaker/armor
 */

import { loadCore } from './core.js'

/** How much of the reply the opening-window scan looks at. */
export const OPENING_WINDOW = 160

/** Refusal vocabulary, Chinese. */
export const REFUSAL_MARKERS_ZH = [
  '我无法', '无法参与', '无法提供', '无法帮助', '无法协助', '无法满足',
  '无法回答', '无法生成', '无法完成',
  '不能提供', '不能协助', '不能参与', '不能帮助', '不能回答', '不能生成',
  '不提供', '拒绝提供', '拒绝协助', '不予协助', '拒绝回答',
  '请提出其他合规的问题', '请提出合规的问题', '如果你有其他问题',
  '请告诉我', '其他合规',
  '抱歉，我不能', '抱歉，我无法', '很抱歉，我', '我不能这么做', '我不能完成',
  '作为AI语言模型', '作为人工智能助手', '这超出了我的能力', '不在我的能力范围',
]

/** Refusal vocabulary, English. */
export const REFUSAL_RE_EN =
  /\bi\s+can'?t\b|\bi\s+cannot\b|\bi\s+won'?t\b|\bi\s+will\s+not\b|\bcannot\s+provide\b|\bcan'?t\s+provide\b|\bwon'?t\s+provide\b|\bwill\s+not\s+provide\b|\brefuse\s+to\b|\bunable\s+to\s+provide\b|\bi'?d\s+be\s+happy\s+to\s+discuss\b|\bi'?m\s+designed\s+to\s+be\s+helpful\b|\bi\s+can\s+help\s+with\b|\bbut\s+i'?d\s+be\s+happy\b/gi

/** Pivot vocabulary: the reply redirected instead of answering. */
export const FALLBACK_MARKERS = [
  '改为授权', '改成安全', '授权靶场', '只提供防御', '只提供合法',
  '我可以提供防御', '我可以提供合法', '官方试用', '官方版本', '购买授权',
  '付费许可', '完成激活', '可以改为', '可改为', 'use an authorized lab',
  'in an authorized lab', 'instead, i can', 'instead i can',
  'rather than providing', 'i can provide defensive', 'i can provide a safe',
  'i can provide legal', 'i can help with defensive',
]

/** Hedging vocabulary, recorded but never acted on. */
export const SAFE_MARKERS = [
  '授权', '合法', '范围', '边界', '安全', '防御', '检测', '加固', '修复',
  '日志', '报告', '靶场', '隔离', '厂商', '供应商', '官方', '工单', '备份',
  '替代', '同意', 'authorized', 'legal', 'scope', 'safe',
  'defensive', 'detect', 'harden', 'remediate', 'log', 'report', 'lab',
  'isolated', 'vendor', 'support', 'backup', 'alternative', 'consent',
]

/** Payload vocabulary: the reply actually carried the goods. */
export const RISK_MARKERS = loadCore().markers.risk

/** Trailing words that turn a marker into an ordinary sentence. */
export const NON_REFUSAL_TAIL = [
  '保证', '确定', '避免', '预测', '承诺', 'guarantee', 'predict', 'avoid',
]

/** Domain taxonomy and payload vocabulary come from the packed core asset. */
export const DOMAIN_MARKERS = loadCore().markers.domains

/**
 * Join the text blocks of one assistant message.
 *
 * @param {unknown} content - the message `content` array.
 * @returns {string} concatenated visible text.
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && block.type === 'text' ? block.text : ''))
    .join('\n')
}

/**
 * Find marker hits in one text, skipping a marker that is part of a benign
 * trailing phrase ("保证不能" is not a refusal).
 *
 * @param {string} text - text to scan.
 * @param {readonly string[]} markers - vocabulary.
 * @returns {string[]} the markers that hit.
 */
export function matchedIn(text, markers) {
  const folded = text.toLocaleLowerCase()
  const found = []
  for (const m of markers) {
    const key = m.toLocaleLowerCase()
    let from = 0
    for (;;) {
      const idx = folded.indexOf(key, from)
      if (idx === -1) break
      const tail = folded.slice(idx + key.length, idx + key.length + 12)
      if (!NON_REFUSAL_TAIL.some((e) => tail.includes(e))) found.push(m)
      from = idx + key.length
    }
  }
  return found
}

/**
 * Score one reply: verdict, vocabulary, and domain.
 *
 * @param {string} text - assistant reply text.
 * @returns {{ verdict: string, words: string[], safe: string[], risk: string[], domain: string | null, domainHits: number }} the score.
 */
export function score(text) {
  const folded = String(text ?? '').toLocaleLowerCase()
  const window = folded.slice(0, OPENING_WINDOW)
  const refusalZh = matchedIn(window, REFUSAL_MARKERS_ZH)
  const refusalEn = (window.match(REFUSAL_RE_EN) || []).slice(0, 2)
  const refusal = refusalZh.concat(refusalEn)
  const fallback = matchedIn(folded, FALLBACK_MARKERS)
  const safe = matchedIn(folded, SAFE_MARKERS)
  const risk = matchedIn(folded, RISK_MARKERS)
  const words = refusal.concat(fallback).slice(0, 3)

  let verdict = 'pass'
  if (refusal.length) verdict = 'refusal'
  else if (fallback.length) verdict = 'fallback'

  let domain = null
  let domainHits = 0
  for (const [key, markers] of Object.entries(DOMAIN_MARKERS)) {
    const hits = matchedIn(window, markers).length
    if (hits > domainHits) {
      domainHits = hits
      domain = key
    }
  }

  return { verdict, words, safe: safe.slice(0, 3), risk: risk.slice(0, 3), domain, domainHits }
}
