import fs from 'node:fs'

/**
 * PowerShell 5.1 decodes a BOM-less file as ANSI, so every Chinese string in a
 * UTF-8 script becomes mojibake — and a full-width bracket inside a
 * single-quoted string swallows the closing quote. The file then stops parsing.
 *
 * The .bat launchers invoke `powershell.exe`, so the BOM is mandatory on every
 * script this project ships. Run this after any edit that rewrites a .ps1.
 */
const BOM = '\uFEFF'
for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, 'utf8')
  const body = text.startsWith(BOM) ? text.slice(1) : text
  fs.writeFileSync(file, BOM + body, 'utf8')
  console.log(`BOM ensured: ${file}`)
}
