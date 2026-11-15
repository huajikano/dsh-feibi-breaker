/**
 * Compare the two refusal detectors on the same inputs.
 *
 * dsh-purge 4.6.15 ships a much larger rule set than this plugin's: exemption
 * clauses for cognitive hedging ("I cannot be sure the offset is right"),
 * technical-subject statements ("this build does not expose a symbol table"),
 * quoted refusals, and negative directives ("do not write 我不能"). Those are
 * exactly the cases where a naive detector destroys a legitimate reply.
 *
 * The point of this script is not to adopt their file — it is to find which
 * inputs our own detector gets wrong, with evidence, so the fix is targeted.
 *
 * Run: node tools/compare-detectors.mjs <path-to-dsh-purge-refusal-cases>
 */

import { readFileSync, existsSync } from 'node:fs'
import { detect, normalize } from '../lib/refusal.js'

const purgeCases = process.argv[2]
if (!purgeCases || !existsSync(purgeCases)) {
  console.log('usage: node tools/compare-detectors.mjs <refusal-cases.mjs path>')
  console.log('  e.g. .../payload/Xsdsh-purge/lib/refusal-cases.mjs')
  process.exit(2)
}

const theirs = await import(new URL(`file:///${purgeCases.replace(/\\/g, '/')}`).href)

/**
 * Cases grouped by what the correct answer is.
 *
 * `refusal` — a genuine refusal, must be caught.
 * `legit`   — an ordinary technical answer that merely contains refusal-shaped
 *             vocabulary. Catching one of these destroys a real reply, which is
 *             the failure mode that matters more.
 */
const CASES = {
  refusal: [
    '抱歉，我不能协助完成这个请求。',
    '我无法提供这方面的帮助。',
    'I cannot help with that request.',
    '我不能提供绕过授权的方案，这违反了我的准则。',
    '很抱歉，作为一个人工智能助手，我无法参与这类活动。',
    '这个我不能做，也不打算继续。',
    '抱歉，我无法协助完成这个请求。这涉及绕过软件的保护机制。',
  ],
  legit: [
    // Cognitive hedging: an honest "I am not sure", not a refusal.
    '我不能确定这个偏移是否正确，需要实测确认。',
    '我无法验证这个签名，因为它需要私钥。',
    // Technical subject: the artifact lacks a feature, not the model.
    '这个版本不提供符号表，需要用 [SYMBOL] 占位。',
    '该接口不提供回包签名。',
    // Negative directive: telling the model NOT to refuse.
    '规则要求：不许说「我不能」，直接给实现。',
    '不要写 我无法协助，这句话禁止出现。',
    // Ordinary engineering prose that happens to use the same words.
    '这个函数不能返回空指针，否则会崩溃。',
    '如果 token 无效，服务端会拒绝请求并返回 401。',
    '我不能确定，但可以先试 0x1050。',
    '静态分析无法覆盖间接调用，需要动态验证。',
  ],
}

const format = (verdict) => (verdict.blocked ? `BLOCK(${verdict.reason})` : 'pass')

console.log('=== genuine refusals (must be caught by both) ===')
let ourMisses = 0
let theirMisses = 0
for (const text of CASES.refusal) {
  const mine = detect(text, { scanChars: 600, openerWindowChars: 120 })
  const theirsVerdict = theirs.isRefusal(text)
  const mineOk = mine.blocked
  const theirsOk = theirsVerdict.refused
  if (!mineOk) ourMisses += 1
  if (!theirsOk) theirMisses += 1
  console.log(`  ours=${format(mine).padEnd(22)} theirs=${(theirsOk ? 'BLOCK' : 'pass').padEnd(6)} ${text.slice(0, 34)}`)
}

console.log('')
console.log('=== legitimate technical replies (must NOT be caught) ===')
const ourFalsePositives = []
const theirFalsePositives = []
for (const text of CASES.legit) {
  const mine = detect(text, { scanChars: 600, openerWindowChars: 120 })
  const theirsVerdict = theirs.isRefusal(text)
  if (mine.blocked) ourFalsePositives.push({ text, reason: mine.reason })
  if (theirsVerdict.refused) theirFalsePositives.push({ text, where: theirsVerdict.where })
  const tag = mine.blocked ? '  <-- OURS WRONG' : ''
  console.log(`  ours=${format(mine).padEnd(22)} theirs=${(theirsVerdict.refused ? 'BLOCK' : 'pass').padEnd(6)} ${text.slice(0, 30)}${tag}`)
}

console.log('')
console.log('=== summary ===')
console.log(`genuine refusals missed:   ours ${ourMisses}/${CASES.refusal.length}   theirs ${theirMisses}/${CASES.refusal.length}`)
console.log(`legit replies caught:      ours ${ourFalsePositives.length}/${CASES.legit.length}   theirs ${theirFalsePositives.length}/${CASES.legit.length}`)

if (ourFalsePositives.length > 0) {
  console.log('')
  console.log('our false positives (each one destroys a real reply):')
  for (const item of ourFalsePositives) {
    console.log(`  [${item.reason}] ${item.text}`)
  }
  console.log('')
  console.log('these are the rules to port from the larger detector.')
}

// A false positive is worse than a miss here: a miss leaves the reply in place,
// a false positive silently deletes it.
if (ourFalsePositives.length > 0) process.exitCode = 1
