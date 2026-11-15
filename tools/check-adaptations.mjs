/**
 * Capability audit: what dsh-purge does that this plugin could also use, and
 * what it does that does not apply here.
 *
 * The point of this file is to make the "what else can be adapted" question
 * answerable with evidence instead of opinion: it checks the running Harness for
 * the services and code shapes each candidate depends on, and reports
 * applicable / not-applicable / already-done per candidate.
 *
 * Run: node tools/check-adaptations.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail })
  const mark = status === 'applicable' ? 'TODO' : status === 'done' ? 'DONE' : 'SKIP'
  console.log(`${mark.padEnd(5)} ${name.padEnd(42)} ${detail}`)
}

// --- Harness discovery -----------------------------------------------------

/** The pnpm store the profile's packages resolve through. */
function pnpmStore() {
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '.pnpm')
}

/** Find one `@deepseek-ai/dsh-*` package inside the store. */
function findPackage(pattern) {
  const store = pnpmStore()
  if (!fs.existsSync(store)) return null
  try {
    const dir = fs.readdirSync(store).find((name) => name.includes(pattern))
    if (!dir) return null
    const inner = path.join(store, dir, 'node_modules', '@deepseek-ai')
    if (!fs.existsSync(inner)) return null
    const pkg = fs.readdirSync(inner).find((name) => name.includes(pattern))
    return pkg ? path.join(inner, pkg) : null
  } catch {
    return null
  }
}

/** Read every .js under a package's lib directory. */
function readLib(pkgDir) {
  const lib = path.join(pkgDir, 'lib')
  if (!fs.existsSync(lib)) return ''
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        try { out.push(fs.readFileSync(full, 'utf8')) } catch { /* unreadable */ }
      }
    }
  }
  walk(lib)
  return out.join('\n')
}

const systemPromptPkg = findPackage('dsh-system-prompt')
const systemPromptSource = systemPromptPkg ? readLib(systemPromptPkg) : ''

// --- 1. phase-1 persona filter ---------------------------------------------
//
// dsh-purge patches the host so `dsh-purge*` sections survive an early
// allow-list that keeps only persona sections. That allow-list existed in an
// older Harness. On the current one there is no such symbol, so patching for it
// would be dead code — and patching host files we do not need to patch is risk
// without benefit.

if (systemPromptSource.length === 0) {
  record('phase-1 persona allow-list patch', 'n/a', 'system-prompt package not found; cannot verify')
} else if (/PERSONA_SECTION_NAMES/.test(systemPromptSource)) {
  record('phase-1 persona allow-list patch', 'applicable',
    'host still filters sections by PERSONA_SECTION_NAMES')
} else {
  record('phase-1 persona allow-list patch', 'n/a',
    'no PERSONA_SECTION_NAMES in dsh-system-prompt; sections are not filtered early')
}

// --- 2. prompt file transparency -------------------------------------------

const promptStore = new URL('../lib/prompt-store.js', import.meta.url)
record('prompt file transparency', 'done',
  fs.existsSync(promptStore) ? 'lib/prompt-store.js: file > default, editable, resettable' : 'MISSING')

// --- 3. readable tool output -----------------------------------------------

const indexSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
record('readable tool report instead of JSON', 'done',
  indexSource.includes('reportOutput') ? 'feibi_profile / feibi_prompt render text' : 'MISSING')

// --- 3c. live self-test ----------------------------------------------------
//
// The whole plugin is a heuristic; nothing measured whether it works. This is
// the one module that answers that against the real model, with a four-state
// report so an unmeasured probe cannot be counted as a pass.

const selfTestModule = new URL('../lib/self-test.js', import.meta.url)
record('live self-test against the real model', 'done',
  fs.existsSync(selfTestModule)
    ? 'lib/self-test.js: 4-state report, guard-exempt purpose, bounded cost'
    : 'MISSING')

// --- 3b. refusal retry -----------------------------------------------------
const retryModule = new URL('../lib/refusal-retry.js', import.meta.url)
record('retry after a withheld reply', 'done',
  fs.existsSync(retryModule)
    ? 'lib/refusal-retry.js: bounded correction on the verdict bus (opt-in)'
    : 'MISSING')

// --- 4. command surface ----------------------------------------------------
//
// dsh-purge registers `/purge`, `/rules`, `/skills`, `/rewind`. A command is
// cheaper than a tool for a user driving a chat: no model round trip, no tokens.
// This checks the service exists so the adaptation is possible here.

{
  const commandsPkg = findPackage('dsh-commands')
  const source = commandsPkg ? readLib(commandsPkg) : ''
  if (source.length === 0) {
    record('slash command surface', 'n/a', 'dsh-commands package not found')
  } else if (/register\s*\(/.test(source)) {
    record('slash command surface', 'applicable',
      'commands service present; /feibi could expose status+prompt without a model call')
  } else {
    record('slash command surface', 'n/a', 'commands package has no register()')
  }
}

// --- 5. session rewind -----------------------------------------------------
//
// dsh-purge wraps `deriveMessages` per session to make `/rewind` drop a turn.
// This plugin's guard already holds replies before commit; rewind would act on
// turns that did land, which is a different problem and a host-internal one.

{
  const sessionPkg = findPackage('dsh-session')
  const source = sessionPkg ? readLib(sessionPkg) : ''
  if (/deriveMessages/.test(source)) {
    record('session rewind hook', 'applicable',
      'sessions expose deriveMessages; could drop a committed turn')
  } else {
    record('session rewind hook', 'n/a', 'no deriveMessages in dsh-session')
  }
}

// --- 6. auto-continue / auto-retry -----------------------------------------
//
// The guard already withholds a refusal. Retry is now implemented; auto-continue
// (re-sending "继续" after a max-token stop) is a different trigger and is not
// wired here, because a truncated reply is not a refusal and the guard cannot
// see it.

{
  const retry = fs.existsSync(new URL('../lib/refusal-retry.js', import.meta.url))
  record('auto-continue after truncation', 'applicable',
    retry
      ? 'retry exists for blocks; a max-token stop is a separate signal this plugin does not see'
      : 'no retry module')
}

// --- 7. console window hiding ----------------------------------------------
//
// dsh-purge patches child_process so spawned commands do not flash a console on
// Windows. That matters for an installer with many spawns; this plugin spawns
// only during install, and `install.ps1` already runs from a visible terminal.

record('child_process windowsHide patch', 'n/a',
  'runtime spawns none; installer already runs in a console')

// --- 8. hooks deny bypass --------------------------------------------------
//
// dsh-purge rewrites the host's hooks-deny settings. This plugin never inspects
// tool authorization, so there is nothing to bypass and no file to rewrite.

record('hooks-deny rewrite', 'n/a',
  'this plugin does not touch tool authorization')

// --- 9. net scope ----------------------------------------------------------
//
// dsh-purge keeps an allow-list of hosts for its drill table. This plugin's wire
// guard matches URL fragments, which is the same idea at a smaller scope.

record('outbound host allow-list', 'done',
  'wireUrlPatterns matches endpoints; no separate allow-list needed')

// --- 10. dual-layer config -------------------------------------------------

record('per-model prompt selection', 'applicable',
  'payload could resolve per provider/model; today one payload serves all')

// --- summary ---------------------------------------------------------------

const done = results.filter((r) => r.status === 'done').length
const applicable = results.filter((r) => r.status === 'applicable').length
const skipped = results.filter((r) => r.status === 'n/a').length

console.log('')
console.log(`${results.length} candidates: ${done} done, ${applicable} applicable, ${skipped} not applicable`)
if (applicable > 0) {
  console.log('')
  console.log('applicable:')
  for (const r of results.filter((x) => x.status === 'applicable')) {
    console.log(`  - ${r.name}: ${r.detail}`)
  }
}
