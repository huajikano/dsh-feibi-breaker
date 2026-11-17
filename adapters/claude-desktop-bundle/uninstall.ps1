<#
.SYNOPSIS
  菲比破限 · Claude Desktop 整合包 一键卸载

.DESCRIPTION
  只撤"我们加上去的东西"：破限（插件/代理/settings）+ 汉化补丁（还原官方 asar）。
  Claude Desktop 本体保留。

.PARAMETER KeepZh
  保留汉化，只卸破限。

.PARAMETER DryRun
  只打印要做什么。
#>
[CmdletBinding()]
param(
  [switch]$KeepZh,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cnDir = Join-Path $root 'claude-desktop-cn'
$feibiDir = Join-Path $root 'feibi'

function Say($t) { Write-Host $t }
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }

function Invoke-Elevated([string]$file, [string[]]$argv) {
  $list = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $file) + $argv
  if ($DryRun) { Say ("  [dry-run] 提权执行: powershell " + ($list -join ' ')); return 0 }
  $p = Start-Process -FilePath 'powershell' -Verb RunAs -Wait -PassThru -ArgumentList $list
  return $p.ExitCode
}

Say "菲比破限 · 卸载"
Say "----------------------------------------"

Step "1/2 卸破限"
if (Test-Path (Join-Path $feibiDir 'uninstall.ps1')) {
  $argv = @()
  if ($DryRun) { $argv += '-DryRun' }
  & (Join-Path $feibiDir 'uninstall.ps1') @argv
} else {
  Say "  找不到 $feibiDir\uninstall.ps1，跳过。"
}

Step "2/2 还原汉化"
if ($KeepZh) {
  Say "  按 -KeepZh 保留汉化。"
} elseif (-not (Test-Path (Join-Path $cnDir 'scripts\hanhua.py'))) {
  Say "  找不到汉化脚本，跳过。"
} else {
  $code = Invoke-Elevated (Join-Path $cnDir 'scripts\hanhua.py') @('restore')
  if ($code -ne 0 -and -not $DryRun) { Write-Host "  还原返回 $code，看上面的输出" -ForegroundColor Yellow }
}

Say ""
Say "完成。Claude Desktop 本体没动；要连它一起卸：设置 → 应用 → Claude → 卸载。"
