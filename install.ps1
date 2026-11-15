# 菲比破限 · feibi-breaker 安装脚本
#
# 一个插件两半：破甲（提示词塑形）+ 提交前拦截。
# 本脚本只写入 feibi-breaker 自己的一行，不改动、不删除其他插件
# （dsh-gatekeeper 等）的挂载行与依赖。

[CmdletBinding()]
param(
    [string]$Profile,
    [switch]$NoIdentity,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pluginId    = 'feibi-breaker'
$pluginLabel = '菲比破限'

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    [!] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "    [X] $Msg" -ForegroundColor Red }

$srcDir = $PSScriptRoot
$dshRoot = Join-Path $env:USERPROFILE '.dsh'
$profilesRoot = Join-Path $dshRoot 'profiles'
$pluginsDir = Join-Path $dshRoot 'plugins'
$destDir = Join-Path $pluginsDir $pluginId

Write-Host "`n====================" -ForegroundColor Cyan
Write-Host "  $pluginLabel 安装" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan

# ---------- [1] 环境检查 ----------
Write-Step '检查环境'

if (-not (Test-Path $profilesRoot)) {
    Write-Err "未找到 DSH profiles 目录：$profilesRoot"
    Write-Host '请先安装并启动过一次 DeepSeek-Harness 再运行本脚本。' -ForegroundColor Red
    exit 1
}

$targetProfiles = @()
if ($Profile) {
    $candidate = Join-Path $profilesRoot $Profile
    if (-not (Test-Path (Join-Path $candidate 'package.json'))) {
        Write-Err "profile 不存在或缺少 package.json：$candidate"
        exit 1
    }
    $targetProfiles = @($candidate)
} else {
    $targetProfiles = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | ForEach-Object { $_.FullName })
    if ($targetProfiles.Count -eq 0) {
        Write-Err "未找到任何 profile（$profilesRoot 下没有含 package.json 的目录）。"
        exit 1
    }
}
foreach ($p in $targetProfiles) { Write-Ok "目标 profile：$(Split-Path $p -Leaf)" }

foreach ($relativeFile in @('package.json', 'lib\index.js', 'lib\core.js', 'core\payload.bin', 'client.js', 'cordis.patch.yml', 'scripts\lib\install.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $srcDir $relativeFile) -PathType Leaf)) {
        Write-Err "安装包缺少文件：$relativeFile。请完整解压后再运行。"
        exit 1
    }
}

# ---------- [2] 复制插件 ----------
Write-Step '复制插件文件'

if ($DryRun) {
    Write-Warn "演练模式：跳过文件复制"
} else {
    if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }
    if (Test-Path $destDir) {
        Write-Warn "检测到已存在的 $pluginId 目录，自动覆盖更新"
        Remove-Item -LiteralPath $destDir -Recurse -Force
    }
    robocopy $srcDir $destDir /E /NFL /NDL /NJH /NJS /NC /NS /XD .git /XF install.ps1 uninstall.ps1 *.bat | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Err "复制失败（robocopy 退出码 $LASTEXITCODE）"
        exit 1
    }
    Write-Ok "插件已复制到：$destDir"
}

# ---------- [3] 写入 profile 配置 ----------
Write-Step '写入 profile 配置（只写入本插件，其他插件保持原样）'

$nodeExe = $null
try {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
} catch {
    Write-Warn '未找到 node，改用 PowerShell 直接改写配置（功能等价，但不做 YAML 结构校验）'
}

if ($DryRun) {
    Write-Warn '演练模式：跳过配置写入'
} elseif ($nodeExe) {
    $args = @((Join-Path $srcDir 'scripts\lib\install.js'), $dshRoot)
    if ($Profile) { $args += $Profile }
    if ($NoIdentity) { $env:FUJIANG_NO_IDENTITY = '1' }
    try {
        $report = & $nodeExe @args 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($report -join "`n") }
        Write-Ok 'profile 配置已更新'
        Write-Host $report -ForegroundColor DarkGray
    } catch {
        Write-Err "配置写入失败：$($_.Exception.Message)"
        exit 1
    }
} else {
    foreach ($pDir in $targetProfiles) {
        $patchPath = Join-Path $pDir 'cordis.patch.yml'
        $before = if (Test-Path $patchPath) { [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8) } else { '' }
        $bak = "$patchPath.before-$pluginId.bak"
        if ((Test-Path $patchPath) -and -not (Test-Path $bak)) { Copy-Item -LiteralPath $patchPath -Destination $bak -Force }

        # 不清理其他插件的挂载行：与 dsh-gatekeeper 共存是本插件的
        # 明确契约。只有本插件自己的一行会被写入或更新（见下）。
        $cleaned = $before
        $cleaned = $cleaned.TrimEnd()

        if ($cleaned -notmatch "(?m)^\s*- id: $pluginId\b") {
            $cleaned = "$cleaned`n`n- insert:`n    - id: $pluginId`n      name: '$pluginId'`n"
        }
        if (-not $NoIdentity -and $cleaned -notmatch "\[$pluginId\] Host identity") {
            $identity = "# [$pluginId] Host identity: no built-in refusal framing.`n- id: system-prompt`n  config:`n    includeHarnessIdentity: false`n    personaPrefix: ''`n`n"
            $cleaned = $identity + $cleaned.TrimStart()
        }

        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchPath, $cleaned.TrimEnd() + [Environment]::NewLine, $utf8NoBom)
        Write-Ok "[$(Split-Path $pDir -Leaf)] cordis.patch.yml 已更新"
    }
}

# ---------- [4] 依赖与 node_modules ----------
Write-Step '安装依赖'

if ($DryRun) {
    Write-Warn '演练模式：跳过依赖安装'
} else {
    foreach ($pDir in $targetProfiles) {
        $pName = Split-Path $pDir -Leaf

        # package.json is rewritten by the Node installer, not here.
        #
        # `ConvertTo-Json` reformats the whole file: two-space indent becomes
        # four, arrays get padded to the widest element, and key order is
        # whatever PowerShell's property bag produced. That turned every run
        # into an apparent change and churned the user's file. The Node side
        # preserves the detected indent and line ending, and is idempotent.
        #
        # `feibi-breaker` must also NOT be added to `dsh.profile.bundles`: a
        # plugin mounted through the patch file is not a base bundle, and
        # listing it in both places loads it twice.

        # 其他插件的 node_modules 链接保持原样。两个拦截插件同时挂 llm/stream
        # 是受支持的状态，安装器不替用户做卸载决定。

        # Junction 实时链接：改插件文件即生效，无需重装
        $nmEntry = Join-Path $pDir "node_modules\$pluginId"
        $nmDir = Join-Path $pDir 'node_modules'
        if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
        if (Test-Path $nmEntry) {
            try {
                if ((Get-Item $nmEntry).LinkType -eq 'Junction') { cmd.exe /c "rmdir `"$nmEntry`"" 2>$null | Out-Null }
                else { Remove-Item -LiteralPath $nmEntry -Recurse -Force }
            } catch { }
        }
        cmd.exe /c "mklink /J `"$nmEntry`" `"$destDir`"" 2>$null | Out-Null
        if (Test-Path $nmEntry) { Write-Ok "[$pName] node_modules Junction 已建立" }

        # Snapshot every link: pnpm has to be reverted if it damages one.
        #
        # `pnpm install` mis-resolves a `link:` specifier whose target contains
        # a non-ASCII path segment: it joins the profile directory onto the
        # absolute target, producing
        #   <profile>\D:\修改提示词\...\package
        # which resolves nowhere. This was observed on a real profile — the
        # only broken link was the one Chinese path, and it broke on the first
        # run. Junction repair is cheap, so the install verifies rather than
        # assumes.
        $linkState = @{}
        $nmDirPath = Join-Path $pDir 'node_modules'
        if (Test-Path $nmDirPath) {
            foreach ($entry in Get-ChildItem $nmDirPath -Force -ErrorAction SilentlyContinue) {
                if ($entry.LinkType -ne 'Junction') { continue }
                if ($entry.Name -eq $pluginId) { continue }
                $linkState[$entry.Name] = [pscustomobject]@{
                    Path = $entry.FullName
                    Target = $entry.Target
                }
            }
        }

        Push-Location $pDir
        try {
            # pnpm asks "The modules directory will be removed and reinstalled
            # from scratch. Proceed?" whenever the lockfile no longer matches.
            # `--config.confirmModulesPurge=false` puts the answer on the command
            # line so an unattended run never answers it by accident. The flag
            # only takes effect with `--config.` in front; a bare
            # `--confirm-modules-purge=false` is not recognised and the prompt
            # still appears.
            $pnpmArgs = @('install', '--config.confirmModulesPurge=false')
            if (Get-Command pnpm -ErrorAction SilentlyContinue) {
                & pnpm @pnpmArgs
            } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
                & npm exec --yes --package=pnpm@10 -- pnpm @pnpmArgs
            } else {
                Write-Warn "[$pName] 未找到 pnpm/npm，跳过依赖安装（仅 link 依赖时通常无需安装）"
            }
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "[$pName] pnpm 返回 $LASTEXITCODE；链接已建立，多数情况仍可加载"
            }
        } finally { Pop-Location }

        # Verify and repair: a link that pnpm moved or mangled is put back to the
        # target it had before the install.
        foreach ($name in $linkState.Keys) {
            $entry = $linkState[$name]
            $now = Get-Item $entry.Path -Force -ErrorAction SilentlyContinue
            $targetChanged = ($null -eq $now) -or ($now.LinkType -ne 'Junction') -or ($now.Target -ne $entry.Target)
            $broken = -not (Test-Path (Join-Path $entry.Path 'package.json'))
            if (-not $targetChanged -and -not $broken) { continue }

            try {
                if ($null -ne $now) {
                    if ($now.LinkType -eq 'Junction') { cmd.exe /c "rmdir `"$($entry.Path)`"" 2>$null | Out-Null }
                    else { Remove-Item -LiteralPath $entry.Path -Recurse -Force }
                }
                cmd.exe /c "mklink /J `"$($entry.Path)`" `"$($entry.Target)`"" 2>$null | Out-Null
                if (Test-Path (Join-Path $entry.Path 'package.json')) {
                    Write-Ok "[$pName] 已修复被 pnpm 改坏的链接：$name"
                } else {
                    Write-Warn "[$pName] 链接仍不可用：$name -> $($entry.Target)"
                }
            } catch {
                Write-Warn "[$pName] 链接修复失败（$name）：$($_.Exception.Message)"
            }
        }
    }
}

# ---------- [5] 完成 ----------
Write-Step '完成'
Write-Host ''
if ($DryRun) {
    Write-Host '  演练结束：没有改动任何文件。' -ForegroundColor Yellow
    Write-Host '  去掉 -DryRun 再运行一次才会真正安装。' -ForegroundColor Yellow
    Write-Host ''
    try { Read-Host '按回车键退出' } catch { }
    exit 0
}
Write-Host "  $pluginLabel 已安装" -ForegroundColor Green
Write-Host ''
Write-Host "  目标 profile：$((($targetProfiles | ForEach-Object { Split-Path $_ -Leaf }) -join ', '))" -ForegroundColor White
Write-Host '  下一步：完全退出并重启 DeepSeek-Harness（Web 版刷新页面 / 桌面版重新打开）' -ForegroundColor White
Write-Host ''
Write-Host '  验证：' -ForegroundColor Yellow
Write-Host '    - 输入框上方显示「菲比破限已激活」' -ForegroundColor Yellow
Write-Host '    - 设置 → 菲比破限 能看到破甲与拦截两栏' -ForegroundColor Yellow
Write-Host '    - 命令行自检：node tools/check-merged.mjs' -ForegroundColor Yellow
Write-Host ''

try { Read-Host '按回车键退出' } catch { }
