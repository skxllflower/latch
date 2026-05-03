#include "bootstrap.h"

#include "download.h"
#include "process.h"
#include "progress.h"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
#endif

namespace latch {

namespace fs = std::filesystem;

namespace {

#ifdef _WIN32
fs::path path_from_utf8(const std::string& utf8) {
  return fs::path(utf8_to_utf16(utf8));
}
std::string path_to_utf8(const fs::path& p) {
  return utf16_to_utf8(p.wstring());
}
#else
fs::path path_from_utf8(const std::string& utf8) { return fs::path(utf8); }
std::string path_to_utf8(const fs::path& p) { return p.string(); }
#endif

std::string esc(const std::string& s) {
  std::string m;
  m.reserve(s.size() + 4);
  for (char c : s) {
    if      (c == '"')  m += "\\\"";
    else if (c == '\\') m += "\\\\";
    else if (c == '\n' || c == '\r' || c == '\t') m += ' ';
    else                m += c;
  }
  return m;
}

void emit_bootstrap(const std::string& stage,
                    const std::string& binary,
                    uint64_t bytes = 0,
                    uint64_t total = 0,
                    const std::string& message = std::string()) {
  std::string out = "{\"type\":\"bootstrap\",\"stage\":\"";
  out += stage;
  out += "\",\"binary\":\"";
  out += binary;
  out += "\"";
  if (bytes > 0 || total > 0) {
    char buf[128];
    std::snprintf(buf, sizeof(buf),
      ",\"bytes\":%llu,\"total\":%llu",
      static_cast<unsigned long long>(bytes),
      static_cast<unsigned long long>(total));
    out += buf;
    if (total > 0) {
      char p[32];
      std::snprintf(p, sizeof(p),
        ",\"percent\":%.2f",
        (double)bytes / (double)total * 100.0);
      out += p;
    }
  }
  if (!message.empty()) {
    out += ",\"message\":\"";
    out += esc(message);
    out += "\"";
  }
  out += "}\n";
  std::fputs(out.c_str(), stdout);
  std::fflush(stdout);
}

bool extract_zip(const fs::path& zip, const fs::path& dest) {
  auto ps_quote = [](const std::string& s) {
    std::string out = "'";
    for (char c : s) { if (c == '\'') out += "''"; else out += c; }
    out += "'";
    return out;
  };
  std::string ps =
    "Expand-Archive -Path " + ps_quote(path_to_utf8(zip)) +
    " -DestinationPath " + ps_quote(path_to_utf8(dest)) +
    " -Force";
  std::vector<std::string> argv = {
    "powershell", "-NoProfile", "-NonInteractive", "-Command", ps,
  };
  std::string err;
  int rc = run_subprocess(argv, [&](const std::string& line) {
    if (!line.empty()) {
      if (!err.empty()) err += "\n";
      err += line;
    }
  });
  if (rc != 0 && !err.empty()) {
    emit_bootstrap("info", "powershell", 0, 0, err);
  }
  return rc == 0;
}

fs::path find_recursive(const fs::path& root, const std::string& filename) {
  std::error_code ec;
  if (!fs::exists(root, ec)) return fs::path();
  for (auto& p : fs::recursive_directory_iterator(root, ec)) {
    if (ec) break;
    if (p.is_regular_file(ec) && p.path().filename() == filename) {
      return p.path();
    }
  }
  return fs::path();
}

}

bool ffmpeg_present() {
  fs::path target = path_from_utf8(exe_dir()) / "ffmpeg.exe";
  std::error_code ec;
  return fs::exists(target, ec);
}

bool ytdlp_present() {
  fs::path target = path_from_utf8(exe_dir()) / "yt-dlp.exe";
  std::error_code ec;
  return fs::exists(target, ec);
}

bool ensure_ffmpeg() {
  if (ffmpeg_present()) return true;

  emit_bootstrap("download", "ffmpeg");

  fs::path bin_dir   = path_from_utf8(exe_dir());
  fs::path zip_path  = bin_dir / "_ffmpeg_download.zip";
  fs::path extract_d = bin_dir / "_ffmpeg_extract";
  fs::path target    = bin_dir / "ffmpeg.exe";

  std::error_code ec;
  fs::remove(zip_path, ec);
  fs::remove_all(extract_d, ec);

  const std::string url =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl.zip";

  bool ok = download_with_progress(url, zip_path,
    [&](uint64_t bytes, uint64_t total) {
      emit_bootstrap("download", "ffmpeg", bytes, total);
    });

  if (!ok) {
    emit_bootstrap("failed", "ffmpeg", 0, 0, "download failed");
    fs::remove(zip_path, ec);
    return false;
  }

  emit_bootstrap("extracting", "ffmpeg");
  if (!extract_zip(zip_path, extract_d)) {
    emit_bootstrap("failed", "ffmpeg", 0, 0, "archive extraction failed");
    fs::remove(zip_path, ec);
    fs::remove_all(extract_d, ec);
    return false;
  }

  fs::path found = find_recursive(extract_d, "ffmpeg.exe");
  if (found.empty()) {
    emit_bootstrap("failed", "ffmpeg", 0, 0,
                   "ffmpeg.exe not found in extracted archive");
    fs::remove(zip_path, ec);
    fs::remove_all(extract_d, ec);
    return false;
  }

  fs::copy_file(found, target, fs::copy_options::overwrite_existing, ec);
  if (ec) {
    emit_bootstrap("failed", "ffmpeg", 0, 0,
                   "could not copy ffmpeg.exe into binaries dir: " + ec.message());
    fs::remove(zip_path, ec);
    fs::remove_all(extract_d, ec);
    return false;
  }

  fs::remove(zip_path, ec);
  fs::remove_all(extract_d, ec);

  emit_bootstrap("done", "ffmpeg");
  return true;
}

bool ensure_ytdlp() {
  if (ytdlp_present()) return true;

  emit_bootstrap("download", "yt-dlp");

  fs::path target = path_from_utf8(exe_dir()) / "yt-dlp.exe";
  std::error_code ec;
  fs::remove(target, ec);

  const std::string url =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

  bool ok = download_with_progress(url, target,
    [&](uint64_t bytes, uint64_t total) {
      emit_bootstrap("download", "yt-dlp", bytes, total);
    });

  if (!ok) {
    emit_bootstrap("failed", "yt-dlp", 0, 0, "download failed");
    return false;
  }

  emit_bootstrap("done", "yt-dlp");
  return true;
}

bool ensure_required() {
  if (!ensure_ytdlp())  return false;
  if (!ensure_ffmpeg()) return false;
  return true;
}

}
