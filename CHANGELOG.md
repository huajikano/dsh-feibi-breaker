# 变更记录 / Changelog

## 1.2.0 — 适配 DSH 0.2.2-rc.5，安装器不再破坏其他插件

### 破坏性变更

- **`engines.dsh` 改为 `>=0.2.1-0 <0.3.0`。** `^0.2.2` 在 semver 里把 `0.2.2-rc.5` 排除在外（预发布排序在发布版之前），宿主会直接 `skipping profile bundle`，插件根本不会装载。低于 0.2.1 的 DSH 会被兼容性检查拦下。
- **安装方式改为 bundle 模式。** 插件在 profile 里由 `dsh.profile.bundles` 装载；profile 的 `cordis.patch.yml` 只保留 `- id: feibi-breaker` 的**配置覆盖**行。不要再写 `- insert:` —— DSH 0.2.x 不去重，两行会挂载两个实例。
- **安装器不再写 `- id: system-prompt`。** 这个全局覆盖（`includeHarnessIdentity: false` + `personaPrefix: ''`）会作用于整个 profile 的每个 agent，并与 preset 的 persona、其他插件的身份段冲突。需要的话请自行在 profile patch 里写。

### 修复：安装器会把其他插件一起弄坏

1. **不再在 profile 里跑 `pnpm install`。** 1.1.0 用 `--config.confirmModulesPurge=false` 等于自动同意「清空 `node_modules` 重装」；lockfile 与 manifest 一旦失配，重装失败就留下一个只剩本插件链接的空壳，其他插件全部解析不到。1.2.0 只写一个 `link:` 依赖、一个 bundle 条目、一个 `node_modules` 目录联接（`fs.symlinkSync(..., 'junction')`，不经过 `cmd` 引号解析，中文/空格路径安全），完全不碰包管理器。
2. **删除 `scripts/lib/patcher.js` 与 `scripts/ensure-runtime.ps1`。** 前者会改写宿主 `@deepseek-ai/dsh-agent-instructions/lib/index.js`，兜底正则把 `filter(section => …)` 换成 `filter(section => true)`；一旦命中就是改共享 inode/宿主安装，所有插件的提示词一起坏。0.2.x 下它只是「没命中」，但留着就是定时炸弹。
3. **默认不写快照目录。** `-Profile` 参数在 1.1.0 里根本没被读取，装机会写进**所有** profile，包括 `desktop-backup-*`。
4. **零输入。** `.bat` 里没有 `set /p`、没有 `pause`；profile 由 `--profile` → `$DSH_PROFILE` → 唯一 profile → 所有活动 profile 的顺序决定。`.bat` 本身是纯 ASCII + CRLF（cmd 按 GBK 解析 UTF-8 中文行会把它切碎）。
5. **新增 `tools/repair-node-modules.ps1`。** 只改名不删除：从旧的 `node_modules.*` 快照恢复，并按 `link:` spec 重建被 pnpm 拼坏的链接（`<profile>\D:\...` 这种目标）。

### 适配 0.2.2-rc.5 的宿主契约

| 位置 | 变更 |
| --- | --- |
| `lib/preview.js` | `PREVIEW_PATH` 从 `/api/dsh-gatekeeper/preview` 改回 `/api/feibi-breaker/preview`（宿主按精确路径分派，之前预览面板永远 404「已断开」） |
| `lib/projection.js` | 会话身份改从 projection `init(header).id` 取（提交的 `assistant/message` 没有 `sessionId`，之前拦截判定永远进不了徽章）；`STATE_VERSION` 4 → 5；无变化时返回同一引用 |
| `lib/index.js` | `sessionProjections.register()` 现在返回可调用 thenable，改成「同步 disposer + 异步取 handle + `handle.dispose()`」，不再走废弃路径；路由注册逐条 `try/catch` 且 `connected` 先置位（之前一条抛错就死循环重试）；自测路由改成 provider 与 model 都必须存在 |
| `lib/refusal-retry.js` | `'user/message'` 不是宿主事件（是 SessionEvent）→ 改听 `'session/event'`，且只认 `source.kind === 'user'`，否则纠正消息会重置预算造成死循环 |
| `lib/self-test.js` | 一次性探测消息去掉 `id`/`source`（`RequestUserInput` 里是 `never`），补 `signal`（120s 上限 + 插件生命周期） |
| `lib/stream.js` | 0.2.2-rc.3 起拒答走 `CONTENT_REFUSED` 错误码且没有正文，guard 把它当成一次拒答扣下，不再让整轮失败 |
| `client.js` | 7 处 `window.location.origin` → `__DSH_TRANSPORT__.streamBaseUrl ?? document.baseURI`（桌面载体页面与 Host 不同源） |
| `package.json` | 新增 `engines.dsh`、`exports["./icon"]`、`exports["./locale/*.json"]`、`files` 清单 |
| `locale/`、`icon.svg` | 新增：插件管理页的标题、描述与图标 |

### 测试

- `test/` 共 **191 条**（原 193 条中 21 条针对已删除的安装器实现，替换为 13 条新的安装器测试 + 6 条适配测试）。
- 新增 `tools/check-install.mjs`：验收 patch 行数、bundle 选中、链接目标、`engines.dsh` 兼容性，以及**profile 里每个依赖是否还能解析**（1.1.0 从不检查最后这条）。
- 新增 `tools/client-smoke.cjs`：在 `__ModuleLoader__` ABI 下验证客户端模块注册与两个 slot。

### 已知限制

- `@norman-else/dsh-claude` 等需要联网解析的插件，只能通过 DSH 插件管理页安装；`desktop` 是 Electron 独占管理的 profile，CLI 会拒绝 `dsh plugin --profile desktop`。
- 状态条只表示插件已装载；实际回复仍受所选模型、其他提示词与 DSH 版本影响。

## 1.1.0

- 合并「菲比破限」与「闸总」：提示词塑形 + 提交前拦截 + 状态条 + 待审区。
- 提示词落在 `$DSH_HOME/feibi-prompt.md`，可改可恢复。
- 自测：用当前模型真跑探测。
