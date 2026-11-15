import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The PowerShell halves must carry a UTF-8 BOM.
 *
 * Windows PowerShell 5.1 decodes a BOM-less file as ANSI. Every Chinese string
 * in these scripts then becomes mojibake, and a full-width bracket inside a
 * single-quoted string swallows the closing quote — the file stops parsing
 * entirely. This actually happened: the scripts were written as BOM-less UTF-8
 * and every `Write-Host '中文'` line was a syntax error on 5.1.
 *
 * The .bat launchers invoke `powershell.exe`, so the BOM is not optional.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const SCRIPTS = [
  'install.ps1',
  'uninstall.ps1',
  path.join('scripts', 'ensure-runtime.ps1'),
]

for (const relative of SCRIPTS) {
  test(`${relative} is UTF-8 with a BOM`, () => {
    const file = path.join(ROOT, relative)
    if (!fs.existsSync(file)) return
    const bytes = fs.readFileSync(file)
    assert.equal(
      bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
      true,
      'a BOM-less UTF-8 PowerShell script is decoded as ANSI by Windows PowerShell 5.1',
    )
  })
}

/**
 * Parse the scripts with the real PowerShell parser when one is available.
 *
 * This is the check that would have caught the mojibake: a BOM test alone
 * proves the encoding is declared, not that the file parses.
 */
const POWERSHELL = process.platform === 'win32'
  ? ['powershell.exe', 'pwsh.exe'].find((exe) => {
      try {
        execFileSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })
  : undefined

for (const relative of SCRIPTS) {
  test(`${relative} parses as PowerShell`, { skip: POWERSHELL === undefined ? 'no PowerShell on PATH' : false }, () => {
    const file = path.join(ROOT, relative)
    if (!fs.existsSync(file)) return
    const script = [
      '$errors = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$errors) | Out-Null`,
      'if ($errors.Count -gt 0) {',
      '  $errors | ForEach-Object { Write-Output ($_.Extent.StartLineNumber.ToString() + ": " + $_.Message) }',
      '  exit 1',
      '}',
      'exit 0',
    ].join('\n')
    try {
      execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      assert.fail(`${relative} does not parse:\n${error.stdout || error.message}`)
    }
  })
}

/**
 * `-DryRun` must not touch a profile.
 *
 * The first version of this flag skipped the file copy and the dependency
 * install but ran the config writer anyway, then printed "已安装" — so a user
 * who ran a rehearsal got a real, half-applied install and no warning. This
 * test runs the script against a throwaway DSH home and asserts the profile is
 * byte-identical afterwards.
 */
test('install.ps1 -DryRun leaves the profile untouched', {
  skip: POWERSHELL === undefined ? 'no PowerShell on PATH' : false,
}, () => {
  const home = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'feibi-dryrun-'))
  try {
    const profile = path.join(home, 'profiles', 'desktop')
    fs.mkdirSync(profile, { recursive: true })
    const patch = [
      '# original comment',
      '- id: system-prompt',
      '  config:',
      "    personaPrefix: 'keep me'",
      '',
    ].join('\n')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch)
    const pkg = JSON.stringify({ name: 'p', dependencies: {} }, null, 2)
    fs.writeFileSync(path.join(profile, 'package.json'), pkg)

    // The script resolves its DSH home from USERPROFILE, so point that at the
    // scratch directory for this child process only.
    try {
      execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'install.ps1'), '-DryRun'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, USERPROFILE: home },
        timeout: 60000,
      })
    } catch (error) {
      // A rehearsal may still exit non-zero (missing files in a test checkout);
      // what matters is that it wrote nothing.
      if (!String(error.stdout || '').includes('演练')) {
        // fall through to the byte comparison below regardless
      }
    }

    assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), patch,
      'the patch file must be byte-identical after a dry run')
    assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), pkg,
      'the package file must be byte-identical after a dry run')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
