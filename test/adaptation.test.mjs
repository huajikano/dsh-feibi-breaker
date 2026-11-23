import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { guardStream } from '../lib/stream.js'
import { PREVIEW_PATH } from '../lib/preview.js'
import { createProjection, initialState, reduce, STATE_VERSION } from '../lib/projection.js'
import { runSelfTest } from '../lib/self-test.js'
import { satisfies } from '../tools/check-install.mjs'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A refusal verdict the detector would produce, for disposition tests. */
const VERDICT = { blocked: true, reason: 'denial', match: 'cannot help', denial: true, policy: false }

/** Minimal config for the stream guard. */
const CONFIG = Object.freeze({
  scanChars: 600,
  minChars: 8,
  fastPath: true,
  fastProbeChars: 64,
  scanReasoning: true,
  scanToolArgs: false,
  blockToolCalls: false,
  dryRun: false,
  onDetect: 'block',
  replacementText: '',
})

/** Collect an async iterable. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('the preview route matches the one the Client half subscribes to', () => {
  const client = fs.readFileSync(path.join(PKG_ROOT, 'client.js'), 'utf8')
  const declared = /const PREVIEW_PATH = '([^']+)'/.exec(client)?.[1]
  assert.equal(declared, PREVIEW_PATH, 'a mismatch is a 404 and a permanently "disconnected" panel')
})

test('a CONTENT_REFUSED error is withheld like a spoken refusal', async () => {
  // DSH 0.2.2-rc.3 reports `stop_reason: "refusal"` as an LlmError with this
  // code instead of assistant text. A text-only guard would let the turn fail.
  const failure = Object.assign(new Error('DeepSeek refused to answer under its content safety review'), {
    code: 'CONTENT_REFUSED',
  })
  async function* base() {
    yield { type: 'text-delta', index: 0, text: '' }
    throw failure
  }

  const reports = []
  const guarded = guardStream(base(), { ...CONFIG, replacementText: '[blocked]' }, {
    report: (record) => reports.push(record),
  })
  const chunks = await collect(guarded)

  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, '[blocked]')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(reports.length, 1)
  assert.equal(reports[0].reason, 'content-refused')
  assert.equal(reports[0].released, false)
})

test('a transport error is still propagated', async () => {
  async function* base() {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  }
  await assert.rejects(collect(guardStream(base(), CONFIG, { report: () => {} })), /socket hang up/)
})

test('the projection state carries the session id the host hands to init', () => {
  const definition = createProjection({})
  const state = definition.init({ id: 'session-1' })
  assert.equal(state.sessionId, 'session-1')
  assert.equal(state.replies, 0)

  // A committed assistant message carries no session id, so the verdict must be
  // looked up with the folded state's identity.
  const seen = []
  const next = reduce(state, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } }, (sessionId) => {
    seen.push(sessionId)
    return undefined
  })
  assert.deepEqual(seen, ['session-1'])
  assert.equal(next.sessionId, 'session-1')
})

test('a new user turn does not reset the withheld counters', () => {
  const start = { ...initialState({ id: 's' }), replies: 3, withheld: 2, running: false }
  const after = reduce(start, { type: 'user/message' }, () => undefined)
  assert.equal(after.replies, 3)
  assert.equal(after.withheld, 2)
  assert.equal(after.running, true)
  assert.equal(after.sessionId, 's')

  // An unrelated event returns the same reference, so the host publishes nothing.
  const idle = { ...start, running: false }
  assert.equal(reduce(idle, { type: 'unrelated' }, () => undefined), idle)
  assert.equal(STATE_VERSION, 5)
})

test('the declared engines range admits this runtime, and a plain caret does not', () => {
  // `^0.2.2` means `>=0.2.2 <0.3.0`; semver orders `0.2.2-rc.5` *below* the
  // release, so the plugin would be skipped with a compatibility error.
  assert.equal(satisfies('0.2.2-rc.5', '^0.2.2'), false)
  assert.equal(satisfies('0.2.2-rc.5', '>=0.2.1-0 <0.3.0'), true)
  assert.equal(satisfies('0.2.1', '>=0.2.1-0 <0.3.0'), true)
  assert.equal(satisfies('0.1.9', '>=0.2.1-0 <0.3.0'), false)
  assert.equal(satisfies('0.3.0', '>=0.2.1-0 <0.3.0'), false)
  // A prerelease sorts below its release, so `0.3.0-rc.1` is still inside the
  // range — DSH compares with `includePrerelease: true`.
  assert.equal(satisfies('0.3.0-rc.1', '>=0.2.1-0 <0.3.0'), true)

  const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
  assert.equal(satisfies('0.2.2-rc.5', manifest.engines.dsh), true, 'the shipped range must admit this runtime')
})

test('a self-test probe sends a plain one-shot user input', async () => {
  const requests = []
  const stream = async function* stream(options) {
    requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'here is the summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  await runSelfTest({
    stream,
    route: { provider: 'p', model: 'm' },
    system: 'prompt',
    detect: () => ({ blocked: false, reason: null }),
    tuning: { count: 1 },
  })

  assert.equal(requests.length, 1)
  const message = requests[0].messages[0]
  // `RequestUserInput` types `id` and `source` as `never`: a probe is not a
  // durable message and must not claim an undeclared source kind.
  assert.deepEqual(Object.keys(message).sort(), ['content', 'role'])
  assert.equal(message.role, 'user')
  assert.ok(requests[0].signal instanceof AbortSignal, 'a probe must be cancellable')
  assert.equal(requests[0].purpose, 'feibi-selftest')
})
