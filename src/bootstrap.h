#pragma once

namespace latch {

bool ffmpeg_present();
bool ytdlp_present();

// Best-effort: ensures the named binary is on disk next to the wrapper.
// If already present, returns true immediately. Otherwise downloads
// from the official source and (for ffmpeg) extracts the archive. Emits
// NDJSON `bootstrap` progress events on stdout.
bool ensure_ffmpeg();
bool ensure_ytdlp();

// Convenience: makes sure every binary latch depends on is in place
// (yt-dlp.exe AND ffmpeg.exe — yt-dlp shells to ffmpeg internally for
// audio extraction, so we need both).
bool ensure_required();

}
