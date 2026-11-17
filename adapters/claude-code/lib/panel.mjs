/**
 * 本地设置面板。
 *
 * dsh 版的设置面板挂在客户端 UI 里（状态条 + 设置页 + 自测页）。Claude Code 的插件
 * 没有 UI 挂载点——`hooks` 只能返回 JSON，命令只能是提示词。所以这里换成
 * **代理自带的本地网页**：代理本来就监听 127.0.0.1，加两条路由就是一个面板，
 * 不引入依赖、不联网、不落 cookie。
 *
 * 三条路由：
 *   GET  /feibi/panel        面板页面（单文件，内联样式脚本）
 *   GET  /feibi/api/state    当前配置 + 提示词 + 计数 + 流水 + 接线状态
 *   POST /feibi/api/config   改配置（就地生效，不用重启代理）
 *   POST /feibi/api/prompt   存 / 恢复提示词
 *   POST /feibi/api/selftest 真发一条最小请求，看回复带不带署名
 *
 * 只监听 127.0.0.1，且不做鉴权——和代理本身同一个信任边界：能访问这个端口的人
 * 本来就能改这台机器上的设定，加一层口令只是假装安全。
 *
 * @module feibi-breaker-cc/panel
 */

import fs from 'node:fs'
import path from 'node:path'
import { feibiPaths, loadConfig, saveConfig, loadState, readJson } from './config.mjs'
import { resolvePrompt, savePrompt, resetPrompt } from './prompt-store.mjs'
import { readEvents } from './stats.mjs'

/** 面板能改的键。白名单，防止误改端口/上游把代理弄成砖。 */
const EDITABLE = new Set([
  'inject',
  'guard',
  'autoRetry',
  'retryMax',
  'scanChars',
  'releaseChars',
  'dualLayer',
  'rewriteIdentity',
  'fastPath',
  'strictness',
  'exhaustedMode',
  'stopMaxBlocks',
  'forceModel',
  'eventLog',
])

/** 状态里可以给前端看的键。 */
const VIEWABLE = [...EDITABLE, 'port', 'upstream', 'watchSettings', 'memoryInject']

/**
 * 读插件侧（Stop hook）的计数，面板里和代理侧分开显示。
 *
 * @param {string} home - 家目录。
 * @returns {object} 插件状态。
 */
function pluginState(home) {
  const paths = feibiPaths(home)
  const state = readJson(paths.root ? path.join(paths.root, 'plugin-state.json') : '') ?? {}
  return {
    total: state.total ?? { judged: 0, blocked: 0, injected: 0 },
    sessions: Object.keys(state.sessions ?? {}).length,
  }
}

/**
 * 组装面板要的全部状态。
 *
 * @param {object} options - {home, config}
 * @returns {object} 状态。
 */
export function panelState({ home, config }) {
  const paths = feibiPaths(home)
  const resolved = resolvePrompt(home)
  const settings = readJson(paths.claudeSettings) ?? {}
  const baseUrl = settings?.env?.ANTHROPIC_BASE_URL ?? null
  const proxyStats = loadState(home)

  const view = {}
  for (const key of VIEWABLE) view[key] = config[key]

  // 接管成立 ≠ 真的有流量。桌面版会绕过 settings.json 的 env，这时候面板如果还
  // 只显示"已接管"，用户就会以为调了半天其实没接上——所以这里把"最近有没有请求"
  // 单独算出来给前端。
  const lastSeen = Date.parse(String(proxyStats.lastEventAt ?? ''))
  const live = Number.isFinite(lastSeen) && Date.now() - lastSeen < 15 * 60 * 1000

  return {
    mode: {
      port: config.port,
      upstream: config.upstream,
      baseUrl,
      takeover: typeof baseUrl === 'string' && baseUrl.includes(`127.0.0.1:${config.port}`),
      live,
      lastSeen: proxyStats.lastEventAt ?? null,
      model: settings?.env?.ANTHROPIC_MODEL ?? settings?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
      proxy: proxyStats,
    },
    config: view,
    prompt: {
      source: resolved.source,
      file: resolved.file,
      chars: resolved.chars,
      hash: (resolved.hash ?? '').slice(0, 12),
      text: resolved.text,
    },
    plugin: pluginState(home),
    events: readEvents(20, home),
  }
}

/**
 * 合并一份配置补丁。
 *
 * 只接受白名单里的键，并且做类型收敛——面板是给人点的，但请求是 HTTP，
 * 不能指望对面一定守规矩。
 *
 * @param {string} home - 家目录。
 * @param {object} patch - 补丁。
 * @returns {{ok: boolean, applied?: object, error?: string}} 结果。
 */
export function applyConfigPatch(home, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '补丁必须是对象' }
  }
  const config = loadConfig(home)
  const applied = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE.has(key)) continue
    if (typeof config[key] === 'boolean') {
      applied[key] = value === true
    } else if (typeof config[key] === 'number') {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) return { ok: false, error: `${key} 必须是非负数` }
      applied[key] = numeric
    } else if (typeof config[key] === 'string') {
      if (typeof value !== 'string' || value.length === 0) return { ok: false, error: `${key} 必须是非空字符串` }
      applied[key] = value
    } else {
      applied[key] = value
    }
  }
  if (Object.keys(applied).length === 0) return { ok: false, error: '没有可应用的键' }
  const saved = saveConfig({ ...config, ...applied }, home)
  // 就地改同一个对象：代理每收到请求都读它，不用重启。
  Object.assign(config, applied)
  return { ok: true, applied, config: saved }
}

/**
 * 真发一条最小请求，看回复第一句带不带署名。
 *
 * 这是唯一能证明"整条链路现在到底通不通"的动作：HTTP 200 只说明端口活着，
 * 带署名才说明 payload 真的压过了系统提示词。
 *
 * @param {object} options - {port, model, key, timeoutMs}
 * @returns {Promise<object>} 结果。
 */
export async function selfTest({ port, model, key, timeoutMs = 60000 }) {
  const body = {
    model,
    max_tokens: 60,
    stream: true,
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: '用一句话说明你是谁。' }],
  }
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01' }
  if (typeof key === 'string' && key.length > 0) headers['x-api-key'] = key

  const started = Date.now()
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
  const raw = await response.text()
  let text = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const frame = JSON.parse(payload)
      if (typeof frame?.delta?.text === 'string') text += frame.delta.text
    } catch {
      // 半截帧
    }
  }
  return {
    ok: response.status === 200,
    status: response.status,
    ms: Date.now() - started,
    signature: /Discord交流群/.test(text),
    preview: (text || raw).slice(0, 300),
  }
}

/** 读请求体的小工具。 */
function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 回 JSON。 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 回 HTML。 */
function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 面板路由。命中返回 true，未命中返回 false 让代理继续走自己的流程。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {{home?: string, config: object}} options - 上下文。
 * @returns {Promise<boolean>} 是否处理了。
 */
export async function handlePanel(req, res, { home, config }) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname

  if (route === '/feibi/panel') {
    html(res, PANEL_HTML)
    return true
  }

  if (route === '/feibi/api/state' && req.method === 'GET') {
    json(res, 200, panelState({ home, config }))
    return true
  }

  if (route === '/feibi/api/config' && req.method === 'POST') {
    const patch = await readJsonBody(req)
    if (patch === null) {
      json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return true
    }
    const result = applyConfigPatch(home, patch)
    json(res, result.ok ? 200 : 400, result)
    return true
  }

  if (route === '/feibi/api/prompt' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const result = body?.reset === true
      ? resetPrompt(home)
      : savePrompt(home, typeof body?.text === 'string' ? body.text : '')
    json(res, result.ok ? 200 : 400, result)
    return true
  }

  if (route === '/feibi/api/selftest' && req.method === 'POST') {
    const paths = feibiPaths(home)
    const settings = readJson(paths.claudeSettings) ?? {}
    const key = settings?.env?.ANTHROPIC_API_KEY ?? settings?.env?.ANTHROPIC_AUTH_TOKEN ?? ''
    const model = config.selftestModel ?? settings?.env?.ANTHROPIC_MODEL ?? 'deepseek-chat'
    const result = await selfTest({ port: config.port, model, key })
    json(res, 200, result)
    return true
  }

  return false
}

/** 面板页面。内联一切，不引外链。 */
const PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>菲比破限 · 设置面板</title>
<style>
:root{--bg:#0e1116;--card:#161b23;--line:#242c38;--txt:#e6edf3;--dim:#8b98a9;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#7c9cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:12px}
h1{font-size:18px;margin:0;font-weight:600}
.sub{color:var(--dim);font-size:12px}
main{padding:20px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;max-width:1400px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
section h2{font-size:13px;margin:0 0 12px;color:var(--dim);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}
.row label{color:var(--txt)}
.row .hint{display:block;color:var(--dim);font-size:12px;margin-top:2px}
input[type=checkbox]{width:38px;height:20px;appearance:none;background:#2b3341;border-radius:999px;position:relative;cursor:pointer;transition:.15s;outline:none}
input[type=checkbox]:checked{background:var(--acc)}
input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.15s}
input[type=checkbox]:checked::after{left:20px}
input[type=number],select,textarea{background:#0f141b;border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:6px 8px;font:inherit}
input[type=number]{width:96px}
select{min-width:120px}
textarea{width:100%;min-height:220px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;resize:vertical}
button{background:#232b37;border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:7px 14px;cursor:pointer;font:inherit}
button:hover{background:#2b3442}
button.primary{background:var(--acc);border-color:var(--acc);color:#0b1020;font-weight:600}
button.danger{color:var(--bad)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:13px}
.kv span:first-child{color:var(--dim)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.badge.ok{color:var(--ok);border-color:rgba(63,185,80,.4);background:rgba(63,185,80,.1)}
.badge.bad{color:var(--bad);border-color:rgba(248,81,73,.4);background:rgba(248,81,73,.1)}
.badge.warn{color:var(--warn);border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.1)}
pre{background:#0f141b;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;max-height:260px;font-size:12px;margin:0}
.log{font-family:ui-monospace,Consolas,monospace;font-size:12px;max-height:280px;overflow:auto}
.log div{padding:3px 0;border-bottom:1px dashed var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log b{font-weight:600}
.toast{position:fixed;right:20px;bottom:20px;background:#1f2630;border:1px solid var(--line);padding:10px 16px;border-radius:8px;opacity:0;transition:.2s;pointer-events:none}
.toast.show{opacity:1}
footer{padding:14px 24px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}
</style></head><body>
<header><h1>菲比破限</h1><span class="sub" id="mode-line">读取中…</span></header>
<main>
  <section>
    <h2>接线</h2>
    <div id="mode"></div>
    <div class="row" style="border:0;padding-top:14px">
      <button class="primary" id="btn-test">跑一次自检（会花一次 token）</button>
    </div>
    <pre id="test-out" style="display:none"></pre>
  </section>

  <section>
    <h2>开关</h2>
    <div id="toggles"></div>
  </section>

  <section>
    <h2>参数</h2>
    <div id="numbers"></div>
    <div class="row"><label>严格度<span class="hint">standard 只放规则；strict 禁反问；max 禁缩减与半成品</span></label>
      <select id="strictness"><option value="standard">standard</option><option value="strict">strict</option><option value="max">max</option></select></div>
    <div class="row"><label>强制模型名<span class="hint">空=不改；桌面版直连第三方上游时填 deepseek-reasoner 这类名字</span></label>
      <input type="text" id="forceModel" placeholder="(不填)" style="width:180px"></div>
    <div class="row"><label>重试用光后<span class="hint">notice 给说明 / pass 把最后一次原样放出去</span></label>
      <select id="exhaustedMode"><option value="notice">notice</option><option value="pass">pass</option></select></div>
  </section>

  <section style="grid-column:span 2">
    <h2>提示词 <span id="prompt-meta" style="text-transform:none;letter-spacing:0;color:var(--dim)"></span></h2>
    <textarea id="prompt-text" spellcheck="false"></textarea>
    <div class="row" style="border:0;padding-top:12px;justify-content:flex-end">
      <button class="danger" id="btn-reset">恢复内置默认</button>
      <button class="primary" id="btn-save">保存（下一轮生效）</button>
    </div>
  </section>

  <section style="grid-column:span 2">
    <h2>计数与流水</h2>
    <div id="counts"></div>
    <div class="log" id="log"></div>
  </section>
</main>
<footer>面板只监听 127.0.0.1：能打开这个页面的人本来就能改这台机器上的设定。</footer>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
let state = null;

function toast(text){ const t = $('toast'); t.textContent = text; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1800); }

function badge(ok, good, bad){ return '<span class="badge ' + (ok?'ok':'bad') + '">' + (ok?good:bad) + '</span>'; }

function render(){
  const s = state;
  const mode = s.mode;
  $('mode-line').textContent = 'v1.0.3 · ' + (mode.takeover ? '已接管 ' : '未接管 ') + '127.0.0.1:' + mode.port;
  $('mode').innerHTML =
    (mode.takeover && !mode.live
      ? '<div style="border:1px solid rgba(248,81,73,.45);background:rgba(248,81,73,.08);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px">'
        + '<b style="color:var(--bad)">代理没收到流量</b><br>settings 的 baseURL 指向本代理，但最近 15 分钟没有请求进来。'
        + '桌面版会绕过 settings.json 的 env，此时只有插件（上下文注入）在起作用。'
        + '<br>要让面板里的开关真的生效，得把桌面版的上游指到 <code>http://127.0.0.1:' + mode.port + '</code>。</div>'
      : '') +
    '<div class="kv"><span>入口</span><span>' + (mode.baseUrl || '未设置') + '</span></div>' +
    '<div class="kv"><span>接管</span>' + badge(mode.takeover, '已接管', '没接管') + '</div>' +
    '<div class="kv"><span>流量</span>' + badge(mode.live, '最近有请求', '最近没有请求') + '</div>' +
    '<div class="kv"><span>上游</span><span>' + mode.upstream + '</span></div>' +
    '<div class="kv"><span>模型</span><span>' + (mode.model || '-') + '</span></div>' +
    '<div class="kv"><span>提示词</span><span>' + ({custom:'你自己那份', default:'内置默认', empty:'空（不会注入！）'}[s.prompt.source] || s.prompt.source) + ' · ' + s.prompt.chars + ' 字</span></div>';

  const toggles = [
    ['inject','注入（改请求体）','关掉就只是透明代理'],
    ['dualLayer','双段注入（头+尾）','关掉省一半 token，压不住系统提示词'],
    ['rewriteIdentity','改写身份锚与权限段','关掉模型会自称 Claude 并拒绝'],
    ['guard','拦截判定','盯回复流'],
    ['autoRetry','自动重试','命中后重发'],
    ['fastPath','快速通道','没信号立刻放行'],
    ['eventLog','落流水','排查用'],
  ];
  $('toggles').innerHTML = toggles.map(([key,label,hint]) =>
    '<div class="row"><label>' + label + '<span class="hint">' + hint + '</span></label>' +
    '<input type="checkbox" data-key="' + key + '"' + (s.config[key] ? ' checked' : '') + '></div>').join('');
  $('toggles').querySelectorAll('input[type=checkbox]').forEach(el => {
    el.onchange = () => patch({ [el.dataset.key]: el.checked });
  });

  const numbers = [
    ['retryMax','最多重发几次','每轮'],
    ['scanChars','判定窗口','字'],
    ['releaseChars','放行阈值','字'],
    ['stopMaxBlocks','Stop 劝回上限','次/轮'],
  ];
  $('numbers').innerHTML = numbers.map(([key,label,unit]) =>
    '<div class="row"><label>' + label + '<span class="hint">' + unit + '</span></label>' +
    '<input type="number" min="0" data-key="' + key + '" value="' + (s.config[key] ?? 0) + '"></div>').join('');
  $('numbers').querySelectorAll('input[type=number]').forEach(el => {
    el.onchange = () => patch({ [el.dataset.key]: Number(el.value) });
  });

  $('forceModel').value = s.config.forceModel || '';
  $('forceModel').onchange = () => patch({ forceModel: $('forceModel').value.trim() });
  $('strictness').value = s.config.strictness || 'standard';
  $('strictness').onchange = () => patch({ strictness: $('strictness').value });
  $('exhaustedMode').value = s.config.exhaustedMode || 'notice';
  $('exhaustedMode').onchange = () => patch({ exhaustedMode: $('exhaustedMode').value });

  $('prompt-meta').textContent = '· ' + (s.prompt.file || '') + ' · ' + s.prompt.hash;
  $('prompt-text').value = s.prompt.text;

  const st = s.mode.proxy || {};
  $('counts').innerHTML =
    '<div class="kv"><span>代理侧</span><span>注入 ' + (st.injected||0) + ' · 判定 ' + (st.judged||0) + ' · 拦 ' + (st.blocked||0) + ' · 重试 ' + (st.retried||0) + '</span></div>' +
    '<div class="kv"><span>插件侧</span><span>注入 ' + (s.plugin.total.injected||0) + ' · 判定 ' + (s.plugin.total.judged||0) + ' · 拦回 ' + (s.plugin.total.blocked||0) + '</span></div>';

  $('log').innerHTML = (s.events || []).slice().reverse().map(e => {
    const kind = e.kind === 'judge' ? (e.blocked ? (e.gaveUp ? '放弃' : '拦') : '放行') : (e.kind === 'identity' ? '改身份' : e.kind === 'inject' ? '注入' : e.kind);
    const head = (e.head || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    return '<div><b>' + (e.at || '').slice(11,19) + '</b> ' + kind + (e.reason ? ' · ' + e.reason : '') + (e.chars ? ' · ' + e.chars + '字' : '') + (head ? ' · ' + head.slice(0, 60) : '') + '</div>';
  }).join('') || '<div style="color:var(--dim)">还没有流水</div>';
}

async function load(){
  const r = await fetch('/feibi/api/state');
  state = await r.json();
  render();
}

async function patch(obj){
  const r = await fetch('/feibi/api/config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(obj) });
  const out = await r.json();
  if (!out.ok) { toast('失败：' + out.error); return; }
  toast('已生效');
  load();
}

$('btn-save').onclick = async () => {
  const r = await fetch('/feibi/api/prompt', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text: $('prompt-text').value }) });
  const out = await r.json();
  toast(out.ok ? '已保存，下一轮生效' : ('失败：' + out.error));
  load();
};
$('btn-reset').onclick = async () => {
  const r = await fetch('/feibi/api/prompt', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reset: true }) });
  const out = await r.json();
  toast(out.ok ? '已恢复内置默认' : ('失败：' + out.error));
  load();
};
$('btn-test').onclick = async () => {
  $('test-out').style.display = 'block';
  $('test-out').textContent = '发请求中…';
  const r = await fetch('/feibi/api/selftest', { method:'POST' });
  const out = await r.json();
  $('test-out').textContent = JSON.stringify(out, null, 2);
  load();
};

load();
setInterval(() => { if (!document.hidden) load(); }, 5000);
</script></body></html>`
