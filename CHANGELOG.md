# Changelog

What changed, newest first. One or two lines per entry: what it does for the user, plus the
non-obvious why. The commit body is the detail; this file is the skim layer.

**Every commit that changes behavior adds its entry here, in the same commit.** Pure chores
(formatting, ignore files) are exempt. Cross-repo rounds add a line in each repo they touched.
Short hashes are optional and get backfilled; never block a commit on one.

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
