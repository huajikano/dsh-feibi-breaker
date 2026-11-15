# 菲比破限

> 菲比破限（`dsh-feibi-breaker`）是一个 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) 本地插件：在系统提示词层做塑形，在模型流提交前做拦截，并在输入框上方用一条状态条报告实际发生了什么。
>
> 插件标识：`feibi-breaker`　当前版本：`1.1.0`　许可：CC-BY-NC-SA-4.0

## 功能

- **提示词塑形**：随插件部署内置规则，装载后自动注入，无需手动复制。
- **提交前拦截**：挂载 `llm/stream`，命中判定就把这一段回复扣在会话之外，拒绝原文不会污染后续每一轮上下文。
- **状态条**：输入框上方显示激活状态、命中域与最近一次判定结果。
- **待审区**：可切换为人工审核模式，命中时把回复全文交给你决定放行或丢弃。
- **提示词可改可还原**：内置规则落在 `%USERPROFILE%\.dsh\feibi-prompt.md`，改完下一轮生效，随时一键恢复内置默认。
- **一键安装 / 一键卸载**：双击批处理即可，缺少 Node.js、npm、pnpm 时自动准备运行环境。
- **自测**：用当前模型真跑几条探测，回答「这套规则在我这个模型上今天到底有没有用」。

## 与 dsh-gatekeeper 的区别

菲比破限把「提示词塑形」和「提交前拦截」合成一个插件，但它**不接管**你已有的拦截插件：

| | 菲比破限 | dsh-gatekeeper |
| --- | --- | --- |
| 插件标识 | `feibi-breaker` | `gatekeeper` / `dsh-gatekeeper` |
| 定位 | 塑形 + 拦截 + 状态条 | 拦截 |
| 挂载点 | `systemPrompt.section` + `llm/stream` | `llm/stream` + `fetch` |
| 安装行为 | 只添加自己的一行，其他插件原样保留 | — |
| 与对方共存 | 支持，同时挂载互不干扰 | 支持 |

具体来说：

- 安装器**只写入自己的一行** `- id: feibi-breaker`，不改动、不删除 `dsh-gatekeeper` 或任何其他插件的挂载行与依赖。
- 卸载器**只移除自己的一行**与自己的插件目录，别人的行保持原样。
- 两个拦截插件同时挂在 `llm/stream` 上是受支持的状态：每个插件独立判定，先命中者先扣下。
- 如果你不想同时装两个拦截器，先卸载其中一个即可，两个项目的卸载脚本都只处理自己。

## 安装前准备

- Windows，已安装 DSH，并至少启动过一次，使 `%USERPROFILE%\.dsh` 存在。
- 首次安装需要联网。已有 Node.js 22 或更新版本时直接复用；缺失或过旧时安装器会从 Node.js 官方下载长期支持版，校验 SHA256 后放进当前用户目录，不需要管理员权限。
- **完全退出 DSH 后再执行安装**，避免运行中的进程继续使用旧插件。

## 一键安装

1. 从 [发布页面](../../releases) 下载 ZIP，或用仓库页面的「Code → Download ZIP」。
2. 完整解压，打开包含 `点我一键安装.bat` 的文件夹。
3. 完全退出 DSH。
4. 双击 `点我一键安装.bat`。
5. 检测到多个配置时，按提示选择要安装的 profile。
6. 等待完成后重新启动 DSH。
7. 打开对话，输入框上方出现状态条即装载成功；在对话里发激活词即可进入规则态。

安装后的插件目录：`%USERPROFILE%\.dsh\plugins\feibi-breaker`。请保留解压后的完整文件夹，卸载时还要用其中的脚本。

也可以手动装：

```powershell
.\install.ps1                 # 装进所有 profile
.\install.ps1 -Profile desktop # 只装一个
.\install.ps1 -DryRun          # 只看会改什么，不落盘
```

## 一键卸载

1. 完全退出 DSH。
2. 在解压后的文件夹中双击 `点我一键卸载.bat`。
3. 完成后重新启动 DSH。

卸载只移除 `feibi-breaker` 自己的挂载行、依赖、目录与 `node_modules` 链接；被改写的文件都留有 `.before-feibi-breaker.bak` 备份，且不会覆盖更早的备份。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，改完即时生效、无需重启：

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

内置规则以打包资产 `core/payload.bin` 随插件发布，不在仓库里以明文形式存在。装载后你仍然可以完全掌控它：

| 位置 | 作用 |
| --- | --- |
| `%USERPROFILE%\.dsh\feibi-prompt.md` | 你的副本，非空时优先于内置规则 |
| `%USERPROFILE%\.dsh\.feibi\prompt-state.json` | 记录是否自定义、哈希与更新时间 |
| `core/payload.bin`（随包） | 内置规则，只读 |

- 直接编辑 `feibi-prompt.md`，**下一轮生效、无需重启**。
- 面板（设置 → 菲比破限 → 提示词内容）里能看到来源是「自定义」还是「内置默认」，可保存、载入默认、恢复默认。
- 对话里也可以问插件自身的工具：查看当前生效内容与来源，或恢复内置默认。
- 保存空内容会被拒绝（要回默认请点恢复默认），上限 256 KB。

## 自测

自测是这个插件里唯一会自我测量的部分：提示词是启发式、判定器也是启发式，只有真跑一遍才知道它在你的模型上有没有用。

- 每条探测是一次**真实的模型调用**，会消耗 token。默认 4 条，上限 8 条。
- 结果分四态：答出内容、被判为拒绝、空回答、调用失败。面板并排显示「整体通过率」与「有效样本通过率」，两个数字不同就说明有轮次什么都没测到。
- 入口：设置 → 菲比破限 → 自测；或对话里调用插件自带的 `feibi_selftest` 工具。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 找不到 DSH 配置 | 先安装并启动一次 DSH，确认 `%USERPROFILE%\.dsh` 已生成。 |
| 运行环境下载失败 | 确认能访问 `nodejs.org` 与 npm 软件源后重试；报错信息会写明原因。 |
| 安装成功但没有状态条 | 完全退出并重启 DSH，确认装进了当前使用的 profile。 |
| 已经有 dsh-gatekeeper，会冲突吗 | 不会。两个插件各自判定，安装器不改别人的行。 |
| 想让回复更省 token | 把 `dualLayer` 设为 `false`，只保留单段注入。 |
| 提示词面板显示「内置默认」 | 表示 `feibi-prompt.md` 与随包规则一致，不是错误。 |
| 卸载后仍有状态条 | 完全退出并重启 DSH，确认卸载的是此前安装的 profile。 |
| 想核对判定记录 | 配置 `auditPath` 后，命中会追加成 JSONL，可逐条比对。 |

状态条只表示插件已装载。实际回复仍受所选模型、其他提示词与 DSH 版本影响，本项目不保证所有模型都产生相同结果。

## 目录结构

```
lib/            插件主体（apply、判定器、拦截、总线、投影、自测）
core/payload.bin  打包的内置规则与评分词表（只读资产）
client.js       设置页与输入框状态条
scripts/        安装器的 Node 侧实现
install.ps1 / uninstall.ps1   一键安装与卸载
test/           193 条单元与端到端测试
```

## 许可

CC-BY-NC-SA-4.0，见 [LICENSE](LICENSE)。第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
