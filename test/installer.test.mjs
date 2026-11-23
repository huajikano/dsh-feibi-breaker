import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_ID, copyPlugin, countIdRows, dependencyHealth, ensureJunction, formatManifest,
  hasInsertRow, linkSpec, planManifest, planPatch, stripRows, validatePatch,
} from '../scripts/lib/profile.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A throwaway DSH home with one profile. */
function tempHome(name = 'desktop') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feibi-installer-'))
  const profileDir = path.join(root, 'profiles', name)
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { 'other-plugin': 'link:C:/plugins/other-plugin' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'other-plugin'] } },
  }, undefined, 2)}\n`)
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# user patch layer',
    '- id: other-plugin',
    '  config:',
    '    enabled: true',
    '- id: system-prompt',
    '  config:',
    '    personaPrefix: \'You are a coding agent.\'',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'other-plugin'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'other-plugin', 'package.json'), '{ "name": "other-plugin" }\n')
  return { root, profileDir }
}

test('validatePatch accepts the real patch dialect and rejects corruption', () => {
  const good = [
    '# comment',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek015',
    '- id: tool-bash',
    '  disabled: !!js process.platform === \'win32\'',
    '- id: body',
    '  config:',
    '    text: |',
    '      first line',
    '      - not a sequence item',
    '',
  ].join('\n')
  assert.deepEqual(validatePatch(good), [])
  assert.deepEqual(validatePatch(''), [])

  assert.ok(validatePatch('- id: a\n\tconfig: 1\n').some((problem) => problem.includes('tab indentation')))
  assert.ok(validatePatch('id: a\n').some((problem) => problem.includes('not a YAML sequence item')))
  // A real profile patch embeds quotes inside plain scalars and escaped JSON;
  // flagging those would refuse a legitimate install.
  assert.deepEqual(validatePatch([
    '- id: mcp',
    '  config:',
    '    command: [ serve, --exclude-tools, "App,PowerShell,FileSystem" ]',
    '    env:',
    '      DISABLE: "1",',
    '',
  ].join('\n')), [])
  assert.ok(validatePatch('\uFEFF- id: a\n').some((problem) => problem.includes('BOM')))
})

test('stripRows removes only the named row and keeps its neighbours', () => {
  const text = '- id: a\n  config:\n    x: 1\n- id: b\n  config:\n    y: 2\n'
  const stripped = stripRows(text, ['b'])
  assert.match(stripped, /- id: a/)
  assert.doesNotMatch(stripped, /- id: b/)
  assert.match(stripped, /x: 1/)
})

test('planPatch converts a legacy insert row into one id row and is idempotent', () => {
  const legacy = `- insert:\n    - id: ${PLUGIN_ID}\n      name: '${PLUGIN_ID}'\n`
  const first = planPatch(legacy)
  assert.equal(countIdRows(first.text), 1)
  assert.equal(hasInsertRow(first.text), false)

  const second = planPatch(first.text)
  assert.deepEqual(second.changes, [])
  assert.equal(second.text, first.text)
})

test('planPatch appends a row to an empty patch and deduplicates repeats', () => {
  const empty = planPatch('')
  assert.equal(countIdRows(empty.text), 1)

  const duplicated = `- id: ${PLUGIN_ID}\n  config:\n    dryRun: true\n\n- id: ${PLUGIN_ID}\n  config:\n    dryRun: false\n`
  const fixed = planPatch(duplicated)
  assert.equal(countIdRows(fixed.text), 1)
  assert.match(fixed.text, /dryRun: true/)
})

test('planManifest writes one link dependency and one bundle entry', () => {
  const manifest = {
    name: 'p',
    dependencies: { other: 'link:C:/other' },
    dsh: { profile: { bundles: ['base', PLUGIN_ID, 'other', PLUGIN_ID] } },
  }
  const planned = planManifest(manifest, 'C:/plugins/feibi-breaker')
  assert.equal(planned.manifest.dependencies[PLUGIN_ID], 'link:C:/plugins/feibi-breaker')
  assert.equal(planned.manifest.dependencies.other, 'link:C:/other')
  assert.deepEqual(planned.manifest.dsh.profile.bundles, ['base', 'other', PLUGIN_ID])
  assert.equal(manifest.dsh.profile.bundles.length, 4, 'input is not mutated')

  const again = planManifest(planned.manifest, 'C:/plugins/feibi-breaker')
  assert.deepEqual(again.changes, [])
})

test('formatManifest keeps the profile indentation and line endings', () => {
  const text = formatManifest({ a: 1 }, '{\r\n    "a": 0\r\n}\r\n')
  assert.ok(text.startsWith('{\r\n    "a": 1'))
  assert.ok(text.endsWith('\r\n'))
})

test('ensureJunction creates a resolving link and replaces a wrong target', () => {
  const { root, profileDir } = tempHome()
  const pluginDir = path.join(root, 'plugins', PLUGIN_ID)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'package.json'), `{ "name": "${PLUGIN_ID}" }\n`)

  assert.equal(ensureJunction(profileDir, pluginDir).action, 'created')
  assert.equal(ensureJunction(profileDir, pluginDir).action, 'present')

  const other = path.join(root, 'other-plugin')
  fs.mkdirSync(other, { recursive: true })
  const replaced = ensureJunction(profileDir, other)
  assert.equal(replaced.action, 'replaced')
  assert.ok(fs.existsSync(replaced.aside), 'the previous link is renamed, never deleted')
  assert.equal(fs.realpathSync.native(path.join(profileDir, 'node_modules', PLUGIN_ID)), fs.realpathSync.native(other))
})

test('dependencyHealth separates resolvable from missing packages', () => {
  const { profileDir } = tempHome()
  const manifest = { dependencies: { 'other-plugin': 'link:x', gone: 'link:y' } }
  const health = dependencyHealth(manifest, profileDir)
  assert.deepEqual(health.ok, ['other-plugin'])
  assert.deepEqual(health.missing, ['gone'])
})

test('copyPlugin skips .git and node_modules', () => {
  const { root } = tempHome()
  const source = path.join(root, 'source')
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(source, '.git'), { recursive: true })
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(source, 'lib', 'index.js'), 'export {}\n')
  fs.writeFileSync(path.join(source, '.git', 'HEAD'), 'ref\n')

  const destination = path.join(root, 'installed')
  const result = copyPlugin(source, destination)
  assert.equal(result.action, 'copied')
  assert.ok(fs.existsSync(path.join(destination, 'lib', 'index.js')))
  assert.equal(fs.existsSync(path.join(destination, '.git')), false)
  assert.equal(fs.existsSync(path.join(destination, 'node_modules')), false)
})

test('install then uninstall touches only this plugin and reports broken siblings', () => {
  const { root, profileDir } = tempHome()
  const env = { ...process.env, DSH_HOME: root }
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts', script), ...args], { env, encoding: 'utf8' })

  fs.rmSync(path.join(profileDir, 'node_modules', 'other-plugin'), { recursive: true })
  const installed = run('install.mjs', '--profile', 'desktop')
  assert.match(installed, /feibi-breaker/)
  // The missing sibling is reported instead of silently "fixed" by a purge.
  assert.match(installed, /other-plugin/)

  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies[PLUGIN_ID], linkSpec(path.join(root, 'plugins', PLUGIN_ID)))
  assert.ok(manifest.dsh.profile.bundles.includes(PLUGIN_ID))
  assert.equal(manifest.dependencies['other-plugin'], 'link:C:/plugins/other-plugin', 'another plugin is untouched')

  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(countIdRows(patch), 1)
  assert.match(patch, /- id: other-plugin/, 'the other row survives')
  assert.match(patch, /personaPrefix/, 'the system-prompt row is never rewritten')
  assert.deepEqual(validatePatch(patch), [])

  const backups = path.join(root, 'backups', PLUGIN_ID)
  assert.ok(fs.readdirSync(backups).length >= 1, 'a backup was taken')

  const removed = run('uninstall.mjs', '--profile', 'desktop')
  assert.match(removed, /已卸载/)
  const after = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(after.dependencies[PLUGIN_ID], undefined)
  assert.equal(after.dependencies['other-plugin'], 'link:C:/plugins/other-plugin')
  assert.ok(after.dsh.profile.bundles.includes('other-plugin'))
  const patchAfter = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(countIdRows(patchAfter), 0)
  assert.match(patchAfter, /- id: other-plugin/)
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules', PLUGIN_ID)), false)
})

test('with several profiles and no flag, every live profile is written without asking', () => {
  const { root } = tempHome('desktop')
  fs.mkdirSync(path.join(root, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'web',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, undefined, 2))
  // A snapshot directory must stay untouched even in the no-flag default.
  fs.mkdirSync(path.join(root, 'profiles', 'desktop-backup-20260101-000000'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profiles', 'desktop-backup-20260101-000000', 'package.json'), '{ "name": "snap", "dependencies": {} }')

  const env = { ...process.env, DSH_HOME: root }
  delete env.DSH_PROFILE
  const output = execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'install.mjs')], { env, encoding: 'utf8' })

  assert.match(output, /自动：所有活动 profile/)
  for (const name of ['desktop', 'web']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'profiles', name, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies[PLUGIN_ID], linkSpec(path.join(root, 'plugins', PLUGIN_ID)), `${name} was not installed`)
  }
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'desktop-backup-20260101-000000', 'package.json'), 'utf8'))
  assert.equal(snapshot.dependencies[PLUGIN_ID], undefined, 'snapshot directories stay read-only')
})

test('$DSH_PROFILE wins over the other profiles', () => {
  const { root } = tempHome('desktop')
  fs.mkdirSync(path.join(root, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profiles', 'web', 'package.json'), '{ "name": "web", "dependencies": {}, "dsh": { "profile": { "bundles": [] } } }')

  const env = { ...process.env, DSH_HOME: root, DSH_PROFILE: 'web' }
  const output = execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'install.mjs')], { env, encoding: 'utf8' })
  assert.match(output, /\$DSH_PROFILE/)

  const web = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.equal(web.dependencies[PLUGIN_ID], linkSpec(path.join(root, 'plugins', PLUGIN_ID)))
  const desktop = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.equal(desktop.dependencies[PLUGIN_ID], undefined, 'the running profile is the only target')
})

test('dry run writes nothing', () => {
  const { root, profileDir } = tempHome()
  const before = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')
  const env = { ...process.env, DSH_HOME: root }
  const output = execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'install.mjs'), '--profile', 'desktop', '--dry-run'], { env, encoding: 'utf8' })
  assert.match(output, /演练结束/)
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(root, 'plugins', PLUGIN_ID)), false)
})
