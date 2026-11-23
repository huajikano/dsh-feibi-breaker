# 修复被 pnpm 清空的 profile node_modules。
#
# 症状：profile 的 cordis.patch.yml 里插件行都在，但装完某个插件后其他插件全部失效。
# 原因：安装器在 profile 目录里跑了 `pnpm install --config.confirmModulesPurge=false`，
# 该参数等于自动回答"是，请把 node_modules 整个删掉重装"；重装一旦失败（lockfile 与
# manifest 失配、file: 绝对路径、minimumReleaseAge 等），就留下一个只剩一个链接的空壳。
#
# 本脚本不联网、不跑 pnpm、不删除任何东西：
#   1. 在 profile 目录里找一个旧的完整 node_modules（node_modules.stale-* /
#      node_modules.bak-* / node_modules.empty-*），用「改名之后能不能解析」来评分；
#   2. 把当前空壳改名为 node_modules.empty-<时间戳>，把候选改回 node_modules；
#   3. 再把 pnpm 弄坏的链接按 package.json 的 link: spec 重建（pnpm 会把绝对路径
#      接到 profile 目录后面，得到 <profile>\D:\... 这种解析不到的目标）；
#   4. 复核每个依赖，缺的列出来（缺的那些只能联网重装）。
#
# 用法（先完全退出 DeepSeek-Harness）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\repair-node-modules.ps1 -Profile desktop -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\repair-node-modules.ps1 -Profile desktop

[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$currentDir = Join-Path $profileDir 'node_modules'

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "    [OK] $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "    [!] $Message" -ForegroundColor Yellow }
function Write-Err2 { param([string]$Message) Write-Host "    [X] $Message" -ForegroundColor Red }

Write-Step "检查 profile：$profileDir"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Err2 '找不到 package.json。用 -Profile 指定正确的 profile 名。'
    exit 1
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$specs = @{}
if ($manifest.PSObject.Properties.Name -contains 'dependencies' -and $null -ne $manifest.dependencies) {
    foreach ($property in $manifest.dependencies.PSObject.Properties) { $specs[$property.Name] = [string]$property.Value }
}
$dependencies = @($specs.Keys | Sort-Object)
Write-Ok "声明的依赖：$($dependencies.Count) 个"

function Get-LinkTarget {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or -not $item.LinkType) { return $null }
    $target = @($item.Target)[0]
    if (-not $target) { return $null }
    return [string]$target
}

<#
  判断一个依赖在「目录改名为 node_modules 之后」能不能解析。

  hoisted 布局的 Junction 目标是绝对路径，而且指向
  <profile>\node_modules\.pnpm\<pkg>@<ver>\node_modules\<pkg>。
  候选目录现在还叫 node_modules.stale-*，直接 Test-Path 会全判缺失，
  所以先把目标里的 node_modules 段换成「候选目录」再判断。
#>
function Test-Dependency {
    param([string]$Directory, [string]$Name)
    $finalDir = Join-Path (Split-Path -Parent $Directory) 'node_modules'
    $entry = Join-Path $Directory $Name

    if (Test-Path -LiteralPath (Join-Path $entry 'package.json')) { return $true }

    $target = Get-LinkTarget -Path $entry
    if ($null -eq $target) { return $false }

    # 目标写在最终路径上：把它换回候选目录再查。
    if ($target.StartsWith($finalDir, [StringComparison]::OrdinalIgnoreCase)) {
        $relative = $target.Substring($finalDir.Length).TrimStart('\', '/')
        return Test-Path -LiteralPath (Join-Path $Directory (Join-Path $relative 'package.json'))
    }
    # pnpm 把绝对路径接到 profile 目录后面（<profile>\D:\...）：这种目标是坏的。
    if ($target -match '^[A-Za-z]:\\' -or $target -match '^\\\\') {
        return Test-Path -LiteralPath (Join-Path $target 'package.json')
    }
    return $false
}

function Measure-Candidate {
    param([string]$Directory)
    $missing = @()
    foreach ($dependency in $dependencies) {
        if (-not (Test-Dependency -Directory $Directory -Name $dependency)) { $missing += $dependency }
    }
    return [pscustomobject]@{
        Directory = $Directory
        Name      = Split-Path -Leaf $Directory
        Missing   = $missing
        HasMarker = Test-Path -LiteralPath (Join-Path $Directory '.modules.yaml')
        HasPnpm   = Test-Path -LiteralPath (Join-Path $Directory '.pnpm')
    }
}

Write-Step '探测候选 node_modules'
$currentState = $null
if (Test-Path -LiteralPath $currentDir) { $currentState = Measure-Candidate -Directory $currentDir }

$candidates = @()
Get-ChildItem -LiteralPath $profileDir -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node_modules.*' } |
    ForEach-Object { $candidates += (Measure-Candidate -Directory $_.FullName) }

if ($candidates.Count -eq 0) {
    Write-Err2 '没有找到任何 node_modules.* 备份目录。'
    Write-Warn2 '这种情况需要联网重装依赖（先备份 profile，再从 DSH 插件管理页安装一次）。'
    exit 1
}

# 评分：缺得越少越好；同样缺时，有 .pnpm 的优先（link: 依赖只占少数）。
$ranked = $candidates | Sort-Object -Property @{ Expression = { $_.Missing.Count } }, @{ Expression = { -not $_.HasPnpm } }
foreach ($candidate in $ranked) {
    $marker = if ($candidate.HasMarker) { '.modules.yaml' } else { '无 .modules.yaml' }
    $pnpm = if ($candidate.HasPnpm) { '.pnpm 完整' } else { '无 .pnpm' }
    Write-Host ("    {0,-40} 缺失 {1}/{2}  {3}  {4}" -f $candidate.Name, $candidate.Missing.Count, $dependencies.Count, $pnpm, $marker)
}

$best = $ranked | Select-Object -First 1
if ($null -ne $currentState) {
    Write-Host ''
    Write-Host ("    当前 node_modules 缺失 {0}/{1}" -f $currentState.Missing.Count, $dependencies.Count) -ForegroundColor DarkGray
}

if ($DryRun) {
    Write-Step '演练'
    Write-Host "    将把 $currentDir 改名为 $currentDir.empty-<时间戳>" -ForegroundColor Yellow
    Write-Host "    将把 $($best.Directory) 改名为 $currentDir" -ForegroundColor Yellow
    Write-Host "    然后按 package.json 的 link: spec 重建被 pnpm 弄坏的链接" -ForegroundColor Yellow
    if ($best.Missing.Count -gt 0) {
        Write-Host "    注意：这个候选仍缺 $($best.Missing.Count) 个依赖：$($best.Missing -join ', ')" -ForegroundColor Yellow
    }
    Write-Host '    没有改动任何文件。去掉 -DryRun 再跑一次才会执行。' -ForegroundColor Yellow
    exit 0
}

Write-Step '执行修复（只改名，不删除）'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path -LiteralPath $currentDir) {
    $aside = "$currentDir.empty-$stamp"
    Rename-Item -LiteralPath $currentDir -NewName (Split-Path -Leaf $aside)
    Write-Ok "空壳已改名为：$(Split-Path -Leaf $aside)"
} else {
    Write-Warn2 '当前没有 node_modules 目录，直接恢复候选。'
}
Rename-Item -LiteralPath $best.Directory -NewName 'node_modules'
Write-Ok '候选已恢复为 node_modules'

Write-Step '按 link: spec 重建被 pnpm 弄坏的链接'
$repaired = @()
foreach ($dependency in $dependencies) {
    $entry = Join-Path $currentDir $dependency
    if (Test-Path -LiteralPath (Join-Path $entry 'package.json')) { continue }

    $spec = $specs[$dependency]
    if (-not $spec.StartsWith('link:')) {
        Write-Warn2 "$dependency：spec 是 $spec（不是 link:），不重建"
        continue
    }

    $target = $spec.Substring(5) -replace '/', '\'
    if (-not (Test-Path -LiteralPath $target)) {
        Write-Warn2 "$dependency：link 目标不存在 $target"
        continue
    }
    try {
        if (Test-Path -LiteralPath $entry) {
            $old = Get-Item -LiteralPath $entry -Force
            if ($old.LinkType) { cmd /c "rmdir `"$entry`"" 2>$null | Out-Null }
            else { Move-Item -LiteralPath $entry -Destination "$entry.old-$stamp" -Force }
        }
        New-Item -ItemType Junction -Path $entry -Target $target -ErrorAction Stop | Out-Null
        if (Test-Path -LiteralPath (Join-Path $entry 'package.json')) {
            $repaired += $dependency
            Write-Ok "已重建 $dependency -> $target"
        } else {
            Write-Warn2 "$dependency：重建后仍解析不到"
        }
    } catch {
        Write-Warn2 "$dependency：重建失败（$($_.Exception.Message)）"
    }
}

Write-Step '验收'
$after = Measure-Candidate -Directory $currentDir
if ($after.Missing.Count -eq 0) {
    Write-Ok "全部 $($dependencies.Count) 个依赖都能解析"
} else {
    Write-Warn2 "仍缺 $($after.Missing.Count) 个：$($after.Missing -join ', ')"
    Write-Warn2 '这些需要联网重装（或在 DSH 插件管理页重装该插件）。'
}
if ($after.HasMarker) { Write-Ok '.modules.yaml 存在，pnpm 不会判定目录失效' } else { Write-Warn2 '缺少 .modules.yaml' }
if ($repaired.Count -gt 0) { Write-Ok "重建的链接：$($repaired -join ', ')" }

Write-Host ''
Write-Host '下一步：启动 DeepSeek-Harness，确认其他插件恢复；再跑 node tools\check-install.mjs --profile ' -NoNewline -ForegroundColor Yellow
Write-Host $Profile -ForegroundColor Yellow
