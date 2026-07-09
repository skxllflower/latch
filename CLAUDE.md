# Latch

Standalone media downloader (yt-dlp front-end) + clip chopper. Tauri v2: React/Vite frontend
(`gui/src`), Rust host (`gui/src-tauri`), C++ helper (`src/`, `latch.exe` CLI: probe/expand/download).
Fork-and-owned from WAVdesk scaffolding; also embedded inside WAVdesk as the Latch window.
Owner: skxllflower. Default branch: `master` (NOT main).

## Build / run
- Dev: `cd gui && export PATH="/c/Program Files/nodejs:/c/Users/Owner/AppData/Roaming/npm:$PATH" && pnpm tauri dev` (port 5175).
- Checks: `pnpm typecheck`; `cargo check` / `cargo test` in gui/src-tauri.
- Release: `& .\tools\build-release.ps1` (NSIS only).

## Iron rules + lockstep invariants (violations have shipped bugs)
- **Shared-with-WAVdesk files**: `gui/src/ChopRegionOverlay.tsx` is byte-identical to WAVdesk's copy
  modulo one import path (mirror with `sed "s|from '../utils/chopRegions'|from './chopRegions'|"`).
  Never add wavdesk-only imports to it; edit-suite hooks are optional props Latch does not pass.
- **Shared bin**: ffmpeg etc. resolve via `%LOCALAPPDATA%\Vacant Systems\Shared\bin` manifests;
  resolution order env/portable/managed + installed-location fallbacks must stay lockstep with
  WAVdesk (`external_tools.rs` here <-> wavdesk's copies). Cookie store is the shared
  `Vacant Systems\Shared\cookies.json` — path is a 3-repo invariant.
- **Audio decode**: the standalone plays through rodio + ffmpeg routing (`audio_decode.rs`) because
  symphonia cannot decode Opus and PANICS on m4a — YouTube bestaudio IS opus/m4a. Never regress to
  rodio-only. Waveforms for compressed outputs go through `generate_waveform_any`.
- **yt-dlp**: metadata probes must NOT use `-f bestaudio` + `--js-runtimes` (nsig needs node on PATH,
  absent when launched from Explorer) — metadata-only + `--ignore-no-formats-error`. Radio-mix (RD)
  URLs enumerate hundreds of tracks: strip via youtubeVideoOnlyUrl when noPlaylist.
- New Rust commands doing I/O: `async` + `spawn_blocking`. No em dashes in user-facing text.
- Logging: always-on file log at `%LOCALAPPDATA%\Vacant Systems\Latch\logs\latch.log`
  (+ About -> Open Log File). Extend it rather than adding printlns.

## Coordination
This repo is coordinated together with WAVdesk. The agent-workflow playbook, verification bars, and
the full cross-repo gotcha list live in the WAVdesk repo: `C:\Users\bansh\Dev\wavdesk\.claude\memory\`
(orchestration.md, gotchas.md). Read them before multi-file work here.
Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
