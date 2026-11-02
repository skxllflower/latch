# build-release-native.ps1 - one command to produce the native Latch's Windows installers (the vpf GUI in native/,
# replacing the Tauri one that tools/build-release.ps1 bundles).
#
#   & .\tools\build-release-native.ps1              # full release build: both installers
#   & .\tools\build-release-native.ps1 -SkipCpp     # reuse the core + GUI builds
#   & .\tools\build-release-native.ps1 -SkipYtdlp   # ship without a bundled yt-dlp (the first extract downloads it)
#
# Two installers, as the Tauri build made (build-release.ps1 and its -Embedded):
#   standalone  native\build-release\Latch_<ver>_x64-setup.exe           bundles yt-dlp AND ffmpeg + ffprobe: Latch
#               alone works offline and seeds Shared\bin for a WAVdesk installed later
#   embedded    native\build-release\embedded\Latch_<ver>_x64-setup.exe  no ffmpeg: the copy WAVdesk ships inside its
#               own installer (WAVdesk provisions the suite's ffmpeg before it offers this one)
#
# Steps, in order:
#   1. the core CLI (cmake build/ --target latch)            -> stage\coredist\latch.exe
#   2. the GUI (native/, its own build tree on the pinned vpf and WAVdesk commits) -> stage\latch-gui.exe
#   3. yt-dlp into stage\resources\ytdlp, ffmpeg + ffprobe into ffmpeg\ (the Tauri build's vendored copies when present)
#   4. makensis native/installer/latch.nsi, twice (with /DFFMPEG, then without)
#   5. copies into gui\src-tauri\target\release\bundle\nsis\ (standalone) and nsis-embedded\ (embedded), where
#      WAVdesk's build-release-native.ps1 picks up Latch's installer for its companion offer (the embedded one)
#
# The GUI builds in native\build-release with no FETCHCONTENT_SOURCE_DIR_* overrides: a release is the pinned commits
# (native/CMakeLists.txt GIT_TAG), never a local checkout's working tree. Quit Latch first.

param(
    [string]$Configuration = 'Release',
    [string]$Makensis      = '',
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
$ffStage   = Join-Path $out 'ffmpeg'
$tauriRes  = Join-Path $repo 'gui\src-tauri\resources'
$icon      = Join-Path $repo 'gui\src-tauri\icons\icon.ico'
$script:LogPath = Join-Path $out 'last-release-build.log'

# the version: tauri.conf.json's, the one source native/CMakeLists.txt also reads (the exe's VERSIONINFO, About)
$version = (Get-Content (Join-Path $repo 'gui\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

if ($Clean -and (Test-Path $out)) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Content -Path $script:LogPath -Value "build-release-native $version $(Get-Date -Format s)"

function Step($n, $msg) { Write-Host "`n[$n/5] $msg" -ForegroundColor Cyan }

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
Step 3 "yt-dlp + ffmpeg"
$ytdlp = Join-Path $tauriRes 'ytdlp\yt-dlp.exe'
if ($SkipYtdlp) {
    Write-Host "  -SkipYtdlp: no bundled yt-dlp (the first extract downloads it)" -ForegroundColor Yellow
} else {
    if (-not (Test-Path $ytdlp)) { & (Join-Path $PSScriptRoot 'fetch-ytdlp.ps1') -Dest (Split-Path $ytdlp) }
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'resources\ytdlp') | Out-Null
    Copy-Item $ytdlp (Join-Path $stage 'resources\ytdlp') -Force
    Write-Host "  yt-dlp -> stage\resources\ytdlp"
}
$ffSrc = Join-Path $tauriRes 'ffmpeg'
if (-not ((Test-Path (Join-Path $ffSrc 'ffmpeg.exe')) -and (Test-Path (Join-Path $ffSrc 'ffprobe.exe')))) {
    & (Join-Path $PSScriptRoot 'fetch-ffmpeg.ps1') -Dest $ffSrc
}
if (Test-Path $ffStage) { Remove-Item -Recurse -Force $ffStage }
New-Item -ItemType Directory -Force -Path $ffStage | Out-Null
foreach ($f in 'ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt') {
    $p = Join-Path $ffSrc $f
    if (Test-Path $p) { Copy-Item $p $ffStage -Force }
}
Write-Host "  ffmpeg + ffprobe -> $ffStage (the standalone installer only)"

# ---- 4: the installers ----
Step 4 "makensis (standalone, then embedded)"
if (-not $Makensis) {
    $cands = @((Get-Command makensis -EA SilentlyContinue).Source,
               "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
               "$env:ProgramFiles\NSIS\makensis.exe",
               "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe") | Where-Object { $_ -and (Test-Path $_) }
    $Makensis = $cands | Select-Object -First 1
}
if (-not $Makensis) { throw "makensis not found: install NSIS 3 (nsis.sourceforge.io) or pass -Makensis <path>." }
$nsi = Join-Path $native 'installer\latch.nsi'
$setup = Join-Path $out "Latch_${version}_x64-setup.exe"
Invoke-Native { & $Makensis /V2 "/DVERSION=$version" "/DSTAGE=$stage" "/DFFMPEG=$ffStage" "/DOUTFILE=$setup" "/DICON=$icon" $nsi } "makensis (standalone)"
New-Item -ItemType Directory -Force -Path (Join-Path $out 'embedded') | Out-Null
$embedded = Join-Path $out "embedded\Latch_${version}_x64-setup.exe"
Invoke-Native { & $Makensis /V2 "/DVERSION=$version" "/DSTAGE=$stage" "/DOUTFILE=$embedded" "/DICON=$icon" $nsi } "makensis (embedded)"

# ---- 5: where WAVdesk's release looks for them ----
Step 5 "copy for WAVdesk's companion offer"
foreach ($pair in @(@($setup, 'nsis'), @($embedded, 'nsis-embedded'))) {
    $dir = Join-Path $repo "gui\src-tauri\target\release\bundle\$($pair[1])"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item $pair[0] $dir -Force
    (Get-Item (Join-Path $dir (Split-Path -Leaf $pair[0]))).LastWriteTime = Get-Date   # (WAVdesk takes the newest)
    Write-Host "  -> $dir"
}

Write-Host "`nInstallers ready:" -ForegroundColor Green
Write-Host "  standalone  $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)"
Write-Host "  embedded    $embedded ($([math]::Round((Get-Item $embedded).Length / 1MB, 1)) MB)"
