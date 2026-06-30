# fetch-ffmpeg.ps1 - vendor the ffmpeg.exe CLI for Latch's shared bin.
# Latch's C++ core resolves ffmpeg from %ProgramData%\Vacant Systems\Shared\bin
# (paths.cpp resolved_ffmpeg -> shared_bin_path). Bundling it into resources lets
# tools.rs provision_ffmpeg seed that shared bin on launch so the chop/clip video
# features work standalone without WAVdesk installed and without the core's
# runtime GitHub download. Source matches the core's bootstrap fallback: the BtbN
# GPL static build. ffmpeg runs as a SEPARATE subprocess (mere aggregation), so
# its GPL doesn't affect Latch's own license; the build's LICENSE is copied
# alongside for compliance.
#
#   pwsh tools/fetch-ffmpeg.ps1                 # -> .\tools\ffmpeg\
#   pwsh tools/fetch-ffmpeg.ps1 -Dest "<path>"

param(
    [string]$Dest = (Join-Path $PSScriptRoot 'ffmpeg')
)

$ErrorActionPreference = 'Stop'

$url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
Write-Host "ffmpeg (BtbN latest, win64 GPL)"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("latch-ffmpeg-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'ffmpeg.zip'

Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -MaximumRedirection 10
# The GPL zip is ~40-50 MB; a tiny payload means an error page, not the build.
if ((Get-Item $zip).Length -lt 5000000) { Remove-Item $zip -Force; throw "ffmpeg zip too small (got an error page?)" }

Expand-Archive -Path $zip -DestinationPath $tmp -Force
# BtbN ships it at <root>/bin/ffmpeg.exe - walk to find it.
$exe = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
if (-not $exe) { throw "ffmpeg.exe not found in the extracted package" }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Path $exe.FullName -Destination (Join-Path $Dest 'ffmpeg.exe') -Force
# GPL compliance: ship the build's license text alongside the binary.
$lic = Get-ChildItem -Path $tmp -Recurse -Include 'LICENSE*','COPYING*' | Select-Object -First 1
if ($lic) { Copy-Item -Path $lic.FullName -Destination (Join-Path $Dest 'LICENSE.txt') -Force }

Remove-Item -Recurse -Force $tmp
Write-Host "Placed: $(Join-Path $Dest 'ffmpeg.exe')"
