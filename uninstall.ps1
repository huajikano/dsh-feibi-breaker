# feibi-breaker uninstaller (wrapper).
#
# All logic lives in scripts/uninstall.mjs. Only this plugin's row, dependency
# and link are removed; the plugin directory is moved into
# $DSH_HOME\backups\feibi-breaker\removed-<stamp> instead of being deleted, so a
# junction back to a checkout can never take a source tree with it.
#
# Usage:
#   .\uninstall.ps1 -Profile desktop
#   .\uninstall.ps1 -Profile desktop -DryRun

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
    exit 1
}

$script = Join-Path $root 'scripts\uninstall.mjs'
$scriptArgs = @($script)
if ($Profile) { $scriptArgs += @('--profile', $Profile) }
if ($All) { $scriptArgs += '--all' }
if ($DryRun) { $scriptArgs += '--dry-run' }

if ($node.Prefix -eq 'electron') { $env:ELECTRON_RUN_AS_NODE = '1' }
& $node.Exe @scriptArgs
exit $LASTEXITCODE
