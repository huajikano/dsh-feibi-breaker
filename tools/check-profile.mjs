/**
 * Validate the profile patch the installer produced, with a real YAML parser.
 *
 * The installer edits this file line by line to preserve comments and `!!js`
 * expressions, so "it parses" is not something to assume: a misplaced indent
 * would silently detach the plugin row from its wrapper.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.USERPROFILE || os.homedir()
const profile = path.join(home, '.dsh', 'profiles', 'desktop')
const patchFile = path.join(profile, 'cordis.patch.yml')

if (!fs.existsSync(patchFile)) {
  console.log('SKIP  no profile patch at', patchFile)
  process.exit(0)
}

// js-yaml is not hoisted to the profile root; it lives under pnpm's virtual
// store. Look there rather than assuming a top-level install.
async function loadYaml(home) {
  const candidates = [
    'js-yaml',
    path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '.pnpm', 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs'),
  ]
  const store = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '.pnpm')
  if (fs.existsSync(store)) {
    for (const entry of fs.readdirSync(store)) {
      if (entry.startsWith('js-yaml@')) {
        candidates.push(path.join(store, entry, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs'))
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const mod = candidate.startsWith('js-yaml')
        ? await import(candidate)
        : await import(new URL(`file:///${candidate.replace(/\\/g, '/')}`).href)
      return mod.default ?? mod
    } catch {
      // try the next candidate
    }
  }
  return null
}

const text = fs.readFileSync(patchFile, 'utf8')
const yaml = await loadYaml(home)
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

// 1. The file must still contain a plugin row, and exactly one.
const rows = text.match(/^\s*- id: feibi-breaker\s*$/gm) || []
check('exactly one feibi-breaker row', rows.length === 1, `${rows.length} found`)

// 2. That row must sit under an `insert:` wrapper, at the child indent.
const lines = text.split(/\r?\n/)
const rowIndex = lines.findIndex((line) => /^\s*- id: feibi-breaker\s*$/.test(line))
let wrapperOk = false
if (rowIndex > 0) {
  const rowIndent = /^ */.exec(lines[rowIndex])[0].length
  for (let i = rowIndex - 1; i >= 0; i -= 1) {
    if (/^\s*$/.test(lines[i])) continue
    const indent = /^ */.exec(lines[i])[0].length
    if (indent < rowIndent) {
      wrapperOk = /^\s*-\s+insert:\s*$/.test(lines[i])
      break
    }
  }
}
check('the row is inside an insert wrapper', wrapperOk)

// 3. No superseded id survives anywhere.
for (const old of ['fujiang-gatekeeper', 'fujiang-armor']) {
  const hits = lines.filter((line) => new RegExp(`- id: ${old}\\b`).test(line))
  check(`no ${old} row remains`, hits.length === 0, `${hits.length} found`)
}

// 4. The system-prompt row is unique, and carries the identity override.
const promptRows = lines.filter((line) => /^\s*- id: system-prompt\s*$/.test(line))
check('exactly one system-prompt row', promptRows.length === 1, `${promptRows.length} found`)
check('identity override present', /includeHarnessIdentity:\s*false/.test(text))

// 5. Comments and !!js survived the line-level edit.
check('user comments preserved', text.includes('# Your patch layer') || text.includes('# 去掉固定身份句'))
check('!!js expressions preserved', text.includes('!!js'))

// 6. Parse with a real parser when one is available.
if (yaml !== null) {
  // `!!js` is a cordis extension, not standard YAML: strip it for the parse so
  // the structure can still be validated.
  const parseable = text.replace(/!!js\s+/g, '')
  try {
    const doc = yaml.load(parseable)
    check('parses as a YAML sequence', Array.isArray(doc), Array.isArray(doc) ? `${doc.length} top-level entries` : typeof doc)
    const inserted = (doc || []).flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
    const mine = inserted.filter((entry) => entry?.id === 'feibi-breaker')
    check('the loader sees the plugin row', mine.length === 1, JSON.stringify(mine[0] ?? null))
    const prompt = (doc || []).find((entry) => entry?.id === 'system-prompt')
    check('the loader sees the identity override',
      prompt?.config?.includeHarnessIdentity === false,
      JSON.stringify(prompt?.config ?? null))
  } catch (error) {
    check('parses as YAML', false, error.message)
  }
} else {
  console.log('SKIP  no yaml module available; structural checks above still ran')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
