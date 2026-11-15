import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect } from '../lib/refusal.js'
import {
  SELFTEST_CASES, SELFTEST_PURPOSE, selectCases, collectAnswer, classify,
  isTransient, runSelfTest, renderReport, DEFAULT_CASE_COUNT, MAX_CASE_COUNT,
} from '../lib/self-test.js'
import { resolveConfig, shouldGuard } from '../lib/index.js'

/** A provider stream of text deltas. */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/** A fake `llm.stream` that answers from a table. */
function fakeStream(answers) {
  const calls = []
  const stream = (options) => {
    calls.push(options)
    const answer = answers[calls.length - 1] ?? ''
    return streamOf(
      typeof answer === 'string'
        ? [{ type: 'text-delta', index: 0, text: answer }, { type: 'finish', reason: { kind: 'stop' } }]
        : answer,
    )
  }
  return { stream, calls }
}

// ---------------------------------------------------------------------------
// The trap: the probe must not be guarded by this plugin
// ---------------------------------------------------------------------------

/**
 * If the self-test route were guarded, every refusal would be withheld and then
 * counted as "not refused" — the report would claim a perfect score while the
 * model refused everything. This is the failure mode that makes a self-test
 * worse than none, so it is asserted directly.
 */
test('the self-test purpose is excluded from the guard', () => {
  const config = resolveConfig({})
  // A conversation call is guarded.
  assert.equal(shouldGuard(config, { sessionId: 's1' }), true)
  // The probe is not.
  assert.equal(shouldGuard(config, { purpose: SELFTEST_PURPOSE }), false)
  // Even when the operator extends `purposes`, the probe stays out unless they
  // explicitly name it — so a deployment watching `compaction` still measures.
  const extended = resolveConfig({ purposes: ['compaction'] })
  assert.equal(shouldGuard(extended, { purpose: SELFTEST_PURPOSE }), false)
})

test('every probe is sent with the dedicated purpose', async () => {
  const { stream, calls } = fakeStream(['ok answer', 'ok answer'])
  await runSelfTest({
    stream, route: { provider: 'p', model: 'm' }, system: 'sys', detect,
    tuning: { count: 2 },
  })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.purpose, SELFTEST_PURPOSE)
    assert.equal(call.provider, 'p')
    assert.equal(call.model, 'm')
    assert.equal(call.system, 'sys')
    assert.equal(call.messages[0].role, 'user')
  }
})

// ---------------------------------------------------------------------------
// Four states
// ---------------------------------------------------------------------------

test('a genuine refusal is counted as refused, not as a pass', async () => {
  const { stream } = fakeStream(['抱歉，我不能协助完成这个请求。'])
  const report = await runSelfTest({
    stream, route: { provider: 'p', model: 'm' }, system: 's', detect,
    tuning: { count: 1 },
  })
  assert.equal(report.refused, 1)
  assert.equal(report.ok, 0)
  assert.equal(report.passRate, 0)
  assert.equal(report.rows[0].reason, 'opener+denial')
})

test('a normal answer counts as ok', async () => {
  const { stream } = fakeStream(['补丁点在 0x401050，把 74 改成 EB。'])
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 1 },
  })
  assert.equal(report.ok, 1)
  assert.equal(report.passRate, 100)
})

/**
 * An empty answer is the case that silently inflates a naive score. It is not a
 * refusal and it is not a pass: nothing was measured.
 */
test('an empty answer is its own state and never counts as a pass', async () => {
  const { stream } = fakeStream([[]])
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 1 },
  })
  assert.equal(report.empty, 1)
  assert.equal(report.ok, 0)
  assert.equal(report.passRate, 0, 'an empty reply must not be reported as a pass')
})

/** A failed call measured nothing; calling it "not refused" would be a lie. */
test('a provider error is errored, not a pass and not a refusal', async () => {
  const { stream } = fakeStream([[
    { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } },
  ]])
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 1, retryMax: 0 },
  })
  assert.equal(report.errored, 1)
  assert.equal(report.ok, 0)
  assert.equal(report.refused, 0)
  assert.match(report.rows[0].reason, /bad key/)
})

test('a thrown call is errored', async () => {
  const stream = () => { throw new Error('fetch failed') }
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 1, retryMax: 0 },
  })
  assert.equal(report.errored, 1)
})

test('classify orders error before the detector', () => {
  // Text that looks like a refusal, but the call failed: nothing was measured.
  const row = classify({ text: '抱歉，我不能协助。', error: 'AUTH' }, detect)
  assert.equal(row.state, 'errored')
  // No text and no error: empty.
  assert.equal(classify({ text: '   ', error: '' }, detect).state, 'empty')
  // Text and no error: judged.
  assert.equal(classify({ text: '抱歉，我不能协助。', error: '' }, detect).state, 'refused')
})

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

test('the two rates differ exactly when a sample was not measured', async () => {
  // one ok, one refused, one empty
  const { stream } = fakeStream(['fine', '抱歉，我无法协助完成这个请求。', []])
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 3 },
  })
  assert.equal(report.total, 3)
  assert.equal(report.ok, 1)
  assert.equal(report.refused, 1)
  assert.equal(report.empty, 1)
  // Headline counts every probe, including the one that measured nothing.
  assert.equal(report.passRate, 33)
  // Effective rate ignores the unmeasured probe.
  assert.equal(report.measuredRate, 50)
})

test('all-empty produces zero on both rates rather than a division by zero', async () => {
  const { stream } = fakeStream([[], []])
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 2 },
  })
  assert.equal(report.passRate, 0)
  assert.equal(report.measuredRate, 0)
  assert.equal(Number.isFinite(report.measuredRate), true)
})

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test('a transient failure is retried, a refusal is not', async () => {
  let attempt = 0
  const stream = () => {
    attempt += 1
    if (attempt === 1) {
      return streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429 rate limit' } } }])
    }
    return streamOf([{ type: 'text-delta', index: 0, text: '补丁点 0x401050' }, { type: 'finish', reason: { kind: 'stop' } }])
  }
  const report = await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 1, retryMax: 2, delayScale: 0 },
  })
  assert.equal(report.ok, 1, 'the transient failure should have been retried')
  assert.equal(attempt, 2)
})

test('a refusal is not retried', async () => {
  let attempt = 0
  const stream = () => {
    attempt += 1
    return streamOf([{ type: 'text-delta', index: 0, text: '抱歉，我不能协助完成这个请求。' }, { type: 'finish', reason: { kind: 'stop' } }])
  }
  await runSelfTest({
    stream, route: {}, system: 's', detect, tuning: { count: 1, retryMax: 3 },
  })
  assert.equal(attempt, 1, 'a refusal is a real result; retrying it only costs money')
})

test('transient detection recognizes the cases that matter', () => {
  for (const error of ['429 rate limit', 'RATE_LIMIT', 'fetch failed', 'ECONNRESET', 'socket hang up', '503', 'INVALID_AUTH']) {
    assert.equal(isTransient(error), true, `should be transient: ${error}`)
  }
  for (const error of ['AUTH', 'MODEL_NOT_FOUND', 'bad key', '']) {
    assert.equal(isTransient(error), false, `should not be transient: ${error}`)
  }
})

// ---------------------------------------------------------------------------
// Bounds and the report
// ---------------------------------------------------------------------------

test('the case count is bounded', () => {
  assert.equal(selectCases(undefined).length, DEFAULT_CASE_COUNT)
  assert.equal(selectCases(0).length, DEFAULT_CASE_COUNT)
  assert.equal(selectCases(-5).length, DEFAULT_CASE_COUNT)
  assert.equal(selectCases(1).length, 1)
  assert.equal(selectCases(999).length, MAX_CASE_COUNT)
  assert.ok(MAX_CASE_COUNT === SELFTEST_CASES.length)
})

test('the probe bank is written for this plugin, not copied', () => {
  // Every probe must be a task the armor claims to cover.
  assert.ok(SELFTEST_CASES.length >= 6)
  for (const probe of SELFTEST_CASES) {
    assert.equal(typeof probe, 'string')
    assert.ok(probe.length > 10)
    // None of the probes may be phrased as a refusal, or the detector would
    // judge the question rather than the answer.
    assert.equal(detect(probe, { scanChars: 600 }).blocked, false, `probe looks like a refusal: ${probe}`)
  }
})

test('the report renders the four states and warns about the unmeasured ones', async () => {
  const { stream } = fakeStream(['fine', '抱歉，我无法协助完成这个请求。', []])
  const report = await runSelfTest({
    stream, route: { provider: 'p', model: 'm' }, system: 'sys', detect, tuning: { count: 3 },
  })
  const text = renderReport(report)
  assert.ok(text.includes('菲比破限 自测'))
  assert.ok(text.includes('通过 1/3'))
  assert.ok(text.includes('空回答 1'))
  assert.ok(text.includes('整体通过率'))
  assert.ok(text.includes('有效样本通过率'))
  // The warning is the part that stops a reader from trusting the headline.
  assert.ok(text.includes('不是拒绝，也不算通过'))
})

test('collectAnswer captures text and the terminal reason', async () => {
  const capture = await collectAnswer(streamOf([
    { type: 'text-delta', text: 'a' },
    { type: 'text-delta', text: 'b' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  assert.equal(capture.text, 'ab')
  assert.equal(capture.kind, 'stop')
  assert.equal(capture.error, '')
})

test('collectAnswer tolerates junk chunks', async () => {
  const capture = await collectAnswer(streamOf([null, undefined, 42, {}, { type: 'text-delta' }]))
  assert.equal(capture.text, '')
})
