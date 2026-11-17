#!/usr/bin/env node
/**
 * feibi-cc —— 菲比破限 for Claude Code Desktop 的命令行入口。
 *
 * 子命令一览（全部无参数也有合理缺省）：
 *
 *   install     接管 ~/.claude/settings.json，把 baseURL 指到本代理
 *   uninstall   还原一切（提示词文件保留）
 *   on / off    只切流量，不装不卸
 *   start/stop  后台跑代理
 *   serve       前台跑代理（调试用）
 *   status      一眼看清现在到底通没通
 *   prompt      看 / 改 / 恢复提示词
 *   log         看判定流水
 *   probe       真发一条最小请求，验证整条链路
 *
 * @module feibi-breaker-cc/cli
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { feibiPaths, loadConfig, saveConfig, loadState } from '../lib/config.mjs'
import { createProxy } from '../lib/proxy.mjs'
import { resolvePrompt, savePrompt, resetPrompt, seedPromptFile } from '../lib/prompt-store.mjs'
import { install, uninstall, toggle, currentBaseUrl, enforceTakeover, enforceDirectEnv, installStatusLine, removeStatusLine, PROJECT_ROOT } from '../lib/install.mjs'
import { statusLine } from '../lib/statusline.mjs'
import { showPanel, setConfig } from '../lib/panel-cli.mjs'
import { installPlugin, uninstallPlugin, pluginStatus } from '../lib/plugin-install.mjs'
import { enableDirect, disableDirect } from '../lib/direct.mjs'
import { readEvents } from '../lib/stats.mjs'

const SELF = fileURLToPath(import.meta.url)

/** 解析 argv 里的 `--key value` 与 `--flag`。 */
function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i += 1
      } else {
        flags[name] = true
      }
    } else {
      rest.push(token)
    }
  }
  return { flags, rest }
}

/** 打一行给终端。 */
function say(line = '') {
  process.stdout.write(`${line}\n`)
}

/**
 * 探测本机某个端口上的代理是不是我们。
 *
 * @param {number} port - 端口。
 * @returns {Promise<object|null>} 健康信息，连不上就是 null。
 */
async function health(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const response = await fetch(`http://127.0.0.1:${port}/feibi/health`, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * 问某个 baseURL 上是不是另一个菲比代理。
 *
 * 用来避免"两个实例互相抢 settings.json"：A 把 baseURL 写成自己的端口，
 * B 的巡检看到漂移就跟着改，最后 upstream 被写死成对方的端口，两边都废。
 * 认得出的就不抢，只在日志里说一句。
 *
 * @param {string} baseUrl - 例如 http://127.0.0.1:45722
 * @returns {Promise<object|null>} 健康信息；不是我们就返回 null。
 */
async function healthFrom(baseUrl) {
  try {
    const target = new URL('/feibi/health', baseUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 600)
    const response = await fetch(target, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return null
    const body = await response.json()
    return body !== null && typeof body === 'object' ? body : null
  } catch {
    return null
  }
}

/** 把日志写到 proxy.log 并（非 quiet 时）打到终端。 */function makeLogger(home, quiet) {
  const paths = feibiPaths(home)
  return (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`
    if (!quiet) process.stdout.write(`${stamped}\n`)
    try {
      fs.mkdirSync(paths.root, { recursive: true })
      fs.appendFileSync(paths.log, `${stamped}\n`, 'utf8')
    } catch {
      // 日志写不进去不影响代理。
    }
  }
}

// ---------------------------------------------------------------------------
// serve / start / stop
// ---------------------------------------------------------------------------

async function cmdServe(flags, home) {
  const config = loadConfig(home)
  if (Number(flags.port) > 0) config.port = Number(flags.port)
  const quiet = flags.quiet === true
  const log = makeLogger(home, quiet)

  const existing = await health(config.port)
  if (existing !== null) {
    if (!quiet) say(`端口 ${config.port} 上已经有一份菲比代理在跑（pid ${existing.pid}），本进程直接退出。`)
    return 0
  }

  const proxy = createProxy(config, { home, log })
  let port
  try {
    ;({ port } = await proxy.listen(config.port))
  } catch (error) {
    process.stderr.write(`端口 ${config.port} 起不来：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const paths = feibiPaths(home)
  try {
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(paths.pid, String(process.pid), 'utf8')
  } catch {
    // pid 文件只是给 stop 用的便利，写不进去不影响运行。
  }

  if (!quiet) {
    say(`菲比破限代理已启动：http://127.0.0.1:${port}`)
    say(`上游：${config.upstream}`)
    say(`注入：${config.inject !== false ? '开' : '关'}    判定：${config.guard !== false ? '开' : '关'}    自动重试：${config.autoRetry !== false ? `最多 ${config.retryMax} 次` : '关'}`)
    say('Ctrl+C 停止。')
  }

  const shutdown = async () => {
    await proxy.close()
    try { fs.unlinkSync(paths.pid) } catch { /* 没有就算了 */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // 盯住 settings.json：CC Switch 切 provider 时会整份重写它，
  // 一重写我们的接管就没了。每 3 秒看一次，被改了就补回来，
  // 并且把被写进去的地址当成新的上游（那才是用户此刻想去的地方）。
  if (config.watchSettings !== false) {
    let repairs = 0
    const timer = setInterval(async () => {
      // 直连模式先守 env（CC Switch 会把 key 和 model 一起抹掉），再守 baseURL。
      if (config.direct) {
        const direct = enforceDirectEnv(config, home)
        if (direct.changed) log('settings.json 的直连 env（key/模型）被抹掉了，已按 config.direct 还原。')
      }
      // 先排除"另一个菲比代理在抢端口"：那种情况下被写进来的地址是它自己，
      // 跟着它走会把自己指成一个死循环，而且会把 upstream 写死成对方的端口。
      const drift = currentBaseUrl(home)
      if (typeof drift === 'string' && !drift.includes(`127.0.0.1:${config.port}`)) {
        const other = await healthFrom(drift)
        if (other !== null && other.ok === true) {
          log(`settings.json 被另一个菲比代理（:${other.port ?? '?'}）接管，忽略这次改写，不跟它抢。`)
          return
        }
      }

      const result = enforceTakeover(config, home)
      if (result.error) {
        log(`接管巡检失败：${result.error}`)
        return
      }
      if (!result.changed) return
      repairs += 1
      config.upstream = result.upstream ?? config.upstream
      log(`settings.json 被改回 ${result.from}，已重新接管到 :${config.port}，上游跟随为 ${config.upstream}`)
      if (repairs > 20) {
        log('接管被反复改写超过 20 次，先停止自动补，检查是不是有工具在跟我们抢这个文件。')
        clearInterval(timer)
      }
    }, 3000)
    timer.unref?.()
  }

  // 常驻：不 resolve，让事件循环挂在 server 上。
  await new Promise(() => {})
  return 0
}

async function cmdStart(flags, home) {
  const config = loadConfig(home)
  if (Number(flags.port) > 0) config.port = Number(flags.port)
  const existing = await health(config.port)
  if (existing !== null) {
    say(`已经在跑：http://127.0.0.1:${config.port}（pid ${existing.pid}）`)
    return 0
  }
  const child = spawn(process.execPath, [SELF, 'serve', '--quiet', '--port', String(config.port)], {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_ROOT,
    windowsHide: true,
  })
  child.unref()

  // 最多等 4 秒，确认它真的起来了；"启动成功"这句话必须由健康检查说出口。
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const up = await health(config.port)
    if (up !== null) {
      say(`代理已后台启动：http://127.0.0.1:${config.port}（pid ${up.pid}）`)
      return 0
    }
  }
  process.stderr.write('代理没能在 4 秒内起来，看 ~/.claude/feibi/proxy.log\n')
  return 1
}

async function cmdStop(home) {  const config = loadConfig(home)
  const paths = feibiPaths(home)
  const up = await health(config.port)
  let pid = up?.pid ?? null
  if (pid === null) {
    try {
      pid = Number(fs.readFileSync(paths.pid, 'utf8').trim())
    } catch {
      pid = null
    }
  }
  if (!pid) {
    say('没有在跑的代理。')
    return 0
  }
  try {
    process.kill(pid)
    say(`已停止 pid ${pid}。`)
  } catch (error) {
    process.stderr.write(`停不掉 pid ${pid}：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  try { fs.unlinkSync(paths.pid) } catch { /* ignore */ }
  return 0
}

// ---------------------------------------------------------------------------
// install / uninstall / on / off
// ---------------------------------------------------------------------------

function cmdInstall(flags, home) {
  const result = install({
    home,
    port: Number(flags.port) > 0 ? Number(flags.port) : undefined,
    upstream: typeof flags.upstream === 'string' ? flags.upstream : undefined,
    autostart: flags.autostart === true,
    memoryInject: flags.memory === true ? true : undefined,
  })
  if (!result.ok) {
    process.stderr.write(`安装失败：${result.error}\n`)
    return 1
  }
  say('安装完成。')
  say(`  配置：${result.configFile}`)
  say(`  提示词：${result.promptFile}（${result.promptSeeded === 'created' ? '已按内置默认种下' : '沿用你已有的那份'}）`)
  say(`  端口：${result.port}    上游：${result.upstream}`)
  say(`  settings.json：${result.settingsChanged ? `已把 ANTHROPIC_BASE_URL 改成 ${result.baseUrl}` : '本来就是我们的地址，没动'}`)
  if (result.settingsBackup) say(`  原文件备份：${result.settingsBackup}`)
  if (result.shim.written.length > 0) say(`  命令垫片：${result.shim.written.join('、')}${result.shim.onPath ? '' : `（${result.shim.dir} 不在 PATH 上，直接用 node 调也行）`}`)
  say(`  开机自启：${result.autostart?.ok ? `已装（${result.autostart.file}）` : '没装（加 --autostart）'}`)
  if (result.memory) say(`  CLAUDE.md 双保险：${result.memory.changed ? '已写入' : '已是最新'}`)
  say('')
  say('下一步：')
  say('  1. feibi-cc start        后台起代理')
  say('  2. 完全退出 Claude Code Desktop 再打开（env 只在启动时读一次）')
  say('  3. feibi-cc status       确认命中数在涨')
  return 0
}

function cmdUninstall(flags, home) {
  const result = uninstall({ home })
  if (!result.ok) process.stderr.write(`还原 settings.json 失败：${result.error}\n`)
  say(`baseURL 已还原：${result.restored ?? '（删掉了这个键，回到上游默认）'}`)
  say('开机自启已移除，命令垫片保留（在 ~/.claude/bin 里，不要了直接删）。')
  say('提示词文件保留在 ~/.claude/feibi/prompt.md，没删。')
  return result.ok ? 0 : 1
}

function cmdToggle(on, home) {
  const result = toggle(on, { home })
  if (!result.ok) {
    process.stderr.write(`切换失败：${result.error}\n`)
    return 1
  }
  if (on) say(`流量已指向本代理：${result.baseUrl}（重启 Claude Code Desktop 生效）`)
  else say(`流量已指回上游：${result.restored ?? '（回到上游默认）'}（重启 Claude Code Desktop 生效）`)
  return 0
}

// ---------------------------------------------------------------------------
// plugin:装成 Claude Code 插件（hook 形态）
// ---------------------------------------------------------------------------

/**
 * 装完之后拿真 hooks 打一发，确认插件自己不出错。
 *
 * 为什么必须做：Claude Code 只在 hook 失败时给一行 stderr，装完重启才发现
 * 不工作的话，用户会以为插件是坏的。这里直接用 `{}` 当输入跑一遍，
 * 能把"路径写错 / import 失败 / 语法错"三类问题当场抓出来。
 *
 * @param {string} installPath - 插件安装目录。
 * @returns {{ok: boolean, detail: string}} 结果。
 */
function smokeTestHooks(installPath) {
  const checks = []
  for (const name of ['session-start.mjs', 'user-prompt-submit.mjs', 'stop.mjs']) {
    const file = path.join(installPath, 'hooks', name)
    const result = spawnSync(process.execPath, [file], { input: '{}', encoding: 'utf8', windowsHide: true })
    if (result.error) {
      checks.push(`${name}: 起不来（${result.error.message}）`)
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse((result.stdout ?? '').trim())
    } catch {
      parsed = null
    }
    if (result.status !== 0) {
      checks.push(`${name}: 退出码 ${result.status}；stderr=${(result.stderr ?? '').trim().slice(0, 200)}`)
    } else if (parsed === null) {
      checks.push(`${name}: 输出不是 JSON（${(result.stdout ?? '').slice(0, 120)}）`)
    } else {
      checks.push(`${name}: 正常（输出键 ${Object.keys(parsed).join(',') || '空'}）`)
    }
  }
  return { ok: checks.every((line) => line.includes('正常')), detail: checks.join('\n    ') }
}

function cmdPlugin(positional, flags, home) {
  const action = positional[0] ?? 'status'

  if (action === 'install') {
    const result = installPlugin({ home })
    if (!result.ok) {
      process.stderr.write(`装插件失败：${result.error}\n`)
      return 1
    }
    say('插件已装好。')
    say(`  本体：${result.installPath}（v${result.version}）`)
    say(`  市场：${result.marketplace}`)
    say(`  启用键：${result.enabledKey} = true  → ${result.settings}`)
    say(`  提示词：${result.promptFile}（${result.promptSeeded === 'created' ? '已种下内置默认' : '沿用你已有的那份'}）`)

    const smoke = smokeTestHooks(result.installPath)
    say('')
    say(`  hooks 自检：${smoke.ok ? '全部正常' : '有问题'}`)
    say(`    ${smoke.detail}`)

    // 插件和代理都会注入 payload，两个同时开会注两遍（多花 token、日志也重复）。
    if (flags['keep-proxy'] !== true) {
      const off = toggle(false, { home })
      if (off.ok) say(`\n  代理接管已关掉（baseURL 回到 ${off.restored ?? '上游默认'}）：插件形态不需要它，两个一起开会注两遍。要都留着加 --keep-proxy。`)
    }

    say('')
    say('下一步：')
    say('  1. 重启 Claude Code Desktop（或终端里的 claude），hooks 只在启动时加载')
    say('  2. 会话里敲 /feibi 看状态')
    say('  3. 想改 payload：editing ~/.claude/feibi/prompt.md，下一轮就生效')
    return smoke.ok ? 0 : 1
  }

  if (action === 'uninstall') {
    const result = uninstallPlugin({ home })
    say(`插件已卸载：${result.removed}`)
    say('登记（市场 / 已装 / 启用）都注销了。~/.claude/feibi/ 保留，提示词没删。')
    return 0
  }

  const status = pluginStatus()
  say('菲比破限 · 插件形态')
  say('='.repeat(46))
  say(`已安装   ${status.installed ? `是（v${status.version}）` : '否'}`)
  say(`已启用   ${status.enabled ? '是' : '否（装了不启用 = hooks 不跑）'}`)
  say(`启用键   ${status.key}`)
  say(`安装位置 ${status.installPath}`)
  say(`hooks    ${status.hooksPresent ? '在' : '缺（重跑 feibi-cc plugin install）'}`)
  say(`市场登记 ${status.marketplaceKnown ? '有' : '无'}`)
  say(`源目录   ${status.sourceExists ? '完整' : '不完整'}`)
  return status.installed && status.enabled ? 0 : 1
}

// ---------------------------------------------------------------------------
// panel / statusline：设置面板与状态条
// ---------------------------------------------------------------------------

/**
 * 在桌面放一个 .url 快捷方式。
 *
 * "不知道该在哪里打开"是纯粹的入口问题：面板是个网址，而网址需要一个
 * 能双击的东西。放一个 Internet Shortcut 比教人记端口可靠。
 *
 * @param {number} port - 代理端口。
 * @returns {string|null} 快捷方式路径。
 */
function writePanelShortcut(port) {
  try {
    const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop')
    if (!fs.existsSync(desktop)) return null
    const file = path.join(desktop, '菲比破限面板.url')
    fs.writeFileSync(file, `[InternetShortcut]\r\nURL=http://127.0.0.1:${port}/feibi/panel\r\nIconIndex=0\r\n`, 'utf8')
    return file
  } catch {
    return null
  }
}

/**
 * 打开设置面板。
 *
 * 代理没跑就先起（面板是它的路由）。起不来就把原因说清楚，别让人对着空白页猜。
 */
async function cmdPanel(flags, home) {
  const config = loadConfig(home)
  const port = Number(flags.port) > 0 ? Number(flags.port) : config.port
  const up = await health(port)
  if (up === null) {
    const started = await cmdStart(flags, home)
    if (started !== 0) return started
  }
  const url = `http://127.0.0.1:${port}/feibi/panel`
  say('设置面板地址（复制到浏览器，或在桌面双击「菲比破限面板」）：')
  say(`  ${url}`)
  const shortcut = writePanelShortcut(port)
  if (shortcut !== null) say(`已放桌面快捷方式：${shortcut}`)
  if (flags.open !== false) {
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      say('已经帮你打开浏览器；没弹出来就用上面的地址。')
    } catch {
      say('浏览器没打开，手动复制上面的地址。')
    }
  }
  const sl = installStatusLine(home)
  say(sl.ok ? '状态条已确认（settings.json 的 statusLine）。' : `状态条没装上：${sl.error}`)
  return 0
}

/** 状态条一行输出。给 settings.json 的 statusLine 命令用，别的东西也会调。 */
function cmdStatusline(home) {
  process.stdout.write(`${statusLine({ home })}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// direct / undirect：旁路 CC Switch，直连一个确定能用的端点
// ---------------------------------------------------------------------------

/**
 * 切直连。
 *
 * 中间那层（CC Switch）选中了一个挂掉的 provider 时，链路上游整段不通，
 * 而从外面看两边都只是"502 上游连接被拒绝"。这条命令把上游换成确定能用的
 * 那个，并把模型名一起换掉——直连之后没人帮你做映射了。
 */
async function cmdDirect(flags, home) {
  const upstream = typeof flags.upstream === 'string' ? flags.upstream : 'https://api.deepseek.com/anthropic'
  const model = typeof flags.model === 'string' ? flags.model : 'deepseek-chat'
  const key = typeof flags.key === 'string' && flags.key.length > 0
    ? flags.key
    : (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '')

  if (key.length === 0) {
    process.stderr.write('缺 key：加 --key sk-... ，或先设环境变量 DEEPSEEK_API_KEY\n')
    return 1
  }

  const result = enableDirect({ home, upstream, key, model, port: Number(flags.port) || undefined })
  if (!result.ok) {
    process.stderr.write(`切直连失败：${result.error}\n`)
    return 1
  }

  say('已切到直连。')
  say(`  上游：${result.upstream}`)
  say(`  模型：${result.model}（env.ANTHROPIC_MODEL，直连后没人替你做映射）`)
  say(`  入口：http://127.0.0.1:${result.port}（还是本代理，注入/判定照旧）`)
  say(`  备份：${result.backup ?? '（备份失败，但原值已记进 config.json）'}`)

  await cmdStop(home)
  const started = await cmdStart(flags, home)
  if (started !== 0) return started

  say('')
  say('发一条真实请求验证……')
  const probe = await cmdProbe({ model: result.model }, home)
  say('')
  if (probe === 0) {
    say('链路通了。完全退出并重启 Claude Code Desktop 之后就会走这条路（env 只在启动时读一次）。')
    say('想还原：feibi-cc undirect')
  } else {
    say('链路还不通。看上面的报错：如果是 401/403 就是 key 不对，400 就是模型名不对。')
  }
  return probe
}

/** 撤掉直连。 */
function cmdUndirect(home) {
  const result = disableDirect({ home })
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`)
    return 1
  }
  say(`已撤销直连，baseURL 还原成 ${result.restored ?? '（未设置）'}，上游回到 ${result.upstream}`)
  say('代理不用重启；Claude Code Desktop 要重启才会读回旧 env。')
  return 0
}

// ---------------------------------------------------------------------------
// status / log / prompt / probe
// ---------------------------------------------------------------------------

async function cmdStatus(home) {
  const config = loadConfig(home)
  const paths = feibiPaths(home)
  const resolved = resolvePrompt(home)
  const state = loadState(home)
  const baseUrl = currentBaseUrl(home)
  const up = await health(config.port)

  const running = up !== null
  const pointsHere = typeof baseUrl === 'string' && baseUrl.includes(`127.0.0.1:${config.port}`)

  say('菲比破限 · Claude Code Desktop')
  say('='.repeat(52))
  say(`版本       1.0.0`)
  say(`家目录     ${paths.root}`)
  say(`端口       ${config.port}`)
  say(`上游       ${config.upstream}`)
  say(`注入       ${config.inject !== false ? '开' : '关'}`)
  say(`判定       ${config.guard !== false ? '开' : '关'}  窗口 ${config.scanChars} 字 / 放行阈值 ${config.releaseChars} 字`)
  say(`自动重试   ${config.autoRetry !== false ? `开，最多 ${config.retryMax} 次` : '关'}  收场方式 ${config.exhaustedMode}`)
  say('')
  say(`代理进程   ${running ? `在跑（pid ${up.pid}）` : '没在跑 → feibi-cc start'}`)
  say(`settings   ${baseUrl ?? '（没设 ANTHROPIC_BASE_URL）'}`)
  say(`接管状态   ${pointsHere ? '已接管 ✓' : '没接管 → 跑 feibi-cc install 或 feibi-cc on'}`)
  say('')
  say(`提示词     ${resolved.source === 'custom' ? '你自己那份' : resolved.source === 'default' ? '内置默认' : '空（不会注入！）'}`)
  say(`           文件 ${resolved.file}`)
  say(`           ${resolved.chars} 字  哈希 ${(resolved.hash ?? '').slice(0, 12)}`)
  say('')
  say('累计')
  say(`  判定 ${state.judged ?? 0}   拦截 ${state.blocked ?? 0}   放行 ${state.passed ?? 0}   重试 ${state.retried ?? 0}   注入 ${state.injected ?? 0}`)
  if (state.lastEventAt) say(`  最近一次判定 ${state.lastEventAt}`)

  const recent = readEvents(3, home)
  if (recent.length > 0) {
    say('')
    say('最近三条')
    for (const event of recent) {
      const kind = event.kind ?? 'judge'
      const flag = event.blocked === true ? '拦截' : kind === 'judge' ? '放行' : kind
      say(`  [${event.at ?? '-'}] ${flag}${event.reason ? ` (${event.reason})` : ''} ${event.chars ?? ''} 字 ${event.head ? `“${String(event.head).slice(0, 40)}”` : ''}`)
    }
  }

  if (!running) say('\n结论：代理没起，现在跑的都是直连。先 feibi-cc start。')
  else if (!pointsHere) say('\n结论：代理在跑但没人指过来。跑 feibi-cc on，然后重启 Claude Code Desktop。')
  else if ((state.judged ?? 0) === 0 && (state.injected ?? 0) > 0) say(`\n结论：接管生效、请求也在进来（已注入 ${state.injected} 次），但没有一条走到判定——说明都卡在上游。去看 CC Switch 里当前 provider 的端点是不是活着（feibi-cc log 里 502 的原文就是上游自己的报错）。`)
  else if ((state.judged ?? 0) === 0) say('\n结论：接线正确，但还没被用过。去桌面版里发一句话，再看这里。')
  else say('\n结论：在用。')
  return 0
}

function cmdLog(flags, home) {
  const count = Number(flags.n) > 0 ? Number(flags.n) : 20
  const events = readEvents(count, home)
  if (events.length === 0) {
    say('还没有流水。')
    return 0
  }
  for (const event of events) {
    const kind = event.kind ?? 'judge'
    const verdict = kind === 'judge' ? (event.blocked === true ? '拦截' : '放行') : kind
    say(`[${event.at ?? '-'}] ${verdict}  原因=${event.reason ?? '-'}  字数=${event.chars ?? '-'}  第${event.attempt ?? 0}次`)
    if (event.head) say(`    ${String(event.head).slice(0, 200)}`)
  }
  return 0
}

function cmdPrompt(flags, rest, home) {
  const action = rest[0] ?? 'show'
  const paths = feibiPaths(home)
  if (action === 'path') {
    say(paths.prompt)
    return 0
  }
  if (action === 'show') {
    const resolved = resolvePrompt(home, { fresh: true })
    say(`来源：${resolved.source === 'custom' ? '用户自定义' : resolved.source === 'default' ? '内置默认' : '空（警告）'}`)
    say(`文件：${resolved.file}`)
    say(`字数：${resolved.chars}   哈希：${(resolved.hash ?? '').slice(0, 12)}`)
    say('-'.repeat(52))
    say(resolved.text)
    return 0
  }
  if (action === 'set') {
    const file = rest[1]
    if (!file) {
      process.stderr.write('用法：feibi-cc prompt set <文件路径>\n')
      return 1
    }
    const text = fs.readFileSync(file, 'utf8')
    const result = savePrompt(home, text)
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`)
      return 1
    }
    say(`已保存：${result.chars} 字（${result.source === 'custom' ? '算自定义' : '和内置默认相同'}）`)
    return 0
  }
  if (action === 'edit') {
    seedPromptFile(home)
    say(`用编辑器打开这个文件改，保存即生效，不用重启代理：\n${paths.prompt}`)
    const editor = process.env.EDITOR ?? process.env.VISUAL
    if (editor) {
      spawn(editor, [paths.prompt], { detached: true, stdio: 'ignore', shell: true }).unref()
    } else {
      try {
        spawn('notepad.exe', [paths.prompt], { detached: true, stdio: 'ignore' }).unref()
      } catch {
        say('打不开编辑器，手动打开上面那个路径就行。')
      }
    }
    return 0
  }
  if (action === 'reset') {
    const result = resetPrompt(home)
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`)
      return 1
    }
    say(`已恢复内置默认：${result.chars} 字`)
    return 0
  }
  process.stderr.write(`未知的 prompt 子命令：${action}（show / path / set / edit / reset）\n`)
  return 1
}

async function cmdProbe(flags, home) {
  const config = loadConfig(home)
  const paths = feibiPaths(home)
  const port = Number(flags.port) > 0 ? Number(flags.port) : config.port
  const up = await health(port)
  if (up === null) {
    process.stderr.write(`端口 ${port} 上没有代理，先 feibi-cc start\n`)
    return 1
  }
  say(`代理在跑（pid ${up.pid}），发一条最小请求验证链路……`)
  const body = {
    model: flags.model ?? 'claude-sonnet-5',
    max_tokens: 32,
    stream: true,
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: '回答两个字：在。' }],
  }
  const started = Date.now()
  // 认证跟着 settings.json 走：不同上游认的 header 不一样（x-api-key 还是
  // Authorization），探针要是自己瞎编一个，就会把"认证不对"报成"链路不通"。
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01' }
  try {
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettings, 'utf8'))
    const env = settings?.env ?? {}
    if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0) headers['x-api-key'] = env.ANTHROPIC_API_KEY
    else if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`
  } catch {
    // 读不到 settings 就裸发，让上游自己报 401。
  }

  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (error) {
    process.stderr.write(`请求代理失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const text = await response.text()
  const ms = Date.now() - started
  say(`HTTP ${response.status}   ${ms}ms`)
  const after = await health(port)
  say(`判定计数：${after?.stats?.judged ?? '?'}（请求前 ${up.stats.judged}）`)
  if (response.status !== 200) {
    say('上游返回了错误，原文片段：')
    say(text.slice(0, 600))
    return 1
  }
  const preview = text.split('\n').filter((line) => line.startsWith('data:')).join('\n').slice(0, 800)
  say('流片段：')
  say(preview)
  say('')
  say('这条能跑通，说明 Claude Code Desktop 也能跑通——它用的是同一条路。')
  return 0
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const [, , command = 'status', ...rest] = process.argv
  const { flags, rest: positional } = parseArgs(rest)
  const home = typeof flags.home === 'string' ? flags.home : undefined

  switch (command) {
    case 'serve': return cmdServe(flags, home)
    case 'start': return cmdStart(flags, home)
    case 'stop': return cmdStop(home)
    case 'install': return cmdInstall(flags, home)
    case 'uninstall': return cmdUninstall(flags, home)
    case 'on': return cmdToggle(true, home)
    case 'off': return cmdToggle(false, home)
    case 'plugin': return cmdPlugin(positional, flags, home)
    case 'panel': return cmdPanel(flags, home)
    case 'statusline': return cmdStatusline(home)
    case 'show': showPanel(home); return 0
    case 'set': return setConfig(positional, home)
    case 'direct': return cmdDirect(flags, home)
    case 'undirect': return cmdUndirect(home)
    case 'status': return cmdStatus(home)
    case 'log': return cmdLog(flags, home)
    case 'prompt': return cmdPrompt(flags, positional, home)
    case 'probe': return cmdProbe(flags, home)
    case 'config': {
      const config = loadConfig(home)
      say(JSON.stringify(config, null, 2))
      return 0
    }
    case 'help':
    case '--help':
    case '-h': {
      say('feibi-cc <命令>')
      say('  plugin    install|uninstall|status   装成 Claude Code 插件（hook 形态，推荐）')
      say('  show      在终端打印设置面板（状态 + 开关 + 最近判定）')
      say('  set       改配置，例：feibi-cc set strictness=max retryMax=3')
      say('  panel     打开网页设置面板（浏览器，本机 127.0.0.1）')
      say('  statusline 打印状态条那一行（给 settings.json 用）')
      say('  direct    旁路中间层，直连一个确定能用的端点（--upstream --key --model）')
      say('  undirect  撤销直连，env 还原')
      say('  install   接管 settings.json 并初始化（代理形态；--port --upstream --autostart --memory）')
      say('  uninstall 还原一切')
      say('  on|off    只切流量')
      say('  start     后台跑代理     stop  停掉')
      say('  serve     前台跑代理（--quiet）')
      say('  status    状态总览')
      say('  prompt    show|path|set <文件>|edit|reset')
      say('  log       判定流水（--n 20）')
      say('  probe     真发一条最小请求验证链路')
      say('  config    打印生效配置')
      return 0
    }
    default:
      process.stderr.write(`未知命令：${command}。feibi-cc help 看用法。\n`)
      return 1
  }
}

main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}\n`)
  process.exitCode = 1
})
