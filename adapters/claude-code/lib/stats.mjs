/**
 * 统计与流水。
 *
 * 计数器让 `feibi-cc status` 能回答"它到底有没有在干活"，流水让
 * `feibi-cc log` 能回答"刚才那条为什么被拦"。这两件事必须分开：
 * 计数器是给人看的一句话，流水是排查用的证据。
 *
 * @module feibi-breaker-cc/stats
 */

import fs from 'node:fs'
import { feibiPaths, loadState, saveState } from './config.mjs'

/** 流水文件超过这个大小就轮转一次，免得长年累月涨成几十兆。 */
const ROTATE_BYTES = 2 * 1024 * 1024

/** 流水里每条最多带这么多字的开头，够认出来就行。 */
const HEAD_CHARS = 160

/**
 * 建一个统计器。
 *
 * @param {{home?: string, config?: object}} [options] - 家目录与配置。
 * @returns {object} 统计器。
 */
export function createStats({ home, config } = {}) {
  const paths = feibiPaths(home)
  const state = loadState(home)
  state.startedAt = new Date().toISOString()

  let dirty = 0

  const persist = (force) => {
    dirty += 1
    if (!force && dirty < 5) return
    dirty = 0
    try {
      saveState(state, home)
    } catch {
      // 统计写不进去不该影响转发；文件锁、只读盘都见过。
    }
  }

  const appendEvent = (event) => {
    if (config?.eventLog === false) return
    try {
      fs.mkdirSync(paths.root, { recursive: true })
      try {
        const stat = fs.statSync(paths.events)
        if (stat.size > ROTATE_BYTES) fs.renameSync(paths.events, `${paths.events}.1`)
      } catch {
        // 没有旧文件就不用轮转。
      }
      fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 同上：流水不是关键路径。
    }
  }

  return {
    state,

    /**
     * 记一次判定。
     *
     * @param {object} event - {phase, blocked, reason, match, chars, head, protocol, path, attempt}
     */
    record(event) {
      const kind = String(event?.kind ?? 'judge')
      if (kind === 'judge') {
        state.judged += 1
        if (event.blocked === true) state.blocked += 1
        else state.passed += 1
      } else if (kind === 'inject') {
        state.injected += 1
      } else if (kind === 'retry') {
        state.retried += 1
      }
      state.lastEventAt = new Date().toISOString()
      appendEvent({
        at: state.lastEventAt,
        ...event,
        head: typeof event?.head === 'string' ? event.head.slice(0, HEAD_CHARS) : undefined,
      })
      persist(false)
    },

    /** 关掉之前强制落一次盘。 */
    flush() {
      persist(true)
    },

    /** 读一份快照。 */
    snapshot() {
      return { ...state }
    },
  }
}

/**
 * 读最近的流水。
 *
 * @param {number} [limit] - 取多少条。
 * @param {string} [home] - 家目录。
 * @returns {object[]} 事件数组，旧的在前。
 */
export function readEvents(limit = 20, home) {
  const paths = feibiPaths(home)
  let raw = ''
  try {
    raw = fs.readFileSync(paths.events, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return { at: null, kind: 'broken', raw: line.slice(0, HEAD_CHARS) }
    }
  })
}
