<#
.SYNOPSIS
    ml-dash installer for Windows.

.DESCRIPTION
    Installs one self-contained ml-dash binary. Nothing else is required on the
    machine — no Node, no npm, no Python — and nothing else is required after.
    The download is checked against the sha256 in the release manifest before
    anything is written to the install directory, so a pinned -Version installs
    identical bytes everywhere.

.EXAMPLE
    irm https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.ps1 | iex

.EXAMPLE
    & ([scriptblock]::Create((irm https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.ps1))) -Version 0.1.0
#>
[CmdletBinding()]
param(
    [string]$Version    = $env:ML_DASH_VERSION,
    [string]$Channel    = $(if ($env:ML_DASH_CHANNEL) { $env:ML_DASH_CHANNEL } else { 'latest' }),
    [string]$InstallDir = $(if ($env:ML_DASH_INSTALL_DIR) { $env:ML_DASH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ml-dash\bin' }),
    [string]$BaseUrl    = $(if ($env:ML_DASH_BASE_URL) { $env:ML_DASH_BASE_URL } else { 'https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev' }),
    # Take over an install-directory entry this installer does not own.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Windows PowerShell 5.1 negotiates TLS 1.0 by default, which R2 refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Invoke-WebRequest renders a progress bar per chunk under 5.1; on a ~60 MB
# binary that costs more time than the download itself.
$ProgressPreference = 'SilentlyContinue'

$BaseUrl = $BaseUrl.TrimEnd('/')
$Prefix  = 'ml-dash-cli/releases'

function Die([string]$Message) { Write-Error "ml-dash install: $Message"; exit 1 }

# ── platform ─────────────────────────────────────────────────────────────────
$archRaw = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $archRaw = $env:PROCESSOR_ARCHITEW6432 }
switch ($archRaw) {
    'AMD64' { $platform = 'windows-x64' }
    'ARM64' { $platform = 'windows-arm64' }
    default { Die "unsupported architecture '$archRaw'" }
}

# ── version ──────────────────────────────────────────────────────────────────
if (-not $Version) {
    try {
        $Version = (Invoke-WebRequest -Uri "$BaseUrl/$Prefix/$Channel" -UseBasicParsing).Content.Trim()
    } catch {
        Die "cannot read channel '$Channel' from $BaseUrl/$Prefix/$Channel"
    }
    if (-not $Version) { Die "channel '$Channel' is empty" }
}

$rel = "$BaseUrl/$Prefix/$Version"
# A per-run temp directory, removed in finally on success, failure and Ctrl-C
# alike, so a broken download never lingers as a half-installed binary.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ml-dash-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
# Declared out here so the finally block can remove a staged file left inside
# the install directory by a failure between the copy and the rename.
$stage = $null

try {
    Write-Host "ml-dash $Version ($platform)"

    try {
        $manifest = (Invoke-WebRequest -Uri "$rel/manifest.json" -UseBasicParsing).Content | ConvertFrom-Json
    } catch {
        Die "no manifest at $rel/manifest.json - is $Version a published version?"
    }

    # Property lookup via PSObject: under Set-StrictMode, $manifest.platforms.$platform
    # would throw on a release that simply has no build for this platform, and
    # "no build for windows-arm64" is a message, not a crash.
    $entry = $manifest.platforms.PSObject.Properties |
             Where-Object { $_.Name -eq $platform } |
             Select-Object -First 1 -ExpandProperty Value
    if (-not $entry) { Die "release $Version has no build for $platform" }

    $binary = $entry.binary        # ml-dash.exe, read from the manifest rather
                                   # than assumed, so a rename cannot silently
                                   # install the wrong object
    $staged = Join-Path $tmp $binary
    Write-Host "  downloading $rel/$platform/$binary"
    try {
        Invoke-WebRequest -Uri "$rel/$platform/$binary" -OutFile $staged -UseBasicParsing
    } catch {
        Die "download failed: $($_.Exception.Message)"
    }

    $gotSize = (Get-Item $staged).Length
    $gotSha  = (Get-FileHash -Path $staged -Algorithm SHA256).Hash.ToLower()
    if ($entry.size -and $gotSize -ne $entry.size) {
        Die "size mismatch: got $gotSize bytes, manifest says $($entry.size)"
    }
    if ($gotSha -ne $entry.checksum.ToLower()) {
        Die "checksum mismatch: got $gotSha, manifest says $($entry.checksum)"
    }
    Write-Host "  sha256 ok"

    # ── install ──────────────────────────────────────────────────────────────
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $target  = Join-Path $InstallDir 'ml-dash.exe'
    # Written after a successful install and the only ownership claim trusted
    # here: it records the sha256 this installer put at $target.
    $receipt = Join-Path $InstallDir '.ml-dash.receipt'

    # An ml-dash from another channel (npm, pip) is reported and left alone:
    # deleting files this installer did not create would break whatever owns
    # them.
    $existing = Get-Command ml-dash -ErrorAction SilentlyContinue |
                Select-Object -First 1 -ExpandProperty Source -ErrorAction SilentlyContinue
    if ($existing -and $existing -ne $target) {
        $kind = if ($existing -match 'node_modules|npm') { 'an npm install' }
                elseif ($existing -match 'site-packages|pipx|Python') { 'a pip/pipx install' }
                else { 'another install' }
        Write-Host ""
        Write-Host "  note: $kind of ml-dash is already on your PATH at:"
        Write-Host "          $existing"
        Write-Host "        It has not been changed. Whichever comes first in PATH wins;"
        Write-Host "        remove it with its own tool if you want this one to take over."
    }

    # The install path may be occupied by something this installer did not put
    # there. A matching path proves nothing about ownership, so the test is the
    # receipt plus the bytes still being the ones it recorded. A reparse point
    # (symlink or junction, as npm and pipx shims use) is never overwritten.
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        $owned = $false
        $conflict = $null
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $conflict = "$target is a link, not a regular file"
        } elseif (-not (Test-Path -LiteralPath $receipt)) {
            $conflict = "$target already exists and has no install receipt"
        } else {
            $recorded = (Get-Content -LiteralPath $receipt |
                         Where-Object { $_ -like 'sha256=*' } |
                         Select-Object -First 1) -replace '^sha256=', ''
            if ($recorded -and $recorded -eq (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()) {
                $owned = $true
            } else {
                $conflict = "$target has been modified or replaced since this installer wrote it"
            }
        }
        if (-not $owned -and -not $Force) {
            Write-Host ""
            Write-Host "  refusing to overwrite: $conflict"
            Write-Host "  It was not installed by this installer, so removing it could break"
            Write-Host "  whatever owns it. Options:"
            Write-Host "    - install elsewhere:   -InstallDir <dir>"
            Write-Host "    - remove it with the tool that installed it, then re-run"
            Write-Host "    - take it over anyway: -Force"
            exit 1
        }
    }

    # Copy in, then rename: the last step is a move within one volume, so
    # $target is either the old binary or the complete new one. Windows refuses
    # to replace a running exe, which surfaces as a clear error rather than a
    # corrupted install. $stage is cleaned up in finally either way.
    $stage = Join-Path $InstallDir (".ml-dash." + [Guid]::NewGuid().ToString('N') + ".tmp")
    Copy-Item -LiteralPath $staged -Destination $stage -Force
    try {
        Move-Item -LiteralPath $stage -Destination $target -Force
        $stage = $null   # renamed, not ours to delete any more
    } catch {
        Die "cannot install to $target (is ml-dash running?): $($_.Exception.Message)"
    }

    @(
        "channel=r2"
        "version=$Version"
        "platform=$platform"
        "sha256=$gotSha"
        "source=$rel/$platform/$binary"
    ) | Set-Content -LiteralPath $receipt -Encoding ASCII

    Write-Host ""
    Write-Host "  installed $target"

    # PATH is extended for the current user only, and only when this directory
    # is not already there — appending a duplicate on every reinstall would
    # grow the user PATH without bound.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $InstallDir) {
        $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "  added $InstallDir to your user PATH - open a new terminal, then: ml-dash --help"
    } else {
        Write-Host "  run: ml-dash --help"
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($stage) { Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue }
}
