// Smoke test: does client.js register a module and mount its slots under the
// DSH 0.2.x browser module ABI (`window.__ModuleLoader__.load({ id, factory })`)?
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync('client.js', 'utf8')
let registration = null
const React = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  Fragment: 'frag',
}
const sandbox = {
  window: { __ModuleLoader__: { load: (r) => { registration = r } } },
  document: { baseURI: 'http://127.0.0.1:1/' },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  URL,
  EventSource: function () { return { close() {} } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (!registration) throw new Error('client.js did not register a module')
if (registration.id !== 'feibi-breaker') throw new Error(`unexpected module id ${registration.id}`)

const exported = registration.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return null
  throw new Error(`unexpected require ${name}`)
})
if (typeof exported.apply !== 'function') throw new Error('client module has no apply()')

const effects = []
const slots = []
const ctx = {
  get: () => ({ register: () => {} }),
  effect: (fn) => { effects.push(fn) },
  slots: {
    inject: (key, cb) => { cb(); return () => {} },
    register: (options) => { slots.push(options); return () => {} },
  },
}
exported.apply(ctx)

console.log('client module OK: id=%s inject=%j effects=%d slots=%j',
  registration.id, exported.inject, effects.length, slots.map((slot) => `${slot.name}#${slot.id}`))
