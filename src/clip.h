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
  // Display-only preview: encode a tiny mono, low-sample-rate, 16-bit WAV
  // (just enough to draw a waveform). Used for the chop window's companion
  // track — never for playback or clip export. Ignored for video / when the
  // audio format is set.
  bool preview = false;
  // Playback speed multiplier. 1.0 = unchanged. >1 faster, <1 slower.
  // Applied to video (setpts + atempo/asetrate) and audio-only exports.
  // Never applied to the preview WAV — the waveform source stays 1x.
  double speed = 1.0;
  // Pitch behavior when speed != 1.0:
  //   "preserve" (default / empty) — atempo chain: change tempo, keep pitch.
  //   "tape" — asetrate varispeed: pitch follows speed like a tape machine
  //   (a 0.5x clip is an octave down AND twice as long). The video setpts is
  //   unchanged either way; only the audio filter differs. Ignored at 1x and
  //   for the preview WAV.
  std::string pitch_mode;
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
