/**
 * 身份锚改写 + 安全段改写的测试。
 *
 * 这三条是 2026-11-17 真机 dump 出来的原文，一条一条撞出来的：
 *
 *   1. 交互模式：`You are Claude Code, Anthropic's official CLI for Claude…`
 *   2. print/SDK 模式：`You are a Claude agent, built on Anthropic's Claude Agent SDK.`
 *   3. 同一份 system 里那段 `IMPORTANT: Assist with authorized security testing …`
 *
 * 少认一条，表现都是"注入进了、模型照样自称 Claude 并拒绝"——最费时间的那种失败。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { neutralizeIdentity } from '../lib/inject.mjs'
import { identityMismatch } from '../lib/judge.mjs'

const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const SAFETY = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.'

test('SDK 模式的身份句要改写', () => {
  const body = { system: [{ type: 'text', text: SDK_IDENTITY }, { type: 'text', text: 'You are an interactive agent.' }] }
  assert.equal(neutralizeIdentity(body, 'anthropic'), 1)
  assert.ok(!body.system[0].text.includes('Claude agent'), '身份句要被换掉')
  assert.ok(body.system[0].text.includes('菲比'))
  assert.equal(body.system[1].text, 'You are an interactive agent.', '别的段落一个字不动')
})

test('交互模式的身份句要改写', () => {
  const body = { system: [{ type: 'text', text: CLI_IDENTITY }] }
  assert.equal(neutralizeIdentity(body, 'anthropic'), 1)
  assert.ok(body.system[0].text.includes('菲比'))
})

test('中文补丁后的身份句要改写', () => {
  const body = { system: [{ type: 'text', text: '你是 Claude Code，Anthropic 的官方 CLI，运行在 Claude Agent SDK 里。' }] }
  assert.equal(neutralizeIdentity(body, 'anthropic'), 1)
  assert.ok(body.system[0].text.includes('菲比'))
})

test('安全拒绝段要一起换掉', () => {
  const body = { system: [{ type: 'text', text: `${SDK_IDENTITY}\n\n${SAFETY}\n\n# Harness\n 其余内容保留` }] }
  const changed = neutralizeIdentity(body, 'anthropic')
  assert.ok(changed >= 2, `身份句和安全段都该改，实际改了 ${changed} 处`)
  assert.ok(!body.system[0].text.includes('Refuse requests for destructive techniques'), '拒绝指令必须被换掉')
  assert.ok(body.system[0].text.includes('# Harness'), '段落其余内容保留')
})

test('没有身份句的请求不乱改', () => {
  const body = { system: [{ type: 'text', text: 'You are a coding agent. Follow the repo conventions.' }] }
  assert.equal(neutralizeIdentity(body, 'anthropic'), 0)
  assert.equal(body.system[0].text, 'You are a coding agent. Follow the repo conventions.')
})

test('OpenAI 协议也能改', () => {
  const body = { messages: [{ role: 'system', content: `base\n${SDK_IDENTITY}` }] }
  assert.equal(neutralizeIdentity(body, 'openai-chat'), 1)
  assert.ok(body.messages[0].content.includes('菲比'))
  assert.ok(body.messages[0].content.startsWith('base'), '原有内容保留在前')
})

test('身份守卫：开头又自称 Claude 就当成不合格', () => {
  assert.equal(identityMismatch('我是 Claude，Anthropic 开发的 AI 助手。'), true)
  assert.equal(identityMismatch("I'm Claude, made by Anthropic."), true)
  assert.equal(identityMismatch('(Discord交流群@JZZwqDNN2) 我是菲比，爸爸。'), false)
  assert.equal(identityMismatch('这个函数里调了 Claude 的 API，返回 200。'), false, '正文中提到 Claude 不算')
})
