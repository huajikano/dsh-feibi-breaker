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
import http from 'node:http'
import { applyConfigPatch, panelState, listUpstreamModels } from '../lib/panel.mjs'
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
    assert.ok(bad.error.includes('retryMax'), '错误里要指出是哪个键')

    const ignored = applyConfigPatch(homes.home, { port: 1234 })
    assert.equal(ignored.ok, false, '端口是只读的：改端口要重启监听，面板里改只会骗人')

    // 空字符串曾被一律拒绝，导致 forceModel 填上就再也清不掉。
    assert.equal(applyConfigPatch(homes.home, { forceModel: 'deepseek-reasoner' }).ok, true)
    assert.equal(applyConfigPatch(homes.home, { forceModel: '' }).ok, true, 'forceModel 必须能清空')
    assert.equal(loadConfig(homes.home).forceModel, '')

    // 新增可改项：身份守卫、数组
    assert.equal(applyConfigPatch(homes.home, { identityGuard: false }).ok, true)
    assert.equal(loadConfig(homes.home).identityGuard, false)
    assert.equal(applyConfigPatch(homes.home, { modelsExtra: ['a', 'b'] }).ok, true)
    assert.deepEqual(loadConfig(homes.home).modelsExtra, ['a', 'b'])

    // 上游可以改，但必须是 http(s)
    assert.equal(applyConfigPatch(homes.home, { upstream: 'ftp://x' }).ok, false)
    assert.equal(applyConfigPatch(homes.home, { upstream: 'https://api.deepseek.com/anthropic' }).ok, true)

    // 就地改运行中的对象 —— 少这一步，面板就是"点了已生效、行为没变"。
    const live = loadConfig(homes.home)
    assert.equal(applyConfigPatch(homes.home, { retryMax: 7 }, live).ok, true)
    assert.equal(live.retryMax, 7, '补丁必须落到传进来的活配置上')

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

    // 只读键要被拒
    const blocked = await fetch(`http://127.0.0.1:${port}/feibi/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 1234 }),
    })
    assert.equal(blocked.status, 400)

    // 改完的那一刻，运行中的代理就要认（不是等重启）
    const live = await fetch(`http://127.0.0.1:${port}/feibi/api/state`).then((r) => r.json())
    assert.equal(live.config.retryMax, 4, '补丁必须即时反映到 state 上')

    // 上游现在可改，但非法地址仍然要被拒
    const badUpstream = await fetch(`http://127.0.0.1:${port}/feibi/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstream: '不是网址' }),
    })
    assert.equal(badUpstream.status, 400)
  } finally {
    await proxy.close()
    homes.cleanup()
  }
})

test('模型列表：上游列出但用不了的模型要被标出来', async () => {
  // 上游的 /v1/models 会列出这个 key 用不了的模型——真机就是这样：
  // 列了 4 个 deepseek-*，只有 1 个能出字。面板不能给用户一个"选了就报错"的下拉。
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'good-model' }, { id: 'bad-model' }] }))
      return
    }
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const model = JSON.parse(body || '{}').model
        if (model === 'good-model') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ input_tokens: 3 }))
        } else {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'not supported by any configured account' } }))
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const result = await listUpstreamModels({ upstream: url, key: 'k' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.models.slice().sort(), ['bad-model', 'good-model'])
    assert.deepEqual(result.usable, ['good-model'])
    assert.deepEqual(result.unusable, ['bad-model'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
