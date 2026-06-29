#include "paths.h"

#include "process.h"

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <string>
#include <vector>

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

const char* ffmpeg_name() {
#ifdef _WIN32
  return "ffmpeg.exe";
#else
  return "ffmpeg";
#endif
}

const char* ytdlp_name() {
#ifdef _WIN32
  return "yt-dlp.exe";
#else
  return "yt-dlp";
#endif
}

// <platform data dir>/Vacant Systems — mirrors the layout WAVdesk's
// get_appdata_dir() established; keep the three branches in lockstep
// across the Vacant Systems repos.
fs::path vendor_root() {
#ifdef _WIN32
  const char* local = std::getenv("LOCALAPPDATA");
  if (local) return path_from_utf8(local) / "Vacant Systems";
  return fs::path("C:/Users/Public") / "Vacant Systems";  // fallback
#elif defined(__APPLE__)
  const char* home = std::getenv("HOME");
  if (home) return fs::path(home) / "Library" / "Application Support" / "Vacant Systems";
  return fs::path("/tmp") / "Vacant Systems";
#else
  const char* xdg = std::getenv("XDG_DATA_HOME");
  if (xdg) return fs::path(xdg) / "vacant-systems";
  const char* home = std::getenv("HOME");
  if (home) return fs::path(home) / ".local" / "share" / "vacant-systems";
  return fs::path("/tmp") / "vacant-systems";
#endif
}

#if defined(_WIN32) || defined(__APPLE__)
constexpr const char* kSharedDir = "Shared";
constexpr const char* kLatchDir  = "Latch";
#else
constexpr const char* kSharedDir = "shared";
constexpr const char* kLatchDir  = "latch";
#endif

// Machine-wide shared root: ProgramData\Vacant Systems on Windows (user-writable
// via the installer's icacls grant) so shared tooling (ffmpeg/yt-dlp) and the
// cross-product registry live out of per-user AppData while staying writable by
// the unelevated app. macOS/Linux keep the shared tree under the vendor root.
fs::path shared_root() {
#ifdef _WIN32
  const char* pd = std::getenv("ProgramData");
  if (pd) return path_from_utf8(pd) / "Vacant Systems";
  return fs::path("C:/ProgramData") / "Vacant Systems";  // fallback
#else
  return vendor_root();
#endif
}

fs::path shared_bin_path() { return shared_root() / kSharedDir / "bin"; }
fs::path latch_bin_path()  { return shared_root() / kLatchDir / "bin"; }

std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

// Move src into dst (same name). Same-volume rename first; cross-volume
// falls back to copy + delete. Best effort — a failure just leaves the
// source in place, which the resolution order still finds.
void move_file(const fs::path& src, const fs::path& dst) {
  std::error_code ec;
  fs::create_directories(dst.parent_path(), ec);
  fs::rename(src, dst, ec);
  if (ec) {
    ec.clear();
    fs::copy_file(src, dst, fs::copy_options::overwrite_existing, ec);
    if (!ec) fs::remove(src, ec);
  }
}

// env override → next-to-exe portable override → managed home.
std::string resolve_binary(const char* env_var, const char* name,
                           const fs::path& managed_dir) {
  std::error_code ec;

  const char* env = std::getenv(env_var);
  if (env && *env) {
    fs::path p = path_from_utf8(env);
    if (fs::exists(p, ec)) return path_to_utf8(p);
  }

  fs::path portable = path_from_utf8(exe_dir()) / name;
  if (fs::exists(portable, ec)) return path_to_utf8(portable);

  return path_to_utf8(managed_dir / name);
}

void migrate_one(const char* name, const fs::path& managed_dir,
                 const char* version_flag) {
  std::error_code ec;
  fs::path managed = managed_dir / name;
  fs::path legacy  = path_from_utf8(exe_dir()) / name;
  if (!fs::exists(managed, ec) && fs::exists(legacy, ec)) {
    move_file(legacy, managed);
    if (fs::exists(managed, ec)) {
      write_binary_manifest(path_to_utf8(managed),
                            "migrated from " + path_to_utf8(legacy.parent_path()),
                            version_flag);
    }
  }
}

}

std::string shared_bin_dir() {
  fs::path p = shared_bin_path();
  std::error_code ec;
  fs::create_directories(p, ec);
  return path_to_utf8(p);
}

std::string latch_bin_dir() {
  fs::path p = latch_bin_path();
  std::error_code ec;
  fs::create_directories(p, ec);
  return path_to_utf8(p);
}

std::string ytdlp_cache_dir() {
  return path_to_utf8(vendor_root() / kLatchDir / "ytdlp-cache");
}

std::string resolved_ffmpeg() {
  return resolve_binary("LATCH_FFMPEG", ffmpeg_name(), shared_bin_path());
}

std::string resolved_ytdlp() {
  return resolve_binary("LATCH_YTDLP", ytdlp_name(), latch_bin_path());
}

// A zero-byte file counts as missing: a crashed pre-tmp-era download could
// leave an empty binary that bare exists() would treat as installed,
// permanently blocking re-bootstrap. file_size sets ec (and we require none)
// on a missing OR unreadable path, so this is also the existence check.
static bool binary_present(const std::string& path_utf8) {
  std::error_code ec;
  const std::uintmax_t sz = fs::file_size(path_from_utf8(path_utf8), ec);
  return !ec && sz > 0;
}

bool ffmpeg_exists() { return binary_present(resolved_ffmpeg()); }
bool ytdlp_exists()  { return binary_present(resolved_ytdlp()); }

void migrate_legacy_binaries() {
  migrate_one(ffmpeg_name(), shared_bin_path(), "-version");
  migrate_one(ytdlp_name(), latch_bin_path(), "--version");
}

void write_binary_manifest(const std::string& binary_path_utf8,
                           const std::string& source,
                           const std::string& version_flag) {
  fs::path bin = path_from_utf8(binary_path_utf8);

  std::error_code ec;
  uint64_t size = fs::file_size(bin, ec);
  if (ec) size = 0;

  // Best-effort self-reported version (first output line). Both
  // ffmpeg -version and yt-dlp --version exit immediately.
  std::string version;
  std::vector<std::string> argv = {binary_path_utf8, version_flag};
  run_subprocess(argv, [&](const std::string& line) {
    if (version.empty() && !line.empty()) version = line;
  });

  char stamp[32] = "";
  std::time_t now = std::time(nullptr);
  if (std::tm* tm = std::gmtime(&now)) {
    std::strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%SZ", tm);
  }

  std::string json = "{\n";
  json += "  \"binary\": \"" + json_escape(path_to_utf8(bin.filename())) + "\",\n";
  json += "  \"source\": \"" + json_escape(source) + "\",\n";
  json += "  \"recorded_at\": \"" + std::string(stamp) + "\",\n";
  json += "  \"size_bytes\": " + std::to_string(size) + ",\n";
  json += "  \"version\": \"" + json_escape(version) + "\"\n";
  json += "}\n";

  fs::path manifest = bin;
  manifest.replace_extension(".json");
#ifdef _WIN32
  FILE* f = _wfopen(manifest.wstring().c_str(), L"wb");
#else
  FILE* f = std::fopen(manifest.string().c_str(), "wb");
#endif
  if (f) {
    std::fwrite(json.data(), 1, json.size(), f);
    std::fclose(f);
  }
}

}
