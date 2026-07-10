#include "bootstrap.h"

#include "download.h"
#include "paths.h"
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

#if defined(__APPLE__)
// Extract a .zip on macOS via `ditto -x -k` (ships on every macOS, unlike a
// guaranteed `unzip`). The evermeet archives hold a single binary at the root.
bool extract_zip_mac(const fs::path& zip, const fs::path& dest) {
  std::error_code ec;
  fs::create_directories(dest, ec);
  std::vector<std::string> argv = {
    "ditto", "-x", "-k", zip.string(), dest.string(),
  };
  std::string err;
  int rc = run_subprocess(argv, [&](const std::string& line) {
    if (!line.empty()) { if (!err.empty()) err += "\n"; err += line; }
  });
  if (rc != 0 && !err.empty()) emit_bootstrap("info", "ditto", 0, 0, err);
  return rc == 0;
}

// Make a freshly downloaded binary runnable: chmod 0755 and strip the
// com.apple.quarantine xattr so Gatekeeper doesn't block the spawned tool.
// Both best-effort — a missing quarantine attr makes xattr exit non-zero,
// which we ignore.
void make_executable_mac(const fs::path& bin) {
  std::error_code ec;
  fs::permissions(bin,
    fs::perms::owner_all |
    fs::perms::group_read | fs::perms::group_exec |
    fs::perms::others_read | fs::perms::others_exec,
    fs::perm_options::replace, ec);
  std::vector<std::string> argv = {
    "xattr", "-d", "com.apple.quarantine", bin.string(),
  };
  run_subprocess(argv, [](const std::string&) {});
}
#endif

}

bool ffmpeg_present() {
  return ffmpeg_exists();
}

bool ffprobe_present() {
  return ffprobe_exists();
}

bool ytdlp_present() {
  return ytdlp_exists();
}

namespace {

// Install one binary found in the extract dir into the shared bin via
// tmp + rename so a concurrent reader (or a sibling app's bootstrap racing us
// in the shared dir) never sees a partial binary. A failed rename with the
// target now present means the racer won — treated as success. Returns true
// when `target` ends up present, sets *err on failure.
bool install_from_extract(const fs::path& extract_d, const std::string& filename,
                          const fs::path& target, std::string* err) {
  fs::path found = find_recursive(extract_d, filename);
  if (found.empty()) {
    if (err) *err = filename + " not found in extracted archive";
    return false;
  }
  std::error_code ec;
  fs::path tmp = target;
  tmp += ".tmp";
  fs::copy_file(found, tmp, fs::copy_options::overwrite_existing, ec);
  std::string install_err = ec ? ec.message() : std::string();
  if (!ec) {
    std::error_code rename_ec;
    fs::rename(tmp, target, rename_ec);
    if (rename_ec) {
      install_err = rename_ec.message();
      fs::remove(tmp, ec);
    }
  }
  std::error_code exists_ec;
  if (!fs::exists(target, exists_ec)) {
    if (err) *err = "could not install " + filename + " into shared bin: " + install_err;
    return false;
  }
  return true;
}

}  // namespace

bool ensure_ffmpeg() {
  // ffprobe is required too: yt-dlp's post-processing (metadata/merge)
  // discovers it next to ffmpeg via --ffmpeg-location. Both ship in the same
  // BtbN archive, so one download installs both. Re-fetch if EITHER is missing
  // (covers an older install that seeded ffmpeg without ffprobe).
  if (ffmpeg_present() && ffprobe_present()) return true;

  emit_bootstrap("download", "ffmpeg");

  // Download into the vendor-shared bin (one ffmpeg for every Vacant
  // Systems app; Lathe resolves the same dir) — also the only
  // guaranteed-writable home once the executable lives under Program
  // Files. Staging lives in the same dir so the final rename is
  // same-volume (atomic).
  fs::path bin_dir   = path_from_utf8(shared_bin_dir());
#ifdef _WIN32
  fs::path zip_path  = bin_dir / "_ffmpeg_download.zip";
  fs::path extract_d = bin_dir / "_ffmpeg_extract";
  fs::path target    = bin_dir / "ffmpeg.exe";
  fs::path probe_tgt = bin_dir / "ffprobe.exe";

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

  std::string install_err;
  bool installed_ffmpeg  = install_from_extract(extract_d, "ffmpeg.exe",  target,    &install_err);
  bool installed_ffprobe = installed_ffmpeg &&
                           install_from_extract(extract_d, "ffprobe.exe", probe_tgt, &install_err);
  if (!installed_ffmpeg || !installed_ffprobe) {
    emit_bootstrap("failed", "ffmpeg", 0, 0, install_err);
    fs::remove(zip_path, ec);
    fs::remove_all(extract_d, ec);
    return false;
  }

  fs::remove(zip_path, ec);
  fs::remove_all(extract_d, ec);

  write_binary_manifest(path_to_utf8(target),    url, "-version");
  write_binary_manifest(path_to_utf8(probe_tgt), url, "-version");

  emit_bootstrap("done", "ffmpeg");
  return true;
#elif defined(__APPLE__)
  // evermeet.cx publishes static, standalone ffmpeg/ffprobe CLI builds for
  // macOS — each a zip holding one binary at the root. Two downloads (separate
  // archives), unlike Windows' single BtbN bundle. GPL is fine here: these are
  // spawned as subprocesses, same as the Windows gpl build.
  fs::path ff_zip    = bin_dir / "_ffmpeg_download.zip";
  fs::path fp_zip    = bin_dir / "_ffprobe_download.zip";
  fs::path ff_ex     = bin_dir / "_ffmpeg_extract";
  fs::path fp_ex     = bin_dir / "_ffprobe_extract";
  fs::path target    = bin_dir / "ffmpeg";
  fs::path probe_tgt = bin_dir / "ffprobe";

  std::error_code ec;
  fs::remove(ff_zip, ec);
  fs::remove(fp_zip, ec);
  fs::remove_all(ff_ex, ec);
  fs::remove_all(fp_ex, ec);

  const std::string ff_url = "https://evermeet.cx/ffmpeg/getrelease/zip";
  const std::string fp_url = "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip";

  bool ok = download_with_progress(ff_url, ff_zip,
    [&](uint64_t bytes, uint64_t total) {
      emit_bootstrap("download", "ffmpeg", bytes, total);
    });
  if (ok) {
    ok = download_with_progress(fp_url, fp_zip,
      [&](uint64_t bytes, uint64_t total) {
        emit_bootstrap("download", "ffprobe", bytes, total);
      });
  }
  if (!ok) {
    emit_bootstrap("failed", "ffmpeg", 0, 0, "download failed");
    fs::remove(ff_zip, ec);
    fs::remove(fp_zip, ec);
    return false;
  }

  emit_bootstrap("extracting", "ffmpeg");
  if (!extract_zip_mac(ff_zip, ff_ex) || !extract_zip_mac(fp_zip, fp_ex)) {
    emit_bootstrap("failed", "ffmpeg", 0, 0, "archive extraction failed");
    fs::remove(ff_zip, ec);
    fs::remove(fp_zip, ec);
    fs::remove_all(ff_ex, ec);
    fs::remove_all(fp_ex, ec);
    return false;
  }

  std::string install_err;
  bool installed_ffmpeg  = install_from_extract(ff_ex, "ffmpeg",  target,    &install_err);
  bool installed_ffprobe = installed_ffmpeg &&
                           install_from_extract(fp_ex, "ffprobe", probe_tgt, &install_err);
  if (!installed_ffmpeg || !installed_ffprobe) {
    emit_bootstrap("failed", "ffmpeg", 0, 0, install_err);
    fs::remove(ff_zip, ec);
    fs::remove(fp_zip, ec);
    fs::remove_all(ff_ex, ec);
    fs::remove_all(fp_ex, ec);
    return false;
  }

  make_executable_mac(target);
  make_executable_mac(probe_tgt);

  fs::remove(ff_zip, ec);
  fs::remove(fp_zip, ec);
  fs::remove_all(ff_ex, ec);
  fs::remove_all(fp_ex, ec);

  write_binary_manifest(path_to_utf8(target),    ff_url, "-version");
  write_binary_manifest(path_to_utf8(probe_tgt), fp_url, "-version");

  emit_bootstrap("done", "ffmpeg");
  return true;
#else
  emit_bootstrap("failed", "ffmpeg", 0, 0, "unsupported platform");
  return false;
#endif
}

bool ensure_ytdlp() {
  if (ytdlp_present()) return true;

  emit_bootstrap("download", "yt-dlp");

  // yt-dlp is Latch-managed (it self-updates in place, so it needs a
  // guaranteed-writable home) — Latch\bin, not the shared dir. Download
  // to a staging name + rename so a half-finished download never sits at
  // the real path looking installed.
#ifdef _WIN32
  fs::path target  = path_from_utf8(latch_bin_dir()) / "yt-dlp.exe";
  fs::path staging = target;
  staging += ".download";
  std::error_code ec;
  fs::remove(staging, ec);

  const std::string url =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

  bool ok = download_with_progress(url, staging,
    [&](uint64_t bytes, uint64_t total) {
      emit_bootstrap("download", "yt-dlp", bytes, total);
    });

  if (!ok) {
    emit_bootstrap("failed", "yt-dlp", 0, 0, "download failed");
    fs::remove(staging, ec);
    return false;
  }

  std::error_code rename_ec;
  fs::rename(staging, target, rename_ec);
  std::error_code exists_ec;
  if (!fs::exists(target, exists_ec)) {
    emit_bootstrap("failed", "yt-dlp", 0, 0,
                   "could not install yt-dlp.exe: " + rename_ec.message());
    fs::remove(staging, ec);
    return false;
  }
  fs::remove(staging, ec);

  write_binary_manifest(path_to_utf8(target), url, "--version");

  emit_bootstrap("done", "yt-dlp");
  return true;
#elif defined(__APPLE__)
  // The macOS build ships as a single standalone binary (yt-dlp_macos); save it
  // under the managed name, chmod + dequarantine, install via staging + rename.
  fs::path target  = path_from_utf8(latch_bin_dir()) / "yt-dlp";
  fs::path staging = target;
  staging += ".download";
  std::error_code ec;
  fs::remove(staging, ec);

  const std::string url =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";

  bool ok = download_with_progress(url, staging,
    [&](uint64_t bytes, uint64_t total) {
      emit_bootstrap("download", "yt-dlp", bytes, total);
    });

  if (!ok) {
    emit_bootstrap("failed", "yt-dlp", 0, 0, "download failed");
    fs::remove(staging, ec);
    return false;
  }

  make_executable_mac(staging);

  std::error_code rename_ec;
  fs::rename(staging, target, rename_ec);
  std::error_code exists_ec;
  if (!fs::exists(target, exists_ec)) {
    emit_bootstrap("failed", "yt-dlp", 0, 0,
                   "could not install yt-dlp: " + rename_ec.message());
    fs::remove(staging, ec);
    return false;
  }
  fs::remove(staging, ec);

  write_binary_manifest(path_to_utf8(target), url, "--version");

  emit_bootstrap("done", "yt-dlp");
  return true;
#else
  emit_bootstrap("failed", "yt-dlp", 0, 0, "unsupported platform");
  return false;
#endif
}

bool ensure_required() {
  if (!ensure_ytdlp())  return false;
  if (!ensure_ffmpeg()) return false;
  return true;
}

}
