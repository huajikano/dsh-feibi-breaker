/**
 * 面板、状态条、严格度的测试。
 *
 * 面板是 HTTP 接口，所以除了纯函数，还要真的起一个代理去打它的路由——
 * 只测函数不测路由，最容易漏的是"路由没挂上"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempHomes } from './helpers.mjs'
import { applyConfigPatch, panelState } from '../lib/panel.mjs'
import { statusLine } from '../lib/statusline.mjs'
import { headBlock } from '../lib/inject.mjs'
import { loadConfig, saveConfig } from '../lib/config.mjs'
import { createProxy } from '../lib/proxy.mjs'

function setup() {
  const homes = tempHomes('feibi-panel')
  process.env.FEIBI_HOME = homes.home
  process.env.FEIBI_USERHOME = homes.userHome
  fs.mkdirSync(path.join(homes.userHome, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(homes.userHome, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:45721', ANTHROPIC_MODEL: 'deepseek-chat' },
  }, null, 2), 'utf8')
  return homes
}

test('配置补丁：白名单、类型收敛、落盘', () => {
  const homes = setup()
  try {
    assert.equal(applyConfigPatch(homes.home, { inject: false }).ok, true)
    assert.equal(loadConfig(homes.home).inject, false)

    assert.equal(applyConfigPatch(homes.home, { retryMax: 5 }).ok, true)
    assert.equal(loadConfig(homes.home).retryMax, 5)

    const bad = applyConfigPatch(homes.home, { retryMax: -1 })
    assert.equal(bad.ok, false)
    assert.ok(bad.error.includes('非负'))

    const ignored = applyConfigPatch(homes.home, { port: 1234, upstream: 'http://evil' })
    assert.equal(ignored.ok, false, '端口和上游不在白名单里')

    assert.equal(applyConfigPatch(homes.home, { strictness: 'max' }).ok, true)
    assert.equal(loadConfig(homes.home).strictness, 'max')
  } finally {
    homes.cleanup()
  }
})

test('面板状态：接线、配置、提示词、流水都在', () => {
  const homes = setup()
  try {
    const config = loadConfig(homes.home)
    const state = panelState({ home: homes.home, config })
    assert.equal(state.mode.takeover, true, 'baseURL 指向本端口就算接管')
    assert.equal(state.mode.upstream, config.upstream)
    assert.ok(state.prompt.chars > 1000)
    assert.ok(['default', 'custom', 'empty'].includes(state.prompt.source))
    assert.ok(Array.isArray(state.events))
    assert.equal(typeof state.config.inject, 'boolean')
  } finally {
    homes.cleanup()
  }
})

test('严格度：档位越高，头段里的执行要求越多', () => {
  const standard = headBlock('payload', 'standard')
  const strict = headBlock('payload', 'strict')
  const max = headBlock('payload', 'max')
  assert.ok(!standard.includes('不要反问'))
  assert.ok(strict.includes('不要反问'))
  assert.ok(!strict.includes('满额要求'))
  assert.ok(max.includes('满额要求'))
  // 三档都得带 payload 本身
  for (const text of [standard, strict, max]) assert.ok(text.includes('payload'))
})

test('状态条：一行、带状态点、能看出没接管', () => {
  const homes = setup()
  try {
    const line = statusLine({ home: homes.home })
    assert.equal(typeof line, 'string')
    assert.ok(!line.includes('\n'), '必须是一行')
    assert.ok(line.startsWith('菲比'))
    assert.ok(line.includes('●') || line.includes('○'))
    // 代理没跑，所以应当是"未接管"状态
    assert.ok(line.includes('未接管') || line.includes('○'))
  } finally {
    homes.cleanup()
  }
})

test('面板路由真的挂在代理上', async () => {
  const homes = setup()
  const config = loadConfig(homes.home)
  const proxy = createProxy({ ...config, upstream: 'http://127.0.0.1:1', inject: false, eventLog: false }, { home: homes.home })
  const { port } = await proxy.listen(0)
  try {
    const state = await fetch(`http://127.0.0.1:${port}/feibi/api/state`)
    assert.equal(state.status, 200)
    const body = await state.json()
    assert.ok(body.mode && body.config && body.prompt && body.plugin)

    const patch = await fetch(`http://127.0.0.1:${port}/feibi/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retryMax: 4 }),
    })
    assert.equal(patch.status, 200)
    assert.equal((await patch.json()).applied.retryMax, 4)

    const page = await fetch(`http://127.0.0.1:${port}/feibi/panel`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes('菲比破限'))
    assert.ok(html.includes('/feibi/api/state'), '页面自己会去拉状态')

    // 不认识的键要被拒
    const blocked = await fetch(`http://127.0.0.1:${port}/feibi/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstream: 'http://x' }),
    })
    assert.equal(blocked.status, 400)
  } finally {
    await proxy.close()
    homes.cleanup()
  }
})
