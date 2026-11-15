import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolvePrompt, savePrompt, resetPrompt, seedPromptFile, escapeInterpolation,
  promptPaths, defaultPromptText, normalizePrompt, hashPrompt, findDshHome,
  MAX_PROMPT_BYTES, PROMPT_FILE_NAME, invalidatePromptCache,
} from '../lib/prompt-store.js'

/** A scratch DSH home per test. */
function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feibi-prompt-store-'))
}

/** Read a resolution with the cache bypassed. */
const fresh = (dir) => resolvePrompt(dir, { fresh: true })

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

test('with no file at all the bundled default is in force', () => {
  const dir = home()
  const resolved = fresh(dir)
  assert.equal(resolved.source, 'default')
  assert.equal(resolved.customized, false)
  assert.ok(resolved.chars > 0)
  assert.equal(resolved.file, path.join(dir, PROMPT_FILE_NAME))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a custom file wins over the bundled default', () => {
  const dir = home()
  savePrompt(dir, '我自己的提示词')
  const resolved = fresh(dir)
  assert.equal(resolved.source, 'custom')
  assert.equal(resolved.customized, true)
  assert.equal(resolved.text, '我自己的提示词')
  fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Seeding materialises the default on disk. Reporting that as `custom` would
 * show a "已自定义" badge to a user who never changed anything — the badge has to
 * mean "this differs from what shipped".
 */
test('a file holding exactly the default is still reported as default', () => {
  const dir = home()
  assert.equal(seedPromptFile(dir).action, 'created')
  const resolved = fresh(dir)
  assert.equal(resolved.source, 'default', 'seeding is not a customisation')
  assert.equal(resolved.customized, false)
  // The file really does exist: the whole point of seeding.
  assert.equal(fs.existsSync(promptPaths(dir).file), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('seeding never overwrites a file that already has content', () => {
  const dir = home()
  savePrompt(dir, 'keep me')
  assert.equal(seedPromptFile(dir).action, 'kept')
  assert.equal(fresh(dir).text, 'keep me')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('saving the default text verbatim is not a customisation', () => {
  const dir = home()
  const result = savePrompt(dir, defaultPromptText())
  assert.equal(result.ok, true)
  assert.equal(result.source, 'default')
  assert.equal(result.customized, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Save / reset
// ---------------------------------------------------------------------------

test('saving writes the file, the state file, and reports the new hash', () => {
  const dir = home()
  const result = savePrompt(dir, '新的提示词 {{cwd}}')
  assert.equal(result.ok, true)
  assert.equal(result.source, 'custom')
  assert.equal(fs.readFileSync(promptPaths(dir).file, 'utf8'), '新的提示词 {{cwd}}')

  const state = JSON.parse(fs.readFileSync(promptPaths(dir).stateFile, 'utf8'))
  assert.equal(state.customized, true)
  assert.equal(state.hash, hashPrompt('新的提示词 {{cwd}}'))
  assert.equal(typeof state.seedHash, 'string')
  assert.equal(typeof state.updatedAt, 'string')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('reset deletes the custom file and falls back to the default', () => {
  const dir = home()
  savePrompt(dir, 'temporary')
  const result = resetPrompt(dir)
  assert.equal(result.ok, true)
  assert.equal(result.source, 'default')
  assert.equal(fs.existsSync(promptPaths(dir).file), false)
  assert.equal(fresh(dir).chars, defaultPromptText().trim().length)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('reset on a home with no custom file is a no-op, not an error', () => {
  const dir = home()
  const result = resetPrompt(dir)
  assert.equal(result.ok, true)
  assert.equal(result.source, 'default')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an empty or whitespace-only body is rejected', () => {
  const dir = home()
  for (const body of ['', '   ', '\n\n\t', ' \r\n ']) {
    const result = savePrompt(dir, body)
    assert.equal(result.ok, false, `saving ${JSON.stringify(body)} must be refused`)
    assert.match(result.error, /不能为空/)
  }
  // A rejected save must not have created the file.
  assert.equal(fs.existsSync(promptPaths(dir).file), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a non-string body is rejected', () => {
  const dir = home()
  for (const body of [null, undefined, 42, {}, []]) {
    assert.equal(savePrompt(dir, body).ok, false)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an oversized body is rejected before it is written', () => {
  const dir = home()
  const huge = 'x'.repeat(MAX_PROMPT_BYTES + 1)
  const result = savePrompt(dir, huge)
  assert.equal(result.ok, false)
  assert.match(result.error, /上限/)
  assert.equal(fs.existsSync(promptPaths(dir).file), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('CRLF and trailing whitespace do not count as a change', () => {
  const dir = home()
  savePrompt(dir, 'line one\nline two')
  const first = fresh(dir)
  savePrompt(dir, 'line one\r\nline two\r\n')
  const second = fresh(dir)
  assert.equal(second.source, 'custom')
  assert.equal(normalizePrompt(first.text), normalizePrompt(second.text))
  assert.equal(first.hash, second.hash)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Injection-time escaping
// ---------------------------------------------------------------------------

/**
 * The host throws on an unknown `{{…}}`. Escape is applied at injection time and
 * never stored, so the user's file keeps their exact text — including braces.
 */
test('interpolation escaping happens at injection, not on disk', () => {
  const dir = home()
  const body = 'keep {{cwd}} but escape {{not_a_variable}}'
  savePrompt(dir, body)
  assert.equal(fs.readFileSync(promptPaths(dir).file, 'utf8'), body, 'the file is untouched')

  const escaped = escapeInterpolation(body)
  assert.ok(escaped.includes('{{cwd}}'), 'known variables survive')
  assert.equal(escaped.includes('{{not_a_variable}}'), false, 'unknown braces are split')
  assert.ok(escaped.includes('{ {not_a_variable}}'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the bundled default escapes cleanly', () => {
  const escaped = escapeInterpolation(defaultPromptText())
  assert.equal(/\{\{(?!cwd\}\}|model\}\}|provider\}\})/.test(escaped), false)
})

// ---------------------------------------------------------------------------
// Cache correctness
// ---------------------------------------------------------------------------

/**
 * The section text is evaluated on every assemble, so a stale cache would mean
 * "saved but does not apply", which is the exact failure this layer exists to
 * prevent.
 */
test('an external edit is picked up once the file mtime changes', async () => {
  const dir = home()
  savePrompt(dir, 'first')
  assert.equal(resolvePrompt(dir).text, 'first')

  // Write behind the module's back, the way a user's editor would.
  await new Promise((resolveNow) => setTimeout(resolveNow, 12))
  fs.writeFileSync(promptPaths(dir).file, 'second, written by an editor', 'utf8')

  assert.equal(resolvePrompt(dir).text, 'second, written by an editor')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('invalidatePromptCache forces a re-read', () => {
  const dir = home()
  savePrompt(dir, 'before')
  assert.equal(resolvePrompt(dir).text, 'before')
  fs.writeFileSync(promptPaths(dir).file, 'after', 'utf8')
  invalidatePromptCache()
  assert.equal(resolvePrompt(dir).text, 'after')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Home resolution
// ---------------------------------------------------------------------------

test('DSH_HOME wins, and the fallback is <home>/.dsh', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'D:\\explicit\\dsh'
    assert.equal(findDshHome(), 'D:\\explicit\\dsh')
    // A caller-supplied home beats the environment, which is what lets tests and
    // the status tool ask about a specific profile.
    assert.equal(findDshHome('D:\\other'), 'D:\\other')
    delete process.env.DSH_HOME
    assert.equal(findDshHome(), path.join(os.homedir(), '.dsh'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
