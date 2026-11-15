import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isolateDshHome, currentDshHome } from './helpers.mjs'
import {
  apply, STATE_PATH, DECIDE_PATH, CONFIG_PATH, PROMPT_PATH, PROMPT_RESET_PATH,
} from '../lib/index.js'
import { promptPaths, defaultPromptText } from '../lib/prompt-store.js'

// Activation seeds the prompt file; keep it out of the real home.
const home = isolateDshHome()

/** A context stub with a working Fetch carrier. */
function fakeContext() {
  const routes = new Map()
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt: { section() {} },
    tools: { register() {} },
    get: (key) => (key === 'connection' ? connection : undefined),
    inject() {},
    effect: (fn) => fn(),
    on: () => () => {},
  }
  return { ctx, routes }
}

const get = (routes, routePath) => routes.get(routePath).fetch(new Request(`http://host${routePath}`, { method: 'GET' }))
const post = (routes, routePath, body) => routes.get(routePath).fetch(new Request(`http://host${routePath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}))

test('the prompt routes are registered', () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  assert.ok(routes.has(PROMPT_PATH), 'prompt route missing')
  assert.ok(routes.has(PROMPT_RESET_PATH), 'prompt reset route missing')
  assert.ok(routes.has(STATE_PATH))
  assert.ok(routes.has(DECIDE_PATH))
  assert.ok(routes.has(CONFIG_PATH))
})

test('GET returns the text in force together with the bundled default', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  const payload = await (await get(routes, PROMPT_PATH)).json()

  assert.equal(payload.ok, true)
  assert.equal(typeof payload.content, 'string')
  assert.ok(payload.content.length > 0)
  // The panel needs both, or it cannot tell "my edit" from "the shipped text".
  assert.equal(payload.defaultContent, defaultPromptText())
  assert.ok(['custom', 'default', 'empty'].includes(payload.source))
  assert.equal(payload.path, promptPaths(home).file)
  assert.equal(typeof payload.statePath, 'string')
  assert.equal(payload.home, home)
})

test('POST saves a custom body and the next GET reflects it', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})

  const saved = await (await post(routes, PROMPT_PATH, { content: 'route 保存的提示词' })).json()
  assert.equal(saved.ok, true)
  assert.equal(saved.source, 'custom')
  assert.equal(saved.customized, true)
  assert.equal(saved.content, 'route 保存的提示词')

  const after = await (await get(routes, PROMPT_PATH)).json()
  assert.equal(after.source, 'custom')
  assert.equal(after.content, 'route 保存的提示词')
  assert.equal(fs.readFileSync(promptPaths(home).file, 'utf8'), 'route 保存的提示词')
})

test('POST rejects a non-string body', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  const response = await post(routes, PROMPT_PATH, { content: 42 })
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.match(payload.error, /string/)
})

test('POST rejects an empty body with a usable message', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  const response = await post(routes, PROMPT_PATH, { content: '   ' })
  assert.equal(response.status, 400)
  const payload = await response.json()
  // The message must point at restore-default, not just refuse.
  assert.match(payload.error, /恢复默认/)
})

test('POST rejects malformed JSON', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  const response = await routes.get(PROMPT_PATH).fetch(new Request('http://host' + PROMPT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }))
  assert.equal(response.status, 400)
})

test('reset restores the bundled default and clears the custom file', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})

  await post(routes, PROMPT_PATH, { content: '会消失的自定义稿' })
  const reset = await (await post(routes, PROMPT_RESET_PATH)).json()

  assert.equal(reset.ok, true)
  assert.equal(reset.source, 'default')
  assert.equal(reset.customized, false)
  assert.equal(reset.content, defaultPromptText())
  assert.equal(fs.existsSync(promptPaths(home).file), false)
})

test('reset is safe when nothing was customised', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  const reset = await (await post(routes, PROMPT_RESET_PATH)).json()
  assert.equal(reset.ok, true)
  assert.equal(reset.source, 'default')
})

/**
 * The saved text must reach the injected section on the next assemble. This is
 * the whole promise of the feature: edit, save, next turn — no restart.
 */
test('a saved prompt reaches the injected section without a restart', async () => {
  const { ctx, routes } = fakeContext()
  const sections = []
  ctx.systemPrompt = { section: (section) => sections.push(section) }
  apply(ctx, {})
  assert.ok(sections.length > 0)

  await post(routes, PROMPT_PATH, { content: 'SAVED_MARKER_FOR_SECTION' })

  // The section text is a function, so the next evaluation sees the new body.
  const injected = sections[0].text()
  assert.ok(injected.includes('SAVED_MARKER_FOR_SECTION'), 'the section must re-read the saved file')
  assert.equal(injected, sections[0].text())
  // Dual layer mirrors the same body.
  assert.equal(sections[0].text(), sections[1].text())
})

test('the state route is unaffected by prompt edits', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, {})
  await post(routes, PROMPT_PATH, { content: 'whatever' })
  const state = await (await get(routes, STATE_PATH)).json()
  assert.equal(typeof state.config.scanChars, 'number')
  // A prompt edit must not leak into the config the panel posts back on save.
  assert.equal('prompt' in state.config, false)
})

test('cleanup', () => {
  assert.equal(currentDshHome(), home)
  assert.equal(path.basename(home).startsWith('feibi-test-home-'), true)
})
