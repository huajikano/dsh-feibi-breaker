import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  stripRows, buildRow, patchProfile, patchPackage, install, ensureIdentity,
  PLUGIN_ID, SUPERSEDED_IDS, IDENTITY_BLOCK,
} from '../scripts/lib/install.js'

/** A throwaway DSH home with one profile. */
function tempHome(name = 'desktop') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fgk-'))
  const profile = path.join(root, 'profiles', name)
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gatekeeper', 'fujiang-armor'] } },
    dependencies: { 'dsh-gatekeeper': 'link:D:/somewhere', 'fujiang-armor': 'file:../../plugins/fujiang-armor' },
  }, null, 2))
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '# a user comment that must survive',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      x:',
    '        baseURL: https://example.invalid/v1',
    '- insert:',
    '    - id: gatekeeper',
    "      name: 'dsh-gatekeeper'",
    '- insert:',
    '    - id: fujiang-armor',
    "      name: 'fujiang-armor'",
    '      config:',
    '        enabled: true',
    '',
  ].join('\n'))
  return { root, profile }
}

test('stripRows removes exactly the rows it is given and keeps everything else', () => {
  const { profile } = tempHome()
  const file = path.join(profile, 'cordis.patch.yml')
  const text = fs.readFileSync(file, 'utf8')
  // Explicit cleanup only: the installer itself passes an empty list.
  const out = stripRows(text, ['gatekeeper', 'fujiang-armor'])

  assert.equal(out.includes('id: gatekeeper'), false)
  assert.equal(out.includes('id: fujiang-armor'), false)
  assert.ok(out.includes('# a user comment that must survive'))
  assert.ok(out.includes('id: llm-pi-ai'))
  assert.ok(out.includes('baseURL: https://example.invalid/v1'))
})

test('stripRows drops an insert wrapper left with no children', () => {
  const text = '- insert:\n    - id: gatekeeper\n      name: x\n- id: other\n'
  const out = stripRows(text, ['gatekeeper'])
  assert.equal(out.includes('insert:'), false, 'an empty insert must not remain')
  assert.ok(out.includes('id: other'))
})

test('stripRows leaves a literal block that looks like YAML alone', () => {
  const text = [
    '- id: plan-mode',
    '  config:',
    '    section: |',
    '      - insert:',
    '          - id: gatekeeper',
    '      done',
    '- insert:',
    '    - id: gatekeeper',
    '      name: x',
    '',
  ].join('\n')
  const out = stripRows(text, ['gatekeeper'])
  // The example inside the block scalar is documentation, not a mount.
  assert.ok(out.includes('      - insert:'))
  assert.ok(out.includes('          - id: gatekeeper'))
  assert.equal(out.trimEnd().endsWith('name: x'), false, 'the real mount was removed')
})

test('buildRow renders config overrides', () => {
  assert.ok(buildRow().includes(`- id: ${PLUGIN_ID}`))
  const withConfig = buildRow({ dualLayer: false, interceptAt: 'preview' })
  assert.ok(withConfig.includes('dualLayer: false'))
  assert.ok(withConfig.includes('interceptAt: "preview"'))
})

test('patchProfile installs the row, leaves other plugins mounted, and backs up once', () => {
  const { profile } = tempHome()
  const file = path.join(profile, 'cordis.patch.yml')
  const before = fs.readFileSync(file, 'utf8')

  const first = patchProfile(profile, {})
  assert.equal(first.changed, true)
  assert.ok(first.backup !== null)
  assert.equal(fs.readFileSync(first.backup, 'utf8'), before, 'the backup is the original')
  assert.deepEqual(first.removed, [])

  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes(`id: ${PLUGIN_ID}`))
  // Coexistence is the contract: another guard's row survives an install.
  assert.ok(text.includes('id: gatekeeper'), 'dsh-gatekeeper must stay mounted')
  assert.ok(text.includes('id: fujiang-armor'), 'fujiang-armor must stay mounted')
  assert.ok(text.includes(IDENTITY_BLOCK.trim()))

  // Idempotent: a second run changes nothing and never clobbers the backup.
  const second = patchProfile(profile, {})
  assert.equal(second.changed, false)
  assert.equal(fs.readFileSync(first.backup, 'utf8'), before)
})

test('patchProfile can skip the identity override', () => {
  const { profile } = tempHome()
  patchProfile(profile, { identity: false })
  const text = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(text.includes('includeHarnessIdentity'), false)
  assert.ok(text.includes(`id: ${PLUGIN_ID}`))
})

test('patchPackage adds this dependency and keeps the others', () => {
  const { profile } = tempHome()
  const result = patchPackage(profile, { pluginsDir: 'D:/x/feibi-breaker' })
  assert.equal(result.changed, true)

  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(pkg.dependencies, 'dsh-gatekeeper'), true, 'a neighbouring guard keeps its dependency')
  assert.equal(Object.hasOwn(pkg.dependencies, 'fujiang-armor'), true)
  assert.equal(pkg.dependencies[PLUGIN_ID], 'link:D:/x/feibi-breaker')
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-gatekeeper', 'fujiang-armor'])

  // Idempotent.
  assert.equal(patchPackage(profile, { pluginsDir: 'D:/x/feibi-breaker' }).changed, false)
})

test('install patches every profile and reports what it did', () => {
  const { root } = tempHome('desktop')
  const web = path.join(root, 'profiles', 'web')
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {} }))

  const report = install({ dshHome: root })
  assert.equal(report.profiles.length, 2)
  assert.deepEqual(report.profiles.map((p) => p.profile).sort(), ['desktop', 'web'])
  for (const entry of report.profiles) {
    assert.ok(entry.patch.changed)
    assert.ok(entry.package.changed)
  }
})

test('install can target one profile', () => {
  const { root } = tempHome('desktop')
  const web = path.join(root, 'profiles', 'web')
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web', dependencies: {} }))

  const report = install({ dshHome: root, profiles: ['web'] })
  assert.equal(report.profiles.length, 1)
  assert.equal(report.profiles[0].profile, 'web')
})

// -- identity handling ------------------------------------------------------
//
// A real profile almost always already carries a `- id: system-prompt` row with
// its own personaPrefix. Prepending a second row with the same id leaves two
// conflicting entries and the winner depends on Loader merge order, so the
// installer must edit the existing row instead of adding one.

test('ensureIdentity prepends when the profile has no system-prompt row', () => {
  const { text, action } = ensureIdentity('- id: other\n  config:\n    x: 1\n')
  assert.equal(action, 'prepended')
  assert.ok(text.includes('includeHarnessIdentity: false'))
  assert.equal(text.match(/- id: system-prompt/g).length, 1)
})

test('ensureIdentity patches the existing row instead of duplicating it', () => {
  const before = [
    '- id: system-prompt',
    '  config:',
    "    personaPrefix: 'You are a coding agent.'",
    '- id: other',
    '  config:',
    '    x: 1',
    '',
  ].join('\n')
  const { text, action } = ensureIdentity(before)
  assert.equal(action, 'patched')
  assert.equal(text.match(/- id: system-prompt/g).length, 1, 'exactly one row')
  assert.ok(text.includes('includeHarnessIdentity: false'))
  // The user's own persona choice must survive.
  assert.ok(text.includes("personaPrefix: 'You are a coding agent.'"))
  assert.ok(text.includes('- id: other'))
})

test('ensureIdentity adds a config block when the row has none', () => {
  const { text, action } = ensureIdentity('- id: system-prompt\n- id: other\n')
  assert.equal(action, 'patched')
  assert.ok(text.includes('  config:'))
  assert.ok(text.includes('includeHarnessIdentity: false'))
  assert.ok(text.includes('- id: other'))
})

test('ensureIdentity leaves an owner row untouched', () => {
  const before = '- id: system-prompt\n  config:\n    includeHarnessIdentity: true\n'
  const { text, action } = ensureIdentity(before)
  assert.equal(action, 'present')
  assert.equal(text, before, 'a deliberate user setting is not overridden')
})

test('patchProfile does not duplicate a system-prompt row the profile owns', () => {
  const { profile } = tempHome()
  const file = path.join(profile, 'cordis.patch.yml')
  fs.writeFileSync(file, [
    '- id: system-prompt',
    '  config:',
    "    personaPrefix: 'You are a coding agent.'",
    '- insert:',
    '    - id: gatekeeper',
    "      name: 'dsh-gatekeeper'",
    '',
  ].join('\n'))

  patchProfile(profile, {})
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.match(/- id: system-prompt/g).length, 1, 'no duplicate identity row')
  assert.ok(text.includes('includeHarnessIdentity: false'))
  assert.ok(text.includes("personaPrefix: 'You are a coding agent.'"))
  assert.ok(text.includes('id: gatekeeper'), 'the neighbouring guard stays mounted')
  assert.ok(text.includes(`id: ${PLUGIN_ID}`))
})

test('patchProfile is idempotent on a profile that owns its identity row', () => {
  const { profile } = tempHome()
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- id: system-prompt',
    '  config:',
    "    personaPrefix: 'x'",
    '',
  ].join('\n'))
  assert.equal(patchProfile(profile, {}).changed, true)
  assert.equal(patchProfile(profile, {}).changed, false)
})

// -- coexistence with other guards ------------------------------------------
//
// 菲比破限 merged the refusal guard and the armor plugin, but that is a merge of
// two codebases, not a claim on a user's profile. A profile that also mounts
// dsh-gatekeeper or fujiang-armor keeps both rows: two guards wrapping
// `llm/stream` is a supported state (each decides independently), and unmounting
// someone else's plugin during an install is the surprising outcome, not the
// safe one.

test('installing next to another guard leaves both plugins mounted', () => {
  const { root, profile } = tempHome()
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '# user comment',
    '- id: system-prompt',
    '  config:',
    "    personaPrefix: 'You are a coding agent.'",
    '- insert:',
    '    - id: fujiang-gatekeeper',
    "      name: 'fujiang-gatekeeper'",
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'fujiang-gatekeeper': 'link:D:/dsh/fujiang-gatekeeper' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))

  const report = install({ dshHome: root })
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))

  assert.ok(patch.includes('id: fujiang-gatekeeper'), 'the other guard keeps its row')
  assert.ok(patch.includes(`id: ${PLUGIN_ID}`), 'the new row is present')
  assert.ok(Object.hasOwn(pkg.dependencies, 'fujiang-gatekeeper'))
  assert.ok(Object.hasOwn(pkg.dependencies, PLUGIN_ID))
  assert.deepEqual(report.profiles[0].patch.removed, [], 'nothing was removed')
  // The user's own choices survive the install.
  assert.ok(patch.includes('# user comment'))
  assert.ok(patch.includes("personaPrefix: 'You are a coding agent.'"))
  assert.equal((patch.match(/- id: system-prompt/g) || []).length, 1)
})
