#pragma once

#include <string>

namespace latch {

// %LOCALAPPDATA%\Vacant Systems\Shared\bin (created on demand) — the
// vendor-shared home for runtime-fetched tool binaries; ffmpeg.exe lives
// here once for every Vacant Systems app (Lathe resolves the same dir).
// macOS: ~/Library/Application Support/Vacant Systems/Shared/bin
// Linux:  $XDG_DATA_HOME/vacant-systems/shared/bin (~/.local/share fallback)
std::string shared_bin_dir();

// %LOCALAPPDATA%\Vacant Systems\Latch\bin (created on demand) — Latch's
// own managed binaries. yt-dlp lives here, NOT in Shared: it's
// Latch-specific and self-updates in place (`latch update`), which needs a
// guaranteed-writable home regardless of where latch.exe is installed.
std::string latch_bin_dir();

// %LOCALAPPDATA%\Vacant Systems\Latch\ytdlp-cache — passed to every
// yt-dlp invocation as --cache-dir so its signature/token cache stays
// inside the vendor folder instead of scattering to %LOCALAPPDATA%\yt-dlp.
// Not pre-created; yt-dlp creates it on first use.
std::string ytdlp_cache_dir();

// %LOCALAPPDATA%\Vacant Systems\Latch\tmp (created on demand) — scratch
// space for the download resilience ladder's last rung, which fetches a
// muxed video here before extracting its audio locally with ffmpeg. The
// caller sweeps its own per-run subdir on success, failure, and cancel.
std::string latch_temp_dir();

// Reclaim orphaned ladder scratch (rungc-* under Latch\tmp) left by a hard
// crash / SIGKILL that skipped the per-run scope-guard sweep. Only entries
// older than one hour are removed, so a rung a parallel latch.exe is actively
// writing is never touched. Called once at CLI startup (the chokepoint every
// real command reaches). Best-effort and silent.
void sweep_stale_temp();

// The ffmpeg binary to use. Resolution order:
//   1. LATCH_FFMPEG env var (explicit override)
//   2. ffmpeg.exe next to latch.exe (portable override)
//   3. Shared\bin (the normal home; bootstrap downloads here)
// Always returns a path — when nothing exists yet it returns the Shared\bin
// target so bootstrap and error messages agree on where it belongs.
std::string resolved_ffmpeg();

// The ffprobe binary to use (resolution mirrors ffmpeg — env LATCH_FFPROBE,
// portable next-to-exe, then Shared\bin). yt-dlp needs ffprobe alongside
// ffmpeg for its post-processing (metadata/merge); it discovers ffprobe in
// ffmpeg's directory, so both live in Shared\bin together.
std::string resolved_ffprobe();

// The yt-dlp binary to use. Resolution order mirrors ffmpeg:
//   1. LATCH_YTDLP env var
//   2. yt-dlp.exe next to latch.exe (portable override)
//   3. Latch\bin (the normal home; bootstrap downloads here)
std::string resolved_ytdlp();

// True when the resolved binary points at an existing file.
bool ffmpeg_exists();
bool ffprobe_exists();
bool ytdlp_exists();

// One-time tidy-up: pre-vendor-folder bootstraps left ffmpeg.exe and
// yt-dlp.exe next to the executable. Move them into their managed homes
// when those have none. Gated on the managed copy being absent, so a
// deliberately-placed portable copy is never stolen later (portable
// copies still win via the resolution order).
void migrate_legacy_binaries();

// Write <stem>.json next to a managed binary recording where it came from,
// when, its size, and its self-reported version (best effort) — the basis
// for future update checks, which today's exists()-only logic can't do.
void write_binary_manifest(const std::string& binary_path_utf8,
                           const std::string& source,
                           const std::string& version_flag);

}
