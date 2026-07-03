#include "clip.h"

#include "bootstrap.h"
#include "paths.h"
#include "process.h"
#include "progress.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

namespace latch {

namespace fs = std::filesystem;

#ifdef _WIN32
static fs::path path_from_utf8(const std::string& utf8) {
  return fs::path(utf8_to_utf16(utf8));
}
static std::string path_to_utf8(const fs::path& p) {
  return utf16_to_utf8(p.wstring());
}
#else
static fs::path path_from_utf8(const std::string& utf8) { return fs::path(utf8); }
static std::string path_to_utf8(const fs::path& p) { return p.string(); }
#endif

static std::string ffmpeg_path() {
  return resolved_ffmpeg();
}

// Lower-cased file extension without the leading dot.
static std::string ext_lower(const std::string& path) {
  std::string e = path_to_utf8(path_from_utf8(path).extension());
  if (!e.empty() && e[0] == '.') e = e.substr(1);
  std::transform(e.begin(), e.end(), e.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return e;
}

// ffmpeg -progress emits "key=value" lines (no spaces in the key). Real
// error lines at -loglevel error never take that shape, so this cleanly
// separates the machine-readable progress feed from genuine errors.
static bool split_kv(const std::string& s, std::string* key, std::string* val) {
  auto eq = s.find('=');
  if (eq == std::string::npos || eq == 0) return false;
  for (size_t i = 0; i < eq; ++i) {
    char c = s[i];
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) return false;
  }
  if (key) *key = s.substr(0, eq);
  if (val) *val = s.substr(eq + 1);
  return true;
}

// atempo is limited to a single factor in [0.5, 2.0], so a speed outside
// that window must be decomposed into a chain of factors that multiply to
// the target (e.g. 0.25 -> "atempo=0.5,atempo=0.5", 4.0 -> "atempo=2,atempo=2").
static std::string atempo_chain(double speed) {
  std::string chain;
  double s = speed;
  auto append = [&](double f) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "atempo=%.6g", f);
    if (!chain.empty()) chain += ",";
    chain += buf;
  };
  while (s > 2.0 + 1e-9) { append(2.0); s /= 2.0; }
  while (s < 0.5 - 1e-9) { append(0.5); s *= 2.0; }
  append(s);
  return chain;
}

// "HH:MM:SS.uuuuuu" -> seconds, or -1 on garbage / N/A.
static double parse_ffmpeg_time(const std::string& v) {
  int h = 0, m = 0;
  double s = 0.0;
  if (std::sscanf(v.c_str(), "%d:%d:%lf", &h, &m, &s) == 3) {
    return h * 3600.0 + m * 60.0 + s;
  }
  return -1.0;
}

ClipResult clip(const std::string& input,
                const std::string& output,
                double start_sec,
                double end_sec,
                const ClipOptions& opts) {
  if (end_sec <= start_sec) {
    progress_error("clip: --end must be greater than --start");
    return ClipResult::Failed;
  }
  if (start_sec < 0.0) start_sec = 0.0;
  const double duration = end_sec - start_sec;

  // Speed change (never for the preview WAV — the waveform source stays 1x).
  double speed = opts.speed;
  if (!(speed > 0.0)) speed = 1.0;
  if (speed < 0.1)  speed = 0.1;
  if (speed > 16.0) speed = 16.0;
  const bool speed_changed = !opts.preview && std::fabs(speed - 1.0) > 1e-6;
  // With a speed change the output length is span/speed. Slower speeds make
  // the output longer than the source span, so trimming the OUTPUT to `span`
  // would truncate it. Trim the INPUT (source-time) instead and let the
  // filter re-time the full span; progress tracks the resulting output length.
  const double out_duration = speed_changed ? duration / speed : duration;

  // ffmpeg only — check first, bootstrap solely if missing (no surprise
  // network use when it's already on disk).
  if (!ffmpeg_present()) {
    if (!ensure_ffmpeg()) {
      progress_error("ffmpeg.exe not available and bootstrap failed");
      return ClipResult::FfmpegMissing;
    }
  }
  std::string ff = ffmpeg_path();
  std::error_code ec;
  if (!fs::exists(path_from_utf8(ff), ec)) {
    progress_error("ffmpeg.exe not found; run `latch bootstrap` first");
    return ClipResult::FfmpegMissing;
  }

  fs::path out_path = path_from_utf8(output);
  if (out_path.has_parent_path()) {
    fs::create_directories(out_path.parent_path(), ec);
  }

  char ss_buf[64], t_buf[64];
  std::snprintf(ss_buf, sizeof(ss_buf), "%.6f", start_sec);
  std::snprintf(t_buf, sizeof(t_buf), "%.6f", duration);

  // `-ss` BEFORE `-i` (fast input seek) combined with re-encoding is
  // frame-accurate in modern ffmpeg — it decodes from the keyframe
  // before the seek point and discards up to the exact start. `-t`
  // (duration) avoids the well-known `-to`-after-input ambiguity.
  std::vector<std::string> argv = {
    ff,
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-y",
    "-ss", ss_buf,
  };
  // Speed change: trim on the input side (source-time) so the re-timing
  // filter keeps the whole span. Otherwise keep the original output-side -t.
  if (speed_changed) argv.insert(argv.end(), {"-t", t_buf});
  argv.insert(argv.end(), {"-i", input});
  if (!speed_changed) argv.insert(argv.end(), {"-t", t_buf});

  if (opts.video) {
    if (speed_changed) {
      char sp_buf[64];
      std::snprintf(sp_buf, sizeof(sp_buf), "%.6f", speed);
      std::string fc = std::string("[0:v]setpts=PTS/") + sp_buf + "[v];[0:a]" +
                       atempo_chain(speed) + "[a]";
      argv.insert(argv.end(), {"-filter_complex", fc, "-map", "[v]", "-map", "[a]"});
    }
    const std::string e = ext_lower(output);
    if (e == "webm") {
      const char* a[] = {
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30",
        "-c:a", "libopus", "-b:a", "192k",
        "-avoid_negative_ts", "make_zero",
      };
      argv.insert(argv.end(), std::begin(a), std::end(a));
    } else {
      // mp4 / mov / mkv -> universally compatible h264 + aac.
      const char* a[] = {
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
      };
      argv.insert(argv.end(), std::begin(a), std::end(a));
    }
  } else if (opts.preview) {
    // Display-only companion track: drop video, downmix to mono at a low
    // sample rate, 16-bit PCM. A fraction of the size / time of a full
    // pcm_s24le decode, and plenty to render a waveform from.
    argv.insert(argv.end(), {"-vn", "-map", "0:a:0", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le"});
  } else {
    std::string fmt = opts.audio_format.empty() ? std::string("wav") : opts.audio_format;
    argv.insert(argv.end(), {"-vn", "-map", "0:a:0"});
    if (speed_changed) {
      argv.insert(argv.end(), {"-filter:a", atempo_chain(speed)});
    }
    if (fmt == "wav") {
      argv.insert(argv.end(), {"-c:a", "pcm_s24le"});
    } else if (fmt == "flac") {
      argv.insert(argv.end(), {"-c:a", "flac"});
    } else if (fmt == "mp3") {
      argv.insert(argv.end(), {"-c:a", "libmp3lame", "-q:a", "0"});
    } else if (fmt == "m4a" || fmt == "aac") {
      argv.insert(argv.end(), {"-c:a", "aac", "-b:a", "256k"});
    } else if (fmt == "opus") {
      argv.insert(argv.end(), {"-c:a", "libopus", "-b:a", "192k"});
    }
    // Unknown formats fall through — ffmpeg infers a codec from the
    // output extension.
  }

  argv.insert(argv.end(), {"-progress", "pipe:1"});
  argv.push_back(output);

  progress_update(0.0, "", "");

  std::string err_tail;
  int code = run_subprocess(argv, [&](const std::string& line) {
    std::string key, val;
    if (split_kv(line, &key, &val)) {
      if (key == "out_time") {
        double t = parse_ffmpeg_time(val);
        if (t >= 0.0 && out_duration > 0.0) {
          double pct = (t / out_duration) * 100.0;
          if (pct < 0.0) pct = 0.0;
          if (pct > 100.0) pct = 100.0;
          progress_update(pct, "", "");
        }
      }
      return;  // any -progress field (frame=, fps=, progress=, ...)
    }
    // Genuine ffmpeg error line at -loglevel error. Keep a bounded tail.
    err_tail += line;
    err_tail += '\n';
    if (err_tail.size() > 4000) err_tail.erase(0, err_tail.size() - 4000);
  });

  if (was_cancelled()) {
    progress_cancelled();
    return ClipResult::Cancelled;
  }

  // file_size returns uintmax_t(-1) on error, and (-1 > 0) is TRUE for
  // unsigned — so the zero-byte guard must gate on the error_code, not the
  // size comparison, or a stat failure on the fresh file reads as success.
  std::error_code ec2;
  const std::uintmax_t out_sz = fs::file_size(out_path, ec2);
  const bool produced = !ec2 && out_sz > 0;
  if (code != 0 || !produced) {
    progress_error(err_tail.empty()
      ? ("ffmpeg clip failed (exit " + std::to_string(code) + ")")
      : err_tail);
    return ClipResult::Failed;
  }

  progress_done(output);
  return ClipResult::Ok;
}

}
