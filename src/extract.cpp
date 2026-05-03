#include "extract.h"

#include "bootstrap.h"
#include "process.h"
#include "progress.h"

#include <algorithm>
#include <cctype>
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

static std::string ytdlp_path() {
  return path_to_utf8(path_from_utf8(exe_dir()) / "yt-dlp.exe");
}

static std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

ExtractResult extract(const std::string& url,
                      const std::string& output_dir,
                      const ExtractOptions& opts) {
  if (!ensure_required()) {
    progress_error("required binary (yt-dlp / ffmpeg) not available; bootstrap failed");
    return ExtractResult::BootstrapFailed;
  }

  fs::path out_dir_path = path_from_utf8(output_dir);
  std::error_code ec;
  fs::create_directories(out_dir_path, ec);

  if (!fs::exists(path_from_utf8(ytdlp_path()), ec)) {
    progress_error("yt-dlp.exe not found alongside latch executable");
    return ExtractResult::YtdlpMissing;
  }

  progress_start(url);

  std::string out_template = path_to_utf8(out_dir_path / "%(title)s.%(ext)s");

  // Highest-quality default: -x without --audio-format leaves the
  // audio stream in its source codec/container (m4a from YouTube
  // DASH, opus from WebM, etc.). The user can re-encode in Lathe if
  // they want a specific format. Passing an explicit audio_format
  // still works — yt-dlp converts via ffmpeg post-extraction.
  //
  // -f bestaudio:
  //   Explicit format selector. Without it, yt-dlp's defaults pick
  //   the best video+audio merge which fails for -x mode on certain
  //   signed-in accounts (YouTube serves DRM-protected combined
  //   streams to logged-in users that yt-dlp can't decrypt).
  // --js-runtimes deno --js-runtimes node:
  //   YouTube's "n-parameter" challenge requires a JS runtime to
  //   solve; without one yt-dlp only sees image-only formats for
  //   signed-in users and fails format selection entirely. We try
  //   deno first (yt-dlp's preferred), then Node — both pulled from
  //   PATH. If neither is installed yt-dlp falls back gracefully.
  std::vector<std::string> argv = {
    ytdlp_path(),
    "--no-warnings",
    "--no-colors",
    "--newline",
    "-x",
    "-f", "bestaudio",
    "--js-runtimes", "deno",
    "--js-runtimes", "node",
    "--ffmpeg-location", exe_dir(),
    "--progress-template",
    "download:LATCH_PROG\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s",
    "--print", "before_dl:LATCH_INFO\t%(title)s\t%(duration)s",
    "--print", "after_move:LATCH_DONE\t%(filepath)s",
    "-o", out_template,
  };
  if (!opts.audio_format.empty()) {
    argv.push_back("--audio-format");
    argv.push_back(opts.audio_format);
  }

  if (opts.no_playlist) {
    argv.push_back("--no-playlist");
  } else {
    argv.push_back("--yes-playlist");
  }
  if (!opts.audio_quality.empty()) {
    argv.push_back("--audio-quality");
    argv.push_back(opts.audio_quality);
  }
  if (opts.embed_metadata) {
    argv.push_back("--embed-metadata");
  }
  if (opts.embed_thumbnail) {
    argv.push_back("--embed-thumbnail");
  }
  if (!opts.cookies_from_browser.empty()) {
    argv.push_back("--cookies-from-browser");
    argv.push_back(opts.cookies_from_browser);
  }
  if (!opts.section.empty()) {
    // yt-dlp expects "*START-END" syntax for time-based sections.
    // Re-encoding our own section string lets the GUI stay format-
    // agnostic and pass plain "00:30-02:15".
    argv.push_back("--download-sections");
    argv.push_back(std::string("*") + opts.section);
    // Without --force-keyframes-at-cuts, yt-dlp asks ffmpeg to slice
    // at the requested times exactly which on YouTube often means
    // re-encoding the input. The keyframe-snap variant is faster and
    // good enough for sample-grabbing — the user can override by
    // passing the raw section themselves if they need precision.
    argv.push_back("--force-keyframes-at-cuts");
  }
  argv.push_back(url);

  bool had_error = false;
  std::string final_path;
  std::string last_error_text;

  run_subprocess(argv, [&](const std::string& line) {
    if (line.rfind("LATCH_PROG\t", 0) == 0) {
      std::string rest = line.substr(11);
      std::string parts[3];
      size_t pi = 0, start = 0;
      for (size_t j = 0; j < rest.size() && pi < 3; ++j) {
        if (rest[j] == '\t') {
          parts[pi++] = rest.substr(start, j - start);
          start = j + 1;
        }
      }
      if (pi < 3) parts[pi] = rest.substr(start);

      double percent = 0.0;
      std::string pct = trim(parts[0]);
      auto pct_pos = pct.find('%');
      if (pct_pos != std::string::npos) pct = pct.substr(0, pct_pos);
      try { percent = std::stod(pct); } catch (...) {}

      progress_update(percent, trim(parts[1]), trim(parts[2]));
      return;
    }
    if (line.rfind("LATCH_INFO\t", 0) == 0) {
      std::string rest = line.substr(11);
      std::string title = rest;
      double duration = 0.0;
      auto tab = rest.find('\t');
      if (tab != std::string::npos) {
        title = rest.substr(0, tab);
        std::string dur = trim(rest.substr(tab + 1));
        if (dur != "NA") {
          try { duration = std::stod(dur); } catch (...) {}
        }
      }
      progress_info(title, duration);
      return;
    }
    if (line.rfind("LATCH_DONE\t", 0) == 0) {
      final_path = line.substr(11);
      return;
    }
    if (line.rfind("ERROR:", 0) == 0) {
      last_error_text = line;
      had_error = true;
      return;
    }
  });

  if (was_cancelled()) {
    progress_cancelled();
    return ExtractResult::Cancelled;
  }

  if (had_error) {
    progress_error(last_error_text);
    return ExtractResult::DownloadFailed;
  }
  if (final_path.empty()) {
    progress_error("yt-dlp finished but no output path was reported");
    return ExtractResult::DownloadFailed;
  }

  progress_done(final_path);
  return ExtractResult::Ok;
}

}
