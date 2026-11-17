<#
.SYNOPSIS
  菲比破限 · Claude Code 版 一键卸载

.DESCRIPTION
  停代理、去自启、还上游、卸插件、撤状态条。
  ~/.claude/feibi 里的提示词副本默认保留（你改过的东西不该在卸载时消失），
  加 -Purge 才删。

.PARAMETER Purge
  连 %USERPROFILE%\.claude\feibi 一起删掉。

.PARAMETER DryRun
  只打印要做什么，不落盘。
#>
[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $root 'bin\feibi-cc.mjs'

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Run($argv) {
  if ($DryRun) { Say ("  [dry-run] node bin/feibi-cc.mjs " + ($argv -join ' ')); return 0 }
  & node $cli @argv | Out-Host
  return $LASTEXITCODE
}

Say "菲比破限 · 卸载"
Say "----------------------------------------"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "没找到 node，无法调用卸载程序。手动删除："
  Say "  - %USERPROFILE%\.claude\plugins\feibi-breaker"
  Say "  - settings.json 里的 enabledPlugins / statusLine / env 三项"
  exit 1
}

Step "1/4 停止代理"
Run @('stop') | Out-Null
$autostart = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\feibi-breaker-cc.vbs'
if (Test-Path $autostart) {
  if ($DryRun) { Say "  [dry-run] 删除开机自启 $autostart" } else { Remove-Item $autostart -Force -ErrorAction SilentlyContinue; Say "  开机自启已移除。" }
}

Step "2/4 还上游（撤销直连）"
Run @('undirect') | Out-Null

Step "3/4 还原 settings.json 并卸插件"
Run @('uninstall') | Out-Null
Run @('plugin', 'uninstall') | Out-Null

Step "4/4 收尾"
if ($Purge) {
  $feibi = Join-Path $env:USERPROFILE '.claude\feibi'
  if (Test-Path $feibi) {
    if ($DryRun) { Say "  [dry-run] 删除 $feibi" } else { Remove-Item $feibi -Recurse -Force -ErrorAction SilentlyContinue; Say "  已删除 $feibi（含提示词副本与流水）。" }
  }
} else {
  Say "  ~/.claude/feibi 保留（提示词副本、流水）。要一起删：.\uninstall.ps1 -Purge"
}

Say ""
Say "完成。settings.json 的备份在 %USERPROFILE%\.claude\settings.json.*-backup.*"
Say "完全退出并重启 Claude Code Desktop 后生效。"
