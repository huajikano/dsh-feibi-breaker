# feibi-breaker installer (wrapper).
#
# All logic lives in scripts/install.mjs. This file only locates a Node runtime
# and forwards arguments, so there is exactly one implementation of the install
# steps and a non-ASCII path never passes through PowerShell argument quoting.
#
# Usage:
#   .\install.ps1 -Profile desktop
#   .\install.ps1 -Profile desktop -DryRun
#   .\install.ps1 -All

[CmdletBinding()]
param(
    [string]$Profile,
    [switch]$All,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $command) { return @{ Exe = $command.Source; Prefix = '' } }

    # DeepSeek-Harness ships its own Electron runtime; it runs scripts as Node
    # when ELECTRON_RUN_AS_NODE is set.
    $harness = $env:DSH_NODE_EXECUTABLE
    if ($harness -and (Test-Path -LiteralPath $harness)) {
        return @{ Exe = $harness; Prefix = 'electron' }
    }
    $default = Join-Path $env:ProgramFiles 'DeepSeek\DeepSeek Harness.exe'
    if (Test-Path -LiteralPath $default) { return @{ Exe = $default; Prefix = 'electron' } }
    return $null
}

$node = Find-Node
if ($null -eq $node) {
    Write-Host 'Node.js was not found and the DeepSeek-Harness runtime was not located.' -ForegroundColor Red
    Write-Host 'Install Node.js 20 or newer, or set DSH_NODE_EXECUTABLE to the Harness binary.' -ForegroundColor Yellow
    exit 1
}

$script = Join-Path $root 'scripts\install.mjs'
$scriptArgs = @($script)
if ($Profile) { $scriptArgs += @('--profile', $Profile) }
if ($All) { $scriptArgs += '--all' }
if ($DryRun) { $scriptArgs += '--dry-run' }

if ($node.Prefix -eq 'electron') { $env:ELECTRON_RUN_AS_NODE = '1' }
& $node.Exe @scriptArgs
exit $LASTEXITCODE
