# 菲比破限 · Claude Desktop 一键整合包

一个 ZIP，双击一次：**装 Claude Desktop → 全量中文 → 装菲比破限**。

这是三份东西的合体：

| 组成 | 来源 | 做了什么 |
| --- | --- | --- |
| 官方安装包 | Anthropic（`Claude Desktop Setup.exe`） | 装 MSIX 版 Claude Desktop |
| 汉化 | [huajikano/claude-desktop-cn](https://github.com/huajikano/claude-desktop-cn) | 外壳 1310 条 + Code 标签页 56,908 处 `defaultMessage` 替换 |
| 破限 | [dsh-feibi-breaker/adapters/claude-code](https://github.com/huajikano/dsh-feibi-breaker/tree/feat/claude-code-adapter/adapters/claude-code) | 插件（注入 + 收尾拦截）+ 本地代理（改 `system` + 流级拦截） |

## 用法

1. 解压到任意目录（路径别带奇怪字符）
2. 双击 **`点我一键安装.bat`**
3. 中途会弹 UAC —— 汉化要写 `C:\Program Files\WindowsApps\...`，绕不过去
4. 装完按屏幕上的三条验收

卸载：双击 **`点我一键卸载.bat`**（只撤破限 + 汉化补丁，Claude Desktop 本体保留）。

## 命令行参数

```powershell
.\install.ps1                      # 三步全做
.\install.ps1 -SkipDesktop         # 已经装了 Claude Desktop
.\install.ps1 -SkipZh              # 只要破限
.\install.ps1 -SkipFeibi           # 只要安装 + 汉化
.\install.ps1 -Key sk-xxxx         # 顺便把上游 key 传下去
.\install.ps1 -DryRun              # 只打印要做什么

.\uninstall.ps1                    # 全撤
.\uninstall.ps1 -KeepZh            # 保留汉化，只卸破限
.\uninstall.ps1 -DryRun
```

## 依赖

| 需要 | 为什么 | 缺了会怎样 |
| --- | --- | --- |
| Windows 10/11 | MSIX 安装包 | — |
| Node.js 20+ | 破限的插件与代理 | 跳过破限，汉化照常 |
| Python 3.8+ | 汉化脚本 `hanhua.py` | 跳过汉化，破限照常 |

安装器会先体检并把缺的东西指名道姓告诉你，不会装一半就崩。

## 每一步在干什么

**1. 装 Claude Desktop**
`Get-AppxPackage -Name *Claude*` 先查；没装才跑自带的 `Claude Desktop Setup.exe`。已经装过的直接跳过——不会覆盖你已经汉化好的那份。

**2. 汉化**
`python scripts/hanhua.py` 四个动作：

- `shell-build`：把补译的 417 条并进官方 893 条 → 1310 条 → 重打 `app.asar`
- `shell-install`：**提权**写回 `WindowsApps`，并用 `@electron/fuses` 关掉
  `EnableEmbeddedAsarIntegrityValidation`（不关会 `FATAL: Integrity check failed`）
- `ion-build`：用 `dict/zh.json.gz` 词库替换 `ion-dist.asar` 里 JS 的 `defaultMessage` 字面量
- `ion-install`：提权写回

**3. 破限**
调 `feibi\install.ps1`：装插件（`/feibi` 命令 + 状态条 + Stop 拦截）、起本地代理（system 层注入 + 流级拦截）、接管 `settings.json`、开机自启。

## 已知限制（上游文档里也写了）

- 改过 `claude.exe` 的 fuse 字节后 MSIX 签名对不上，Windows 不会拦启动，但**商店更新/修复会覆盖补丁**，重跑一次本包即可
- 拿过 `app.asar` / `ion-dist.asar` 所有权（`takeown`）后，卸载重装若报权限，用
  `Get-AppxPackage Claude | Remove-AppxPackage` 再装
- 词库若命中率下降（新版本 key 变了），换 `sheen945/claude-hanhua` 的新 `zh.json.gz` 覆盖 `claude-desktop-cn/dict/` 即可

## 打包（给自己用）

```powershell
node build-bundle.mjs --version 1.0.0
```

需要三份输入：官方安装包、`claude-desktop-cn`（含 `dict/zh.json.gz`）、`adapters/claude-code`。
产出 `dist/feibi-claude-desktop-bundle-<版本>.zip` 并打印 sha256。

## 许可

整合包里的三部分各自遵循自己的许可：官方安装包归 Anthropic；汉化项目 MIT；菲比破限 CC-BY-NC-SA-4.0。
