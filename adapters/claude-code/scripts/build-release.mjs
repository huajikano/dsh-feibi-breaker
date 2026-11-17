#!/usr/bin/env node
/**
 * 打发布包：给 Release 用的 ZIP。
 *
 * ## 为什么不能直接压目录
 *
 * 仓库里的适配层**不含**内置规则（payload 只以 `core/payload.bin` 的形式存在）。
 * 直接压适配层，用户解压后 `plugin install` 找不到 payload，装出来的插件 vendor 为空，
 * 表现是"装好了但什么都不注入"。
 *
 * 所以打包时把那份加密资产和解码器一起塞进 `payload/`，安装器的 fallback 会用它。
 *
 * ## 产出
 *
 *   dist/feibi-breaker-claude-code-<版本>.zip
 *   里面是一个同名目录，双击里面的 `点我一键安装.bat` 即可
 *
 * @module feibi-breaker-cc/build-release
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

/** 仓库根：适配层在 adapters/claude-code 时，往上两级；独立分发时就是自己。 */
function repoRoot() {
  const maybe = path.dirname(path.dirname(ROOT))
  return fs.existsSync(path.join(maybe, 'core', 'payload.bin')) ? maybe : ROOT
}

/** 要打进 zip 的顶层条目。 */
const INCLUDE_FILES = ['install.ps1', 'uninstall.ps1', '点我一键安装.bat', '点我一键卸载.bat', 'README.md', 'package.json']
const INCLUDE_DIRS = ['bin', 'lib', 'plugin', 'test', 'scripts']

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const name = `feibi-breaker-claude-code-${version}`
const dist = path.join(ROOT, 'dist')
const staging = path.join(dist, name)

fs.rmSync(staging, { recursive: true, force: true })
fs.mkdirSync(staging, { recursive: true })

const copied = []
for (const file of INCLUDE_FILES) {
  const from = path.join(ROOT, file)
  if (!fs.existsSync(from)) continue
  fs.copyFileSync(from, path.join(staging, file))
  copied.push(file)
}
for (const dir of INCLUDE_DIRS) {
  const from = path.join(ROOT, dir)
  if (!fs.existsSync(from)) continue
  fs.cpSync(from, path.join(staging, dir), { recursive: true })
  copied.push(`${dir}/`)
}

// LICENSE 从仓库根拿
const license = path.join(repoRoot(), 'LICENSE')
if (fs.existsSync(license)) {
  fs.copyFileSync(license, path.join(staging, 'LICENSE'))
  copied.push('LICENSE')
}

// 内置规则 + 解码器：仓库里是 core/payload.bin 与 lib/core.js、lib/keyring.js
const core = path.join(repoRoot(), 'core', 'payload.bin')
const lib = path.join(repoRoot(), 'lib')
if (!fs.existsSync(core)) {
  console.error('找不到 core/payload.bin，无法打包含内置规则的包。')
  process.exit(1)
}
fs.mkdirSync(path.join(staging, 'payload'), { recursive: true })
fs.copyFileSync(core, path.join(staging, 'payload', 'payload.bin'))
for (const file of ['core.js', 'keyring.js']) {
  fs.copyFileSync(path.join(lib, file), path.join(staging, 'payload', file))
}
copied.push('payload/')

// 压包：用系统自带的 Compress-Archive（Windows），别的平台退到 zip 命令
const zip = path.join(dist, `${name}.zip`)
fs.rmSync(zip, { force: true })
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${staging}' -DestinationPath '${zip}' -CompressionLevel Optimal`,
  ], { stdio: 'inherit' })
} else {
  execFileSync('zip', ['-r', '-q', zip, name], { cwd: dist, stdio: 'inherit' })
}

const size = fs.statSync(zip).size
const sha = createHash('sha256').update(fs.readFileSync(zip)).digest('hex')

console.log('')
console.log(`打包完成：${zip}`)
console.log(`  版本 ${version}   大小 ${(size / 1024).toFixed(0)} KB`)
console.log(`  sha256 ${sha}`)
console.log(`  内容 ${copied.join(' ')}`)
console.log('')
console.log('用户拿到后的用法：解压 → 双击 点我一键安装.bat')
