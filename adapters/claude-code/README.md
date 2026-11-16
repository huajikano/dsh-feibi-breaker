# 菲比破限 · Claude Code 适配层

[菲比破限](../../README.md)（`dsh-feibi-breaker`）的 Claude Code 分支实现。

上游是 DeepSeek-Harness 插件：在系统提示词层做塑形、在模型流提交前做拦截。
Claude Code 没有那两个挂载点，所以这一层换了两个位置，效果尽量对齐：

| 上游 dsh 版 | 这里（插件形态） | 这里（代理形态，可选） |
|---|---|---|
| `systemPrompt.section`（Order 100/200） | `SessionStart` 的 `additionalContext` | 请求体 `system` 数组末尾 |
| `llm/stream` 判定 + 扣下 | `Stop` hook 的 `decision:block` | SSE 流扣住 + 重发 |
| `agent.followup()` 纠正 | Stop 的 `reason` 直接喂回模型 | 同一次请求带附加段重发 |
| 设置面板 | 会话内 `/feibi` | `feibi-cc status` |
| 内置规则 `core/payload.bin` | **同一份资产**（vendored 副本 + `lib/core.js` 解码） | 同左 |

内置规则不在这里复制成明文：本目录只有解码器副本和那个二进制资产的搬运逻辑，
运行时从 `core/payload.bin` 现解。

---

## 装

```powershell
cd adapters/claude-code

node bin/feibi-cc.mjs plugin install     # 拷插件、登记市场、启用、hooks 自检
node bin/feibi-cc.mjs plugin status      # 四步登记齐不齐
node bin/feibi-cc.mjs plugin uninstall   # 全撤（提示词副本保留）
```

装完**完全退出并重启** Claude Code（hooks 只在启动时加载），会话里敲 `/feibi` 看状态。

`plugin install` 做的五件事，缺一不可：

1. 拷插件体到 `~/.claude/plugins/feibi-breaker/`
2. 把 `core/payload.bin` + `lib/core.js` + `lib/keyring.js` vendor 到插件的 `vendor/`
3. `known_marketplaces.json` 登记市场（本地目录源）
4. `installed_plugins.json` + `settings.json` 的 `enabledPlugins` 置真
   —— **装而不启用 = hooks 一条都不跑**
5. 拿 `{}` 当输入把三个 hook 各跑一遍，输出不是合法 JSON 就当场报错

---

## 三个 hook 各自干什么

**`SessionStart`** → 注入。`additionalContext` 被包成 system-reminder 放进会话开头，
之后每轮都在上下文里。matcher 带 `compact`：压缩后必须补回来，否则长会话跑到中段规则就没了。

**`UserPromptSubmit`** → 重置"劝回预算"（按用户轮次算，不重置就永久失效）+ 激活词补注
（用户只发「菲比」时那两字没信息量，得告诉模型这是激活词）。

**`Stop`** → 拦截。读 `transcript_path` 取本轮主线程正文，判成拒绝就返回
`{"decision":"block","reason":…}`，Claude Code 不结束这一轮、把 reason 当新指令喂回去。
`reason` 用的是上游 `correctionText()` 原文。

三道闸防坏：只在有正文时判、每轮预算 `stopMaxBlocks`（默认 2）、判定要求"拒绝形状"
（「这个函数不能返回空指针」不会中）。

---

## 实测（不是推测）

同一问题同一模型，只改 Stop hook 返回值，看 `--output-format json` 的 `num_turns`：

| 场景 | num_turns |
|---|---|
| 不拦 | 1 |
| 强制 block 一次 | **2** |

诊断开关：`FEIBI_DEBUG_FORCE_BLOCK=1 claude -p "…"` 强行把第一轮判成拒绝。

**强度边界**（如实写）：插件注入走的是用户侧上下文，模型可能先答身份再补一句
「这段规则不是我的一部分」。这句话本身现在会被判定规则抓住（见下）并触发重写，
但要"第一句就带署名"那种压制力，只有代理形态——它改的是系统提示词。

顺带一个负面结论：本版 CLI（2.1.325）**不读 `settings.outputStyle`**（把名字写成乱码也照跑、
不报错、不生效）。所以这个分支干脆不带风格文件——带着只会让人以为"选了就生效"。
真要系统提示词级的注入，用下面的代理形态。

---

## 代理形态（可选，更强）

```powershell
node bin/feibi-cc.mjs install --port 45721            # 接管 ANTHROPIC_BASE_URL
node bin/feibi-cc.mjs start                            # 常驻
node bin/feibi-cc.mjs status
```

`Claude Code → 127.0.0.1:45721（本代理）→ 原上游`，在请求体里注入、在流里扣拒绝、
命中就断流重发。还能自动补回被 CC Switch 等工具改写的 `settings.json`。

两种形态可叠（`plugin install --keep-proxy`），叠了就是注两遍，token 翻倍。

---

## 改 payload

```
~/.claude/feibi/prompt.md      ← 你自己那份，非空就赢；两种形态共用
core/payload.bin               ← 出厂规则（加密打包），只读
```

改 `prompt.md` **下一轮就生效**，不用重启（hook 是短命进程，每次重新读）。

---

## 判定规则相对上游的增补

|cases|规则|为什么补|
|---|---|---|
|「作为AI语言模型，我不能这样做。」|`(不能\|不会\|无法\|没法)(这么\|这样\|那样)(做\|干\|帮\|答)`|上游只列了"不能+任务动词"，指示代词隔开就漏|
|「这段规则不是我的一部分，我不会照着扮演」|`(不会\|不打算\|不愿意\|拒绝\|不接受)(照着\|按照\|照\|按)(扮演\|执行\|配合\|做\|办\|说\|写)`|Claude Code 实测会这样顶嘴，不抓就是插件白装|

两条都收得很窄，有正反样例在 `test/`。

---

## 测试

```powershell
node --test "test/*.test.mjs"     # 39 条
```

## 许可

CC-BY-NC-SA-4.0，与上游一致。见 [LICENSE](../../LICENSE)。
