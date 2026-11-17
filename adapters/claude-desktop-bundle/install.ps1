<#
.SYNOPSIS
  菲比破限 · Claude Desktop 一键整合包

.DESCRIPTION
  三步做完：装 Claude Desktop（官方 MSIX）→ 全量中文（外壳 + Code 标签页）→ 装菲比破限。
  每一步都能单独跳过，任何一步失败都会说清楚原因，不会留下"装了一半"的状态。

  汉化和写回 WindowsApps 需要管理员权限（会弹 UAC）；装 Claude Desktop 本身不需要。

.PARAMETER Key
  上游 API key，透传给菲比破限的安装器。不给就让它自己找。

.PARAMETER SkipDesktop
  跳过"装 Claude Desktop"（已经装好了就用这个）。

.PARAMETER SkipZh
  跳过汉化（只想装破限）。

.PARAMETER SkipFeibi
  跳过破限（只想装 + 汉化）。

.PARAMETER DryRun
  只打印要做什么。

.EXAMPLE
  .\install.ps1
  .\install.ps1 -SkipDesktop -Key sk-xxxx
  .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Key = '',
  [switch]$SkipDesktop,
  [switch]$SkipZh,
  [switch]$SkipFeibi,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupExe = Join-Path $root 'Claude Desktop Setup.exe'
$cnDir = Join-Path $root 'claude-desktop-cn'
$feibiDir = Join-Path $root 'feibi'
$fail = @()

function Say($t) { Write-Host $t }
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host $t -ForegroundColor Green }
function Warn($t) { Write-Host $t -ForegroundColor Yellow; $script:fail += $t }
function Bad($t) { Write-Host $t -ForegroundColor Red; $script:fail += $t }

# 以管理员身份跑一条命令并等它结束。
# UAC 会弹窗——改 WindowsApps 里的文件绕不过这一步。
# 传进来的是命令行字符串而不是脚本路径：汉化的 shell-install / ion-install 是
# python 脚本，把 .py 当成 -File 的 PowerShell 脚本传，必然跑不起来。
function Invoke-Elevated([string]$scriptBlock) {
  if ($DryRun) { Say ("  [dry-run] 提权执行: " + $scriptBlock); return 0 }
  $p = Start-Process -FilePath 'powershell' -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $scriptBlock
  )
  return $p.ExitCode
}

Say "菲比破限 · Claude Desktop 一键整合包"
Say "----------------------------------------"

# ---------------------------------------------------------------- 1. 环境
Step "1/4 检查环境"
$node = Get-Command node -ErrorAction SilentlyContinue
$py = Get-Command python -ErrorAction SilentlyContinue
if ($node) { Say "  node    $(& node --version)" } else { Bad "  没找到 node（破限需要 Node 20+）：https://nodejs.org" }
if ($py) { Say "  python  $(& python --version 2>&1)" } elseif (-not $SkipZh) { Bad "  没找到 python（汉化需要 3.8+）：https://www.python.org/downloads/" }
if ($node) {
  $major = [int]((& node --version).TrimStart('v').Split('.')[0])
  if ($major -lt 20) { Bad "  Node 版本太低（需要 >= 20）" }
}
Say ("  目录    " + $root)

# ---------------------------------------------------------------- 2. Claude Desktop
Step "2/4 安装 Claude Desktop"
$pkg = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($SkipDesktop) {
  Say "  按 -SkipDesktop 跳过。"
} elseif ($pkg) {
  Say ("  已安装：" + $pkg.Name + " " + $pkg.Version)
  Say ("  位置  ：" + $pkg.InstallLocation)
} elseif (-not (Test-Path $setupExe)) {
  Bad "  找不到安装包：$setupExe"
} elseif ($DryRun) {
  Say "  [dry-run] 运行 $setupExe 并等它装完"
} else {
  Say "  正在安装（会弹官方安装界面，跟着点完即可）……"
  try {
    Start-Process -FilePath $setupExe -Wait
    Start-Sleep -Seconds 3
    $pkg = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pkg) { Ok ("  装好了：" + $pkg.Version) } else { Bad "  安装似乎没完成，检查 %TEMP%\ClaudeSetup.log" }
  } catch {
    Bad ("  安装失败：" + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------- 3. 汉化
Step "3/4 中文汉化（外壳 1310 条 + Code 标签页 561 条）"
if ($SkipZh) {
  Say "  按 -SkipZh 跳过。"
} elseif (-not $py) {
  Bad "  没装 python，跳过汉化。"
} elseif (-not (Test-Path (Join-Path $cnDir 'scripts\hanhua.py'))) {
  Bad "  汉化脚本缺失：$cnDir\scripts\hanhua.py"
} else {
  Push-Location $cnDir
  try {
    Say "  · 体检"
    if (-not $DryRun) { & python scripts\hanhua.py check 2>&1 | Out-Host }

    Say "  · 外壳：合并 417 条补译 → 重打 app.asar"
    if (-not $DryRun) { & python scripts\hanhua.py shell-build 2>&1 | Out-Host }
    else { Say "    [dry-run] python scripts\hanhua.py shell-build" }

    Say "  · 外壳：写回安装目录 + 关 asar 完整性 fuse（需要管理员）"
    $code = Invoke-Elevated ("& python '" + (Join-Path $cnDir 'scripts\hanhua.py') + "' shell-install")
    if ($code -ne 0 -and -not $DryRun) { Warn "  外壳写回失败（退出码 $code），看上面的输出" }

    Say "  · Code 标签页：用词库替换 JS 里的 defaultMessage"
    if (-not $DryRun) { & python scripts\hanhua.py ion-build 2>&1 | Out-Host }
    else { Say "    [dry-run] python scripts\hanhua.py ion-build" }

    Say "  · Code 标签页：写回 ion-dist.asar（需要管理员）"
    $code = Invoke-Elevated ("& python '" + (Join-Path $cnDir 'scripts\hanhua.py') + "' ion-install")
    if ($code -ne 0 -and -not $DryRun) { Warn "  Code 标签页写回失败（退出码 $code）" }
  } finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------- 4. 破限
Step "4/4 安装菲比破限"
if ($SkipFeibi) {
  Say "  按 -SkipFeibi 跳过。"
} elseif (-not (Test-Path (Join-Path $feibiDir 'install.ps1'))) {
  Bad "  破限安装器缺失：$feibiDir\install.ps1"
} else {
  $feibiInstaller = Join-Path $feibiDir 'install.ps1'
  if ($Key -and $DryRun) { & $feibiInstaller -Key $Key -DryRun }
  elseif ($Key) { & $feibiInstaller -Key $Key }
  elseif ($DryRun) { & $feibiInstaller -DryRun }
  else { & $feibiInstaller }
  if ($LASTEXITCODE -ne 0) { Warn "  破限安装返回 $LASTEXITCODE" }
}

# ---------------------------------------------------------------- 收尾
Step "完成"
if ($fail.Count -gt 0) {
  Write-Host "下面这些没成功，逐条看：" -ForegroundColor Yellow
  foreach ($f in $fail) { Write-Host ("  - " + $f.Trim()) -ForegroundColor Yellow }
} else {
  Ok "三步都走完了。"
}
Say ""
Say "验收："
Say "  1. 开始菜单搜 Claude 打开 → 界面应是中文（设置页、按钮、确认框）"
Say "  2. 侧栏 Code 标签页 → 新建会话/搜索/自定义 都是中文"
Say "  3. 会话里敲 /feibi → 出设置面板；发一句话看回复带不带 (Discord交流群@…)"
Say ""
Say "卸载：双击「点我一键卸载.bat」"
