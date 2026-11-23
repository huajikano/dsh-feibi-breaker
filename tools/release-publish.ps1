# Publish a GitHub Release for this repo using the locally stored git credential.
#
# The token never leaves this process: it is written to a header file in %TEMP%,
# passed to curl as `-H @file`, and deleted afterwards. Nothing is echoed, and
# the script is idempotent (an existing release or asset is reused, not
# duplicated).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\release-publish.ps1 `
#       -Tag v1.2.0 -AssetPath ..\dist\dsh-feibi-breaker-1.2.0.zip

[CmdletBinding()]
param(
    [string]$Repo = 'huajikano/dsh-feibi-breaker',
    [string]$Tag = 'v1.2.0',
    [string]$Title,
    [string]$AssetPath,
    [string]$Proxy = $env:HTTPS_PROXY,
    # Windows' schannel build of curl rejects the certificate this proxy
    # presents; Git for Windows ships its own CA bundle, and pointing curl at it
    # verifies the same chain the way `git push` already does.
    [string]$CaBundle = 'D:\Git\ucrt64\etc\ssl\certs\ca-bundle.crt'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Title) {
    $changelog = Get-Content -LiteralPath (Join-Path $repoRoot 'CHANGELOG.md') -Raw -Encoding UTF8
    $heading = [regex]::Match($changelog, "(?m)^##\s+$([regex]::Escape($Tag.TrimStart('v')))\s+—\s+(.+)$")
    $Title = if ($heading.Success) { "$($Tag.TrimStart('v')) — $($heading.Groups[1].Value.Trim())" } else { $Tag }
}

if (-not $AssetPath) {
    $candidate = Join-Path (Split-Path -Parent $repoRoot) "dist\dsh-feibi-breaker-$($Tag.TrimStart('v')).zip"
    if (Test-Path -LiteralPath $candidate) { $AssetPath = $candidate }
}

$cred = ("protocol=https`nhost=github.com`n`n" | git credential fill) | Out-String
$token = [regex]::Match($cred, '(?m)^password=(.+)$').Groups[1].Value.Trim()
if ($token -eq '') { throw 'no stored GitHub credential for github.com' }

$headerFile = Join-Path $env:TEMP 'gh-release-header.txt'
[System.IO.File]::WriteAllText($headerFile, "Authorization: token $token`nAccept: application/vnd.github+json`n", [System.Text.UTF8Encoding]::new($false))
$payloadFile = Join-Path $env:TEMP 'gh-release.json'

function Invoke-Curl {
    param([string[]]$Arguments)
    $prefix = @('-sS')
    if ($CaBundle -and (Test-Path -LiteralPath $CaBundle)) { $prefix += @('--cacert', $CaBundle) }
    if ($Proxy) { $prefix += @('--proxy', $Proxy) }
    $raw = & curl.exe @($prefix + $Arguments)
    if ($LASTEXITCODE -ne 0) { throw "curl exited $LASTEXITCODE" }
    return $raw
}

function Get-Json {
    param([string]$Url)
    $raw = Invoke-Curl @('-H', "@$headerFile", $Url)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { return $raw | ConvertFrom-Json } catch { return $null }
}

try {
    $who = Get-Json 'https://api.github.com/user'
    if ($null -eq $who) { throw 'the stored credential cannot reach the GitHub API' }
    Write-Host "authenticated as: $($who.login)"

    $changelog = Get-Content -LiteralPath (Join-Path $repoRoot 'CHANGELOG.md') -Raw -Encoding UTF8
    $version = $Tag.TrimStart('v')
    $start = $changelog.IndexOf("## $version")
    if ($start -lt 0) { throw "CHANGELOG.md has no $version section" }
    $next = [regex]::Match($changelog.Substring($start + 3), '(?m)^##\s')
    $body = if ($next.Success) { $changelog.Substring($start, $start + 3 + $next.Index - $start) } else { $changelog.Substring($start) }
    $body = $body.Trim()

    $payload = [ordered]@{
        tag_name   = $Tag
        name       = $Title
        body       = $body
        draft      = $false
        prerelease = $false
        make_latest = 'true'
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($payloadFile, $payload, [System.Text.UTF8Encoding]::new($false))

    $release = Get-Json "https://api.github.com/repos/$Repo/releases/tags/$Tag"
    if ($null -ne $release -and $release.id) {
        Write-Host "release already exists: $($release.html_url)"
    } else {
        $created = Invoke-Curl @('-X', 'POST', '-H', "@$headerFile", '--data-binary', "@$payloadFile", "https://api.github.com/repos/$Repo/releases") | ConvertFrom-Json
        if (-not $created.id) { throw 'release creation failed' }
        Write-Host "release created: $($created.html_url)"
        $release = $created
    }

    if ($AssetPath -and (Test-Path -LiteralPath $AssetPath)) {
        $name = [IO.Path]::GetFileName($AssetPath)
        $current = Get-Json "https://api.github.com/repos/$Repo/releases/tags/$Tag"
        $listed = $current.assets | Where-Object { $_.name -eq $name }
        if ($listed) {
            Write-Host "asset already uploaded: $($listed.browser_download_url)"
        } else {
            $uploadUrl = $release.upload_url -replace '\{.*$', ''
            $uploaded = Invoke-Curl @('-X', 'POST', '-H', "@$headerFile", '-H', 'Content-Type: application/zip', '--data-binary', "@$AssetPath", "$uploadUrl?name=$name") | ConvertFrom-Json
            Write-Host "asset uploaded: $($uploaded.browser_download_url)"
        }
    } else {
        Write-Host 'no asset supplied; release created without a ZIP'
    }
} finally {
    foreach ($file in @($headerFile, $payloadFile)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
}
