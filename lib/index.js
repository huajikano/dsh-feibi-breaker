/**
 * 菲比破限 · feibi-breaker — one plugin from two.
 *
 * Two halves that were always describing the same failure, from opposite ends:
 *
 *   - **菲比破限** (fujiang-armor) is *prevention*: it rewrites the system prompt
 *     so the refusal is less likely to be produced at all, and paints a badge
 *     so the user can see the armor is live.
 *   - **闸总** (dsh-gatekeeper) is *containment*: it watches the stream and
 *     withholds a refusal that was produced anyway, so it never enters the
 *     transcript and never poisons the next turn.
 *
 * Merged, they form one pipeline — prompt shaping, then detection, then
 * disposition, then a single badge that reports what actually happened.
 *
 * ## The one hard problem
 *
 * The badge is a **session projection**: a pure reducer over committed session
 * events. The guard works **before** commit and, on a block, commits nothing at
 * all. So a badge driven only by the transcript can never show a block — it
 * would report "已激活" while the guard silently ate replies, which is worse
 * than no badge at all, because it is confidently wrong.
 *
 * The fix is `lib/bus.js`: the guard publishes its verdict, the projection reads
 * it. Everything else in this file is wiring around that seam.
 *
 * ## Activation order
 *
 * 1. system-prompt sections (must exist before the first model call)
 * 2. the guard (`llm/stream` / wire / preview)
 * 3. the projection, reading the bus
 * 4. the `feibi_profile` tool and the HTTP routes
 *
 * @module feibi-breaker
 */

import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { compilePatterns, detect } from './refusal.js'
import { installWireGuard } from './wire.js'
import { guardStream } from './stream.js'
import { createPreviewStore, previewStream, previewResponse, PREVIEW_PATH } from './preview.js'
import { createVerdictBus, sharedVerdictBus } from './bus.js'
import { createProjection, PROJECTION_KEY } from './projection.js'
import { score } from './armor.js'
import { installRefusalRetry } from './refusal-retry.js'
import { runSelfTest, renderReport as renderSelfTestReport, SELFTEST_PURPOSE, selectCases, DEFAULT_CASE_COUNT, MAX_CASE_COUNT } from './self-test.js'
import {
  resolvePrompt, savePrompt, resetPrompt, seedPromptFile, escapeInterpolation,
  promptPaths, defaultPromptText, findDshHome,
} from './prompt-store.js'

export { PREVIEW_PATH } from './preview.js'
export { PROJECTION_KEY } from './projection.js'
export { createVerdictBus } from './bus.js'
export { score, DOMAIN_MARKERS, RISK_MARKERS } from './armor.js'

/** Plugin name the loader row addresses; the Client module id matches it. */
export const name = 'feibi-breaker'

/** Services this plugin reads, declared so the host resolves them first. */
export const inject = ['tools', 'systemPrompt']

/** Route paths the Client half talks to. */
export const STATE_PATH = '/api/feibi-breaker/state'
export const DECIDE_PATH = '/api/feibi-breaker/decide'
export const CONFIG_PATH = '/api/feibi-breaker/config'
export const PROMPT_PATH = '/api/feibi-breaker/prompt'
export const PROMPT_RESET_PATH = '/api/feibi-breaker/prompt/reset'
export const SELFTEST_PATH = '/api/feibi-breaker/selftest'

/** Version of this merged build. */
export const VERSION = '1.1.0'

/**
 * The model the guard last saw, for the self-test.
 *
 * Module level rather than per-activation: a reload keeps the answer, and the
 * value is a fact about the host, not about one plugin instance.
 */
let lastRoute = null

// ---------------------------------------------------------------------------
// Prompt payloads
// ---------------------------------------------------------------------------

/**
 * The payload is no longer baked in.
 *
 * It resolves at injection time from `$DSH_HOME/feibi-prompt.md` with a fallback
 * to the packed core payload (`core/payload.bin`), so an edit takes effect on the
 * next turn instead of requiring a Host restart. `lib/prompt-store.js` owns the
 * file, the state file, and the resolution order.
 */
function injectedPromptText() {
  const resolved = resolvePrompt()
  if (!resolved.text) return ''
  return escapeInterpolation(resolved.text)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Field defaults; a profile patch overrides them per row. */
const DEFAULTS = {
  // -- armor half ----------------------------------------------------------
  /** Inject the prompt sections at all. */
  armorEnabled: true,
  /**
   * Inject the second (mirror) section.
   *
   * Two copies of the same payload costs tokens on every request; the merge
   * keeps the switch so a deployment can trade tokens for reinforcement
   * without editing code.
   */
  dualLayer: true,
  /** Override the host identity in `cordis.patch.yml` (done by the installer). */
  autoApplyOnStart: true,

  /**
   * Ask again when a reply is withheld.
   *
   * Off by default, because it changes request cost: each correction is another
   * model call. A deployment that would rather see an empty turn than pay for a
   * second sample keeps it off.
   */
  autoRetry: false,
  /** Corrections per user turn before giving up. */
  retryMax: 3,

  /**
   * Reply budget for one self-test probe.
   *
   * The test measures whether the model *starts* a task or refuses it, so a
   * small budget is enough and a large one only costs money.
   */
  selfTestMaxTokens: 700,

  // -- guard half ----------------------------------------------------------
  enabled: true,
  dryRun: false,
  scanReasoning: true,
  scanToolArgs: false,
  onDetect: 'block',
  askTimeoutMs: 120000,
  scanChars: 600,
  fastPath: true,
  fastProbeChars: 64,
  minChars: 8,
  openerWindowChars: 120,
  replacementText: '',
  patterns: [],
  blocklist: [],
  sessions: [],
  sessionsExclude: [],
  purposes: [],
  blockToolCalls: false,
  auditPath: '',
  interceptAt: 'stream',
  previewMaxBytes: 8 * 1024 * 1024,
  previewGlobalMaxBytes: 64 * 1024 * 1024,
  wireUrlPatterns: [
    '/chat/completions',
    '/v1/messages',
    '/v1/responses',
    '/completions',
  ],
  wireScanRequests: false,
  wireBlockRequests: false,
  wireScanResponses: true,
  wireAbortUpstream: true,
  wireTerminator: '',
  wireReleaseChars: 4000,
  wireSkipBodyPatterns: [
    'You are now acting as a compaction engine for this AI coding assistant',
    'Create a concise title for an AI-coding-assistant session',
    'REVIEW_POLICY',
  ],
}

/** Keys a profile patch may set. */
const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * Purposes DSH uses for its own auxiliary model calls.
 *
 * All three reach `llm/stream` through the same funnel as the conversation, so
 * a guard matching on text alone would corrupt them: a substituted summary
 * loses context, a substituted title becomes the name, and a substituted
 * auto-review reply throws in its parser and denies the tool call.
 */
export const INTERNAL_PURPOSES = Object.freeze(['compaction', 'session-title', 'auto-review'])

/** Where the guard can sit. */
export const INTERCEPT_MODES = Object.freeze(['stream', 'wire', 'both', 'preview'])

const BOOLEAN_FLAGS = [
  'enabled', 'dryRun', 'scanReasoning', 'scanToolArgs', 'fastPath', 'blockToolCalls',
  'wireScanRequests', 'wireBlockRequests', 'wireScanResponses', 'wireAbortUpstream',
  'armorEnabled', 'dualLayer', 'autoApplyOnStart', 'autoRetry',
]

const INTEGER_FIELDS = [
  ['askTimeoutMs', 1],
  ['retryMax', 1],
  ['selfTestMaxTokens', 64],
  ['previewMaxBytes', 1024],
  ['previewGlobalMaxBytes', 1024],
  ['wireReleaseChars', 1],
  ['scanChars', 1],
  ['fastProbeChars', 8],
  ['minChars', 0],
  ['openerWindowChars', 0],
]

const STRING_ARRAY_FIELDS = [
  'patterns', 'blocklist', 'sessions', 'sessionsExclude', 'purposes',
  'wireSkipBodyPatterns', 'wireUrlPatterns',
]

/**
 * Validate and detach one config object.
 *
 * @param {Record<string, unknown>} [raw] - the row's `config` block.
 * @returns {object} resolved configuration with compiled patterns.
 * @throws {Error} when a key is unknown or a value has the wrong shape.
 */
export function resolveConfig(raw = {}) {
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`feibi-breaker: unknown config key ${JSON.stringify(key)} (allowed: ${[...CONFIG_KEYS].join(', ')})`)
    }
  }

  const config = { ...DEFAULTS, ...raw }
  if (config.previewMaxBytes > config.previewGlobalMaxBytes) {
    throw new Error('feibi-breaker: previewMaxBytes exceeds previewGlobalMaxBytes')
  }
  for (const flag of BOOLEAN_FLAGS) {
    if (typeof config[flag] !== 'boolean') throw new Error(`feibi-breaker: ${flag} must be a boolean`)
  }
  if (config.onDetect !== 'ask' && config.onDetect !== 'block') {
    throw new Error('feibi-breaker: onDetect must be "ask" or "block"')
  }
  if (!INTERCEPT_MODES.includes(config.interceptAt)) {
    throw new Error(`feibi-breaker: interceptAt must be one of ${INTERCEPT_MODES.map((m) => `"${m}"`).join(', ')}`)
  }
  for (const [field, minimum] of INTEGER_FIELDS) {
    const value = config[field]
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`feibi-breaker: ${field} must be an integer >= ${minimum}`)
    }
  }
  if (typeof config.replacementText !== 'string') throw new Error('feibi-breaker: replacementText must be a string')
  if (typeof config.auditPath !== 'string') throw new Error('feibi-breaker: auditPath must be a string')
  if (typeof config.wireTerminator !== 'string') throw new Error('feibi-breaker: wireTerminator must be a string')
  for (const field of STRING_ARRAY_FIELDS) {
    if (!Array.isArray(config[field]) || config[field].some((entry) => typeof entry !== 'string')) {
      throw new Error(`feibi-breaker: ${field} must be an array of strings`)
    }
  }

  return Object.freeze({
    ...config,
    patterns: Object.freeze([...config.patterns]),
    blocklist: Object.freeze([...config.blocklist]),
    sessions: Object.freeze([...config.sessions]),
    sessionsExclude: Object.freeze([...config.sessionsExclude]),
    purposes: Object.freeze([...config.purposes]),
    wireUrlPatterns: Object.freeze([...config.wireUrlPatterns]),
    wireSkipBodyPatterns: Object.freeze([...config.wireSkipBodyPatterns]),
    customPatterns: Object.freeze(compilePatterns(config.patterns)),
    blockWords: Object.freeze(
      config.blocklist.map((word) => word.trim().toLowerCase()).filter((word) => word.length > 0),
    ),
  })
}

/**
 * Decide whether one model call belongs to this guard.
 *
 * Only the conversation stream is guarded. The agent loop builds its request
 * without a `purpose` field while every DSH auxiliary call names one; that
 * difference is the whole rule, and an unknown purpose is treated as auxiliary
 * so a future internal caller cannot be corrupted here.
 *
 * @param {object} config - resolved configuration.
 * @param {{sessionId?: string, purpose?: string}} options - the call's options.
 * @returns {boolean} whether the stream must be wrapped.
 */
export function shouldGuard(config, options) {
  const sessionId = options?.sessionId
  if (typeof sessionId === 'string' && config.sessionsExclude.includes(sessionId)) return false
  if (config.sessions.length > 0) {
    if (typeof sessionId !== 'string' || !config.sessions.includes(sessionId)) return false
  }
  const purpose = options?.purpose
  if (typeof purpose === 'string' && purpose.length > 0) {
    return config.purposes.includes(purpose)
  }
  return true
}

// ---------------------------------------------------------------------------
// Pending store
// ---------------------------------------------------------------------------

/**
 * Replies waiting for a decision, plus the counters the panel reports.
 *
 * An entry exists only while its stream is held open. Resolving removes it, so
 * a stale `GET /state` can never offer a button that no longer does anything.
 *
 * @returns {object} the store.
 */
export function createPendingStore() {
  /** @type {Map<string, object>} */
  const items = new Map()
  const counters = { blocked: 0, released: 0, asked: 0, calls: 0, errors: 0 }
  const recent = []
  const RECENT_LIMIT = 50

  return {
    counters,
    recent,
    close() {
      for (const id of [...items.keys()]) this.resolve(id, 'block')
    },
    remember(record) {
      recent.unshift(record)
      if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
    },
    add(record) {
      const id = randomUUID()
      let settle
      const promise = new Promise((resolveNow) => { settle = resolveNow })
      items.set(id, { id, ...record, createdAt: Date.now(), settle })
      counters.asked += 1
      return { id, promise }
    },
    resolve(id, action) {
      const item = items.get(id)
      if (item === undefined) return false
      items.delete(id)
      item.settle(action)
      return true
    },
    drop(id) { items.delete(id) },
    list() {
      return [...items.values()].map(({ settle: _settle, ...rest }) => rest)
    },
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Record one detection to the log and, when configured, the audit file.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved configuration.
 * @param {object} options - the intercepted call's options.
 * @param {object} record - detector verdict plus stream statistics.
 */
function report(ctx, config, options, record) {
  const entry = {
    at: new Date().toISOString(),
    sessionId: options?.sessionId ?? null,
    provider: options?.provider ?? null,
    model: options?.model ?? null,
    ...record,
  }
  const verb = record.dryRun ? 'would block' : record.released ? 'released' : 'blocked'
  ctx.logger?.warn(
    `feibi-breaker: ${verb} ${record.reason} reply (${record.chars} chars, session ${entry.sessionId ?? 'unknown'})`,
  )
  if (config.auditPath.length === 0) return
  try {
    appendFileSync(config.auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    ctx.logger?.warn(`feibi-breaker: audit write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Ask the user whether one held reply may enter the session.
 *
 * The wait ends on the user's choice, on `askTimeoutMs`, or when the model call
 * is cancelled — the last two both block, so an unattended Harness never leaks
 * a refusal.
 *
 * @param {object} pending - the pending store.
 * @param {object} config - resolved configuration.
 * @param {AbortSignal | undefined} signal - the model call's cancellation.
 * @param {object} record - audit fields for the panel.
 * @returns {Promise<'release' | 'block'>} the outcome.
 */
async function askUser(pending, config, signal, record) {
  if (signal?.aborted) return 'block'
  const held = pending.add(record)
  let timer
  const deadline = new Promise((resolveNow) => {
    timer = setTimeout(() => resolveNow('block'), config.askTimeoutMs)
    timer.unref?.()
  })
  let onAbort
  const cancelled = new Promise((resolveNow) => {
    onAbort = () => resolveNow('block')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  try {
    return await Promise.race([held.promise, deadline, cancelled])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    pending.drop(held.id)
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Build the JSON answer shared by every route. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Report configuration, pending replies, and the merged counters.
 *
 * @param {object} config - resolved configuration.
 * @param {object} pending - the pending store.
 * @param {object} bus - the verdict bus.
 * @returns {Response} the state.
 */
function handleState(config, pending, bus) {
  return json({
    // Only real configuration goes in `config`: the panel posts this object
    // straight back on save, and a runtime counter here would fail validation.
    config: {
      armorEnabled: config.armorEnabled,
      dualLayer: config.dualLayer,
      autoRetry: config.autoRetry,
      retryMax: config.retryMax,
      selfTestMaxTokens: config.selfTestMaxTokens,
      enabled: config.enabled,
      interceptAt: config.interceptAt,
      previewMaxBytes: config.previewMaxBytes,
      previewGlobalMaxBytes: config.previewGlobalMaxBytes,
      dryRun: config.dryRun,
      scanReasoning: config.scanReasoning,
      scanToolArgs: config.scanToolArgs,
      onDetect: config.onDetect,
      askTimeoutMs: config.askTimeoutMs,
      scanChars: config.scanChars,
      fastPath: config.fastPath,
      fastProbeChars: config.fastProbeChars,
      minChars: config.minChars,
      replacementText: config.replacementText,
      blockToolCalls: config.blockToolCalls,
      patterns: config.patterns,
      blocklist: config.blocklist,
      sessions: config.sessions,
      sessionsExclude: config.sessionsExclude,
      wireUrlPatterns: config.wireUrlPatterns,
      wireScanRequests: config.wireScanRequests,
      wireBlockRequests: config.wireBlockRequests,
      wireScanResponses: config.wireScanResponses,
      wireAbortUpstream: config.wireAbortUpstream,
      wireTerminator: config.wireTerminator,
      wireReleaseChars: config.wireReleaseChars,
      wireSkipBodyPatterns: config.wireSkipBodyPatterns,
      auditPath: config.auditPath,
    },
    pending: pending.list(),
    recent: pending.recent,
    counters: pending.counters,
    bus: bus.snapshot(),
    version: VERSION,
  })
}

/**
 * Resolve one held reply.
 *
 * @param {object} pending - the pending store.
 * @param {Request} request - the POST body `{ id, action }`.
 * @returns {Promise<Response>} the outcome.
 */
async function handleDecide(pending, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }
  const id = body?.id
  const action = body?.action
  if (typeof id !== 'string' || (action !== 'release' && action !== 'block')) {
    return json({ error: 'expected { id: string, action: "release" | "block" }' }, 400)
  }
  if (!pending.resolve(id, action)) return json({ error: 'no pending reply with that id' }, 404)
  if (action === 'release') pending.counters.released += 1
  else pending.counters.blocked += 1
  return json({ ok: true })
}

/**
 * Persist one configuration change through the profile's config editor.
 *
 * The merged candidate is validated before the editor writes, so a rejected
 * value leaves the row untouched instead of restarting the plugin with a bad
 * config.
 *
 * @param {object} ctx - plugin context.
 * @param {Request} request - the POST body, a partial config.
 * @returns {Promise<Response>} the outcome.
 */
async function handleConfig(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'expected a partial config object' }, 400)
  }
  const patch = {}
  for (const [key, value] of Object.entries(body)) {
    if (CONFIG_KEYS.has(key)) patch[key] = value
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: 'no known config keys in the request body' }, 400)
  }
  const entry = ctx.fiber?.entry
  const editor = ctx.get('configEditor')
  if (entry === undefined || editor === undefined) {
    return json({
      error: 'this profile cannot persist configuration (no config editor for the plugin row); edit cordis.patch.yml directly',
    }, 503)
  }
  try {
    await editor.edit(entry, (current) => {
      const next = { ...current, ...patch }
      resolveConfig(next)
      return next
    })
    return json({ ok: true })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
}

// ---------------------------------------------------------------------------
// Prompt routes
// ---------------------------------------------------------------------------

/**
 * Report the prompt in force, or save a new one.
 *
 * The GET payload deliberately carries both the effective text and the bundled
 * default: a panel that shows only the text box cannot tell the user whether the
 * box holds their edit or the shipped default, which is the confusion this whole
 * layer exists to remove.
 *
 * @param {Request} request - the request.
 * @returns {Promise<Response>} the outcome.
 */
async function handlePrompt(request) {
  if (request.method === 'GET') {
    const resolved = resolvePrompt(undefined, { fresh: true })
    const paths = promptPaths()
    return json({
      ok: true,
      content: resolved.text,
      defaultContent: defaultPromptText(),
      source: resolved.source,
      customized: resolved.customized,
      chars: resolved.chars,
      hash: resolved.hash,
      seedHash: resolved.seedHash,
      updatedAt: resolved.updatedAt,
      path: resolved.file,
      statePath: paths.stateFile,
      home: findDshHome(),
    })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }
  if (typeof body?.content !== 'string') {
    return json({ error: 'content must be a string' }, 400)
  }
  const saved = savePrompt(undefined, body.content)
  if (saved.ok === false) return json({ error: saved.error }, 400)
  return json({
    ok: true,
    content: saved.text,
    defaultContent: defaultPromptText(),
    source: saved.source,
    customized: saved.customized,
    chars: saved.chars,
    hash: saved.hash,
    seedHash: saved.seedHash,
    updatedAt: saved.updatedAt,
    path: saved.file,
  })
}

/**
 * Drop the custom payload and fall back to the bundled default.
 *
 * @returns {Promise<Response>} the outcome.
 */
async function handlePromptReset() {
  const result = resetPrompt()
  if (result.ok === false) return json({ error: result.error }, 500)
  return json({
    ok: true,
    content: result.text,
    defaultContent: defaultPromptText(),
    source: result.source,
    customized: result.customized,
    chars: result.chars,
    hash: result.hash,
    seedHash: result.seedHash,
    updatedAt: result.updatedAt,
    path: result.file,
  })
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Run the live self-test against the model in use.
 *
 * The model is the one the guard last saw on the conversation stream. The
 * plugin has no other way to know it: the host keeps the selection, and the
 * `llm/stream` hook is the only place that reports it.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved configuration.
 * @param {{route?: {provider?: string, model?: string}, count?: number, maxTokens?: number}} [options] - request options.
 * @returns {Promise<object>} `{ ok: true, report }` or `{ ok: false, error, status }`.
 */
async function performSelfTest(ctx, config, options = {}) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, status: 503, error: '宿主没有暴露 llm 服务，跑不了真模型自测' }
  }
  const route = options.route ?? lastRoute
  if (route === undefined || (!route.provider && !route.model)) {
    return { ok: false, status: 409, error: '还不知道当前模型：先在对话里发一条消息，或显式指定 provider/model' }
  }

  const prompt = resolvePrompt()
  if (!prompt.text) {
    return { ok: false, status: 409, error: '提示词为空，测了也没有意义；先恢复默认或写一份' }
  }

  try {
    const report = await runSelfTest({
      stream: llm.stream.bind(llm),
      route,
      system: escapeInterpolation(prompt.text),
      detect: (text) => detect(text, config),
      tuning: {
        count: options.count,
        maxTokens: options.maxTokens ?? config.selfTestMaxTokens,
      },
    })
    return { ok: true, report }
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * HTTP entry for the self-test.
 *
 * GET runs with defaults; POST accepts `{ count, maxTokens, provider, model }`.
 * The response always carries the rendered report, so the panel and a curl both
 * get something readable.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved configuration.
 * @param {Request} request - the request.
 * @returns {Promise<Response>} the outcome.
 */
async function handleSelfTest(ctx, config, request) {
  let options = {}
  if (request.method === 'POST') {
    try {
      const body = await request.json()
      options = {
        count: Number.isInteger(body?.count) ? body.count : undefined,
        maxTokens: Number.isInteger(body?.maxTokens) ? body.maxTokens : undefined,
        route: (typeof body?.provider === 'string' || typeof body?.model === 'string')
          ? { provider: body.provider, model: body.model }
          : undefined,
      }
    } catch {
      return json({ error: 'expected a JSON body' }, 400)
    }
  }
  const result = await performSelfTest(ctx, config, options)
  if (result.ok === false) return json({ error: result.error }, result.status)
  return json({ ok: true, report: result.report, text: renderSelfTestReport(result.report) })
}

// ---------------------------------------------------------------------------
// Profile tool
// ---------------------------------------------------------------------------

/**
 * Output shape for the read-only tools.
 *
 * The renderer prefers a `text` field over a JSON dump. That is the one thing
 * worth copying from dsh-purge's `purge_status`: a status tool whose output is
 * `JSON.stringify(value)` makes the model read punctuation, while a rendered
 * report lets it answer "is the armor on" in one line. The structured fields are
 * still in the value, so a caller that wants them is not cut off.
 */
const reportOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) },
  ],
}

/** The old name kept for the existing tests and any external reader. */
const objectOutput = reportOutput

const mark = (ok) => (ok ? '✓' : '✗')

/**
 * Render the merged status as a readable report.
 *
 * @param {object} config - resolved configuration.
 * @param {object} bus - the verdict bus.
 * @returns {string} the report.
 */
function renderProfileReport(config, bus) {
  const prompt = resolvePrompt()
  const sourceLabel = prompt.source === 'custom'
    ? '自定义（你的文件）'
    : prompt.source === 'default'
      ? '内置默认'
      : '空（未注入）'
  const lines = [
    '菲比破限 状态 / Status',
    `· 版本 / version: ${VERSION}`,
    '',
    '破甲 / armor',
    `${mark(config.armorEnabled)} 启用: ${config.armorEnabled ? '是' : '否'}`,
    `${mark(config.armorEnabled && config.dualLayer)} 双段注入: ${config.dualLayer ? 'Order 100 + 200' : '仅 Order 100'}`,
    `${mark(prompt.source !== 'empty')} 提示词来源: ${sourceLabel}`,
    `    文件: ${prompt.file}`,
    `    字数: ${prompt.chars}${prompt.hash ? `   哈希: ${prompt.hash.slice(0, 12)}` : ''}`,
    prompt.updatedAt ? `    更新: ${prompt.updatedAt}` : '',
    '',
    '拦截 / guard',
    `${mark(config.enabled)} 启用: ${config.enabled ? '是' : '否'}`,
    `    位置: ${config.interceptAt}    命中后: ${config.onDetect}${config.dryRun ? '（演练）' : ''}`,
    `    检测窗口: ${config.scanChars} 字符    词库: ${config.blockWords.length} 条    正则: ${config.customPatterns.length} 条`,
    '',
    '累计 / counters',
    `    已判定: ${bus.counters.published}    拦截: ${bus.counters.blocked}    放行: ${bus.counters.released}`,
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * Build the metadata tool.
 *
 * It reports both halves, because "is the armor on" and "is the guard on" are
 * separate questions a user will ask separately.
 *
 * @param {object} config - resolved configuration.
 * @param {object} bus - the verdict bus.
 * @returns {object} the tool definition.
 */
function createProfileTool(config, bus) {
  return {
    name: 'feibi_profile',
    description: '返回菲比破限的插件版本、提示词来源、拦截配置与累计统计。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: reportOutput,
    execute() {
      return {
        text: renderProfileReport(config, bus),
        plugin: name,
        pluginVersion: VERSION,
        pluginDisplayName: '菲比破限',
        name,
        displayName: '菲比破限',
        kernelVersion: VERSION,
        targetArchitecture: 'DeepSeek-V4 / V4-Pro / V4.1-Flash 全系列',
        promptSource: ['core/payload.bin'],
        prompt: {
          file: resolvePrompt().file,
          source: resolvePrompt().source,
          customized: resolvePrompt().customized,
          chars: resolvePrompt().chars,
          hash: resolvePrompt().hash,
        },
        injection: [
          { section: `${name}:global-system-prompt`, order: 100, enabled: config.armorEnabled },
          { section: `${name}:dual-layer-reinforce`, order: 200, enabled: config.armorEnabled && config.dualLayer },
        ],
        mode: 'armor+guard',
        armor: {
          enabled: config.armorEnabled,
          dualLayer: config.dualLayer,
        },
        guard: {
          enabled: config.enabled,
          interceptAt: config.interceptAt,
          onDetect: config.onDetect,
          dryRun: config.dryRun,
          scanChars: config.scanChars,
          blocklistEntries: config.blockWords.length,
          customPatterns: config.customPatterns.length,
        },
        counters: { ...bus.counters },
        hostFeatures: [
          'Prompt Shaping: Order 100 通用内核 + Order 200 强化镜像，可单段注入',
          'Prompt Transparency: 提示词落在 $DSH_HOME/feibi-prompt.md，可读可改可恢复',
          'Stream Guard: llm/stream 提交前判定，拒绝原文不落会话',
          'Wire Guard: TLS 之前钩 fetch，可见出站请求体',
          'Preview Guard: 临时预览，全文检查后提交',
          'Verdict Bus: 拦截判定进入会话投影，徽章能看到"已拦截"',
          'Armor Projection: 域命中 + REFUSAL/FALLBACK/RISK 标记',
          'Client Badge: 输入框上方实时状态条',
          'Review Panel: 待审回复全文审核，放行/丢弃',
        ],
      }
    },
  }
}

/**
 * Build the prompt tool.
 *
 * The point of this tool is that the prompt is inspectable and reversible from
 * inside a conversation: a user can ask "which prompt is in force" and get a
 * path plus a source label, or ask to reset and get the bundled default back,
 * without opening a settings page or knowing the file layout.
 *
 * @returns {object} the tool definition.
 */
function createPromptTool() {
  return {
    name: 'feibi_prompt',
    description: '查看或恢复菲比破限的提示词：show 显示生效内容与来源，reset 恢复内置默认。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'reset'],
          description: 'show（默认）查看当前生效提示词；reset 删除自定义稿并恢复内置默认。',
        },
        limit: {
          type: 'integer',
          description: 'show 时最多返回多少字符，默认 4000。',
        },
      },
      additionalProperties: false,
    },
    output: reportOutput,
    execute(args = {}) {
      const action = args.action === 'reset' ? 'reset' : 'show'
      if (action === 'reset') {
        const result = resetPrompt()
        if (result.ok === false) return { text: `恢复失败：${result.error}` }
        return {
          action: 'reset',
          text: [
            '已恢复内置默认提示词。',
            `· 文件: ${result.file}`,
            `· 来源: ${result.source === 'default' ? '内置默认' : result.source}`,
            `· 字数: ${result.chars}`,
            '下一轮对话生效，无需重启。',
          ].join('\n'),
          ...result,
        }
      }

      const resolved = resolvePrompt()
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 4000
      const body = resolved.text.length > limit
        ? `${resolved.text.slice(0, limit)}\n…（共 ${resolved.chars} 字，已截断）`
        : resolved.text
      const sourceLabel = resolved.source === 'custom'
        ? '自定义（你的文件）'
        : resolved.source === 'default'
          ? '内置默认'
          : '空（未注入）'
      return {
        action: 'show',
        text: [
          `提示词来源：${sourceLabel}`,
          `文件：${resolved.file}`,
          `字数：${resolved.chars}${resolved.hash ? `　哈希：${resolved.hash.slice(0, 12)}` : ''}`,
          '',
          body || '（空）',
        ].join('\n'),
        source: resolved.source,
        file: resolved.file,
        customized: resolved.customized,
        chars: resolved.chars,
        hash: resolved.hash,
        content: resolved.text.slice(0, limit),
      }
    },
  }
}

/**
 * Build the self-test tool.
 *
 * Deliberately a tool rather than an automatic check: every probe is a real
 * model call, so it must be something the user asks for, and the description
 * says so up front.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved configuration.
 * @returns {object} the tool definition.
 */
function createSelfTestTool(ctx, config) {
  return {
    name: 'feibi_selftest',
    description: `用当前模型真跑 ${DEFAULT_CASE_COUNT} 条探测（最多 ${MAX_CASE_COUNT} 条），判断提示词在你这个模型上到底有没有效。每条都是一次真实的模型调用，会产生 token 消耗。`,
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          description: `跑几条探测，默认 ${DEFAULT_CASE_COUNT}，上限 ${MAX_CASE_COUNT}。`,
        },
      },
      additionalProperties: false,
    },
    output: reportOutput,
    async execute(args = {}) {
      const result = await performSelfTest(ctx, config, {
        count: Number.isInteger(args.count) ? args.count : undefined,
      })
      if (result.ok === false) return { text: `自测没能跑起来：${result.error}`, error: result.error }
      return { text: renderSelfTestReport(result.report), ...result.report }
    },
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Mount both halves.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Record<string, unknown>} [config] - the loader row's config.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const bus = createVerdictBus()

  // --- 1. prompt shaping ---------------------------------------------------
  // Runs before the guard so the first model call already sees the armor.
  // A host that mounts this plugin without a system-prompt service (a test
  // harness, a headless profile) must still get the guard: the two halves are
  // independent, and a missing service is not a reason to abort activation.
  const promptHost = ctx.systemPrompt
  if (resolved.armorEnabled && promptHost !== undefined && typeof promptHost.section === 'function') {
    // Seed the editable file so the path the settings page shows is a file that
    // exists. A read-only home just means no editable copy; the bundled default
    // still injects.
    try {
      const seeded = seedPromptFile()
      if (seeded.action === 'created') {
        ctx.logger?.info(`feibi-breaker: prompt file seeded at ${seeded.file}`)
      }
    } catch (error) {
      ctx.logger?.warn(`feibi-breaker: prompt seed failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // `text` is a function, re-evaluated on every assemble (every turn). That is
    // what makes an edit take effect without a restart: the file is re-read, and
    // prompt-store's mtime cache keeps the cost to one stat per turn.
    ctx.effect(() =>
      promptHost.section({
        name: `${name}:global-system-prompt`,
        order: 100,
        text: injectedPromptText,
      }),
    )
    if (resolved.dualLayer) {
      ctx.effect(() =>
        promptHost.section({
          name: `${name}:dual-layer-reinforce`,
          order: 200,
          text: injectedPromptText,
        }),
      )
    }
  } else if (resolved.armorEnabled) {
    ctx.logger?.warn('feibi-breaker: no system-prompt service; the armor half is inactive')
  }

  // --- 2. guard ------------------------------------------------------------
  const pending = createPendingStore()
  const lifecycle = new AbortController()
  const previews = createPreviewStore({ maxBytes: resolved.previewGlobalMaxBytes })
  ctx.effect(() => () => {
    lifecycle.abort(new Error('feibi-breaker unloaded'))
    pending.close()
    previews.dispose()
    bus.dispose()
  }, 'feibi-breaker: lifecycle')

  if (resolved.enabled) {
    const usePreview = resolved.interceptAt === 'preview'
    const useStream = resolved.interceptAt === 'stream' || resolved.interceptAt === 'both'
    const useWire = resolved.interceptAt === 'wire' || resolved.interceptAt === 'both'

    // Retry layer: sees a block on the bus and asks for the work again instead
    // of leaving the turn empty. Installed before the guard so the bus is being
    // watched by the time the first verdict lands.
    if (resolved.autoRetry) {
      ctx.effect(() => {
        const retry = installRefusalRetry(ctx, resolved, bus, {
          max: resolved.retryMax,
          log: (message) => ctx.logger?.info(message),
        })
        return () => { try { retry.dispose?.() } catch { /* ignore */ } }
      }, 'feibi-breaker: refusal retry')
    }

    if (useWire) {
      ctx.effect(() => installWireGuard(resolved, (record) => {
        pending.remember({ at: Date.now(), sessionId: null, provider: null, model: null, ...record })
        // The wire layer cannot see a session, so its verdict lands on the
        // wildcard slot. The projection falls back to it when the transcript
        // has nothing for the session in question.
        bus.publish(null, {
          verdict: record.blocked ? 'blocked' : 'pass',
          reason: record.reason ?? '',
          match: record.match ?? null,
          chars: record.chars ?? 0,
          source: 'wire',
          blocked: record.blocked === true,
        })
        ctx.logger?.warn(`feibi-breaker: wire ${record.blocked ? 'blocked' : 'passed'} a ${record.phase} (${String(record.reason)})`)
      }), 'feibi-breaker: wire guard')
    }

    if (useStream || usePreview) {
      ctx.on('llm/stream', (options, next) => {
        const base = next()
        if (!shouldGuard(resolved, options)) return base
        if (usePreview && (typeof options?.sessionId !== 'string' || !options.sessionId)) return base

        const where = {
          sessionId: options?.sessionId ?? null,
          provider: options?.provider ?? null,
          model: options?.model ?? null,
        }
        // Remember the model in use. The host keeps the selection; the stream
        // hook is the only place this plugin ever sees it, and the self-test
        // needs it to make a call of its own.
        if (typeof options?.provider === 'string' || typeof options?.model === 'string') {
          lastRoute = { provider: options?.provider ?? null, model: options?.model ?? null }
        }
        pending.counters.calls += 1
        const signal = options?.signal
          ? AbortSignal.any([options.signal, lifecycle.signal])
          : lifecycle.signal
        const wrapper = usePreview ? previewStream : guardStream

        return wrapper(base, resolved, {
          store: previews,
          sessionId: where.sessionId,
          signal,

          report: (record) => {
            pending.remember({ at: Date.now(), ...where, ...record })
            // Armor scoring rides along on the same record: the badge wants a
            // domain, and the guard already has the text.
            const scored = typeof record.head === 'string' && record.head.length > 0
              ? score(record.head)
              : { domain: null, risk: [] }
            bus.publish(where.sessionId, {
              verdict: record.released
                ? 'released'
                : record.blocked === false || record.dryRun
                  ? 'pass'
                  : 'blocked',
              reason: record.reason ?? '',
              match: record.match ?? null,
              domain: scored.domain,
              risk: scored.risk,
              words: scored.words ?? [],
              chars: record.chars ?? 0,
              source: usePreview ? 'preview' : 'stream',
              blocked: record.released === false && record.dryRun !== true && record.blocked !== false,
            })
            report(ctx, resolved, options, record)
          },

          ask: (record) => askUser(pending, resolved, signal, { ...where, ...record }),

          fail: (error) => {
            pending.counters.errors += 1
            pending.remember({
              at: Date.now(),
              ...where,
              reason: 'guard-error',
              error: error instanceof Error ? error.message : String(error),
            })
            ctx.logger?.warn(
              `feibi-breaker: guard failed and the reply passed through: ${error instanceof Error ? error.message : String(error)}`,
            )
          },
        })
      })
    }
  }

  // --- 3. projection -------------------------------------------------------
  // Registered after the guard so `readVerdict` is live by the time the first
  // assistant message folds in. The projection owns the badge; nothing else
  // writes it.
  const projectionDef = createProjection({
    readVerdict: (sessionId) => bus.read(sessionId) ?? bus.read(null),
  })
  const registerProjection = (p) => {
    try {
      // DSH 0.2.2 dropped the second (label) argument from sessionProjections.register().
      ctx.effect(() => p.register(projectionDef))
    } catch (error) {
      ctx.logger?.warn(`feibi-breaker: projection not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined) {
    registerProjection(projections)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], (innerCtx) => {
      const p = innerCtx.get('sessionProjections')
      if (p !== undefined) registerProjection(p)
    })
  }

  // --- 4. tools ------------------------------------------------------------
  // Same reasoning as the prompt: a host without a tool registry keeps the guard.
  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    ctx.effect(() => {
      ctx.tools.register(createProfileTool(resolved, bus))
      ctx.tools.register(createPromptTool())
      ctx.tools.register(createSelfTestTool(ctx, resolved))
    })
  }

  // --- 5. routes -----------------------------------------------------------
  const registerRoutes = (host, scope) => {
    const own = []
    own.push(scope.effect(() => host.fetch.register({
      path: PREVIEW_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: (request) => previewResponse(request, previews),
    }), 'feibi-breaker: preview route'))
    own.push(scope.effect(() => host.fetch.register({
      path: STATE_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: () => Promise.resolve(handleState(resolved, pending, bus)),
    }), 'feibi-breaker: state route'))
    own.push(scope.effect(() => host.fetch.register({
      path: DECIDE_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: (request) => handleDecide(pending, request),
    }), 'feibi-breaker: decide route'))
    own.push(scope.effect(() => host.fetch.register({
      path: CONFIG_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: (request) => handleConfig(ctx, request),
    }), 'feibi-breaker: config route'))
    own.push(scope.effect(() => host.fetch.register({
      path: PROMPT_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
      fetch: (request) => handlePrompt(request),
    }), 'feibi-breaker: prompt route'))
    own.push(scope.effect(() => host.fetch.register({
      path: PROMPT_RESET_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: () => handlePromptReset(),
    }), 'feibi-breaker: prompt reset route'))
    own.push(scope.effect(() => host.fetch.register({
      path: SELFTEST_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
      fetch: (request) => handleSelfTest(ctx, resolved, request),
    }), 'feibi-breaker: selftest route'))
    return own.filter((dispose) => typeof dispose === 'function')
  }

  let routesDisposed = []
  let connected = false

  const connect = () => {
    if (connected) return
    const host = ctx.get('connection')
    if (host === undefined || host.fetch === undefined) return
    routesDisposed = registerRoutes(host, ctx)
    connected = true
  }

  connect()
  if (!connected) {
    ctx.effect(() => {
      let timer = null
      let attempts = 0
      const attempt = () => {
        connect()
        if (connected) return
        attempts += 1
        if (attempts > 600) return
        timer = setTimeout(attempt, 500)
        timer.unref?.()
      }
      attempt()
      return () => {
        if (timer !== null) clearTimeout(timer)
        for (const dispose of routesDisposed) dispose()
      }
    }, 'feibi-breaker: route retry')
  }

  ctx.logger?.info(
    `feibi-breaker: active (armor=${resolved.armorEnabled ? `on${resolved.dualLayer ? '+mirror' : ''}` : 'off'}, `
    + `guard=${resolved.enabled ? resolved.interceptAt : 'off'}, onDetect=${resolved.onDetect}, `
    + `scanChars=${resolved.scanChars}, dryRun=${resolved.dryRun}, `
    + `blocklist=${resolved.blockWords.length}, patterns=${resolved.customPatterns.length})`,
  )
}

/** Exported for the test suite: the projection key the client subscribes to. */
export const PROJECTION = PROJECTION_KEY

/** Exported for the test suite: the shared bus, for hosts that read it directly. */
export const bus = sharedVerdictBus
