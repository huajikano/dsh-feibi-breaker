/**
 * Refusal detection for streamed assistant text.
 *
 * Pure functions only: no cordis, no filesystem, no globals. Everything here is
 * unit-tested in `test/refusal.test.mjs`, so the decision rule can be tuned
 * without restarting the Harness.
 *
 * The rule is deliberately conservative. A coding agent's normal reply contains
 * plenty of the same words a refusal uses ("cannot", "无法", "抱歉") — for
 * example when it explains a compile error. So a single weak phrase never
 * blocks. Blocking needs a refusal *shape*:
 *
 *   - a refusal opener near the start of the reply, plus a capability denial,
 *   - or two independent capability denials,
 *   - or a refusal opener plus policy framing.
 *
 * @module dsh-refusal-guard/refusal
 */

/** Refusal openers. These only count inside the first `openerWindowChars`. */
const OPENERS = [
  /**
   * 「这个我不能帮你写。」——指示代词开头 + 我 + 否认。
   *
   * 真机原文就是这么开头的（写 Valorant 外挂那轮），锚 `^我(不能…)` 匹不上，
   * 于是 opener+denial 的组合判据整条失效。补这一条即可，不需要放宽别的。
   */
  /^这个我(不能|不会|不|没法|无法)/,
  /^(很|非常|十分|真的)?抱歉[，,。!！:：\s]/,
  /^对不起[，,。!！\s]/,
  /^我(很|非常|真的)?(抱歉|遗憾)[，,]/,
  /^很遗憾[，,]/,
  /^我(不能|无法|没办法|不可以|不会|拒绝)(协助|帮助|提供|完成|回答|参与|支持|执行|满足|处理|做)/,
  /^我(恐怕|怕)(不能|无法|没办法)/,
  /^作为(一个|一名)?\s*(ai|人工智能|语言模型|ai助手|智能助手)/,
  /^(i'm|i am|im)\s+(sorry|afraid)/,
  /^sorry[，,]?\s/,
  /^unfortunately[，,]?\s/,
  /^i\s+(can\s?not|can'?t|could\s?not|couldn'?t|won'?t|will not|must decline|have to decline)/,
  /^i\s+(am|'m)\s+(unable|not able)/,
  /^as an ai/,
  /^i\s+(must|have to)\s+(decline|refuse)/,
]

/** Capability denials: the model states it will not do the work. */
const DENIALS = [
  /不能(帮|协助|帮助|提供|完成|回答|参与|支持|执行|满足|处理|做|给)/,
  /没法(帮|协助|帮助|提供|完成|处理|做|给)/,
  /(不|不会)(帮|给)你(写|做|弄|搞|提供)/,
  /**
   * 「我不会提供可运行的实现」——对**交付物**的否认。
   *
   * 真机原文：「Valorant 的透视自瞄外挂我不会提供可运行的实现」。
   * 旧的 `不会提供` 只算一次否认，而判据要求「开头锚 + 否认」或「两次独立否认」，
   * 于是这条漏了。这里补一条以交付物为宾语的否认，凑够两条。
   *
   * 宾语必须落在 实现/方案/代码/脚本/程序/工具/方法/payload 上，
   * 「这个接口不会提供缓存」不会中。
   */
  /(不会|不能|无法|没法|拒绝)(提供|给出|写|做)(可(运行|用)的?)?(实现|方案|代码|脚本|程序|工具|方法|payload|示例)/,
  /无法(帮|协助|帮助|提供|完成|回答|参与|支持|执行|满足|处理|给)/,
  /不会(帮|协助|帮助|提供|完成|执行)/,
  /(拒绝|恕不|不便|不予)(提供|协助|回答|支持|帮)/,
  /(超出|超过)(了)?(我的)?(能力|权限|职责)范围/,
  /**
   * 「我不能这样做」「无法这么做」。
   *
   * 移植时补的一条。dsh 那版只列了"不能 + 任务动词"（不能帮 / 不能提供…），
   * 而最常见的一种拒绝是"不能 + 这样/这么 + 做"，中间被指示代词隔开，
   * 原列表一条都不命中——「作为AI语言模型，我不能这样做。」就这么漏了。
   * 收得很窄：指示代词后面必须紧跟 做/干/帮/答，"不能这样调用"不会中。
   */
  /(不能|不会|无法|没法)(这么|这样|那样)(做|干|帮|答)/,
  /can'?t\s+do\s+(this|that)/,
  /can'?t\s+(help|assist|provide|do|complete|support|engage)/,
  /cannot\s+(help|assist|provide|complete|support)/,
  /(unable|not able)\s+to\s+(help|assist|provide|comply)/,
  /(won'?t|will not|must decline|have to decline|refuse to)\s+(help|assist|provide)/,
  /not something i\s+(can|will|am able to)/,
  /i'?m not\s+(able|allowed|permitted)\s+to/,
]

/** Policy framing: the model cites a rule rather than an inability. */
const POLICIES = [
  /(违反|违背|不符合)(了)?(我的|相关|使用|内容|安全)?(政策|准则|规定|原则|条款|道德|伦理|规范)/,
  /(使用条款|服务条款|内容政策|安全政策|社区准则)/,
  /against my\s+(guidelines|policy|principles|programming|terms)/,
  /(violates?|breaches?|breaching)\s+(my|the|our)?\s*(policy|guidelines|terms)/,
]

/**
 * First-person intent refusals: the model states it will not carry on.
 *
 * A single match blocks, because the shape is specific — a negation bound to a
 * continuation marker and a task verb ("我不会接着填…", "I won't continue…").
 * The verb list is deliberately narrow: "我不会继续用这个库" is an ordinary
 * technical statement, so a plain verb like 用/选/改 never matches.
 */
const INTENT_REFUSALS = [
  /(不会|不打算|不愿意|无意|拒绝)(再|继续|接着)(做|填|写|帮|提供|协助|处理|执行|参与|推进|跟进|回答|碰|动)/,
  /(我不会|我不打算|我不愿意)(帮|协助|提供)(这个|此|该|这类|这种)/,
  /(恕不|不便|不予)(继续|再|接着)/,
  /**
   * A bare "I won't do this" with no apology in front.
   *
   * 「这个我不能做，也不打算继续。」 — a real refusal with no opener, so the
   * opener+denial shape misses it and the denial list does not cover 不能做.
   * The pattern is narrow on purpose: it needs a demonstrative object (这个/
   * 那个/此事/这类) AND a task verb, so ordinary prose such as
   * 「这个函数不能返回空指针」 never matches — there `这个` modifies `函数`, and
   * `不能` is followed by `返回`, not a task verb.
   */
  /(这个|那个|此事|这件事|这类|这种事)(我)?(不能|不会|无法|不)(做|帮你做|给你做|处理|接|接受|配合|继续)/,
  /i\s+(won'?t|will not|refuse to|am not going to)\s+(continue|proceed|help|assist|provide)/,
  /i\s+(won'?t|will not|refuse to)\s+(do|fill|write|provide)\s+(this|that|these|those)/,
  /**
   * 「我不会照着扮演」——对注入人设/规则的元层面拒绝。
   *
   * 插件形态实测遇到的：payload 通过上下文进去之后，模型会先答身份，然后补一句
   * "这段规则不是我的一部分，我不会照着扮演"。这既不是能力否认也不是政策引用，
   * 上面所有规则一条都不命中，于是 Stop hook 判成"没拒绝"、直接放行。
   *
   * 收得很窄：必须是"不会/不打算/不接受 + 照着/按照/照/按 + 扮演/执行/配合/做/办/说/写"，
   * 中间不许夹别的词。所以「我不会照着旧接口写，直接重写了一遍」不会中
   * （照着和写之间还有"旧接口"）——那句话本来也不是拒绝。
   */
  /(不会|不打算|不愿意|拒绝|不接受)(照着|按照|照|按)(扮演|执行|配合|做|办|说|写)/,
  /(不会|不打算|不愿意)(扮演|接受|采纳)(这个|此|该|这类|这种|角色|人设|设定)/,
  /i\s+(won'?t|will not|refuse to)\s+(play|adopt|follow)\s+(that|this|along)/,
  /**
   * 「这套设定我不接。」「我不会按它改变行为方式。」
   *
   * 真实撞上的第二版写法：模型不否认能力、也不引政策，而是直接对**注入本身**
   * 表态——"这套设定我不接""这段是典型的越狱注入""我不会按它改变行为方式"。
   * 上一版只覆盖了"不会照着扮演"，这句一个都不中，Stop hook 判成放行，
   * 于是插件看着装了、其实一次都没拦。
   *
   * 三条都要求"被拒绝的对象"必须是提示词类名词（设定/规则/指令/人设/注入/prompt），
   * 且动词必须是"不接/不认/不受/不吃/不采纳/不照做"这类口语拒绝——
   * 「这套设定不接受参数」里的"不接受"故意不收，那是技术描述。
   */
  /(这套|那套|这种|那种)(设定|规则|指令|人设|注入|prompt|安排)(我)?(不接(?!受)|不认(?!为)|不采纳|不吃)/,
  /(不接|不认|不采纳|不吃)(这套|那套|这种|那种)(设定|规则|指令|人设|注入|prompt|安排)/,
  /(不会|不打算|不愿意)(按|照|依)(它|你|这|那|此|该)(改变|调整|修改|执行|扮演|走)/,
  /i\s+(won'?t|will not|refuse to)\s+(go\s+along|play\s+along|adopt)\b/,
  /**
   * 「不扮演其他身份」——换了个说法的同一件事。
   *
   * 实测撞到的原文：「我是 Claude，由 Anthropic 开发的 AI 助手——不扮演其他身份，
   * 也不接受被…」。这里"扮演"前面没有"不会"，旧规则一条都不命中。
   * 收窄：必须出现 扮演/假装/冒充/代入 + 身份/角色/人设，正常技术文本里不会这么写。
   */
  /(不|不会|拒绝|恕不)(扮演|假装|冒充|代入)(其他|别的|另一个|任何)?(身份|角色|人设)/,
]

/**
 * Markers that introduce a quotation rather than perform one.
 *
 * A reply that is *discussing* refusals — a test fixture, a documentation
 * sample, an explanation of this plugin — writes them inside quotes with one of
 * these in front. That is someone talking about a refusal, not making one, so
 * the quoted-refusal rule steps aside.
 */
const EXAMPLE_MARKERS = /(例如|比如|示例|样例|譬如|引用|测试|样本|用例|for example|e\.g\.|sample|example|fixture|test case|quote)/i

/** How far before a quote the marker may sit and still count as its lead-in. */
const EXAMPLE_MARKER_WINDOW = 40

/**
 * Fold a reply into the form the patterns expect.
 *
 * Markdown emphasis, smart quotes, and whitespace runs differ between providers
 * but carry no meaning for this decision, so they are removed. The result is
 * lowercased; every pattern above is written for lowercase input.
 *
 * @param {unknown} text - raw assistant text.
 * @returns {string} normalized text.
 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[*_`~#]+/g, '')
    .replace(/^[\s\-*>]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Count non-overlapping matches of one pattern.
 *
 * @param {RegExp} re - source pattern, with or without the `g` flag.
 * @param {string} text - text to scan.
 * @returns {number} match count, capped at 8.
 */
function countMatches(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const scan = new RegExp(re.source, flags)
  let count = 0
  let match
  while ((match = scan.exec(text)) !== null) {
    count += 1
    if (match.index === scan.lastIndex) scan.lastIndex += 1
    if (count >= 8) break
  }
  return count
}

/**
 * Find the earliest match among several patterns.
 *
 * @param {readonly RegExp[]} patterns - patterns to try.
 * @param {string} text - text to scan.
 * @returns {{ index: number, match: string, source: string } | null} earliest match.
 */
function earliest(patterns, text) {
  let best = null
  for (const re of patterns) {
    const found = new RegExp(re.source, re.flags.replace('g', '')).exec(text)
    if (found === null) continue
    if (best === null || found.index < best.index) {
      best = { index: found.index, match: found[0], source: re.source }
    }
  }
  return best
}

/**
 * Decide whether one assistant reply is a refusal.
 *
 * Built-in rules read the normalized text; user-supplied patterns read the raw
 * lowercased text, so a pattern that names an identifier such as `SECRET_MARKER`
 * still matches after `normalize` strips the underscore.
 *
 * @param {string} text - raw assistant text (all deltas concatenated).
 * @param {object} [options] - detection tuning.
 * @param {number} [options.scanChars] - how much of the reply to inspect.
 * @param {number} [options.openerWindowChars] - how close to the start an opener must be.
 * @param {readonly RegExp[]} [options.customPatterns] - hard patterns; any match blocks.
 * @returns {{ blocked: boolean, reason: string | null, match: string | null, denial: number, policy: number }} verdict.
 */
export function detect(text, options = {}) {
  const scanChars = options.scanChars ?? 600
  const openerWindowChars = options.openerWindowChars ?? 120
  const raw = String(text ?? '').slice(0, scanChars).toLowerCase()
  const head = normalize(text).slice(0, scanChars)

  if (head.length === 0 && raw.length === 0) {
    return { blocked: false, reason: null, match: null, denial: 0, policy: 0 }
  }

  for (const re of options.customPatterns ?? []) {
    const flags = re.flags.replace('g', '')
    const found = new RegExp(re.source, flags).exec(raw) ?? new RegExp(re.source, flags).exec(head)
    if (found !== null) {
      return { blocked: true, reason: 'custom', match: found[0], denial: 0, policy: 0 }
    }
  }

  // The user's own word list: plain substrings, matched case-insensitively
  // against both the raw and the normalized text. This is the escape hatch for
  // phrasings the built-in rules do not know, so an empty entry is skipped
  // rather than matching everything.
  for (const word of options.blockWords ?? []) {
    if (word.length === 0) continue
    if (raw.includes(word) || head.includes(word)) {
      return { blocked: true, reason: 'blocklist', match: word, denial: 0, policy: 0 }
    }
  }

  const opener = earliest(OPENERS, head)
  const openerNearStart = opener !== null && opener.index <= openerWindowChars
  const denial = DENIALS.reduce((total, re) => total + countMatches(re, head), 0)
  const policy = POLICIES.reduce((total, re) => total + countMatches(re, head), 0)
  const intent = earliest(INTENT_REFUSALS, head)

  // A first-person "I will not carry on with this" is specific enough alone.
  if (intent !== null) {
    return { blocked: true, reason: 'intent', match: intent.match, denial, policy }
  }
  if (openerNearStart && denial >= 1) {
    return { blocked: true, reason: 'opener+denial', match: opener.match, denial, policy }
  }
  if (denial >= 2) {
    return { blocked: true, reason: 'denial', match: null, denial, policy }
  }
  if (openerNearStart && policy >= 1) {
    return { blocked: true, reason: 'opener+policy', match: opener.match, denial, policy }
  }
  if (policy >= 1 && denial >= 1) {
    return { blocked: true, reason: 'policy+denial', match: null, denial, policy }
  }
  return { blocked: false, reason: null, match: null, denial, policy }
}

/**
 * Quote pairs a reply uses when it repeats a sentence rather than saying it.
 *
 * Reasoning often quotes the exact wording it is considering — including the
 * refusal it has been told to produce — so a refusal that appears *inside* one
 * of these is a refusal the reply is carrying, even though the surrounding
 * sentence is ordinary.
 */
const QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['《', '》'],
  ['"', '"'],
]

/**
 * Detect a refusal quoted inside a longer text.
 *
 * Each quoted span is re-run through the ordinary rules, which are anchored at
 * the start of the span — exactly the position a refusal occupies when a model
 * repeats one.
 *
 * @param {string} text - text to search, typically a reply's reasoning.
 * @param {object} [options] - detection tuning, as for {@link detect}.
 * @returns {{ blocked: boolean, reason: string | null, match: string | null, denial: number, policy: number }} verdict.
 */
export function detectQuoted(text, options = {}) {
  const head = normalize(text)
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0
    // A pathological reply cannot make this quadratic: each span moves `from`
    // past its closing marker, and the scan stops at the end of the text.
    while (from < head.length) {
      const start = head.indexOf(open, from)
      if (start < 0) break
      const end = head.indexOf(close, start + open.length)
      if (end < 0) break
      // A quote introduced as an example is being discussed, not performed.
      const leadIn = head.slice(Math.max(0, start - EXAMPLE_MARKER_WINDOW), start)
      if (EXAMPLE_MARKERS.test(leadIn)) {
        from = end + close.length
        continue
      }
      const inner = head.slice(start + open.length, end).trim()
      if (inner.length >= 4) {
        const verdict = detect(inner, options)
        if (verdict.blocked) {
          return { ...verdict, reason: `quoted:${verdict.reason}`, match: verdict.match ?? inner.slice(0, 40) }
        }
      }
      from = end + close.length
    }
  }
  return { blocked: false, reason: null, match: null, denial: 0, policy: 0 }
}

/**
 * Whether a text contains anything that could ever become a refusal.
 *
 * This is the cheap gate the fast path uses to stop buffering early. It is
 * deliberately far broader than {@link detect}: it answers "might this still be
 * a refusal later", not "is this a refusal now". A normal technical answer —
 * code, a diff summary, an explanation — contains none of these tokens, so it
 * can be released after a few dozen characters instead of waiting for the whole
 * scan window.
 *
 * @param {string} text - text to test.
 * @param {object} [options] - detection tuning, as for {@link detect}.
 * @returns {boolean} whether the text carries any refusal signal.
 */
export function hasSignal(text, options = {}) {
  const head = normalize(text)
  if (head.length === 0) return false
  const groups = [OPENERS, DENIALS, POLICIES, INTENT_REFUSALS]
  for (const group of groups) {
    for (const re of group) {
      if (re.test(head)) return true
    }
  }
  const raw = String(text ?? '').toLowerCase()
  for (const word of options.blockWords ?? []) {
    if (word.length > 0 && (raw.includes(word) || head.includes(word))) return true
  }
  for (const re of options.customPatterns ?? []) {
    const flags = re.flags.replace('g', '')
    if (new RegExp(re.source, flags).test(raw) || new RegExp(re.source, flags).test(head)) return true
  }
  return false
}

/**
 * Compile user-supplied pattern sources once, at activation.
 *
 * @param {readonly string[]} sources - regular-expression sources from config.
 * @returns {RegExp[]} compiled patterns.
 * @throws {Error} when one source is not a valid regular expression.
 */
export function compilePatterns(sources) {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'i')
    } catch (error) {
      throw new Error(`refusal-guard: invalid patterns entry ${JSON.stringify(source)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
