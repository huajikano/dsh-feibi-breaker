#!/usr/bin/env node
/**
 * 打「Claude Desktop 一键整合包」。
 *
 * 三份东西合成一个 ZIP：
 *   1. 官方安装包           Claude Desktop Setup.exe
 *   2. 汉化项目             claude-desktop-cn（含 dict/zh.json.gz 词库）
 *   3. 菲比破限适配层       直接复用 adapters/claude-code 打好的发布包
 *
 * 为什么不各自单独发三个包：用户要的是"双击一次，中文 + 破限都到位"。
 * 三个包让用户自己排顺序、自己记得重启，最后一定有人装成半成品。
 *
 * 用法：
 *   node build-bundle.mjs [--setup <exe>] [--cn <dir>] [--feibi <dir>] [--version 1.0.0]
 *
 * @module feibi-claude-desktop-bundle/build
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]
  if (!token.startsWith('--')) continue
  args[token.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]
}

const version = typeof args.version === 'string' ? args.version : '1.0.0'
const setup = path.resolve(args.setup ?? 'D:\\claude code\\Claude Desktop Setup.exe')
const cnDir = path.resolve(args.cn ?? 'D:\\xm1\\claude-desktop-cn')
const feibiDir = path.resolve(args.feibi ?? path.join(HERE, '..', 'claude-code'))

for (const [label, target] of [['安装包', setup], ['汉化项目', cnDir], ['破限适配层', feibiDir]]) {
  if (!fs.existsSync(target)) {
    console.error(`找不到${label}：${target}`)
    process.exit(1)
  }
}

// 1) 先打菲比的发布包（复用已验收的打包逻辑，保证 payload/ 带全）
console.log('· 打菲比破限发布包…')
execFileSync(process.execPath, [path.join(feibiDir, 'scripts', 'build-release.mjs')], { stdio: 'inherit', cwd: feibiDir })
const feibiZip = fs.readdirSync(path.join(feibiDir, 'dist'))
  .filter((f) => f.endsWith('.zip'))
  .map((f) => ({ f, t: fs.statSync(path.join(feibiDir, 'dist', f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].f

// 2) 组装
const name = `feibi-claude-desktop-bundle-${version}`
const dist = path.join(HERE, 'dist')
const stage = path.join(dist, name)
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

for (const file of ['install.ps1', 'uninstall.ps1', '点我一键安装.bat', '点我一键卸载.bat', 'README.md']) {
  const from = path.join(HERE, file)
  if (fs.existsSync(from)) copyFile(from, path.join(stage, file))
}

console.log('· 放入官方安装包…')
copyFile(setup, path.join(stage, 'Claude Desktop Setup.exe'))

console.log('· 放入汉化项目…')
const SKIP = new Set(['.git', 'work', 'backup', 'dist', 'node_modules', '__pycache__'])
fs.cpSync(cnDir, path.join(stage, 'claude-desktop-cn'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(cnDir, src)
    if (rel === '') return true
    const top = rel.split(path.sep)[0]
    return !SKIP.has(top)
  },
})
// 词库必须有，否则 ion-build 跑不动
const dict = path.join(cnDir, 'dict', 'zh.json.gz')
if (!fs.existsSync(dict)) {
  console.error('汉化项目里缺 dict/zh.json.gz —— ion-build 需要它。先按 README 下载。')
  process.exit(1)
}
copyFile(dict, path.join(stage, 'claude-desktop-cn', 'dict', 'zh.json.gz'))

console.log('· 放入菲比破限…')
const feibiStage = path.join(dist, '_feibi_tmp')
fs.rmSync(feibiStage, { recursive: true, force: true })
fs.mkdirSync(feibiStage, { recursive: true })
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Path '${path.join(feibiDir, 'dist', feibiZip)}' -DestinationPath '${feibiStage}' -Force`], { stdio: 'inherit' })
} else {
  execFileSync('unzip', ['-q', path.join(feibiDir, 'dist', feibiZip), '-d', feibiStage], { stdio: 'inherit' })
}
const inner = fs.readdirSync(feibiStage).map((n) => path.join(feibiStage, n)).find((p) => fs.statSync(p).isDirectory())
fs.cpSync(inner, path.join(stage, 'feibi'), { recursive: true })
fs.rmSync(feibiStage, { recursive: true, force: true })

// 3) 压包
const zip = path.join(dist, `${name}.zip`)
fs.rmSync(zip, { force: true })
console.log('· 压缩…')
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${stage}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' })
} else {
  execFileSync('zip', ['-r', '-q', zip, name], { cwd: dist, stdio: 'inherit' })
}

const size = fs.statSync(zip).size
const sha = createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
console.log('')
console.log(`打包完成：${zip}`)
console.log(`  大小 ${(size / 1024 / 1024).toFixed(1)} MB`)
console.log(`  sha256 ${sha}`)
console.log('  内容：安装包 + 汉化项目(含词库) + 菲比破限 + 两只 bat')
