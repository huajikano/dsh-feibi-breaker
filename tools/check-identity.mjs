import fs from 'node:fs'
import { loadCore } from '../lib/core.js'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const idx = fs.readFileSync('lib/index.js', 'utf8')
const proj = fs.readFileSync('lib/projection.js', 'utf8')
const cl = fs.readFileSync('client.js', 'utf8')
// The payload lives in the packed core asset; reading it through the loader is
// the only supported way and keeps this tool working without the plaintext.
const prompt = loadCore().prompt.primary
const inst = fs.readFileSync('scripts/lib/install.js', 'utf8')
const patch = fs.readFileSync('cordis.patch.yml', 'utf8')

const row = (label, value) => console.log(`  ${label.padEnd(18)} ${value}`)

console.log('== identity ==')
row('package.name', pkg.name)
row('dsh.id', pkg.dsh.id)
row('dsh.name', pkg.dsh.name)
row('export name', /export const name = '([^']+)'/.exec(idx)[1])
row('tool', /name: 'feibi_profile'/.test(idx) ? 'feibi_profile' : 'MISSING')
row('PROJECTION_KEY', /PROJECTION_KEY = '([^']+)'/.exec(proj)[1])
row('STATE_PATH', /STATE_PATH = '([^']+)'/.exec(idx)[1])
row('client id', /id: '([^']+)'/.exec(cl)[1])
row('dock id', /id: '([^']+:dock)'/.exec(cl)[1])
row('cordis row', /- id: ([a-z-]+)/.exec(patch.split('\n').find(l => l.includes('    - id:')))[1])

console.log('\n== display copy ==')
row('badge', /badgeActive: '([^']+)'/.exec(cl)[1])
row('settings title', /title: '([^']+)'/.exec(cl)[1])
row('prompt persona', prompt.split('\n')[0].slice(0, 30))
row('activation word', /sends "([^"]+)"/.exec(prompt)[1])

console.log('\n== installer ==')
row('PLUGIN_ID', /PLUGIN_ID = '([^']+)'/.exec(inst)[1])
row('PLUGIN_LABEL', /PLUGIN_LABEL = '([^']+)'/.exec(inst)[1])
const sup = /SUPERSEDED_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(inst)[1]
row('supersedes', sup.replace(/['\s]/g, '').split(',').filter(Boolean).join(', '))

console.log('\n== consistency ==')
const id = pkg.dsh.id
const checks = [
  ['package.name == dsh.id', pkg.name === id],
  ['export name == dsh.id', /export const name = '([^']+)'/.exec(idx)[1] === id],
  ['projection key == dsh.id', /PROJECTION_KEY = '([^']+)'/.exec(proj)[1] === id],
  ['client id == dsh.id', /id: '([^']+)'/.exec(cl)[1] === id],
  ['state path uses id', idx.includes(`/api/${id}/state`)],
  ['cordis row == dsh.id', patch.includes(`- id: ${id}`)],
  ['installer id == dsh.id', /PLUGIN_ID = '([^']+)'/.exec(inst)[1] === id],
  ['prompt says 菲比', prompt.includes('You are 菲比')],
  ['activation is 菲比', /sends "菲比"/.test(prompt)],
  ['no 富江 in prompt', !prompt.includes('富江')],
]
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} consistency checks passed`)
if (failed.length) process.exitCode = 1
