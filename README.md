# 菲比破限 / feibi-breaker

> 一个 DeepSeek-Harness 本地插件：在系统提示词层做塑形，在模型流提交前做拦截，并在输入框上方用一条状态条报告实际发生了什么。
>
> 插件标识：`feibi-breaker`　版本：`1.2.0`　适配：DSH **0.2.2-rc.5**（`engines.dsh: >=0.2.1-0 <0.3.0`）　许可：CC-BY-NC-SA-4.0
>
> 为什么不是 `^0.2.2`：semver 把 `0.2.2-rc.5` 排在 `0.2.2` **之前**，`^0.2.2` 的下界会把它排除，bundle 直接被宿主跳过（`skipping profile bundle "feibi-breaker": requirements {"engines.dsh":"^0.2.2"}`）。带预发布的声明必须写成 `>=0.2.1-0 <0.3.0`。

---

## 1.2.0 做了什么

这一版是给 DSH 0.2.x 的适配版，同时修掉 1.1.0 安装器会把**其他插件一起弄坏**的问题。两件事都要说清楚，因为它们是同一套假设的两个后果。

### 1.2.0 适配的宿主契约（0.2.2-rc.5）

| 位置 | 1.1.0 的写法 | 0.2.2 的现实 | 1.2.0 |
| --- | --- | --- | --- |
| `lib/preview.js` | `PREVIEW_PATH = '/api/dsh-gatekeeper/preview'`（闸总残留） | 宿主按**精确路径**分派，客户端连的是 `/api/feibi-breaker/preview` | 路径改对，两条路由一致；预览面板不再永远「已断开」 |
| `lib/projection.js` | `sessionId` 从 `event.data.sessionId` 读 | 提交的 `assistant/message` **没有** `sessionId` | 从 projection `init(header)` 的 `header.id` 取，`STATE_VERSION` 4 → 5 |
| `lib/index.js` | `ctx.effect(() => p.register(def))` | `register()` 返回**可调用 thenable**（已废弃用法） | 同步 disposer + 异步取 `handle`，`handle.dispose()` 释放 |
| `lib/refusal-retry.js` | 监听 `'user/message'` | 那是 SessionEvent，不是宿主事件 | 改听 `'session/event'`，且只认 `source.kind === 'user'` |
| `lib/self-test.js` | 一次性消息带 `id` + 自定义 `source.kind` | `RequestUserInput` 的这两个字段是 `never` | 只发 `{ role, content }`，并补 `signal`（120s 上限 + 插件生命周期） |
| `lib/index.js` | 自测路由 `provider \|\| model` 任一存在就放行 | 路由缺一半时每条探测都失败 | 改成两者都必须存在，否则 409 早退 |
| `lib/index.js` | 路由注册一条抛错就中断整轮 | 重复精确路径会**同步抛**，重试定时器原地死循环 | 逐条 `try/catch`，`connected` 先置位 |
| `client.js` | 全部用 `window.location.origin` | 桌面载体的页面与 Host 不同源 | 统一走 `__DSH_TRANSPORT__.streamBaseUrl ?? document.baseURI` |
| `package.json` | 无 `engines`、`locale/` 空 | 兼容性检查与插件管理页读这两处 | 加 `engines.dsh`、`locale/{en,zh}.json`、`icon.svg` |

顺带：`stop_reason: "refusal"` 在 0.2.2-rc.3 起以 `CONTENT_REFUSED` 错误码报告（不再有正文），1.2.0 的 stream guard 会把这种错误当成一次拒答扣下，而不是让整轮失败。

### 1.1.0 安装器为什么会让其他插件出错

三条独立的问题，全是「安装时动了不该动的东西」：

1. **在 profile 里跑 `pnpm install --config.confirmModulesPurge=false`。**
   这个参数的含义是「不要问，直接清空 `node_modules` 重装」。而 profile 的 `pnpm-lock.yaml` 往往和 `package.json` 已经失配（手动加过 `link:` 依赖），pnpm 于是判定 modules 目录失效 → 整个删掉 → 重装一旦失败（`file:` 绝对路径、`minimumReleaseAge`、非 ASCII 路径被 pnpm 拼坏），就留下一个只剩本插件链接的**空壳**。其他插件并没有被改配置，是**包没了**。
   1.2.0 **完全不跑包管理器**：只写 `package.json` 的一个 `link:` 依赖 + 一个 `dsh.profile.bundles` 条目 + 一个 `node_modules` 目录联接（`fs.symlinkSync(..., 'junction')`，不经过 `cmd` 的引号解析，中文/空格路径安全）。
2. **改宿主文件。** `scripts/lib/patcher.js` 会去写 `@deepseek-ai/dsh-agent-instructions/lib/index.js`，兜底正则还把 `filter(section => …)` 换成 `filter(section => true)`。在 0.2.x 下宿主在 `app.asar` 里（只读），旧代码只是「没命中」；一旦命中就是改共享 inode 或改宿主安装，所有插件的提示词一起坏。该文件与 `ensure-runtime.ps1` 已**整个删除**。
3. **全局覆盖 `system-prompt`。** 往 profile patch 前置 `- id: system-prompt` + `includeHarnessIdentity: false` + `personaPrefix: ''` 会作用于**整个 profile 的每个 agent**，并和 preset 的 persona、其他插件的身份段打架，胜负取决于行序。1.2.0 不再写这一行；需要的话你自己在 profile patch 里写，安装器不替你做决定。

另外：1.1.0 的 `-Profile` 参数其实没被读，装机会写进**所有** profile，包括 `desktop-backup-*` 这种快照目录。1.2.0 默认拒绝多 profile 无点名安装，并默认排除快照目录。

---

## 安装

### 前置

- Windows / macOS / Linux 上已安装 DSH 0.2.x，并至少启动过一次（`%USERPROFILE%\.dsh` 存在）。
- 需要 `node`（20+）；没装也没关系，脚本会退回用 Harness 自带的 Electron 运行时（`ELECTRON_RUN_AS_NODE`）。
- **完全退出 DeepSeek-Harness 再安装。**

### 一键安装

1. 完整解压发布包，进入含 `点我一键安装.bat` 的目录。
2. **完全退出 DSH，双击它。** 不需要输入任何东西（没有 `set /p`，没有 `pause`）。
3. 重启 DSH。

目标 profile 由脚本自己决定，顺序固定：

```
--profile <name>（显式）→ $DSH_PROFILE（当前运行的 profile）→ 唯一的 profile → 所有活动 profile
```

快照目录（`desktop-backup-*`、`node_modules.stale-*` 等）**始终排除**。多个 profile 时每个都只写入本插件自己的一行，可重复执行；想只装一个就 `.\install.ps1 -Profile desktop`。

> 双击运行时窗口会在 10 秒后自动关闭（`ping` 延时，不需要按键），这样报告能看清又不打断你。

### 手动安装

```powershell
# 只装一个 profile（推荐）
.\install.ps1 -Profile desktop

# 先看会改什么，不落盘
.\install.ps1 -Profile desktop -DryRun

# 明确装到所有 profile（快照目录默认排除）
.\install.ps1 -All
```

也可以完全走官方路径（DSH 0.2.x 的 bundle 机制）：

```powershell
# 注意：desktop 是 Electron 独占管理的 profile，CLI 会直接拒绝
#   error: profile "desktop" is managed exclusively by the Electron application
# 其它 profile 可以：
dsh plugin --profile myprofile add -w "file:C:/Users/<you>/.dsh/plugins/feibi-breaker"
# 然后把 feibi-breaker 加进该 profile 的 dsh.profile.bundles
```

安装器做的事，逐条可见：

```
1. 读取并校验 package.json / cordis.patch.yml（写坏 profile patch = 所有插件都装不上）
2. 复制插件到 $DSH_HOME/plugins/feibi-breaker（不动 .git / node_modules）
3. 备份 profile 到 $DSH_HOME/backups/feibi-breaker/<profile>-<时间戳>/
4. package.json：一个 link: 依赖 + 一个 dsh.profile.bundles 条目
5. cordis.patch.yml：只保留一条 - id: feibi-breaker 覆盖行，清掉历史遗留的 - insert: 行
6. node_modules/feibi-breaker 目录联接（已有则复用；指向别处则改名保留而非删除）
7. 验收：依赖能解析、bundle 已选中、patch 只有一行、node_modules 链接指向正确
```

### 安装后验证

```powershell
node tools\check-install.mjs --profile desktop --verbose
```

它会报告：插件版本、patch 行数、bundle 选中状态、链接目标、`engines.dsh` 兼容性，以及**profile 里每个依赖是否还能解析**（1.1.0 从不检查最后这条）。

---

## 修复被 1.1.x 安装器清空的 node_modules

如果你的其他插件在装完本插件后全没了（配置行还在、但加载失败），那是 `node_modules` 被清空过。修法不需要联网：

```powershell
# 1. 完全退出 DSH
# 2. 先看计划
powershell -NoProfile -ExecutionPolicy Bypass -File tools\repair-node-modules.ps1 -Profile desktop -DryRun
# 3. 执行（只改名，不删除）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\repair-node-modules.ps1 -Profile desktop
```

脚本会在 profile 目录里找 `node_modules.stale-*` / `node_modules.bak-*` 这类旧快照，挑依赖最全的一份校验后改回 `node_modules`，把当前空壳改名为 `node_modules.empty-<时间戳>` 留档。hoisted 布局的 Junction 用的是绝对路径，改名后会自己复活。

没有可用快照时只能联网重装依赖（先备份 profile）。

---

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（**不要**再写 `- insert:`，bundle 已经插入了这一行）：

```yaml
- id: feibi-breaker
  config:
    armorEnabled: true      # 提示词塑形总开关
    dualLayer: true         # Order 100 + Order 200 双段注入；关掉省一半 token
    enabled: true           # 拦截总开关
    interceptAt: stream     # stream | wire | both | preview
    onDetect: block         # block 自动丢弃；ask 进待审区
    autoRetry: false        # 命中后自动补一条纠正消息让模型重答
    retryMax: 3
    scanChars: 600
    blocklist: []           # 追加词库
    patterns: []            # 追加正则
    auditPath: ''           # 非空则把命中记录追加成 JSONL
```

`armorEnabled: false` 只关提示词，拦截照常；`enabled: false` 只关拦截，提示词照常 —— 两半互不牵连。

## 提示词

内置规则以打包资产 `core/payload.bin` 随插件发布。装载后你仍然可以完全掌控它：

| 位置 | 作用 |
| --- | --- |
| `%USERPROFILE%\.dsh\feibi-prompt.md` | 你的副本，非空时优先于内置规则 |
| `%USERPROFILE%\.dsh\.feibi\prompt-state.json` | 记录是否自定义、哈希与更新时间 |
| `core/payload.bin`（随包） | 内置规则，只读 |

- 直接编辑 `feibi-prompt.md`，**下一轮生效、无需重启**。
- 面板（设置 → 菲比破限 → 提示词内容）里能看到来源是「自定义」还是「内置默认」。
- 对话里也可以问插件自带的工具：`feibi_prompt` 查看/恢复，`feibi_profile` 看状态，`feibi_selftest` 真跑探测。

## 自测

- 每条探测是一次**真实的模型调用**，会消耗 token。默认 4 条，上限 8 条。
- 结果分四态：答出内容、被判为拒绝、空回答、调用失败；面板并排显示「整体通过率」与「有效样本通过率」。
- 入口：设置 → 菲比破限 → 自测；或对话里调用 `feibi_selftest`。

## 卸载

```powershell
.\uninstall.ps1 -Profile desktop -DryRun   # 先看
.\uninstall.ps1 -Profile desktop           # 只删自己
```

只移除本插件自己的依赖、bundle 条目、挂载行和 `node_modules` 链接。插件目录**移动到** `.dsh\backups\feibi-breaker\removed-<时间戳>`，不删除 —— 它常常是指向源码的链接，递归删除 reparse point 会删掉目标。别人的行、别人的链接、`pnpm-lock.yaml` 都不动。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 装完其他插件全挂了 | 1.1.x 的 `pnpm install` 清空了 `node_modules`。退出 DSH 后跑 `tools\repair-node-modules.ps1`，见上文。 |
| 状态条/设置面板不显示 | 完全退出并重启 DSH；`node tools\check-install.mjs --profile <name>` 会告诉你 patch 行、bundle 与链接是否都到位。 |
| 预览面板一直「已断开」 | 1.1.0 的路由路径残留（`/api/dsh-gatekeeper/preview`），1.2.0 已修。 |
| 已经有 dsh-gatekeeper，会冲突吗 | 不会。两个插件各自判定，安装器不改别人的行。 |
| 想让回复更省 token | 把 `dualLayer` 设为 `false`，只保留单段注入。 |
| 插件管理页标题显示成包名 | 缺 `locale/*.json` 的 `meta.title`；本包已带 `en`/`zh`。 |
| 安装器说「有 N 个依赖解析不到」 | 这是事实报告，不是它去修。先按上面的修复流程恢复 `node_modules`，再重跑。 |
| 双击 `.bat` 报 `'夎' 不是内部或外部命令` / `'m' is not recognized` | 批处理必须 **纯 ASCII + CRLF**：cmd 按控制台 OEM 代码页（简体中文是 GBK）逐行解析，UTF-8 中文行和 LF 换行都会被切碎。仓库里的 `.bat` 已由 `node tools/write-launchers.mjs` 生成，改完请重跑它，不要把中文写回 `.bat`。 |
| 为什么装到了 `web` 等别的 profile | 双击时没有 `$DSH_PROFILE`，脚本退回「所有活动 profile」。只想装一个：`.\install.ps1 -Profile desktop`。 |

状态条只表示插件已装载。实际回复仍受所选模型、其他提示词与 DSH 版本影响。

## 目录结构

```
lib/               插件主体（apply、判定器、拦截、总线、投影、自测）
core/payload.bin   打包的内置规则与评分词表（只读资产）
client.js          设置页与输入框状态条（window.__ModuleLoader__ 模块）
locale/            插件管理页标题与描述（en / zh）
icon.svg           插件图标
scripts/           安装器（install.mjs / uninstall.mjs / lib/profile.js）
install.ps1 / uninstall.ps1 / 点我一键*.bat   薄封装
tools/             check-install.mjs（验收）、repair-node-modules.ps1（修复）
test/              node --test 单元与端到端测试
```

## 许可

CC-BY-NC-SA-4.0，见 [LICENSE](LICENSE)。第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
