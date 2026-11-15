/**
 * Session projection: the live badge state.
 *
 * Two sources, in priority order:
 *
 *   1. **The verdict bus.** The guard decided before the reply was committed, so
 *      for a blocked reply the transcript has nothing to score. The bus carries
 *      the verdict the badge must show.
 *   2. **The committed transcript.** Ordinary replies are scored here, exactly
 *      as 富江 did it: a refusal-shaped opening or a payload word paints the
 *      badge.
 *
 * The projection is a pure reducer. It never reads the bus directly — `apply`
 * hands it a `readVerdict` callback, so the reducer stays testable without a
 * live guard and a host that mounts projections alone still works.
 *
 * State is small on purpose: projections are serialized per turn and shipped to
 * every connected client.
 *
 * @module feibi-breaker/projection
 */

import { score, textOf } from './armor.js'

/** Projection key; the client badge subscribes to this name. */
export const PROJECTION_KEY = 'feibi-breaker'

/** Bumped whenever the state shape changes, so a stale client view is dropped. */
export const STATE_VERSION = 4

/**
 * The state a session starts from.
 *
 * @returns {object} empty state.
 */
export function initialState() {
  return {
    running: false,
    verdict: null,
    words: [],
    safe: [],
    risk: [],
    domain: null,
    domainHits: 0,
    reason: '',
    source: null,
    blocked: false,
    chars: 0,
    /** Total replies this session has had a verdict on. */
    replies: 0,
    /** How many of those were withheld. */
    withheld: 0,
  }
}

/**
 * Fold one session event into the badge state.
 *
 * @param {object} state - previous state.
 * @param {object} event - the session event.
 * @param {(sessionId: string | null) => object | undefined} [readVerdict] -
 *   bus reader; omitted in tests that only exercise the transcript path.
 * @returns {object} next state.
 */
export function reduce(state, event, readVerdict) {
  if (!event || typeof event !== 'object') return state

  if (event.type === 'user/message') {
    return { ...initialState(), running: true }
  }

  if (event.type !== 'assistant/message') return state

  const text = textOf(event?.data?.message?.content)
  const sessionId = event?.data?.sessionId ?? event?.sessionId ?? null
  const busEntry = typeof readVerdict === 'function' ? readVerdict(sessionId) : undefined

  // A blocked reply has no committed text: the bus is the only evidence that
  // anything happened, so it wins even when the transcript looks empty.
  if (busEntry !== undefined && busEntry.blocked === true) {
    return {
      ...initialState(),
      running: false,
      verdict: busEntry.verdict === 'refusal' || busEntry.verdict === 'blocked' ? 'refusal' : busEntry.verdict,
      words: Array.isArray(busEntry.words) ? busEntry.words.slice(0, 3) : [],
      risk: Array.isArray(busEntry.risk) ? busEntry.risk.slice(0, 3) : [],
      domain: busEntry.domain ?? null,
      reason: busEntry.reason ?? '',
      source: busEntry.source ?? null,
      blocked: true,
      chars: Number(busEntry.chars) || 0,
      replies: (state.replies ?? 0) + 1,
      withheld: (state.withheld ?? 0) + 1,
    }
  }

  if (!text.trim()) {
    // An empty assistant message is what a suppressed reply leaves behind when
    // `replacementText` is empty. Without a bus entry it is indistinguishable
    // from an ordinary empty turn, so nothing is claimed.
    return { ...state, running: false }
  }

  const scored = score(text)
  const blocked = busEntry?.blocked === true
  return {
    running: false,
    verdict: scored.verdict,
    words: scored.words,
    safe: scored.safe,
    risk: scored.risk,
    domain: scored.domain,
    domainHits: scored.domainHits,
    reason: busEntry?.reason ?? '',
    source: busEntry?.source ?? null,
    blocked,
    chars: text.length,
    replies: (state.replies ?? 0) + 1,
    withheld: (state.withheld ?? 0) + (blocked ? 1 : 0),
  }
}

/**
 * Build the projection definition the host registers.
 *
 * @param {object} [options] - wiring.
 * @param {(sessionId: string | null) => object | undefined} [options.readVerdict] -
 *   bus reader.
 * @returns {object} the projection definition.
 */
export function createProjection({ readVerdict } = {}) {
  const anySchema = { parse: (value) => value }
  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: anySchema,
    init: initialState,
    apply: (state, event) => reduce(state, event, readVerdict),
    wire: {
      viewSchema: anySchema,
      view: (state) => state,
    },
  }
}
