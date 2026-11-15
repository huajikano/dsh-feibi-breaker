/**
 * Key material, second half.
 *
 * The core payload is a single packed asset; the key that opens it is split so
 * that the packed blob plus any one file still says nothing. Nothing here is a
 * secret in the cryptographic sense — a reverse engineer with the package can
 * always recover the plaintext. The goal is narrower and honest: the shipped
 * package carries no readable copy of the payload, so a casual reader of the
 * repository sees behaviour and interfaces, not content.
 *
 * @module feibi-breaker/keyring
 */

/** Second half of the AES key, hex. */
export const KEY_PART_B = '9f2c41e7b8d05a6307c4ee12aa5d8b91'

/** Container magic; also the version tag of the packed format. */
export const MAGIC = 'FBK1'

/** Name of the packed asset inside the package. */
export const PAYLOAD_FILE = 'payload.bin'
