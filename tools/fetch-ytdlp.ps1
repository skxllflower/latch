# fetch-ytdlp.ps1 - vendor the yt-dlp Windows binary for Latch's URL extractor.
# yt-dlp is spawned as a subprocess by the C++ core; bundling it lets a fresh
# install work fully offline instead of downloading from GitHub on first use.
#
#   pwsh tools/fetch-ytdlp.ps1                 # -> .\tools\ytdlp\
#   pwsh tools/fetch-ytdlp.ps1 -Dest "<path>"
#
# Source matches the core's runtime fallback (bootstrap.cpp): the latest
# yt-dlp.exe from the yt-dlp GitHub releases. Single .exe, no archive.

param(
    [string]$Dest = (Join-Path $PSScriptRoot 'ytdlp')
)

$ErrorActionPreference = 'Stop'

$url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
Write-Host "yt-dlp (latest release)"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$out = Join-Path $Dest 'yt-dlp.exe'

Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -MaximumRedirection 10
# yt-dlp.exe is ~17 MB; treat a tiny payload as an error page / miss.
if ((Get-Item $out).Length -lt 1000000) {
    Remove-Item $out -Force
    throw "yt-dlp.exe download too small (got an error page?)"
}
Write-Host "Placed: $out"
