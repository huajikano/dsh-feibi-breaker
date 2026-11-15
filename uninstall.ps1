# 菲比破限 · feibi-breaker 卸载脚本
#
# 移除本插件的挂载行、依赖与 node_modules 链接，并保留备份。

[CmdletBinding()]
param(
    [string]$Profile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pluginId = 'feibi-breaker'
$dshRoot = Join-Path $env:USERPROFILE '.dsh'
$profilesRoot = Join-Path $dshRoot 'profiles'
$pluginsDir = Join-Path $dshRoot 'plugins'
$destDir = Join-Path $pluginsDir $pluginId

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    [!] $Msg" -ForegroundColor Yellow }

Write-Host "`n菲比破限 卸载" -ForegroundColor Cyan

if (-not (Test-Path $profilesRoot)) { Write-Warn "未找到 profiles 目录，无需卸载"; exit 0 }

$targetProfiles = if ($Profile) { @(Join-Path $profilesRoot $Profile) } else {
    @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | ForEach-Object { $_.FullName })
}

Write-Step '移除 profile 挂载'
foreach ($pDir in $targetProfiles) {
    $pName = Split-Path $pDir -Leaf
    if ($DryRun) { Write-Warn "[$pName] 演练模式，跳过"; continue }

    # cordis.patch.yml：移除本插件与身份覆盖块
    $patchPath = Join-Path $pDir 'cordis.patch.yml'
    if (Test-Path $patchPath) {
        $before = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
        $bak = "$patchPath.before-uninstall-$pluginId.bak"
        if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $patchPath -Destination $bak -Force }

        $cleaned = [regex]::Replace($before, "(?ms)^- insert:\s*\r?\n\s+- id: $pluginId\b.*?(?=^- |\z)", '')
        $cleaned = [regex]::Replace($cleaned, "(?ms)^# \[$pluginId\][^\r\n]*\r?\n- id: system-prompt\r?\n(?:  [^\r\n]*\r?\n)*", '')
        $cleaned = $cleaned.TrimEnd()

        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchPath, $cleaned + [Environment]::NewLine, $utf8NoBom)
        Write-Ok "[$pName] cordis.patch.yml 已清理（备份：$bak）"
    }

    # package.json：移除依赖与 bundle 条目
    $pkgPath = Join-Path $pDir 'package.json'
    if (Test-Path $pkgPath) {
        $pkgBak = "$pkgPath.before-uninstall-$pluginId.bak"
        if (-not (Test-Path $pkgBak)) { Copy-Item -LiteralPath $pkgPath -Destination $pkgBak -Force }
        $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains $pluginId)) {
            $pkg.dependencies.PSObject.Properties.Remove($pluginId)
        }
        if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
            $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $pluginId })
        }
        $json = $pkg | ConvertTo-Json -Depth 10
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($pkgPath, $json + [Environment]::NewLine, $utf8NoBom)
        Write-Ok "[$pName] package.json 已清理"
    }

    # node_modules 链接
    $nmEntry = Join-Path $pDir "node_modules\$pluginId"
    if (Test-Path $nmEntry) {
        try {
            if ((Get-Item $nmEntry).LinkType -eq 'Junction') { cmd.exe /c "rmdir `"$nmEntry`"" 2>$null | Out-Null }
            else { Remove-Item -LiteralPath $nmEntry -Recurse -Force }
            Write-Ok "[$pName] node_modules 链接已移除"
        } catch { Write-Warn "[$pName] node_modules 链接移除失败：$($_.Exception.Message)" }
    }
}

Write-Step '移除插件目录'
if ($DryRun) {
    Write-Warn '演练模式：跳过'
} elseif (Test-Path $destDir) {
    Remove-Item -LiteralPath $destDir -Recurse -Force
    Write-Ok "已删除：$destDir"
} else {
    Write-Ok '插件目录不存在，跳过'
}

Write-Host ''
Write-Host '  卸载完成。请完全退出并重启 DeepSeek-Harness。' -ForegroundColor Green
Write-Host '  备份文件（*.before-uninstall-feibi-breaker.bak）保留在原目录。' -ForegroundColor Yellow
Write-Host ''

try { Read-Host '按回车键退出' } catch { }
