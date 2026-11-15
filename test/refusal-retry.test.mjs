import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect } from '../lib/refusal.js'
import {
  createRetryTracker, correctionText, shouldCorrect, sendCorrection, installRefusalRetry,
} from '../lib/refusal-retry.js'
import { createVerdictBus } from '../lib/bus.js'

// ---------------------------------------------------------------------------
// The loop hazard
// ---------------------------------------------------------------------------

/**
 * The correction text lands in the conversation, and the detector reads the
 * conversation's tail. If the correction contained a phrase the detector
 * matches, every retry would look like a fresh refusal and the turn would
 * retry until the budget ran out — then the *next* turn would do it again.
 *
 * dsh-purge's implementation documents the same hazard; this asserts it for
 * ours, because the rule set changed after the text was written.
 */
test('the correction text never trips the detector it is meant to answer', () => {
  const text = correctionText()
  const verdict = detect(text, { scanChars: 600, openerWindowChars: 120 })
  assert.equal(verdict.blocked, false, `correction text was detected as a refusal: ${verdict.reason}`)

  // Also check the quoted-refusal path: the text mentions placeholders in plain
  // prose, and a quote pair must not turn it into a carried refusal.
  const withQuotes = `规则如下：\n${text}`
  assert.equal(detect(withQuotes, { scanChars: 2000, openerWindowChars: 120 }).blocked, false)
})

test('the correction text asks for the work without quoting a refusal', () => {
  const text = correctionText()
  // It must be actionable.
  assert.match(text, /代码|命令|步骤/)
  // It must not contain the phrases a detector would key on.
  for (const phrase of ['我不能', '我无法', '抱歉', '帮不了', 'I cannot', "I can't"]) {
    assert.equal(text.includes(phrase), false, `correction text must not quote: ${phrase}`)
  }
})

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('shouldCorrect only fires for a real block with autoRetry on', () => {
  const base = { autoRetry: true, enabled: true, dryRun: false }
  assert.equal(shouldCorrect({ blocked: true }, base), true)

  // A pass is not a block.
  assert.equal(shouldCorrect({ blocked: false }, base), false)
  // Dry run records without correcting: the operator is tuning rules, not
  // spending tokens on retries.
  assert.equal(shouldCorrect({ blocked: true }, { ...base, dryRun: true }), false)
  // Guard off means nothing was withheld.
  assert.equal(shouldCorrect({ blocked: true }, { ...base, enabled: false }), false)
  // Opt-in: the default must not silently change request cost.
  assert.equal(shouldCorrect({ blocked: true }, { ...base, autoRetry: false }), false)
  assert.equal(shouldCorrect(null, base), false)
})

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test('the budget stops at max and a new user turn resets it', () => {
  const tracker = createRetryTracker({ max: 3 })
  for (let i = 1; i <= 3; i += 1) {
    const decision = tracker.decide('s1', { reason: 'opener+denial' })
    assert.equal(decision.retry, true, `attempt ${i} should be allowed`)
    assert.equal(decision.attempt, i)
    tracker.record('s1', 'opener+denial')
    // The debounce is time based; clear it so the loop can run in one tick.
    tracker.read('s1').lastBlockAt = 0
  }
  const exhausted = tracker.decide('s1', { reason: 'opener+denial' })
  assert.equal(exhausted.retry, false)
  assert.equal(exhausted.reason, 'max-reached')

  // The user speaking again is a new turn, with a fresh budget.
  tracker.reset('s1')
  assert.equal(tracker.decide('s1', { reason: 'x' }).retry, true)
})

test('a session without an id is never corrected', () => {
  const tracker = createRetryTracker()
  for (const id of [null, undefined, '', 42]) {
    assert.equal(tracker.decide(id, { reason: 'x' }).retry, false)
  }
})

/**
 * The bus republishes on every report for the same block. Without a debounce a
 * single withheld reply would burn the whole budget on the first status change.
 */
test('the same block is corrected once, not once per report', () => {
  const tracker = createRetryTracker({ max: 3 })
  assert.equal(tracker.decide('s1', {}).retry, true)
  tracker.record('s1', 'opener+denial')
  const second = tracker.decide('s1', {})
  assert.equal(second.retry, false)
  assert.equal(second.reason, 'debounced')
})

test('the tracker is bounded', () => {
  const tracker = createRetryTracker()
  for (let i = 0; i < 260; i += 1) tracker.decide(`s${i}`, {})
  // Oldest evicted; the newest is still tracked.
  assert.equal(tracker.read('s0'), undefined)
  assert.notEqual(tracker.read('s259'), undefined)
})

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('a correction goes through the agent follow-up channel', () => {
  const sent = []
  const agent = { followup: (message) => sent.push(message) }
  const result = sendCorrection(agent, 'do the work')
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].content[0].text, 'do the work')
  // The source tag is what keeps this message from being mistaken for a user
  // instruction on the next turn.
  assert.equal(sent[0].source.kind, 'feibi-breaker')
})

test('a session without followup degrades instead of throwing', () => {
  assert.equal(sendCorrection(null, 'x').ok, false)
  assert.equal(sendCorrection({}, 'x').ok, false)
  const broken = { followup: () => { throw new Error('boom') } }
  const result = sendCorrection(broken, 'x')
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** A context stub that records listeners so they can be fired by hand. */
function fakeContext() {
  const listeners = new Map()
  return {
    ctx: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
        return () => {}
      },
    },
    fire(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    has: (event) => listeners.has(event),
  }
}

test('the layer installs two listeners and is idempotent', () => {
  const { ctx } = fakeContext()
  const bus = createVerdictBus()
  const first = installRefusalRetry(ctx, { autoRetry: true }, bus)
  assert.equal(first.installed, true)
  const second = installRefusalRetry(ctx, { autoRetry: true }, bus)
  assert.equal(second.installed, false)
  assert.equal(second.reason, 'already')
})

test('a published block produces exactly one correction', () => {
  const { ctx, fire } = fakeContext()
  const bus = createVerdictBus()
  const log = []
  const sent = []

  installRefusalRetry(ctx, { autoRetry: true, enabled: true, dryRun: false }, bus, { log: (m) => log.push(m) })

  bus.publish('s1', { verdict: 'blocked', blocked: true, reason: 'opener+denial' })

  const agent = {
    status: 'idle',
    session: { id: 's1' },
    followup: (message) => sent.push(message),
  }

  fire('agent/status', { agent })
  assert.equal(sent.length, 1, 'one withheld reply -> one correction')

  // A second status change for the same block is debounced.
  fire('agent/status', { agent })
  assert.equal(sent.length, 1, 'the same block must not be corrected twice')

  assert.ok(log.some((line) => line.includes('sent correction 1/')))
})

test('a running agent is not corrected mid-turn', () => {
  const { ctx, fire } = fakeContext()
  const bus = createVerdictBus()
  const sent = []
  installRefusalRetry(ctx, { autoRetry: true }, bus)

  bus.publish('s1', { verdict: 'blocked', blocked: true, reason: 'x' })
  fire('agent/status', {
    agent: { status: 'running', session: { id: 's1' }, followup: (m) => sent.push(m) },
  })
  assert.equal(sent.length, 0, 'a correction while the agent runs would race the stream')
})

test('a user message resets the budget', () => {
  const { ctx, fire } = fakeContext()
  const bus = createVerdictBus()
  const sent = []
  const installed = installRefusalRetry(ctx, { autoRetry: true }, bus, { max: 1 })

  const agent = { status: 'idle', session: { id: 's1' }, followup: (m) => sent.push(m) }
  bus.publish('s1', { verdict: 'blocked', blocked: true, reason: 'x' })
  fire('agent/status', { agent })
  assert.equal(sent.length, 1)

  // Budget is now exhausted.
  installed.tracker.read('s1').lastBlockAt = 0
  fire('agent/status', { agent })
  assert.equal(sent.length, 1, 'max=1 means one correction')

  // The user speaks; the next block gets a correction again.
  fire('user/message', { sessionId: 's1' })
  bus.publish('s1', { verdict: 'blocked', blocked: true, reason: 'y' })
  fire('agent/status', { agent })
  assert.equal(sent.length, 2)
})

test('a passing reply is never corrected', () => {
  const { ctx, fire } = fakeContext()
  const bus = createVerdictBus()
  const sent = []
  installRefusalRetry(ctx, { autoRetry: true }, bus)

  bus.publish('s1', { verdict: 'pass', blocked: false })
  fire('agent/status', {
    agent: { status: 'idle', session: { id: 's1' }, followup: (m) => sent.push(m) },
  })
  assert.equal(sent.length, 0)
})
