#include "clip.h"

#include "bootstrap.h"
#include "process.h"
#include "progress.h"

#include <algorithm>
#include <cctype>
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
  return path_to_utf8(path_from_utf8(exe_dir()) / "ffmpeg.exe");
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
    progress_error("ffmpeg.exe not found alongside latch executable");
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
    "-i", input,
    "-t", t_buf,
  };

  if (opts.video) {
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
        if (t >= 0.0 && duration > 0.0) {
          double pct = (t / duration) * 100.0;
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

  std::error_code ec2;
  const bool produced = fs::exists(out_path, ec2) && fs::file_size(out_path, ec2) > 0;
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
