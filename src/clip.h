#pragma once

#include <string>

namespace latch {

enum class ClipResult {
  Ok,
  Failed,
  Cancelled,
  FfmpegMissing,
};

struct ClipOptions {
  // true  -> video clip: re-encode video+audio (frame-accurate).
  // false -> audio-only clip: drop video, encode audio (sample-accurate).
  bool video = false;
  // Audio container/codec for audio-only mode: wav / flac / mp3 / m4a /
  // aac / opus. Empty defaults to wav (pcm_s24le). Ignored for video.
  std::string audio_format;
};

// Cuts [start_sec, end_sec) out of `input` into `output` with ffmpeg.
// Re-encodes (no keyframe-snap) so cuts land on the exact sample (audio)
// or frame (video). Emits the same NDJSON progress/done/error events as
// extract via progress.h, so the GUI's event reader handles it unchanged.
ClipResult clip(const std::string& input,
                const std::string& output,
                double start_sec,
                double end_sec,
                const ClipOptions& opts);

}
