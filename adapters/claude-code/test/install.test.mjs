/**
 * 安装层的测试。
 *
 * 这里盯的是"可逆"两个字：接管要能还原，重复接管不能把原值覆盖成自己的端口。
 * 后者是这类工具最常见的自杀方式——卸载之后把 127.0.0.1:45721 写回 baseURL，
 * 从此谁也连不上。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempHomes } from './helpers.mjs'

/** 每个测试都要重设 env，因为 feibiPaths 是运行时读的。 */
function setup() {
  const homes = tempHomes('feibi-install')
  process.env.FEIBI_HOME = homes.home
  process.env.FEIBI_USERHOME = homes.userHome
  const settings = path.join(homes.userHome, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721', ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED' },
    language: 'Chinese',
  }, null, 2), 'utf8')
  return { ...homes, settings }
}

test('install 接管 baseURL，并记下原值', async () => {
  const { home, settings, cleanup } = setup()
  const { install, currentBaseUrl } = await import('../lib/install.mjs')
  const { loadConfig } = await import('../lib/config.mjs')
  try {
    const result = install({ home, port: 45721, upstream: 'http://127.0.0.1:15721' })
    assert.equal(result.ok, true)
    assert.equal(currentBaseUrl(home), 'http://127.0.0.1:45721')

    const onDisk = JSON.parse(fs.readFileSync(settings, 'utf8'))
    assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED', '别的键不能被弄丢')
    assert.equal(onDisk.language, 'Chinese')

    const config = loadConfig(home)
    assert.equal(config.originalBaseUrl, 'http://127.0.0.1:15721')
    assert.equal(config.upstream, 'http://127.0.0.1:15721')
  } finally {
    cleanup()
  }
})

test('重复 install 不会把原值覆盖成自己的端口', async () => {
  const { home, cleanup } = setup()
  const { install } = await import('../lib/install.mjs')
  const { loadConfig } = await import('../lib/config.mjs')
  try {
    install({ home, port: 45721 })
    install({ home, port: 45721 })
    install({ home, port: 45721 })
    assert.equal(loadConfig(home).originalBaseUrl, 'http://127.0.0.1:15721')
  } finally {
    cleanup()
  }
})

test('uninstall 把 baseURL 还原成接管前那个', async () => {
  const { home, settings, cleanup } = setup()
  const { install, uninstall, currentBaseUrl } = await import('../lib/install.mjs')
  try {
    install({ home, port: 45721 })
    uninstall({ home })
    assert.equal(currentBaseUrl(home), 'http://127.0.0.1:15721')
    const onDisk = JSON.parse(fs.readFileSync(settings, 'utf8'))
    assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED')
  } finally {
    cleanup()
  }
})

test('on / off 只切流量', async () => {
  const { home, cleanup } = setup()
  const { install, toggle, currentBaseUrl } = await import('../lib/install.mjs')
  try {
    install({ home, port: 45721 })
    toggle(false, { home })
    assert.equal(currentBaseUrl(home), 'http://127.0.0.1:15721')
    toggle(true, { home })
    assert.equal(currentBaseUrl(home), 'http://127.0.0.1:45721')
  } finally {
    cleanup()
  }
})

test('settings.json 坏了就停下，不半覆盖', async () => {
  const { home, settings, cleanup } = setup()
  const { install } = await import('../lib/install.mjs')
  try {
    fs.writeFileSync(settings, '{ 这不是 JSON', 'utf8')
    const result = install({ home, port: 45721 })
    assert.equal(result.ok, false)
    assert.ok(String(result.error).includes('不是合法 JSON'))
    assert.equal(fs.readFileSync(settings, 'utf8'), '{ 这不是 JSON', '坏文件一个字节都不能动')
  } finally {
    cleanup()
  }
})

test('settings.json 被第三方改回去时，巡检补回来并跟随新上游', async () => {
  const { home, settings, cleanup } = setup()
  const { install, enforceTakeover, currentBaseUrl } = await import('../lib/install.mjs')
  const { loadConfig } = await import('../lib/config.mjs')
  try {
    install({ home, port: 45721 })
    // 模拟 CC Switch 切 provider 整份重写
    const onDisk = JSON.parse(fs.readFileSync(settings, 'utf8'))
    onDisk.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:15721'
    fs.writeFileSync(settings, JSON.stringify(onDisk, null, 2), 'utf8')

    const result = enforceTakeover(loadConfig(home), home)
    assert.equal(result.changed, true)
    assert.equal(result.from, 'http://127.0.0.1:15721')
    assert.equal(currentBaseUrl(home), 'http://127.0.0.1:45721')

    // 已经是我们的时候什么都不做
    assert.equal(enforceTakeover(loadConfig(home), home).changed, false)
  } finally {
    cleanup()
  }
})

test('还原时绝不把自己的端口写回去', async () => {
  const { home, settings, cleanup } = setup()
  const { restoreSettings } = await import('../lib/install.mjs')
  try {
    // 人为造一个"原值其实是我们自己"的坏状态：这是早期实现会留下的坑，
    // 一旦把它写回 baseURL，代理没跑的时候 Claude Code 就整个连不上。
    fs.writeFileSync(settings, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:45721' },
    }, null, 2), 'utf8')

    restoreSettings({ port: 45721, originalBaseUrl: 'http://127.0.0.1:45721' }, home)
    const onDisk = JSON.parse(fs.readFileSync(settings, 'utf8'))
    assert.equal(onDisk.env?.ANTHROPIC_BASE_URL, undefined, '应该删掉这个键，而不是写回 45721')
  } finally {
    cleanup()
  }
})

test('CLAUDE.md 双保险：写入、替换、删除都不动用户原本那段', async () => {
  const { home, userHome, cleanup } = setup()
  const { injectMemory, removeMemory } = await import('../lib/install.mjs')
  const memory = path.join(userHome, '.claude', 'CLAUDE.md')
  try {
    fs.writeFileSync(memory, '# 语言规则\n\n- 始终用简体中文。\n', 'utf8')
    assert.equal(injectMemory('payload 第一版', home).changed, true)
    let text = fs.readFileSync(memory, 'utf8')
    assert.ok(text.includes('始终用简体中文'), '用户原有内容必须在')
    assert.ok(text.includes('payload 第一版'))

    assert.equal(injectMemory('payload 第二版', home).changed, true)
    text = fs.readFileSync(memory, 'utf8')
    assert.ok(text.includes('payload 第二版'))
    assert.ok(!text.includes('payload 第一版'), '旧的一段要被替换掉')

    assert.equal(removeMemory(home).changed, true)
    text = fs.readFileSync(memory, 'utf8')
    assert.ok(!text.includes('payload'))
    assert.ok(text.includes('始终用简体中文'))
  } finally {
    cleanup()
  }
})
