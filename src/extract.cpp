#include "extract.h"

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
                      const std::string& audio_format) {
  fs::path out_dir_path = path_from_utf8(output_dir);
  std::error_code ec;
  fs::create_directories(out_dir_path, ec);

  if (!fs::exists(path_from_utf8(ytdlp_path()), ec)) {
    progress_error("yt-dlp.exe not found alongside latch executable");
    return ExtractResult::YtdlpMissing;
  }

  progress_start(url);

  std::string out_template = path_to_utf8(out_dir_path / "%(title)s.%(ext)s");

  std::vector<std::string> argv = {
    ytdlp_path(),
    "--no-warnings",
    "--no-colors",
    "--newline",
    "-x",
    "--audio-format", audio_format,
    "--ffmpeg-location", exe_dir(),
    "--progress-template",
    "download:LATCH_PROG\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s",
    "--print", "before_dl:LATCH_INFO\t%(title)s\t%(duration)s",
    "--print", "after_move:LATCH_DONE\t%(filepath)s",
    "-o", out_template,
    url,
  };

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
