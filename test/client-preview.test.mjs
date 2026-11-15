import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Minimal hook runner exercises the actual shipped Client, with no browser or
// live DSH calls. Deliberately not a second preview UI implementation.
function client() {
  let plugin
  const registrations = []
  let initialState = null
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(value) { const out = initialState; initialState = null; return [out ?? value, () => {}] },
    useEffect() {}, useCallback(fn) { return fn },
    // The badge keeps its flash window in refs; a stub that omits them makes
    // every badge test fail for a reason unrelated to the badge.
    useRef(current) { return { current } },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(def) { plugin = def.factory(name => { if (name === 'react') return React; throw new Error(name) }) } } },
  })
  plugin.apply({ get() {}, effect(fn) { return fn() }, slots: {
    inject(_, fn) { fn() }, register(options, view) { registrations.push({ options, view }); return () => {} },
  } })
  return { registrations, render(view, props, state) { initialState = state; return view(props) } }
}
function nodes(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...node.children.flat(Infinity).flatMap(nodes)]
}

test('Client offers preview as a separate mode and keeps the existing modes', () => {
  const c = client()
  const page = c.registrations.find(r => r.options.name === 'settings.section')
  const tree = c.render(page.view, { t: key => key }, { config: { enabled: true, interceptAt: 'preview' }, pending: [], recent: [], counters: {} })
  const values = nodes(tree).filter(n => n.type === 'option').map(n => n.props.value)
  for (const value of ['stream', 'wire', 'both', 'preview']) assert.ok(values.includes(value))
})

/** Every function-typed element in a tree: the components the host would render. */
function components(node) {
  if (!node || typeof node !== 'object') return []
  const own = typeof node.type === 'function' ? [node] : []
  return [...own, ...node.children.flat(Infinity).flatMap(components)]
}

/** Render one component element with the given props. */
function renderComponent(element) {
  return element.type(element.props)
}

test('the dock always mounts the badge, and the preview only in preview mode', () => {
  const c = client()
  const dock = c.registrations.find(r => r.options.name === 'conversation.input.dock')

  // Merged behavior: the badge is permanent. The originals each registered
  // their own dock entry, and each returned null outside its own mode — so the
  // status line vanished whenever the other half was the active one.
  const stream = c.render(dock.view, { t: key => key, sessionId: 'a' }, { config: { interceptAt: 'stream' }, pending: [] })
  const streamKinds = components(stream)
  assert.equal(streamKinds.length, 1, 'stream mode mounts exactly the badge')
  assert.equal(streamKinds[0].props.useProjection, undefined)
  // The badge renders even with no projection at all.
  const badge = renderComponent(streamKinds[0])
  assert.equal(nodes(badge).filter(n => n.props && n.props['data-plugin'] === 'feibi-breaker').length, 1)

  // Preview adds its own component on top of the badge, never instead of it.
  const preview = c.render(dock.view, { t: key => key, sessionId: 'a' }, { config: { interceptAt: 'preview' }, pending: [] })
  const previewKinds = components(preview)
  assert.equal(previewKinds.length, 2, 'preview mode mounts the badge and the preview dock')
  assert.ok(previewKinds.some(el => el.props.sessionId === 'a'), 'the preview dock receives the session id')
})

test('the badge reports a withheld reply that never reached the transcript', () => {
  const c = client()
  const dock = c.registrations.find(r => r.options.name === 'conversation.input.dock')
  const view = c.render(dock.view, {
    t: key => key,
    sessionId: 'a',
    // The projection is fed by the verdict bus, which is the only source that
    // knows about a reply the guard dropped before commit.
    useProjection: key => {
      assert.equal(key, 'feibi-breaker')
      return { running: false, verdict: 'refusal', blocked: true, withheld: 1, words: ['我无法'], risk: [], domain: 'crack', chars: 0 }
    },
  }, { config: { interceptAt: 'stream' }, pending: [] })

  const badgeElement = components(view).find(el => el.props.useProjection !== undefined)
  assert.ok(badgeElement, 'the badge subscribes to the projection')
  const badge = renderComponent(badgeElement)
  const badges = nodes(badge).filter(n => n.props && n.props['data-plugin'] === 'feibi-breaker')
  assert.equal(badges.length, 1)
  assert.equal(badges[0].props['data-blocked'], 'true')
})

/** The settings page is the only place the prompt and self-test panels live. */
test('the settings page mounts the prompt and self-test panels', () => {
  const c = client()
  const page = c.registrations.find(r => r.options.name === 'settings.section')
  const tree = c.render(page.view, { t: key => key }, {
    config: {
      enabled: true,
      armorEnabled: true,
      dualLayer: true,
      interceptAt: 'stream',
      onDetect: 'block',
      autoRetry: false,
      blocklist: [],
      wireUrlPatterns: [],
      wireTerminator: '',
    },
    pending: [],
    recent: [],
    counters: {},
  })

  const kinds = components(tree)
  // PromptPanel fetches /prompt; SelfTestPanel fetches /selftest. Both render
  // even before their data arrives, so their presence is checkable here.
  assert.ok(kinds.length >= 2, 'settings must mount the prompt and self-test panels')
  for (const element of kinds) {
    // Rendering either one must not throw with a null data set.
    assert.doesNotThrow(() => element.type(element.props))
  }
})
