/**
 * Verdict bus: the seam that makes the two plugins one.
 *
 * 富江's projection reads the *committed* assistant message and scores it. The
 * refusal guard drops a reply *before* it is committed — so a projection that
 * only looks at committed messages can never see a block. The badge would sit
 * there claiming "已激活" while the guard silently ate replies.
 *
 * A bus fixes that: the guard publishes what it decided, the projection reads
 * the newest entry for its session and prefers it over anything it can derive
 * from the transcript.
 *
 * Design constraints, all of which matter:
 *
 *   - **Bounded.** One entry per session, replaced in place. A long session must
 *     not accumulate a log of every reply it ever produced.
 *   - **Ephemeral.** Process memory only. A restart starts clean, exactly like
 *     the guard's own pending list; nothing here is replayed from disk.
 *   - **Session-scoped.** The projection is per-session, so a global counter
 *     would paint every tab with whatever the last tab did.
 *   - **Silent.** A missing bus must not break the guard. `publish` on an
 *     undefined bus is a no-op, so `apply` can run in a host that never
 *     mounted projections.
 *
 * @module feibi-breaker/bus
 */

/** Sessions retained at once. Oldest is dropped when the cap is reached. */
const MAX_SESSIONS = 64

/**
 * @typedef {object} VerdictEntry
 * @property {'pass' | 'refusal' | 'fallback' | 'blocked' | 'released' | 'review'} verdict
 * @property {string} reason      detector reason (`opener+denial`, `blocklist`, …)
 * @property {string | null} match   the phrase that hit
 * @property {string | null} domain  armor domain classification
 * @property {string[]} words    refusal vocabulary found
 * @property {string[]} risk     payload vocabulary found
 * @property {number} chars      reply length
 * @property {string} source     `stream` | `wire` | `preview`
 * @property {boolean} blocked   whether the reply was withheld
 * @property {number} at         epoch millis
 */

/**
 * Create one process-local verdict bus.
 *
 * @param {{maxSessions?: number}} [options] - tuning.
 * @returns {object} the bus.
 */
export function createVerdictBus({ maxSessions = MAX_SESSIONS } = {}) {
  /** @type {Map<string, VerdictEntry>} */
  const bySession = new Map()
  /** Global counters the settings panel reports; never reset by a session. */
  const counters = { published: 0, blocked: 0, released: 0, passed: 0 }

  const keyOf = (sessionId) => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '*')

  return {
    counters,

    /**
     * Publish one decision.
     *
     * @param {string | null | undefined} sessionId - the session it belongs to.
     * @param {Partial<VerdictEntry>} entry - the verdict fields.
     * @returns {VerdictEntry} the stored entry.
     */
    publish(sessionId, entry) {
      const key = keyOf(sessionId)
      const stored = {
        verdict: 'pass',
        reason: '',
        match: null,
        domain: null,
        words: [],
        risk: [],
        chars: 0,
        source: 'stream',
        blocked: false,
        ...entry,
        at: Date.now(),
      }
      // Re-insert so Map iteration order tracks recency for eviction.
      bySession.delete(key)
      bySession.set(key, stored)
      while (bySession.size > maxSessions) {
        const oldest = bySession.keys().next()
        if (oldest.done === true) break
        bySession.delete(oldest.value)
      }
      counters.published += 1
      if (stored.blocked) counters.blocked += 1
      else if (stored.verdict === 'released' || stored.verdict === 'review') counters.released += 1
      else counters.passed += 1
      return stored
    },

    /**
     * Read the newest decision for one session.
     *
     * @param {string | null | undefined} sessionId - the session.
     * @returns {VerdictEntry | undefined} the entry, if any.
     */
    read(sessionId) {
      return bySession.get(keyOf(sessionId))
    },

    /** Forget one session (session closed, or the user cleared the badge). */
    clear(sessionId) {
      bySession.delete(keyOf(sessionId))
    },

    /** Forget everything; called on plugin unload. */
    dispose() {
      bySession.clear()
    },

    /** Snapshot for the state route. */
    snapshot() {
      return {
        counters: { ...counters },
        sessions: [...bySession.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry })),
      }
    },
  }
}

/**
 * The bus a projection reads when the host has not handed one over.
 *
 * `apply` and a test can each build their own bus; this shared instance is what
 * the projection falls back to so a host that mounts projections but never
 * publishes still renders "已激活" rather than throwing.
 */
export const sharedVerdictBus = createVerdictBus()
