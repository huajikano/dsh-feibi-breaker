<#
.SYNOPSIS
  菲比破限 · Claude Code 版 一键安装

.DESCRIPTION
  做四件事：装插件（hook 注入 + Stop 拦截）、起本地代理（system 层注入 + 流级拦截）、
  接管 settings.json、装状态条。全部改动都有备份，卸载脚本一键还原。

.PARAMETER Key
  上游的 API key。不给就从 DEEPSEEK_API_KEY 环境变量、或 %USERPROFILE%\.dsh\.credentials.yaml 里找。

.PARAMETER Model
  上游真正认的模型名，默认 deepseek-reasoner。

.PARAMETER Upstream
  上游 base URL，默认 https://api.deepseek.com/anthropic。

.PARAMETER Port
  本地代理端口，默认 45721。

.PARAMETER NoDirect
  只装插件 + 代理壳，不接管上游（适合已经用 CC Switch 之类把上游指过来的情况）。

.PARAMETER DryRun
  只打印要做什么，不落盘。

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Key sk-xxxx -Model deepseek-reasoner
  .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Key = '',
  [string]$Model = 'deepseek-reasoner',
  [string]$Upstream = 'https://api.deepseek.com/anthropic',
  [int]$Port = 45721,
  [switch]$NoDirect,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $root 'bin\feibi-cc.mjs'

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Warn($text) { Write-Host $text -ForegroundColor Yellow }
function Fail($text) { Write-Host $text -ForegroundColor Red; exit 1 }
function Run($argv) {
  if ($DryRun) { Say ("  [dry-run] node bin/feibi-cc.mjs " + ($argv -join ' ')); return 0 }
  & node $cli @argv | Out-Host
  return $LASTEXITCODE
}

Say "菲比破限 · Claude Code 版"
Say "----------------------------------------"

# 1) 环境
Step "1/5 检查环境"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "没找到 node。先装 Node.js 20 或更新版本（https://nodejs.org），再跑一次。"
}
$nodeVersion = (& node --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
Say "  node $nodeVersion"
if ($major -lt 20) { Fail "Node 版本太低（需要 >= 20，当前 $nodeVersion）。" }
if (-not (Test-Path $cli)) { Fail "安装包不完整：找不到 $cli" }

# 2) 插件
Step "2/5 安装 Claude Code 插件"
$code = Run @('plugin', 'install', '--keep-proxy')
if ($code -ne 0) { Fail "插件安装失败（退出码 $code）。" }

# 3) 上游
Step "3/5 接上游"
if ($NoDirect) {
  Say "  按 -NoDirect 跳过，保持你现在的 settings.json 上游设置。"
  $code = Run @('install', '--port', "$Port", '--autostart')
  if ($code -ne 0) { Fail "代理配置失败（退出码 $code）。" }
} else {
  if ([string]::IsNullOrWhiteSpace($Key)) {
    if ($env:DEEPSEEK_API_KEY) { $Key = $env:DEEPSEEK_API_KEY; Say "  用环境变量 DEEPSEEK_API_KEY。" }
  }
  if ([string]::IsNullOrWhiteSpace($Key)) {
    $cred = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
    if (Test-Path $cred) {
      $m = Select-String -Path $cred -Pattern 'DEEPSEEK_API_KEY:\s*(\S+)' | Select-Object -First 1
      if ($m) { $Key = $m.Matches[0].Groups[1].Value; Say "  从 .dsh\credentials.yaml 找到了 DEEPSEEK_API_KEY。" }
    }
  }
  if ([string]::IsNullOrWhiteSpace($Key)) {
    Warn "  没找到上游 key。可以现在填，留空则只装插件（拦截仍然有效，但注入走上下文，效果弱一档）。"
    $Key = Read-Host "  上游 API Key（直接回车跳过）"
  }
  if ([string]::IsNullOrWhiteSpace($Key)) {
    $code = Run @('install', '--port', "$Port", '--autostart')
    if ($code -ne 0) { Fail "代理配置失败（退出码 $code）。" }
    Warn "  已跳过直连：请在 CC Switch 等工具里把上游指到 http://127.0.0.1:$Port"
  } else {
    $code = Run @('direct', '--key', $Key, '--model', $Model, '--upstream', $Upstream, '--port', "$Port")
    if ($code -ne 0) { Warn "  直连自检没通过（退出码 $code）。代理已装好，修好上游后跑 feibi-cc probe 复查。" }
  }
}

# 4) 代理常驻
Step "4/5 启动代理并设置开机自启"
$code = Run @('start')
if ($code -ne 0) { Warn "  代理没起来，看 %USERPROFILE%\.claude\feibi\proxy.log" }
Run @('panel', '--no-open') | Out-Null
if (-not $DryRun) { Say "  状态条已写入 settings.json（Claude Code 输入框下方那一行）。" }

# 5) 收尾
Step "5/5 完成"
if (-not $DryRun) {
  & node $cli show
} else {
  Say "  [dry-run] 到此为止，什么都没改。"
}

Say ""
Say "下一步："
Say "  1. 完全退出 Claude Code Desktop（托盘里也退干净）再打开"
Say "  2. 会话里敲 /feibi 看设置面板；/feibi strictness=max 可现场加压"
Say "  3. 桌面双击「菲比破限面板」看流量与判定流水"
Say ""
Say "卸载：双击「点我一键卸载.bat」，或跑 .\uninstall.ps1"
