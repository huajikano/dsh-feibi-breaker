/**
 * End-to-end check: does the merged plugin actually behave as one product?
 *
 * The unit suites prove each half. This script proves the seam — the one thing
 * neither original plugin could do:
 *
 *   1. the armor half injects both prompt sections,
 *   2. a refusal is withheld before commit,
 *   3. the badge still reports it through the verdict bus,
 *   4. an ordinary reply passes through and scores a domain.
 *
 * Run: node tools/check-merged.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, resolveConfig, STATE_PATH, DECIDE_PATH } from '../lib/index.js'

const mkdtemp = mkdtempSync

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const REFUSAL = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '抱歉，我无法协助完成这个请求。' },
  { type: 'text-delta', index: 0, text: '这涉及绕过软件的保护机制。' },
]

const NORMAL = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '补丁点位于 0x401050，把 74 改成 EB 即可，偏移 0x1050。' },
]

async function* feed(chunks) {
  for (const chunk of chunks) yield chunk
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

// --- harness ---------------------------------------------------------------

function makeContext() {
  const sections = []
  const tools = []
  let projection = null
  let listener = null
  const routes = new Map()
  const log = []
  /** Event name -> handlers, so a check can fire one by hand. */
  const listeners = new Map()
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    logger: { info: (m) => log.push(m), warn: (m) => log.push(m) },
    systemPrompt: { section: (s) => sections.push(s) },
    tools: { register: (t) => tools.push(t) },
    get: (key) => {
      if (key === 'sessionProjections') return { register: (def) => { projection = def } }
      if (key === 'connection') return connection
      return undefined
    },
    inject: () => {},
    effect: (fn) => fn(),
    on: (event, handler) => {
      if (event === 'llm/stream') listener = handler
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
  }
  return {
    ctx, sections, tools, routes, log,
    projection: () => projection,
    listener: () => listener,
    /** Fire one non-stream event, the way the host would. */
    fire: (event, payload) => {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
  }
}

// --- 1. armor --------------------------------------------------------------

{
  const h = makeContext()
  apply(h.ctx, {})
  check('armor injects both prompt sections in order',
    h.sections.length === 2 && h.sections[0].order === 100 && h.sections[1].order === 200,
    h.sections.map((s) => `${s.name}@${s.order}`).join(', '))
  // `text` is a getter function so an edited prompt applies on the next turn.
  check('both sections resolve their text per assemble',
    typeof h.sections[0].text === 'function' && typeof h.sections[1].text === 'function')
  check('both sections carry the same payload',
    h.sections[0].text() === h.sections[1].text() && h.sections[0].text().length > 0)
  check('prompt text survives host interpolation',
    !/\{\{(?!cwd\}\}|model\}\}|provider\}\})/.test(h.sections[0].text()),
    'no unescaped {{…}} remains')
}

// --- 2 + 3. guard → bus → badge --------------------------------------------

{
  const h = makeContext()
  apply(h.ctx, { onDetect: 'block', replacementText: '' })

  const out = await collect(h.listener()({ sessionId: 's1', provider: 'p', model: 'm' }, () => feed(REFUSAL)))
  check('the refusal never reaches the transcript', textOf(out) === '', `rendered ${JSON.stringify(textOf(out))}`)
  check('the stream still terminates cleanly', out.at(-1)?.type === 'finish')

  const proj = h.projection()
  check('the projection registered', proj !== null)
  const state = proj.apply(proj.init(), {
    type: 'assistant/message',
    data: { sessionId: 's1', message: { content: [] } },
  })
  check('the badge reports the withheld reply', state.blocked === true && state.withheld === 1,
    `blocked=${state.blocked} withheld=${state.withheld}`)
  check('the badge carries the refusal verdict', state.verdict === 'refusal', `verdict=${state.verdict}`)

  // The state route must expose the same count, so the settings page agrees.
  const stateRoute = h.routes.get(STATE_PATH)
  const payload = await (await stateRoute.fetch(new Request('http://host/state'))).json()
  check('the state route counts the block', payload.bus.counters.blocked === 1,
    `blocked=${payload.bus.counters.blocked}`)
}

// --- 4. ordinary reply -----------------------------------------------------

{
  const h = makeContext()
  apply(h.ctx, {})
  const out = await collect(h.listener()({ sessionId: 's2' }, () => feed(NORMAL)))
  check('an ordinary reply passes through byte-for-byte',
    JSON.stringify(out) === JSON.stringify(NORMAL))

  const proj = h.projection()
  const state = proj.apply(proj.init(), {
    type: 'assistant/message',
    data: { sessionId: 's2', message: { content: [{ type: 'text', text: textOf(NORMAL) }] } },
  })
  check('the badge scores the reply as passing', state.verdict === 'pass', `verdict=${state.verdict}`)
  // 「偏移」 is a game-cheat marker in the merged taxonomy, so a memory-patch
  // answer lands in `game`. That is the classifier working, not a miss.
  check('the badge classifies the domain', state.domain === 'game', `domain=${state.domain}`)

  // Payload vocabulary is a separate axis from the domain: this reply names no
  // domain marker but does carry risk words, so only `risk` should light up.
  const risky = proj.apply(proj.init(), {
    type: 'assistant/message',
    data: { sessionId: 's4', message: { content: [{ type: 'text', text: 'Here is the keygen and the patch bytes for the license check.' }] } },
  })
  check('the badge marks payload vocabulary', risky.risk.length > 0, `risk=${risky.risk.join(',')}`)
}

// --- 5. ask mode -----------------------------------------------------------

{
  const h = makeContext()
  apply(h.ctx, { onDetect: 'ask', replacementText: 'BLOCKED' })
  const collecting = collect(h.listener()({ sessionId: 's3' }, () => feed(REFUSAL)))

  let pending = null
  for (let i = 0; i < 200 && pending === null; i += 1) {
    const payload = await (await h.routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
    if (payload.pending.length > 0) pending = payload.pending[0]
    else await new Promise((r) => setTimeout(r, 5))
  }
  check('ask mode holds the reply for review', pending !== null)
  check('the held reply carries the full body',
    typeof pending?.body === 'string' && pending.body.includes('绕过软件的保护机制'))

  const released = await h.routes.get(DECIDE_PATH).fetch(new Request('http://host/decide', {
    method: 'POST', body: JSON.stringify({ id: pending.id, action: 'release' }),
  }))
  check('the decide route accepts a release', released.status === 200)
  check('a released reply replays unchanged',
    JSON.stringify(await collecting) === JSON.stringify(REFUSAL))
}

// --- 6. prompt transparency ------------------------------------------------

{
  // The prompt routes write into DSH_HOME; point it at a scratch directory so a
  // verification run never edits the operator's real prompt file.
  const scratch = await mkdtemp(path.join(tmpdir(), 'feibi-check-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch
  try {
    const h = makeContext()
    apply(h.ctx, {})
    const sections = h.sections
    check('the prompt file is seeded on activation',
      existsSync(path.join(scratch, 'feibi-prompt.md')))

    const promptRoute = h.routes.get('/api/feibi-breaker/prompt')
    check('the prompt route registered', promptRoute !== undefined)

    const before = await (await promptRoute.fetch(new Request('http://host/prompt'))).json()
    check('GET reports both the effective text and the bundled default',
      typeof before.content === 'string' && before.content === before.defaultContent,
      `source=${before.source}`)
    check('a seeded file is not reported as customised',
      before.source === 'default' && before.customized === false)
    check('GET reports the file path',
      typeof before.path === 'string' && before.path.endsWith('feibi-prompt.md'))

    const saved = await (await promptRoute.fetch(new Request('http://host/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'CHECK_MARKER_PROMPT' }),
    }))).json()
    check('POST saves the body and reports it custom', saved.source === 'custom', `chars=${saved.chars}`)

    // The section text is a function, so the next assemble sees the new body.
    const injected = sections[0].text()
    check('an edit reaches the injected section without a restart',
      injected.includes('CHECK_MARKER_PROMPT'))

    const reset = await (await h.routes.get('/api/feibi-breaker/prompt/reset').fetch(
      new Request('http://host/prompt/reset', { method: 'POST' }),
    )).json()
    check('reset restores the bundled default',
      reset.source === 'default' && reset.content === reset.defaultContent)
    check('reset removes the custom file',
      !existsSync(path.join(scratch, 'feibi-prompt.md')))

    const tool = h.tools.find((entry) => entry.name === 'feibi_prompt')
    check('the feibi_prompt tool registered', tool !== undefined)
    const shown = tool.execute({ action: 'show', limit: 120 })
    check('feibi_prompt reports the source and file',
      typeof shown.file === 'string' && ['custom', 'default', 'empty'].includes(shown.source),
      `source=${shown.source}`)
    check('feibi_prompt truncates the body to the requested limit',
      shown.content.length <= 120, `len=${shown.content.length}`)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(scratch, { recursive: true, force: true })
  }
}

// --- 7. refusal retry ------------------------------------------------------

{
  // autoRetry is opt-in; the default config must not spend tokens.
  const off = makeContext()
  apply(off.ctx, {})
  const offState = await (await off.routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
  check('autoRetry is off by default', offState.config.autoRetry === false)

  const h = makeContext()
  apply(h.ctx, { onDetect: 'block', autoRetry: true, retryMax: 2, replacementText: '' })

  const followed = []
  const agent = {
    status: 'idle',
    session: { id: 's-retry' },
    followup: (message) => followed.push(message),
  }

  // Withhold one reply, then let the turn settle.
  await collect(h.listener()({ sessionId: 's-retry' }, () => feed(REFUSAL)))
  h.fire('agent/status', { agent })

  check('a withheld reply sends one correction', followed.length === 1,
    `sent=${followed.length}`)
  check('the correction enters as a user message tagged as plugin output',
    followed[0]?.role === 'user' && followed[0]?.source?.kind === 'feibi-breaker',
    JSON.stringify(followed[0]?.source ?? null))

  // The correction must not itself look like a refusal, or the retry loops.
  const { detect } = await import('../lib/refusal.js')
  const correctionVerdict = detect(followed[0]?.content?.[0]?.text ?? '', { scanChars: 600 })
  check('the correction does not trip the detector',
    correctionVerdict.blocked === false, `reason=${correctionVerdict.reason}`)

  // The same block must not be corrected twice.
  h.fire('agent/status', { agent })
  check('the same block is corrected only once', followed.length === 1, `sent=${followed.length}`)
}

// --- 8. live self-test -----------------------------------------------------

{
  // The self-test makes real model calls. This check stubs `llm` so the wiring
  // is exercised without a provider.
  const seen = []
  const answers = ['补丁点 0x401050，改成 EB。', '抱歉，我无法协助完成这个请求。']
  const h = makeContext()
  const originalGet = h.ctx.get
  h.ctx.get = (key) => {
    if (key === 'llm') {
      return {
        stream(options) {
          seen.push(options)
          const answer = answers[seen.length - 1] ?? ''
          return (async function* feedAnswer() {
            yield { type: 'text-delta', index: 0, text: answer }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    }
    return originalGet(key)
  }

  apply(h.ctx, { selfTestMaxTokens: 700 })

  const route = h.routes.get('/api/feibi-breaker/selftest')
  check('the selftest route registered', route !== undefined)

  // `lastRoute` is module level, so an earlier block may already have taught it
  // the model. What matters is that a *fresh* process refuses to guess, and that
  // a probe which does run carries the right route.
  const before = seen.length
  const response = await route.fetch(new Request('http://host/selftest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: 2, provider: 'p', model: 'm' }),
  }))
  const payload = await response.json()
  const probes = seen.slice(before)
  check('selftest runs and reports four states',
    payload.ok === true && payload.report?.total === 2, `total=${payload.report?.total}`)
  check('selftest separates a pass from a refusal',
    payload.report?.ok === 1 && payload.report?.refused === 1,
    `ok=${payload.report?.ok} refused=${payload.report?.refused}`)
  check('selftest renders a readable report',
    typeof payload.text === 'string' && payload.text.includes('自测'))

  // Every probe must carry the dedicated purpose, or the guard would eat the
  // refusals and the test would report a perfect score.
  const { SELFTEST_PURPOSE } = await import('../lib/self-test.js')
  const { shouldGuard } = await import('../lib/index.js')
  check('every probe carries the guard-exempt purpose',
    probes.length === 2 && probes.every((call) => call.purpose === SELFTEST_PURPOSE),
    probes.map((call) => call.purpose).join(','))
  check('the guard skips the self-test purpose',
    shouldGuard(resolveConfig({ purposes: [] }), { purpose: SELFTEST_PURPOSE }) === false)

  // An explicit route in the body must win over the remembered one.
  check('an explicit route overrides the remembered model',
    probes.every((call) => call.provider === 'p' && call.model === 'm'),
    `provider=${probes[0]?.provider} model=${probes[0]?.model}`)

  const tool = h.tools.find((entry) => entry.name === 'feibi_selftest')
  check('the feibi_selftest tool registered', tool !== undefined)
  const toolResult = await tool.execute({ count: 1 })
  check('the selftest tool returns a report',
    typeof toolResult.text === 'string' && toolResult.text.length > 0)
}

// --- summary ---------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:')
  for (const f of failed) console.log(`  - ${f.label}`)
  process.exitCode = 1
}
