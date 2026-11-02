# Changelog

What changed, newest first. One or two lines per entry: what it does for the user, plus the
non-obvious why. The commit body is the detail; this file is the skim layer.

**Every commit that changes behavior adds its entry here, in the same commit.** Pure chores
(formatting, ignore files) are exempt. Cross-repo rounds add a line in each repo they touched.
Short hashes are optional and get backfilled; never block a commit on one.

## 2026-11-02

- **Native Latch on WAVdesk 336717f7**: the main and chop windows run their own tooltips (a 0.7 s rest), as the Lathe app does; the windows' tip texts are still to come.
- **Native Latch parity, chop video (WAVdesk a1b7d262)**: a region row drags out as an audio file, Shift+arrows wrap through regions, and the video preview gains volume / mute, fullscreen (F), frame step, IN / OUT / loop, HDR, palette and histogram, pop-out and zoom / pan, which Tauri's preview had.
- **Native Latch parity, chop (WAVdesk 5d6efa39)**: Settings' clip folder now takes a link's chop exports (it was shown but ignored), a local file's go to `<its folder>/Latch Chops` as in Tauri, plus a resume-from-stop toggle and a channel split button; the Tauri import also carries the chop window's own settings.
- **Native Latch parity, main window (WAVdesk dbd5bf9a)**: drop files from Explorer (one media file opens Chop, several queue), Backspace on an empty prompt removes the last row, local rows show their length, and Chop's exports join Outputs as they did in Tauri.

## 2026-11-01

- **Native Latch on WAVdesk c381b77**: a child process inherits only its own std handles, so a tool's answer no longer waits seconds for an unrelated child started at the same moment (ffprobe beside an ffmpeg decode took ~4 s).
- **Native Latch: Mac thumbnails, start-delay logging**: the Mac build fetches card thumbnails with the system's curl (Windows keeps URLMon). The log now names the audio driver and block size and how long Audition took to sound (about 90 ms here); the ~1 s chop delay seen earlier came from the headless test runner, not the app.
- **Native Latch on WAVdesk 4e84795**: a 4 px gap between a row's icon buttons (Play, Chop, Reveal, X), which touched in the VX, Focused and Zen Dark looks.
- **Native Latch card thumbnails and the audition waveform** (`native/app/thumbs.*`, `latch_app.cpp`): a link's card shows its image (downloaded once, cropped square by the suite's ffmpeg, which reads YouTube's WebP as well as JPEG / PNG, cached under the data folder); the row that is playing folds out its waveform with the played part and the playhead, and a click there seeks.
- **Native Latch chops** (`native/app/audio_out.*`, main.cpp): a row's Chop button opens WAVdesk's own Latch chop window (its `wdn_latch_chop` library over Etch, from the pinned commit, no stems or palette): regions on the waveform, the picture for a video, play, Speed, Export of audio and video clips. It plays through Latch's one audio output, which Audition now shares: one stream at a time (opening chop stops Audition), the device closed after 10 s with nothing playing. A headless run's chop sidecars follow `--data-dir` instead of landing in the real Latch folder.
- **Native Latch host stubs for the chop library** (`native/app/host_stubs.cpp`): `hostedKeyText` (key words as written) and `writeDataFile` (the grade store, written temp-then-rename beside settings.json, never in a headless run), the two calls WAVdesk's chop library makes beyond the window's.
- **Native Latch on WAVdesk b493153** (the hooks branch): launch arguments and a second launch's handoff are queued through the window's own `enqueue` instead of typing into its prompt, so nothing the user typed is disturbed; the window also fetches yt-dlp before its first lookup on a fresh install (the first paste no longer fails).
- **The native installer build no longer replaces what WAVdesk ships**: `build-release-native.ps1` copies its installers into the Tauri bundle folders only with `-Publish`. WAVdesk's release takes the newest file in `bundle/nsis-embedded`, so every native build had silently become WAVdesk's companion Latch before it was tested; the Tauri embedded installer is back there.
- **Titles keep CJK and other non-Latin text; killed yt-dlp runs stop leaking ~40 MB temp folders** (`src/`): every yt-dlp run gets `--encoding utf-8`, because piped it wrote the Windows ANSI code page and dropped what that cannot hold ("Ünïcödé 試聴 tone" arrived as "Ünïcödé  tone"; PYTHONIOENCODING does not reach the bundled exe). Each core command now also sweeps `%TEMP%\_MEI<digits>` folders that a cancelled (hard-killed) yt-dlp.exe left behind: only ones holding yt-dlp's own `yt_dlp_ejs`, older than 5 minutes, and only after a rename aside succeeds, which Windows refuses while a running yt-dlp has them open. Helps WAVdesk's Latch window too (same core).
- **Native Latch Settings window, and the Tauri app's settings carried over** (`native/app/settings_window.*`, `tauri_import.cpp`): SETTINGS in the title bar has what the Tauri one had (yt-dlp / ffmpeg / lathe path overrides with the path in use under each, the download and clip folders), saved to the same settings.json keys so either app reads the other's; the overrides reach every core it starts as LATCH_YTDLP / LATCH_FFMPEG. On first launch the Tauri window's own choices (save folder, format, mode, thumbnails) are read from its WebView2 localStorage (a LevelDB log, parsed directly) into the native window, then the old webview profile is removed by the app instead of by the installer, which used to delete it before anything could read it.
- **Native Latch plays Audition itself** (`native/app/player.*`): the row's play button plays the file in the app (a strip over the status bar: stop, the name, a seek track, the time; the button again stops it) instead of opening the system player. The suite's ffmpeg decodes it (opus / m4a included, as the audio rule requires) into vpf's own audio on the default output, which is opened only while something plays; no ffmpeg is left running after a stop, the end, or closing Latch.
- **Native Latch installers** (`tools/build-release-native.ps1` + `native/installer/latch.nsi`): both Tauri variants again, the standalone one bundling yt-dlp and ffmpeg (works offline, seeds Shared\bin) and the embedded one without ffmpeg that WAVdesk ships, with the Tauri identity (Program Files\Vacant Systems\Latch, uninstall key "Latch", latch-gui.exe) so either installs over the Tauri app in place.
- **Native Latch GUI (vpf), Windows first** (`native/`, branch feat/native-vpf): the downloader as a standalone vpf app replacing the Tauri GUI, built from WAVdesk native's own Latch window (compiled from a pinned WAVdesk commit, not forked, as native Lathe does) plus the app's frame, Minimize, About with Open Log File, a look chooser (Dev look, VX, Focused, Zen Dark), one copy at a time (a second launch's URLs and files land in the open window), the Shared registry self-registration WAVdesk finds the CLI by, the always-on `latch.log`, and the first-launch copy of an installer's bundled yt-dlp / ffmpeg. Audition opens the system player for now and Chop is not wired yet. Settings start fresh: the Tauri webview's localStorage is not migrated.
- **The Mac build runs on macOS 12 and later**: the `latch` core was built for the build Mac's own OS (minos 26.0), so dyld refused it on macOS 12-25 and Latch (and WAVdesk's bundled copy) could not download or chop. CMake now defaults the deployment target to 12.0, the GUI declares `LSMinimumSystemVersion` 12.0, and the release script aborts on any Mach-O above that floor.

## 2026-10-07

- **Version 0.1.8.** Ships the native arm64 ffmpeg + ffprobe bootstrap on Apple Silicon (no more Intel-only download that needed Rosetta) and the mac mouse-wheel zoom fix.
- **Apple Silicon downloads a native ffmpeg + ffprobe**: when the shared bin lacks them, `latch` now fetches pinned, checksum-verified arm64 builds (martin-riedl.de 1783011502_8.1.2) instead of evermeet.cx's Intel-only ones, which needed Rosetta (or failed without it). Intel Macs keep evermeet. Normally WAVdesk provisions the suite's arm64 pair first, so this is the standalone fallback.

## 2026-10-05

- **A mouse wheel zooms the waveform and image/video views on Mac**: the app now asks macOS whether each scroll came from a notched wheel or a trackpad (WebKit reports a slow wheel notch exactly like a small trackpad swipe, so the old guess panned instead of zooming). Trackpad pan and pinch are unchanged; a receipt line in latch.log records each classification. Port of WAVdesk's fix.

## 2026-09-26

- **Version 0.1.7.** Ships this repo's fixes from the WAVdesk 0.1.8 stabilization round (see the 2026-09-25 entries below).

## 2026-09-25

- **Mac drag-outs report what the drop actually did** (vendored drag crate, synced with WAVdesk): a DAW or Finder drop used to come back as an "unknown" result because only Cancel and Trash were mapped. Copy, Generic, Link and Move are now read correctly; in WAVdesk the old mapping let the chop reaper delete a file a DAW was still using, Latch's clips were not at risk but share the crate.

## 2026-09-04

- **A freshly drawn chop region no longer auto-plays** (shared overlay synced from WAVdesk): drawing selects the region and leaves it silent until you trigger it. The drop path that assumed a just-drawn region was already armed now cages playback only on a region that actually is, so dropping a fresh region no longer loops it.

## 2026-08-30

- **Mac builds are Developer ID signed and notarized**: the mac release script only ad-hoc signed
  (`codesign --deep -s -`), so every DMG it produced was refusable by Gatekeeper on any machine but
  the one that built it, and `--deep` is the flag the notary service rejects outright. It now signs
  inside-out per nested binary with a hardened runtime and secure timestamp, seals the bundle last,
  signs the DMG container, then notarizes and staples. Stapling is what lets an offline tester open
  it without a live round trip to Apple. `--skip-notarize` keeps the fast local path.
- **The prompt opens paths dragged in from Terminal**: a file dragged into Terminal arrives shell
  escaped (`/Users/me/My\ File.wav`), and the path parser, written against Explorer's quoted form,
  kept the backslashes and then could not find the file. Bare POSIX paths are unescaped now, and
  single-quoted paths strip like double-quoted ones. Windows paths and `file://` URIs are untouched,
  since a backslash there is a separator, not an escape. Kept in lockstep with WAVdesk's copy.

## 2026-08-28

- **Depth-preserving audition path** (`3ad4ae6`): both engine lanes were 16-bit sample paths, so
  24-bit WAVs, float WAVs and 24-bit FLACs auditioned with silent depth loss. A new streaming f32
  WAV reader and a symphonia-direct FLAC path carry full depth, and the ffmpeg lane decodes f32 at
  the source sample rate. Chop derive also gained real percent, a working Cancel and a Retry.
- **Full-quality audio in every audible lane** (`baa02a0`): the 22.05 kHz preview companion could be
  heard in local-file sessions. It is now visuals-only (peaks, zero-cross, drag chips); playback
  always gets full quality, deriving one full-rate companion for formats rodio cannot stream.
- **Open local files for chopping from the main window** (`2556db0`): scissors on landed Output
  rows, drag-drop anywhere on the window, local paths in the terminal prompt, and a file picker.
  Local video seeds open paused at the handoff position; clips always cut from the source, never
  the display WAV.

## 2026-08-27

- **Extract honors the input-queue selection** (`44be3db`): with one link selected out of ten,
  Extract downloaded all ten. A selection now narrows the run; no selection keeps the old
  extract-everything default. Applied in lockstep with the WAVdesk-embedded copy.

## 2026-08-26

- **Region looping works on compressed sources** (`d4dbad5`): ffmpeg-decoded sinks (Opus/AAC/WebM,
  i.e. raw YouTube bestaudio) report position relative to where the decode started while rodio
  sinks are absolute, and the collision-physics loop compared the two domains. Also: mouse-wheel
  zoom back to house gain after the mac trackpad tuning multiplied it ~10x, a resume-from-stop
  toggle, and a dead video deck re-takes on the next play instead of staying mute forever.

## 2026-08-20

- **Version stamps unified at 0.1.6** (`807add2`): CMake said 0.4.0 and the GUI 0.1.3. The C++
  banner now derives from `project(VERSION)`, and the mac bundle stops shipping the core twice.
- **Smooth scroll-zoom on macOS** (`3a5d1ee`): momentum scrolling delivers spiky deltas, so raw
  exponential gain made the zoom target jitter. Deltas are EMA-smoothed and reseeded after 120 ms
  idle so a new flick never inherits the previous flick velocity. Lockstep with WAVdesk.

## 2026-08-18

- **Float WAV sources stay float through a clip** (`e510833`): `latch clip` re-encoded all WAV
  output to 24-bit, truncating WAVdesk float32 palette bakes on cuts that are not re-overwritten.
  A dependency-free header sniff emits float32 for float inputs and 24-bit otherwise.

## 2026-07-16

- **Drag crate live-image slot** (`791113e`): keeps the vendored mac drag crate byte-aligned with
  the WAVdesk verb chip. No Latch-side callers yet; Latch chips have no live verb.
- **The first drag on a fresh macOS install no longer crashes** (`eb27a6b`): the pointer poll called
  into `device_query`, whose accessibility assert aborts before the app is in the TCC list. Reading
  NSEvent state directly needs no permission and shows no prompt. The main window also accepts the
  first click while inactive.
- **Dragging a chop clip to the Dock Trash disposes the temp** (`7aea562`): the drag source now
  offers Delete alongside Copy/Move and removes the dragged temp on that verdict, the one drop
  result trustworthy enough to act on without racing an async paste.
- **The first-launch rights notice lands on top** (`65cdbb6`): macOS brought the main window forward
  after the dialog had already shown and focused, burying it. The spawn defers one beat past
  activation and every mac dialog re-raises after show.
- **Transparent satellite windows on macOS** (`7a0b5bf`): About/dialog/settings get mac transparent
  corners; the release script finds Homebrew rustup and names the dmg by actual arch instead of a
  hardcoded x64.
- **Video drag-outs start instantly** (`55f55bb`): a second pre-render slot warms the video variant
  after defaults settle, since the drag strip right half is always a video drag. Also rounded
  corners under the native video layer and rail-button centering for mac font metrics.
- **Instant drag-out via pre-render reuse, real video chips** (`0592f92`): the drag reuses the
  settle-time pre-render when it is still current and on disk, so the OS drag starts inside the
  gesture instead of after ~1s of bare crosshair on mac (there is no follow-chip there). Chip frames
  come from the mac pixel tap rather than a canvas that is never painted, and frame-shaped chips
  cover-crop centered instead of squashing into the strip.

<!-- Seeded 2026-08-29 from the last 15 commits. -->
