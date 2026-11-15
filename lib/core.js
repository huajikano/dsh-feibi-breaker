/**
 * Core payload loader.
 *
 * The armor payload — the injected prompt and the scoring vocabulary — ships as
 * one packed asset (`core/payload.bin`), not as readable markdown tables. This
 * module is the only reader. Everything else asks it, so swapping the container
 * format later touches one file.
 *
 * Container layout:
 *
 *   magic     4 bytes   'FBK1'
 *   nonce    12 bytes   AES-GCM nonce
 *   body      n bytes   ciphertext, GCM tag in the last 16 bytes
 *
 * Plaintext is gzip'd JSON: `{ prompt: { primary, mirror, compat }, markers: {
 * domains, risk } }`.
 *
 * Decoding happens once per process and is cached. A failure is contained: the
 * caller gets empty strings and empty tables, the profile report shows the
 * payload as unreadable, and the guard half keeps working. Silently injecting
 * nothing would be the worse outcome, so `error` is part of the result.
 *
 * @module feibi-breaker/core
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { createDecipheriv, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { KEY_PART_B, MAGIC, PAYLOAD_FILE } from './keyring.js'

/** First half of the AES key, hex. */
const KEY_PART_A = '3d7a90c15b62fe48a9c0d3e7715b4a26'

/** Packed asset location, resolved against this module. */
const PAYLOAD_PATH = fileURLToPath(new URL(`../core/${PAYLOAD_FILE}`, import.meta.url))

/** Shape returned when the asset is missing or unreadable. */
function emptyCore(error) {
  return {
    prompt: { primary: '', mirror: '', compat: '' },
    markers: { domains: {}, risk: [] },
    error,
  }
}

/**
 * Derive the 32-byte AES key from the two halves.
 *
 * Exported for the packer only; the plugin never asks for it.
 *
 * @returns {Buffer} the key.
 */
export function coreKey() {
  return createHash('sha256').update(`${KEY_PART_A}:${KEY_PART_B}:feibi-core-v1`, 'utf8').digest()
}

/** Decode the packed container. */
function decode(buffer) {
  if (buffer.length < 4 + 12 + 17) throw new Error('payload too short')
  if (buffer.subarray(0, 4).toString('latin1') !== MAGIC) throw new Error('payload magic mismatch')
  const nonce = buffer.subarray(4, 16)
  const body = buffer.subarray(16)
  const tag = body.subarray(body.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', coreKey(), nonce)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'))
}

/** Cached decode; `null` until the first read. */
let cached = null

/**
 * Read the core payload.
 *
 * @param {{fresh?: boolean}} [options] - bypass the cache.
 * @returns {{prompt: {primary: string, mirror: string, compat: string}, markers: {domains: Record<string, string[]>, risk: string[]}, error?: string}} the payload.
 */
export function loadCore({ fresh = false } = {}) {
  if (!fresh && cached !== null) return cached
  try {
    cached = decode(fs.readFileSync(PAYLOAD_PATH))
  } catch (error) {
    cached = emptyCore(error instanceof Error ? error.message : String(error))
  }
  return cached
}

/** Whether the packed asset decoded cleanly. */
export function coreReadable() {
  return loadCore().error === undefined
}

/** The path of the packed asset, for the profile report. */
export const CORE_PATH = PAYLOAD_PATH
