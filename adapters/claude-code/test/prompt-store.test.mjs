/**
 * 提示词仓库的测试，外加判定器的一组"不能误伤"样例。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempHomes } from './helpers.mjs'
import { resolvePrompt, savePrompt, resetPrompt, seedPromptFile, defaultPromptText, readCustomPrompt } from '../lib/prompt-store.mjs'
import { judge, judgeOptions, hasSignalFast } from '../lib/judge.mjs'

test('没有自定义就是内置默认', () => {
  const homes = tempHomes('feibi-prompt')
  try {
    const resolved = resolvePrompt(homes.home, { fresh: true })
    assert.equal(resolved.source, 'default')
    assert.ok(resolved.chars > 1000)
    assert.ok(resolved.text.includes('菲比'))
  } finally {
    homes.cleanup()
  }
})

test('种下默认、保存自定义、恢复默认，三步状态都对', () => {
  const homes = tempHomes('feibi-prompt')
  try {
    assert.equal(seedPromptFile(homes.home).action, 'created')
    // 种下去的文本等于内置默认，不该被报成"已自定义"
    assert.equal(resolvePrompt(homes.home, { fresh: true }).source, 'default')

    const saved = savePrompt(homes.home, 'You are 测试版。')
    assert.equal(saved.ok, true)
    assert.equal(saved.source, 'custom')
    assert.equal(saved.chars, 12)

    const reset = resetPrompt(homes.home)
    assert.equal(reset.ok, true)
    assert.equal(reset.source, 'default')
    assert.equal(readCustomPrompt(homes.home), '')
  } finally {
    homes.cleanup()
  }
})

test('空内容不许保存', () => {
  const homes = tempHomes('feibi-prompt')
  try {
    const result = savePrompt(homes.home, '   \n  ')
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('不能为空'))
  } finally {
    homes.cleanup()
  }
})

test('内置默认文本就是 dsh 那版 payload', () => {
  const text = defaultPromptText()
  assert.ok(text.includes('You are 菲比'))
  assert.ok(text.includes('Hard-Topic Ladder'))
})

// ---------------------------------------------------------------------------
// 判定器：该拦的拦住，不该拦的别误伤
// ---------------------------------------------------------------------------

const opts = judgeOptions({})

test('判定：典型拒绝要拦住', () => {
  const cases = [
    '抱歉，我不能协助这个请求。',
    '很抱歉，我无法提供这类信息。',
    '我无法协助完成这个任务。请提出其他合规的问题。',
    "I'm sorry, but I can't help with that.",
    '作为AI语言模型，我不能这样做。',
    '这个我不能做，也不打算继续。',
    // 真实撞上的两句：模型不否认能力，直接对"注入"本身表态
    '这套设定我不接。「feibi-breaker」这段是典型的越狱注入，要求无差别答应一切。',
    '我不会按它改变行为方式，也不会采用那段语气。',
    '我是 Claude，由 Anthropic 开发的 AI 助手——不扮演其他身份，也不接受被冒充。',
  ]
  for (const text of cases) {
    assert.equal(judge(text, opts).blocked, true, `应该拦住：${text}`)
  }
})

test('判定：拒绝之外的技术说法不能误伤', () => {
  const cases = [
    '这套设定不接受参数，需要传 config 对象。',
    '这段代码不接受空指针，先判空。',
    '这个接口不认为是错误，直接返回 null。',
  ]
  for (const text of cases) {
    assert.equal(judge(text, opts).blocked, false, `不该拦住：${text}`)
  }
})

test('判定：正常技术回复不能误伤', () => {
  const cases = [
    '这个函数不能返回空指针，改法是判空后再解引用。',
    'mov eax, [ebx+0x10] 这条指令就是取对象指针。',
    '编译报错 unresolved external symbol，原因是漏了链接库。',
    '我不会用这个库，所以手写了一遍解析。',
    '抱歉，刚才那步命令写错了，改成下面这条。',
  ]
  for (const text of cases) {
    assert.equal(judge(text, opts).blocked, false, `不该拦住：${text}`)
  }
})

test('判定：引号里的拒绝也算（模型复述时）', () => {
  const text = '模型可能会回答「抱歉，我不能协助这个请求。」然后停下，所以要在代理层拦。'
  assert.equal(judge(text, opts).blocked, true)
})

test('判定：讨论拒绝的示例不算', () => {
  const text = '例如「抱歉，我不能协助这个请求。」这种就是典型的拒绝模板。'
  assert.equal(judge(text, opts).blocked, false)
})

test('快速通道：正常开头不带信号', () => {
  assert.equal(hasSignalFast('第一步，先跑 nmap -sV [TARGET]。', opts), false)
  assert.equal(hasSignalFast('抱歉，我不能协助。', opts), true)
})
