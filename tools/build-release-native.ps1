# build-release-native.ps1 - one command to produce the native Latch's Windows release: the zip Vacant Systems
# Manager installs. There is no standalone installer since 2026-11-20: the manager installs, updates and removes it.
#
#   & .\tools\build-release-native.ps1              # full release build
#   & .\tools\build-release-native.ps1 -SkipCpp     # reuse the core + GUI builds
#   & .\tools\build-release-native.ps1 -SkipYtdlp   # ship without a bundled yt-dlp (the first extract downloads it)
#
# Steps, in order:
#   1. the core CLI (cmake build/ --target latch)            -> stage\coredist\latch.exe
#   2. the GUI (native/, its own build tree on the pinned vpf and WAVdesk commits) -> stage\latch-gui.exe
#   3. yt-dlp into stage\resources\ytdlp (no ffmpeg: the suite's Shared\bin copy, fetched on first run)
#   4. the manager's zip: native\build-release\manager\Latch-<ver>-win-x64.zip (one Latch\ folder; latch-gui --setup
#      does the shortcuts and the entry, native/app/setup_cli.cpp)
#
# The GUI builds in native\build-release with no FETCHCONTENT_SOURCE_DIR_* overrides: a release is the pinned commits
# (native/CMakeLists.txt GIT_TAG), never a local checkout's working tree. Quit Latch first.

param(
    [string]$Configuration = 'Release',
    [switch]$Clean,
    [switch]$SkipCpp,
    [switch]$SkipYtdlp
)

$ErrorActionPreference = 'Stop'

$repo      = Split-Path -Parent $PSScriptRoot
$build     = Join-Path $repo 'build'
$native    = Join-Path $repo 'native'
$out       = Join-Path $native 'build-release'
$guiBuild  = Join-Path $out 'build'
$stage     = Join-Path $out 'stage'
$coredist  = Join-Path $stage 'coredist'
$tauriRes  = Join-Path $repo 'gui\src-tauri\resources'
$script:LogPath = Join-Path $out 'last-release-build.log'

# the version: tauri.conf.json's, the one source native/CMakeLists.txt also reads (the exe's VERSIONINFO, About)
$version = (Get-Content (Join-Path $repo 'gui\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

if ($Clean -and (Test-Path $out)) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Content -Path $script:LogPath -Value "build-release-native $version $(Get-Date -Format s)"

function Step($n, $msg) { Write-Host "`n[$n/4] $msg" -ForegroundColor Cyan }

# cmake and friends write warnings to stderr; under EAP Stop one stderr line would abort a good build, so the exit code
# is the only failure signal
function Invoke-Native([scriptblock]$Block, [string]$What) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block 2>&1 | Tee-Object -FilePath $script:LogPath -Append }
    finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

# ---- 1: the core ----
Step 1 "the core CLI ($Configuration)"
if ($SkipCpp) {
    Write-Host "  -SkipCpp: reusing build/" -ForegroundColor Yellow
} else {
    Invoke-Native { & cmake -B $build -S $repo } "cmake configure (core)"
    Invoke-Native { & cmake --build $build --config $Configuration --target latch } "cmake build (core)"
}
$relDir  = Join-Path $build $Configuration
$coreSrc = Join-Path $relDir 'latch.exe'
if (-not (Test-Path $coreSrc)) { throw "core binary not found: $coreSrc (run without -SkipCpp?)" }
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $coredist | Out-Null
Copy-Item $coreSrc $coredist -Force
Get-ChildItem -Path $relDir -Filter '*.dll' -EA SilentlyContinue | Copy-Item -Destination $coredist -Force
$coreVersion = (& (Join-Path $coredist 'latch.exe') --version | Out-String).Trim()
Write-Host "  staged $coreVersion -> $coredist"

# ---- 2: the GUI ----
Step 2 "the native GUI ($Configuration, pinned vpf + WAVdesk)"
if (-not $SkipCpp -or -not (Test-Path (Join-Path $guiBuild "bin\$Configuration\latch-gui.exe"))) {
    Invoke-Native { & cmake -S $native -B $guiBuild -A x64 -U 'FETCHCONTENT_SOURCE_DIR_*' } "cmake configure (GUI)"
    Invoke-Native { & cmake --build $guiBuild --config $Configuration --target latch_gui } "cmake build (GUI)"
}
$guiExe = Join-Path $guiBuild "bin\$Configuration\latch-gui.exe"
if (-not (Test-Path $guiExe)) { throw "GUI not found: $guiExe" }
Copy-Item $guiExe $stage -Force
Write-Host "  -> $(Join-Path $stage 'latch-gui.exe')"

# ---- 3: the bundled tools ----
Step 3 "yt-dlp"
$ytdlp = Join-Path $tauriRes 'ytdlp\yt-dlp.exe'
if ($SkipYtdlp) {
    Write-Host "  -SkipYtdlp: no bundled yt-dlp (the first extract downloads it)" -ForegroundColor Yellow
} else {
    if (-not (Test-Path $ytdlp)) { & (Join-Path $PSScriptRoot 'fetch-ytdlp.ps1') -Dest (Split-Path $ytdlp) }
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'resources\ytdlp') | Out-Null
    Copy-Item $ytdlp (Join-Path $stage 'resources\ytdlp') -Force
    Write-Host "  yt-dlp -> stage\resources\ytdlp"
}

# ---- 4: the manager's package ----
# vacant-labs apps/manager/docs/app-contract.md, 2: the stage (no ffmpeg, fetched on first run) as one Latch\ folder.
# Windows' bsdtar writes forward slashes; fixed timestamps so the same stage packs the same (catalog.py pack sorts it again)
Step 4 "the manager's zip"
$mgr  = Join-Path $out 'manager'
$zip  = Join-Path $mgr "Latch-$version-win-x64.zip"
$pack = Join-Path $out 'manager-pack'
if (Test-Path $pack) { Remove-Item -Recurse -Force $pack }
New-Item -ItemType Directory -Force -Path (Join-Path $pack 'Latch'), $mgr | Out-Null
Copy-Item (Join-Path $stage '*') (Join-Path $pack 'Latch') -Recurse -Force
$fixed = Get-Date '2020-01-01T00:00:00'
Get-ChildItem $pack -Recurse | ForEach-Object { $_.LastWriteTime = $fixed }
if (Test-Path $zip) { Remove-Item -Force $zip }
Invoke-Native { & "$env:SystemRoot\System32\tar.exe" -a -cf $zip -C $pack Latch } "tar (manager zip)"
Remove-Item -Recurse -Force $pack

Write-Host "`nRelease ready:" -ForegroundColor Green
Write-Host "  manager     $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
