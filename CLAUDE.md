# Latch

Standalone media downloader (yt-dlp front-end) + clip chopper. Tauri v2: React/Vite frontend
(`gui/src`), Rust host (`gui/src-tauri`), C++ helper (`src/`, the `latch` CLI: probe/expand/download).
Being replaced by a native vpf GUI (`native/`, branch `feat/native-vpf`, Windows first; see "Native GUI" below).
Fork-and-owned from WAVdesk scaffolding; also embedded inside WAVdesk as the Latch window.
Owner: skxllflower. Default branch: `master` (NOT main). Version 0.1.8. Ships on Windows (NSIS) and
macOS (Developer ID signed + notarized DMG). Day-to-day development happens on the Mac.

## Build / run
**macOS**
- Shell setup: `export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH"` (cargo comes
  from Homebrew rustup; there is no `~/.cargo/bin`).
- C++ helper: `cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j6` -> `build/latch`.
- Dev GUI: `cd gui && pnpm tauri dev` (port 5175). No codesigning needed in dev.
  A debug build resolves the core from this checkout's `build/` first (`tools.rs`
  `dev_tool_fallbacks`), then `~/Dev/latch/build`, so rebuild the core before `tauri dev`;
  `LATCH_EXE` still overrides.
- Release: `tools/build-release-mac.sh [--skip-notarize]` (`SKIP_CPP=1` reuses the core build).
  Signs nested binaries inside-out (never `--deep`), builds the DMG with `hdiutil`, notarizes with
  keychain profile `wavdesk-notary` (override `NOTARY_PROFILE`). Needs
  `APPLE_SIGNING_IDENTITY="Developer ID Application: ..."`; unset = ad-hoc build that runs only here.
- ffmpeg and yt-dlp are not bundled on mac: the core fetches them at runtime (`src/bootstrap.cpp`).

**Windows**
- Dev GUI: `cd gui && export PATH="/c/Program Files/nodejs:$HOME/AppData/Roaming/npm:$PATH" && pnpm tauri dev`.
- Release: `& .\tools\build-release.ps1` (NSIS only).

**Native GUI (vpf, `native/`)**
- WAVdesk native's own Latch window (`native/shell/latch_window.*` + ExtWindow, the skins, dialogs,
  tool runner) compiled UNCHANGED from a pinned WAVdesk commit; `native/app/` adds the app frame,
  Minimize, About (+ Open Log File), the look chooser, launch args (URLs / files queued as typed),
  one-instance handoff, registry self-registration, the file log (`app_log.cpp`: `logs/latch.log`),
  the first-launch copy of the installer's bundled yt-dlp / ffmpeg, and `host_stubs.cpp` (the 6
  WAVdesk-library calls those files make: data root = Latch's folder). Same shape as native Lathe.
  vpf and WAVdesk are FetchContent-pinned to commits (`native/CMakeLists.txt`): a fix to the window
  lands in WAVdesk first, then this pin moves. The pin must be a pushed commit (release fetches it).
- Not yet: Audition opens the system player (no engine of its own); Chop is not wired (WAVdesk's
  `latch_chop_*` needs its chop code split from the library first); no Settings window; no Mac build.
- Dev: `cmake -S native -B native/build -A x64 -DFETCHCONTENT_SOURCE_DIR_WAVDESK=<wavdesk checkout>`
  then `cmake --build native/build --config Release` -> `native/build/bin/Release/latch-gui.exe`.
  A dev run (exe in a build tree) uses the repo's `build/Release/latch.exe` via LATCH_EXE and does not
  self-register; an installed run uses `<exe>/coredist/latch.exe` and registers it in registry.json.
  Headless (`--steps`, `--screenshot`) runs write nothing and never hand off to a running window.
- Release (Windows): `& .\tools\build-release-native.ps1` -> `native/build-release/Latch_<ver>_x64-setup.exe`
  (standalone: bundles yt-dlp + ffmpeg) and `native/build-release/embedded/` (no ffmpeg: the copy WAVdesk
  ships), both from `native/installer/latch.nsi` (the Tauri install folder, uninstall key and exe name);
  copied to `gui/src-tauri/target/release/bundle/nsis{,-embedded}/` where WAVdesk's release picks them up.
- Data: `%LOCALAPPDATA%\Vacant Systems\Latch` (settings.json: the Tauri keys + `skin`; native_ui.json:
  the window's settings under the Tauri localStorage key names; logs/latch.log).

**Checks (both):** `pnpm typecheck`; `cargo check` + `cargo test` in `gui/src-tauri`.

## Where things live
| | Windows | macOS |
|---|---|---|
| Shared bin (ffmpeg etc.) | `%ProgramData%\Vacant Systems\Shared\bin` | `~/Library/Application Support/Vacant Systems/Shared/bin` |
| Shared cookie store | `%LOCALAPPDATA%\Vacant Systems\Shared\cookies.json` | `~/Library/Application Support/Vacant Systems/Shared/cookies.json` |
| Log (About -> Open Log File) | `%LOCALAPPDATA%\Vacant Systems\Latch\logs\latch.log` | `~/Library/Application Support/Vacant Systems/Latch/logs/latch.log` |

Tool registry: `<shared root>/Shared/registry.json`. Settings: `.../Latch/settings.json`.

## Iron rules + lockstep invariants (violations have shipped bugs)
- **Shared with WAVdesk:** `gui/src/ChopRegionOverlay.tsx` is byte-identical to WAVdesk's
  `gui/src/app/components/ChopRegionOverlay.tsx` modulo one import path. Mirror with
  `sed "s|from '../utils/chopRegions'|from './chopRegions'|"` and typecheck here. Never add
  wavdesk-only imports; edit-suite hooks are optional props Latch does not pass. `chopRegions.ts`
  has diverged on purpose (latch: `videoClip*`; WAVdesk: `postNative`, region id seq); the overlay
  compiles against both, so keep its imports to the common subset.
- **Shared-bin resolution:** `gui/src-tauri/src/tools.rs` is a fork of WAVdesk's `external_tools.rs`
  and `src/paths.cpp` keeps three platform branches; resolution order (env / portable / managed /
  installed-location fallbacks) and the cookie store path are a 3-repo invariant.
- **`mac_video.rs` is a fork, not lockstep:** WAVdesk's copy has since gained the timebase-driven
  picture follow, `objc2_06` and `wd_log`; latch keeps `objc2`, `log::`, and `recovered_loop`.
  Port engine fixes deliberately, not by copying the file.
- **Audio decode:** the standalone plays through rodio + ffmpeg routing (`audio_decode.rs`) because
  symphonia cannot decode Opus and PANICS on m4a, and YouTube bestaudio IS opus/m4a. Never regress
  to rodio-only. FLAC above 16-bit auditions via symphonia straight to f32 (`flac_f32.rs`).
  Waveforms for compressed outputs go through `generate_waveform_any`.
- **yt-dlp:** metadata probes must NOT use `-f bestaudio` + `--js-runtimes` (nsig needs node on
  PATH, absent when launched from Explorer/Finder): metadata-only + `--ignore-no-formats-error`.
  Radio-mix (RD) URLs enumerate hundreds of tracks: strip via `youtubeVideoOnlyUrl` when noPlaylist.
- New Rust commands doing I/O: `async` + `spawn_blocking`. No em dashes in user-facing text.
- Logging: extend the always-on file log (`logger.rs`) rather than adding printlns.

## Changelog (required)
`CHANGELOG.md` at the repo root is a running log, newest first. Every commit that changes behavior
adds its entry to the top dated section IN THAT COMMIT: one or two lines, what changed for the user
plus the non-obvious why. It is not a copy of the commit body: the commit is the detail, the
changelog is the skim layer. Pure chores (formatting, ignore files) are exempt. A cross-repo round
adds a line in every repo it touched.

## Coordination
Coordinated with WAVdesk, checked out as a sibling (`../wavdesk`). The agent playbook, verification
bars and cross-repo gotchas live in `../wavdesk/.claude/memory/` (orchestration.md, gotchas.md,
section "Cross-repo lockstep"). Read them before multi-file work here. Commit trailers follow the
harness's attribution instructions; don't hard-code a model name.
