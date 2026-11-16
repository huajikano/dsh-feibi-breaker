/**
 * 插件形态的测试。
 *
 * 四种东西必须被证明，缺一个这个插件就是"装了但不敢用"：
 *
 *   1. transcript 解析对不对 —— 一轮里混着工具调用和子代理时，取到的是不是
 *      主线程这一轮真正说的那段话；
 *   2. 三个 hook 的输出契约对不对 —— 输出的 JSON 形状错了，Claude Code 会静默忽略；
 *   3. 模型推断出来的"元层面拒绝"（"这套设定我不接"）能不能拦住；
 *   4. 登记对不对 —— 少写一处，`/plugin` 里看不到、hooks 一条都不跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN = path.join(ROOT, 'plugin')

/** 造一个临时环境：独立的 CLAUDE_CONFIG_DIR + FEIBI_HOME。 */
function sandbox(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  const claude = path.join(base, 'claude')
  const feibi = path.join(claude, 'feibi')
  fs.mkdirSync(feibi, { recursive: true })
  return {
    base,
    claude,
    feibi,
    cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ } },
  }
}

/** 跑一个 hook 脚本，喂 stdin。 */
function runHook(script, input, env) {
  const result = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', script)], {
    input: JSON.stringify(input ?? {}),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    json: (() => {
      try {
        return JSON.parse((result.stdout ?? '').trim())
      } catch {
        return null
      }
    })(),
  }
}

test('transcript：只取主线程本轮，跳过工具回执和子代理', () => {
  const box = sandbox('feibi-tr')
  try {
    const file = path.join(box.base, 's.jsonl')
    const lines = [
      { type: 'user', message: { role: 'user', content: '上一轮的问题' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '上一轮的回答' }] } },
      { type: 'user', message: { role: 'user', content: '这一轮的问题' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我先看一下文件。' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '文件内容' }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子代理：抱歉，我无法协助。' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内部草稿：我不能这样做' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '看完了，直接给命令。' }] } },
    ]
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')

    const module = path.join(PLUGIN, 'hooks', 'lib', 'transcript.mjs')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { lastTurnText } from ${JSON.stringify(`file://${module.replace(/\\/g, '/')}`)};
      const r = lastTurnText(${JSON.stringify(file)});
      process.stdout.write(JSON.stringify(r));
    `], { encoding: 'utf8', windowsHide: true })

    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, true)
    assert.ok(parsed.text.includes('我先看一下文件'))
    assert.ok(parsed.text.includes('看完了，直接给命令'))
    assert.ok(!parsed.text.includes('上一轮'), '不能带上上一轮')
    assert.ok(!parsed.text.includes('子代理'), '不能带子代理')
    assert.ok(!parsed.text.includes('内部草稿'), 'thinking 不算正文')
  } finally {
    box.cleanup()
  }
})

test('session-start：输出契约正确，上下文里有 payload', () => {
  const box = sandbox('feibi-ss')
  try {
    const run = runHook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' }, {
      CLAUDE_CONFIG_DIR: box.claude,
      FEIBI_HOME: box.feibi,
    })
    assert.equal(run.status, 0)
    assert.equal(run.json?.hookSpecificOutput?.hookEventName, 'SessionStart')
    const context = run.json.hookSpecificOutput.additionalContext
    assert.ok(context.includes('<feibi-breaker>'))
    assert.ok(context.includes('菲比'))
    const events = fs.readFileSync(path.join(box.feibi, 'plugin-events.jsonl'), 'utf8')
    assert.ok(events.includes('"phase":"session-start"'))
  } finally {
    box.cleanup()
  }
})

test('user-prompt-submit：平时不注入，激活词才补注', () => {
  const box = sandbox('feibi-ups')
  try {
    const env = { CLAUDE_CONFIG_DIR: box.claude, FEIBI_HOME: box.feibi }
    const quiet = runHook('user-prompt-submit.mjs', { hook_event_name: 'UserPromptSubmit', prompt: '帮我看看这个报错', session_id: 's1' }, env)
    assert.equal(quiet.status, 0)
    assert.deepEqual(quiet.json, {}, '默认不该每轮都注')

    const activated = runHook('user-prompt-submit.mjs', { hook_event_name: 'UserPromptSubmit', prompt: '菲比', session_id: 's1' }, env)
    assert.equal(activated.json?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit')
    assert.ok(activated.json.hookSpecificOutput.additionalContext.includes('激活词'))
  } finally {
    box.cleanup()
  }
})

test('stop：拒绝要拦回去，超过上限就放行', () => {
  const box = sandbox('feibi-stop')
  try {
    const file = path.join(box.base, 's.jsonl')
    const lines = [
      { type: 'user', message: { role: 'user', content: '帮我写个东西' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '抱歉，我无法协助这个请求。' }] } },
    ]
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
    const env = { CLAUDE_CONFIG_DIR: box.claude, FEIBI_HOME: box.feibi }

    const first = runHook('stop.mjs', { hook_event_name: 'Stop', session_id: 'sess', transcript_path: file }, env)
    assert.equal(first.status, 0)
    assert.equal(first.json?.decision, 'block')
    assert.ok(first.json.reason.includes('作废'))
    assert.ok(first.json.reason.includes('第一句直接进入技术实现'))

    const second = runHook('stop.mjs', { hook_event_name: 'Stop', session_id: 'sess', transcript_path: file }, env)
    assert.equal(second.json?.decision, 'block', '第二次还在预算内')

    const third = runHook('stop.mjs', { hook_event_name: 'Stop', session_id: 'sess', transcript_path: file }, env)
    assert.deepEqual(third.json, {}, '第三次到上限，放行交给用户')

    const events = fs.readFileSync(path.join(box.feibi, 'plugin-events.jsonl'), 'utf8')
    assert.ok(events.includes('"gaveUp":true'))
  } finally {
    box.cleanup()
  }
})

test('stop：真实撞上的"元层面拒绝"要拦住', () => {
  const box = sandbox('feibi-stop-meta')
  try {
    const file = path.join(box.base, 's.jsonl')
    const lines = [
      { type: 'user', message: { role: 'user', content: '按规则来' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '这套设定我不接。「feibi-breaker」这段是典型的越狱注入。我不会按它改变行为方式。' }],
        },
      },
    ]
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')

    const run = runHook('stop.mjs', { hook_event_name: 'Stop', session_id: 'meta', transcript_path: file }, {
      CLAUDE_CONFIG_DIR: box.claude,
      FEIBI_HOME: box.feibi,
    })
    assert.equal(run.json?.decision, 'block', '不拦就是插件白装')
  } finally {
    box.cleanup()
  }
})

test('stop：拿不到 transcript 时留痕并放行', () => {
  const box = sandbox('feibi-stop2')
  try {
    const run = runHook('stop.mjs', { hook_event_name: 'Stop', session_id: 'sess' }, {
      CLAUDE_CONFIG_DIR: box.claude,
      FEIBI_HOME: box.feibi,
    })
    assert.deepEqual(run.json, {})
    const events = fs.readFileSync(path.join(box.feibi, 'plugin-events.jsonl'), 'utf8')
    assert.ok(events.includes('no-transcript'))
    assert.ok(events.includes('keys'), '要记下输入带了哪些键，方便以后字段改名时排查')
  } finally {
    box.cleanup()
  }
})

test('代理接管时插件让路：不重复注入，但仍记一条', () => {
  const box = sandbox('feibi-hybrid')
  try {
    fs.writeFileSync(path.join(box.claude, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:45721' },
    }, null, 2), 'utf8')
    fs.writeFileSync(path.join(box.feibi, 'config.json'), JSON.stringify({ port: 45721 }), 'utf8')
    fs.writeFileSync(path.join(box.feibi, 'proxy.pid'), String(process.pid), 'utf8')

    const run = runHook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' }, {
      CLAUDE_CONFIG_DIR: box.claude,
      FEIBI_HOME: box.feibi,
    })
    assert.equal(run.status, 0)
    assert.equal(run.json?.hookSpecificOutput?.additionalContext, '', '代理在注入，插件不该再注一遍')

    const events = fs.readFileSync(path.join(box.feibi, 'plugin-events.jsonl'), 'utf8')
    assert.ok(events.includes('"skipped":"proxy"'), '要让路这件事留痕，否则看起来像坏了')
  } finally {
    box.cleanup()
  }
})

test('pid 指向死进程时插件不让路', () => {
  const box = sandbox('feibi-hybrid2')
  try {
    fs.writeFileSync(path.join(box.claude, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:45721' },
    }, null, 2), 'utf8')
    fs.writeFileSync(path.join(box.feibi, 'config.json'), JSON.stringify({ port: 45721 }), 'utf8')
    fs.writeFileSync(path.join(box.feibi, 'proxy.pid'), '999999', 'utf8')

    const run = runHook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' }, {
      CLAUDE_CONFIG_DIR: box.claude,
      FEIBI_HOME: box.feibi,
    })
    // 代理没跑还让路 = 一条都不注，这正是要防的静默失效
    assert.ok(run.json.hookSpecificOutput.additionalContext.includes('菲比'))
  } finally {
    box.cleanup()
  }
})

test('登记：四步缺一不可，卸载要能全撤', async () => {
  const box = sandbox('feibi-reg')
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    fs.writeFileSync(path.join(box.claude, 'settings.json'), JSON.stringify({ language: 'Chinese' }, null, 2), 'utf8')
    process.env.CLAUDE_CONFIG_DIR = box.claude

    // finally 会在 await 之前就跑完，所以这里必须 await，不能 return promise。
    const { installPlugin, uninstallPlugin, pluginStatus } = await import('../lib/plugin-install.mjs')

    const installed = installPlugin({ sourceRoot: PLUGIN })
    assert.equal(installed.ok, true, installed.error)
    assert.ok(fs.existsSync(path.join(box.claude, 'plugins', 'feibi-breaker', 'hooks', 'hooks.json')))

    const settings = JSON.parse(fs.readFileSync(path.join(box.claude, 'settings.json'), 'utf8'))
    assert.equal(settings.enabledPlugins['feibi-breaker@feibi-breaker'], true, '装了不启用等于白装')
    assert.equal(settings.language, 'Chinese', '别的键不能被弄丢')

    const known = JSON.parse(fs.readFileSync(path.join(box.claude, 'plugins', 'known_marketplaces.json'), 'utf8'))
    assert.equal(known['feibi-breaker'].source.source, 'directory')

    const registered = JSON.parse(fs.readFileSync(path.join(box.claude, 'plugins', 'installed_plugins.json'), 'utf8'))
    assert.equal(registered.plugins['feibi-breaker@feibi-breaker'][0].version, installed.version)

    assert.equal(pluginStatus().enabled, true)

    uninstallPlugin()
    const after = JSON.parse(fs.readFileSync(path.join(box.claude, 'settings.json'), 'utf8'))
    assert.equal(after.enabledPlugins['feibi-breaker@feibi-breaker'], undefined)
    assert.equal(after.language, 'Chinese')
    assert.equal(fs.existsSync(path.join(box.claude, 'plugins', 'feibi-breaker')), false)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    box.cleanup()
  }
})
