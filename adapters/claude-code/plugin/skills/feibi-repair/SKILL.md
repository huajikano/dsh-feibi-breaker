---
name: feibi-repair
description: 菲比破限出问题时用它自查自修：链路断了、模型不可用、破限没效果、会话报错。用 feibi-cc 的 doctor / ensure / models / set 定位并修好。
---

# 修好菲比破限

用户说「破限没效果」「连不上」「一直被拒」「会话用不了」「模型不可用」时，按这个顺序做，
**每一步都把命令输出原样贴出来**，别自己解释。

## 1. 先体检

```bash
feibi-cc doctor
```

输出是一张表，六项：代理进程 / 入口接管 / 上游密钥 / 模型名改写 / 注入判定改锚 / 最近流量。
哪项是 ✗ 就对应下面一章。

## 2. 按 ✗ 的那一项处理

| 症状 | 含义 | 修法 |
| --- | --- | --- |
| `代理进程 ✗` | 本地代理没跑，客户端发的请求没人接 | `feibi-cc start`（带看门狗，被杀会自己回来） |
| `入口接管 ✗` | `settings.json` 的 `ANTHROPIC_BASE_URL` 被别的工具改回直连了 | `feibi-cc ensure` |
| `上游密钥 ✗` | settings 里没有 `ANTHROPIC_API_KEY` | 面板里填，或 `feibi-cc bypass --key sk-…` |
| `模型名改写 ✗` | 当前改写目标不在上游可用列表里（最常见的 404 来源） | `feibi-cc models` 看可用项，再 `feibi-cc set forceModel=<可用的名字>` |
| `注入/判定/改锚 ✗` | 有人把开关关了 | `feibi-cc set inject=true guard=true rewriteIdentity=true identityGuard=true` |
| `最近流量 ✗` | 代理活着但没请求进来，客户端绕过了 env | 重启 Claude Code Desktop（env 只在启动时读一次）；桌面版还要确认 CC Switch 的上游指向本代理 |

一次全修：

```bash
feibi-cc doctor --fix
```

## 3. 换模型

```bash
feibi-cc models        # 列出上游真实可用的模型（✓ 能用 / ✗ 上游说不可用）
feibi-cc set forceModel=deepseek-v4.1-flash
```

注意：上游的 `/v1/models` 会列出**这个 key 用不了**的模型。只选 ✓ 的。

## 4. 关代理也要能用

```bash
feibi-cc bypass        # 入口切成上游直连（会同时写三档模型别名，避免 claude-* 404）
feibi-cc resume        # 回到代理
```

关代理后：CLI 直接可用；**桌面版**还要求 CC Switch 的 provider 里 Sonnet/Opus/Haiku 三档
填上游认得的模型名，否则它仍会发 `claude-sonnet-5`。

## 5. 硬性约束

- 不要手改 `~/.claude/feibi/config.json` 里的 `port` / `upstream` 之外的键，用 `feibi-cc set`
- 不要删 `payload/` 或 `vendor/`，那是内置规则
- 每次改完跑一次 `feibi-cc doctor`，确认表全绿再告诉用户"好了"

## 6. 什么时候不该硬修

用户问的是「为什么」而不是「修好」时，只跑 `feibi-cc doctor` 和三处日志
（`~/.claude/feibi/proxy.log`、`events.jsonl`、`plugin-events.jsonl`），把证据贴出来，
不要擅自改配置。
