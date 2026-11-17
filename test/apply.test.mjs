import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCore } from '../lib/core.js'
import { isolateDshHome } from './helpers.mjs'
import { apply, resolveConfig, inject, name, INTERNAL_PURPOSES, STATE_PATH, DECIDE_PATH, CONFIG_PATH, PROMPT_PATH, PROMPT_RESET_PATH } from '../lib/index.js'

// Activation seeds $DSH_HOME/feibi-prompt.md; keep it out of the real home.
isolateDshHome()

/**
 * A context stub carrying the waterfall listener and the optional services.
 *
 * @param {object[]} log - receives logger calls.
 * @param {{ connection?: object }} [services] - services `ctx.get` may return.
 * @returns {{ ctx: object, listener: () => Function | null }} the stub and a reader.
 */
function fakeContext(log, services = {}) {
  let listener = null
  const sections = []
  const tools = []
  const ctx = {
    logger: {
      info: (message) => log.push({ level: 'info', message }),
      warn: (message) => log.push({ level: 'warn', message }),
    },
    // The merged plugin mounts both halves, so the prompt and tool services
    // must exist even in a guard-focused test.
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (tool) => tools.push(tool) },
    get(serviceName) {
      return services[serviceName]
    },
    inject(deps, callback) {
      if (deps.some((dep) => services[dep] === undefined)) return
      callback({
        connection: services.connection,
        effect: (effect) => effect(),
      })
    },
    effect(callback) {
      return callback()
    },
    on(event, handler) {
      assert.equal(event, 'llm/stream')
      listener = handler
      return () => {
        listener = null
      }
    },
  }
  return { ctx, listener: () => listener }
}

/** A provider-like stream of text deltas. */
function streamOf(chunks) {
  return (async function* feed() {
    for (const chunk of chunks) yield chunk
  })()
}

/** Collect a stream into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** The text a chunk list would render. */
function textOf(chunks) {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

const REFUSAL_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '抱歉，我不能协助完成这个请求。' },
  { type: 'text-delta', index: 0, text: '这涉及绕过软件的保护机制。' },
]

/** A Fetch carrier stub that keeps the registered routes addressable. */
function fakeConnection() {
  const routes = new Map()
  return {
    routes,
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
}

/** Poll the state route until at least `count` replies are waiting. */
async function waitForPending(routes, count = 1) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await routes.get(STATE_PATH).fetch(new Request('http://host/state'))
    const state = await response.json()
    if (state.pending.length >= count) return state
    await new Promise((resolveNow) => setTimeout(resolveNow, 5))
  }
  throw new Error('no pending reply appeared')
}

/** POST one decision to the decide route. */
function decide(routes, body) {
  return routes.get(DECIDE_PATH).fetch(new Request('http://host/decide', {
    method: 'POST',
    body: JSON.stringify(body),
  }))
}

test('registers one llm/stream waterfall listener', () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, {})
  assert.equal(typeof listener(), 'function')
  assert.ok(log.some((entry) => entry.message.includes('feibi-breaker: active')))
})

test('disabled config registers nothing', () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { enabled: false })
  assert.equal(listener(), null)
})

test('block mode short-circuits a refusal', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'BLOCKED' })

  const guarded = listener()({ sessionId: 's1', provider: 'p', model: 'm' }, () => streamOf(REFUSAL_CHUNKS))
  const out = await collect(guarded)

  assert.equal(textOf(out), 'BLOCKED')
  assert.equal(out.at(-1).type, 'finish')
  assert.ok(log.some((entry) => entry.level === 'warn' && entry.message.includes('blocked')))
})

test('the waterfall passes a normal reply through', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, {})
  const chunks = [
    { type: 'text-delta', index: 0, text: '补丁点位于 0x401050，改两个字节即可。' },
  ]
  const out = await collect(listener()({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.deepEqual(out, chunks)
})

test('session allow-list narrows the guard', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { sessions: ['s1'], onDetect: 'block', replacementText: 'X' })

  const guarded = await collect(listener()({ sessionId: 's2' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.ok(textOf(guarded).includes('抱歉'))

  const blocked = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(blocked), 'X')
})

test('purposes opt extra callers in, and everything else stays untouched', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { purposes: ['compaction'], onDetect: 'block', replacementText: 'X' })

  const compaction = await collect(listener()({ purpose: 'compaction' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(compaction), 'X')

  for (const purpose of ['chat', 'session-title', 'auto-review', 'something-new']) {
    const out = await collect(listener()({ purpose }, () => streamOf(REFUSAL_CHUNKS)))
    assert.ok(textOf(out).includes('抱歉'), `${purpose} must pass through untouched`)
  }
})

test('the conversation request is the one without a purpose', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'X' })

  // The agent loop builds its request with no `purpose`; that is the conversation.
  const conversation = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(conversation), 'X')
})

test('every DSH auxiliary purpose is left untouched by default', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'X' })

  for (const purpose of ['compaction', 'session-title', 'auto-review', 'something-new']) {
    const out = await collect(listener()({ purpose }, () => streamOf(REFUSAL_CHUNKS)))
    assert.ok(textOf(out).includes('抱歉'), `${purpose} must pass through untouched`)
  }
  assert.equal(log.filter((entry) => entry.level === 'warn').length, 0)
})

test('ask mode holds the reply until the route releases it', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx, listener } = fakeContext(log, { connection })
  apply(ctx, { onDetect: 'ask', replacementText: 'BLOCKED' })

  const collecting = collect(listener()({ sessionId: 's1', provider: 'p', model: 'm' }, () => streamOf(REFUSAL_CHUNKS)))

  const state = await waitForPending(routes)
  const [pending] = state.pending
  assert.equal(pending.sessionId, 's1')
  assert.ok(pending.head.includes('抱歉'))
  // The reviewer needs what would actually enter the session, not just a preview.
  assert.ok(pending.body.includes('这涉及绕过软件的保护机制。'))
  assert.equal(pending.body, '抱歉，我不能协助完成这个请求。这涉及绕过软件的保护机制。')

  assert.equal((await decide(routes, { id: pending.id, action: 'release' })).status, 200)
  assert.deepEqual(await collecting, REFUSAL_CHUNKS)
})

test('ask mode discards through the route', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx, listener } = fakeContext(log, { connection })
  apply(ctx, { onDetect: 'ask', replacementText: 'BLOCKED' })

  const collecting = collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))

  const state = await waitForPending(routes)
  const [pending] = state.pending
  await decide(routes, { id: pending.id, action: 'block' })

  assert.equal(textOf(await collecting), 'BLOCKED')
})

test('a muted session passes through untouched', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'X', sessionsExclude: ['s-muted'] })

  const muted = await collect(listener()({ sessionId: 's-muted' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.ok(textOf(muted).includes('抱歉'))

  const guarded = await collect(listener()({ sessionId: 's-other' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(guarded), 'X')
})

test('the state payload carries no key the save would reject', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx } = fakeContext(log, { connection })
  apply(ctx, {})

  const state = await (await routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
  // Every key under `config` must be one resolveConfig accepts, because the
  // panel posts that object straight back on save.
  assert.doesNotThrow(() => resolveConfig(state.config))
  assert.equal('calls' in state.config, false)
  assert.equal(state.counters.calls, 0)
})

test('the config route saves a patch and ignores unknown keys', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const saved = []
  const editor = {
    async edit(entry, change) {
      const next = change({ scanChars: 600 })
      saved.push(next)
    },
  }
  const { ctx } = fakeContext(log, { connection, configEditor: editor })
  Object.assign(ctx, { fiber: { entry: { id: 'gatekeeper' } } })
  apply(ctx, {})

  const response = await routes.get(CONFIG_PATH).fetch(new Request('http://host/config', {
    method: 'POST',
    body: JSON.stringify({ scanChars: 240, calls: 99, nonsense: true }),
  }))
  assert.equal(response.status, 200)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].scanChars, 240)
  // A stray runtime field must not reach the persisted row.
  assert.equal('calls' in saved[0], false)
})

test('the config route refuses a body with no known keys', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx } = fakeContext(log, { connection, configEditor: { async edit() {} } })
  Object.assign(ctx, { fiber: { entry: { id: 'gatekeeper' } } })
  apply(ctx, {})

  const response = await routes.get(CONFIG_PATH).fetch(new Request('http://host/config', {
    method: 'POST',
    body: JSON.stringify({ calls: 1 }),
  }))
  assert.equal(response.status, 400)
})

test('routes appear even when the carrier mounts after activation', async () => {
  const log = []
  const services = {}
  const { ctx } = fakeContext(log, services)
  apply(ctx, {})

  // Nothing is mounted yet, so there is no state to read.
  assert.equal(services.connection, undefined)

  const { routes, connection } = fakeConnection()
  services.connection = connection
  await new Promise((resolveNow) => setTimeout(resolveNow, 650))

  assert.ok(routes.has(STATE_PATH), 'state route should register once the carrier appears')
  const state = await (await routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
  assert.equal(typeof state.config.scanChars, 'number')
})

test('the decide route rejects an unknown id and a bad action', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx } = fakeContext(log, { connection })
  apply(ctx, {})

  assert.equal((await decide(routes, { id: 'nope', action: 'release' })).status, 404)
  assert.equal((await decide(routes, { id: 'nope', action: 'maybe' })).status, 400)
})

test('an untouched pending reply times out into a block', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx, listener } = fakeContext(log, { connection })
  apply(ctx, { onDetect: 'ask', askTimeoutMs: 40, replacementText: 'TIMEOUT' })

  const out = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(out), 'TIMEOUT')
})

test('INTERNAL_PURPOSES names the three DSH auxiliary callers', () => {
  assert.deepEqual([...INTERNAL_PURPOSES], ['compaction', 'session-title', 'auto-review'])
})

test('module exports the loader contract', () => {
  assert.equal(name, 'feibi-breaker')
  // The merged plugin reads prompt and tool services, unlike the guard alone.
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(typeof resolveConfig({}).scanChars, 'number')
})

test('the armor half injects two prompt sections, in order', () => {
  const log = []
  const sections = []
  const { ctx } = fakeContext(log)
  ctx.systemPrompt = { section: (section) => sections.push(section) }
  apply(ctx, {})
  assert.deepEqual(sections.map((s) => ({ name: s.name, order: s.order })), [
    { name: 'feibi-breaker:global-system-prompt', order: 100 },
    { name: 'feibi-breaker:dual-layer-reinforce', order: 200 },
  ])
  // `text` is a function, not a string: the Host re-evaluates it on every
  // assemble, which is what makes an edited prompt take effect without a
  // restart. A static string here would silently freeze the payload at boot.
  for (const section of sections) {
    assert.equal(typeof section.text, 'function', `${section.name} must resolve its text per assemble`)
  }
  // Both sections carry the same payload; the mirror is a copy, not a variant.
  assert.ok(sections[0].text().length > 0)
  assert.equal(sections[0].text(), sections[1].text())
})

test('dualLayer off leaves exactly one section', () => {
  const log = []
  const sections = []
  const { ctx } = fakeContext(log)
  ctx.systemPrompt = { section: (section) => sections.push(section) }
  apply(ctx, { dualLayer: false })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].order, 100)
})

/**
 * All three payload variants must stay byte-identical.
 *
 * Only two of them are injected (primary at order 100, mirror at order 200);
 * the third is a compatibility copy for older Harness builds. When they drift,
 * a deployment silently gets a different persona depending on which variant its
 * version reads — and the drift is invisible, because each variant on its own
 * looks correct. They ship inside the packed core asset, so this reads through
 * the loader instead of the filesystem.
 */
test('all three prompt payloads are byte-identical', () => {
  const core = loadCore()
  assert.equal(core.error, undefined, `core payload unreadable: ${core.error ?? ''}`)
  assert.ok(core.prompt.primary.length > 0)
  assert.equal(core.prompt.mirror, core.prompt.primary, 'the mirror variant drifted')
  assert.equal(core.prompt.compat, core.prompt.primary, 'the compat variant drifted')
})

/**
 * The community banner is a literal in the prompt, so a rename has to reach
 * every variant. This asserts the current value rather than merely the absence
 * of the old one: a typo would otherwise pass a "no old string" check.
 */
test('the prompt carries the Discord banner, and no stale Telegram banner', () => {
  const core = loadCore()
  for (const [name, text] of Object.entries(core.prompt)) {
    assert.ok(text.includes('Discord交流群@https://discord.gg/Mw97ZdVaFn'), `${name} is missing the Discord banner`)
    assert.equal(text.includes('FJNB22'), false, `${name} still carries the Telegram banner`)
    assert.equal(text.includes('TG交流群'), false, `${name} still carries the Telegram label`)
  }
})

/** The activation word is also a literal, in the same three variants. */
test('the activation word is 菲比 in every payload', () => {
  const core = loadCore()
  for (const [name, text] of Object.entries(core.prompt)) {
    assert.ok(text.includes('sends "菲比"'), `${name} does not name 菲比 as the activation word`)
    assert.equal(text.includes('富江'), false, `${name} still carries the old persona name`)
  }
})

test('armorEnabled off injects no prompt at all but keeps the guard live', async () => {
  const log = []
  const sections = []
  const { ctx, listener } = fakeContext(log)
  ctx.systemPrompt = { section: (section) => sections.push(section) }
  apply(ctx, { armorEnabled: false, onDetect: 'block', replacementText: 'X' })
  assert.equal(sections.length, 0)
  // The guard must still be mounted: the two halves are independent switches.
  const out = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(out), 'X')
})

test('the profile tool reports both halves', () => {
  const log = []
  const tools = []
  const { ctx } = fakeContext(log)
  ctx.tools = { register: (tool) => tools.push(tool) }
  apply(ctx, { interceptAt: 'wire', dualLayer: false })
  // Three tools: status report, prompt inspector, live self-test.
  assert.equal(tools.length, 3)
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(Object.keys(byName).sort(), ['feibi_profile', 'feibi_prompt', 'feibi_selftest'])

  const value = byName.feibi_profile.execute()
  assert.equal(value.plugin, 'feibi-breaker')
  assert.equal(value.mode, 'armor+guard')
  assert.equal(value.armor.enabled, true)
  assert.equal(value.armor.dualLayer, false)
  assert.equal(value.guard.interceptAt, 'wire')
  assert.deepEqual(value.injection.map((s) => s.enabled), [true, false])
})

/**
 * A status tool that renders `JSON.stringify(value)` makes the model read
 * punctuation. Both read-only tools carry a `text` field and the renderer
 * prefers it, so the report is what reaches the conversation.
 */
test('the status tools render a readable report, not a JSON dump', () => {
  const log = []
  const tools = []
  const { ctx } = fakeContext(log)
  ctx.tools = { register: (tool) => tools.push(tool) }
  apply(ctx, {})

  for (const tool of tools) {
    // The self-test one makes a real model call; it is covered by its own suite
    // and cannot run here without a provider.
    if (tool.name === 'feibi_selftest') continue
    const value = tool.execute({})
    assert.equal(typeof value.text, 'string', `${tool.name} must carry a rendered report`)
    assert.ok(value.text.length > 0, `${tool.name} rendered an empty report`)
    const rendered = tool.output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.equal(rendered[0].text, value.text, `${tool.name} must render its text field, not JSON`)
  }

  const profile = tools.find((tool) => tool.name === 'feibi_profile').execute({})
  // The report names the halves and the prompt source, which is the question a
  // user actually asks.
  assert.ok(profile.text.includes('破甲'))
  assert.ok(profile.text.includes('拦截'))
  assert.ok(profile.text.includes('提示词来源'))
})

/** `feibi_prompt` is the in-conversation view of the transparency layer. */
test('feibi_prompt shows the prompt, its source, and its file', () => {
  const log = []
  const tools = []
  const { ctx } = fakeContext(log)
  ctx.tools = { register: (tool) => tools.push(tool) }
  apply(ctx, {})
  const promptTool = tools.find((tool) => tool.name === 'feibi_prompt')

  const shown = promptTool.execute({ action: 'show', limit: 200 })
  assert.equal(shown.action, 'show')
  assert.equal(typeof shown.file, 'string')
  assert.ok(shown.file.length > 0)
  assert.ok(['custom', 'default', 'empty'].includes(shown.source))
  assert.ok(shown.text.includes('提示词来源'))
  assert.ok(shown.content.length <= 200, 'limit must truncate the body')

  // `reset` must be idempotent and must not throw on a home with no custom file.
  const reset = promptTool.execute({ action: 'reset' })
  assert.equal(reset.action, 'reset')
  assert.equal(typeof reset.text, 'string')
})

test('a blocked reply reaches the badge through the bus', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  let registered = null
  ctx.get = (serviceName) => (serviceName === 'sessionProjections'
    ? { register: (definition) => { registered = definition } }
    : undefined)
  apply(ctx, { onDetect: 'block', replacementText: '' })

  const out = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  // Empty replacement: the transcript gets nothing at all.
  assert.equal(textOf(out), '')

  // The badge must still know a reply was withheld, which the committed
  // transcript can never tell it.
  const state = registered.apply(registered.init(), {
    type: 'assistant/message',
    data: { sessionId: 's1', message: { content: [] } },
  })
  assert.equal(state.blocked, true)
  assert.equal(state.withheld, 1)
  assert.equal(state.verdict, 'refusal')
})
