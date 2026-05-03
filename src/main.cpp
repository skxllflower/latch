#include "bootstrap.h"
#include "extract.h"
#include "process.h"
#include "progress.h"

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <shellapi.h>
  #pragma comment(lib, "Shell32.lib")
#endif

namespace {

int print_help() {
  std::puts(
    "latch " "0.2.0" " - URL media extractor (yt-dlp wrapper)\n"
    "\n"
    "Usage:\n"
    "  latch extract <url> <output-dir> [options]\n"
    "  latch probe   <url> [--cookies-from-browser=<name>]\n"
    "  latch bootstrap\n"
    "  latch update\n"
    "  latch --version\n"
    "  latch --help\n"
    "\n"
    "Extract options (all optional):\n"
    "  --format=<f>                     mp3 / m4a / wav / opus / flac. Default is\n"
    "                                   empty = leave the source codec (highest\n"
    "                                   quality, no re-encode). Pass a format\n"
    "                                   only if you specifically want conversion.\n"
    "  --playlist                       opt-INTO downloading a full playlist\n"
    "  --no-playlist                    explicit single-video (default)\n"
    "  --audio-quality=<n>              yt-dlp -q 0..10 (0 = best)\n"
    "  --embed-metadata                 embed title / artist / album tags\n"
    "  --embed-thumbnail                embed cover-art thumbnail (mp3 / m4a / opus)\n"
    "  --cookies-from-browser=<name>    pull cookies from an installed browser\n"
    "                                   (chrome / firefox / edge / brave / safari /\n"
    "                                   opera / chromium / vivaldi). Required for\n"
    "                                   YouTube downloads since the bot-detection\n"
    "                                   wall went up; only matters per-host.\n"
    "  --section=<start-end>            time-range trim, e.g. 00:30-02:15. Mapped\n"
    "                                   to yt-dlp --download-sections \"*<section>\".\n"
    "                                   Snaps to keyframes for speed.\n"
    "\n"
    "`latch update` runs `yt-dlp -U` against the bundled yt-dlp.exe to pull the\n"
    "latest release. Use this when extractors break against an updated site.\n"
    "\n"
    "If yt-dlp.exe or ffmpeg.exe is missing from the executable's\n"
    "directory, latch will download both on first run. Run\n"
    "`latch bootstrap` to pre-fetch without doing an extraction.\n"
    "\n"
    "Progress is emitted as newline-delimited JSON on stdout, one event\n"
    "per line: bootstrap / start / info / progress / done / cancelled / error / update.\n"
  );
  return 0;
}

// `latch probe <url> [--cookies-from-browser=X]` — dry-run metadata
// fetch. Prints exactly one JSON line on stdout: either
//   {"type":"probe","title":"...","duration_s":123,"uploader":"..."}
// or
//   {"type":"probe","error":"<message>"}
// Exit code 0 on success, non-zero on failure. Used by the GUI to
// (a) show a live preview of a pasted URL before extraction and
// (b) verify that cookies-from-browser is unblocking the gate.
int run_probe(const std::vector<std::string>& args) {
  if (args.size() < 3) {
    std::fputs("{\"type\":\"probe\",\"error\":\"probe requires <url>\"}\n", stdout);
    return 2;
  }
  std::string url = args[2];
  std::string cookies;
  for (size_t i = 3; i < args.size(); ++i) {
    const std::string& a = args[i];
    if (a.rfind("--cookies-from-browser=", 0) == 0) cookies = a.substr(23);
    else if (a == "--cookies-from-browser" && i + 1 < args.size()) cookies = args[++i];
  }

  namespace fs = std::filesystem;
#ifdef _WIN32
  fs::path ytdlp = fs::path(latch::utf8_to_utf16(latch::exe_dir())) / L"yt-dlp.exe";
  std::string ytdlp_utf8 = latch::utf16_to_utf8(ytdlp.wstring());
#else
  fs::path ytdlp = fs::path(latch::exe_dir()) / "yt-dlp.exe";
  std::string ytdlp_utf8 = ytdlp.string();
#endif
  std::error_code ec;
  if (!fs::exists(ytdlp, ec)) {
    std::fputs("{\"type\":\"probe\",\"error\":\"yt-dlp.exe not found\"}\n", stdout);
    return 1;
  }

  // We pull title / duration / uploader from yt-dlp's --print pipe.
  // Tab-separated keeps parsing trivial — none of the three fields can
  // legitimately contain a tab (yt-dlp strips them during extraction).
  // Same -f bestaudio + --js-runtimes plumbing as extract — without it
  // YouTube probes fail on signed-in accounts (the print pipe relies
  // on a successfully-selected format being in the info dict).
  std::vector<std::string> argv = {
    ytdlp_utf8,
    "--no-warnings",
    "--no-colors",
    "--skip-download",
    "--no-playlist",
    "-f", "bestaudio",
    "--js-runtimes", "deno",
    "--js-runtimes", "node",
    "--print", "LATCH_PROBE\t%(title)s\t%(duration)s\t%(uploader)s",
  };
  if (!cookies.empty()) {
    argv.push_back("--cookies-from-browser");
    argv.push_back(cookies);
  }
  argv.push_back(url);

  std::string title, duration, uploader, error_msg;
  bool got_line = false;
  latch::run_subprocess(argv, [&](const std::string& line) {
    if (line.rfind("LATCH_PROBE\t", 0) == 0) {
      got_line = true;
      std::string rest = line.substr(12);
      auto t1 = rest.find('\t');
      auto t2 = (t1 == std::string::npos) ? std::string::npos : rest.find('\t', t1 + 1);
      if (t1 != std::string::npos) {
        title = rest.substr(0, t1);
        if (t2 != std::string::npos) {
          duration = rest.substr(t1 + 1, t2 - t1 - 1);
          uploader = rest.substr(t2 + 1);
        } else {
          duration = rest.substr(t1 + 1);
        }
      } else {
        title = rest;
      }
    } else if (line.rfind("ERROR:", 0) == 0) {
      error_msg = line;
    }
  });

  // JSON-escape helper inlined here — small enough that pulling in
  // progress.cpp's escaper as a namespace export wasn't worth it.
  auto escape = [](const std::string& s) {
    std::string out; out.reserve(s.size() + 8);
    for (char c : s) {
      switch (c) {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n";  break;
        case '\r': out += "\\r";  break;
        case '\t': out += "\\t";  break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8]; std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
            out += buf;
          } else out += c;
      }
    }
    return out;
  };

  if (!got_line) {
    std::fprintf(stdout, "{\"type\":\"probe\",\"error\":\"%s\"}\n",
      escape(error_msg.empty() ? "no metadata returned" : error_msg).c_str());
    return 1;
  }

  double dur_s = 0.0;
  if (duration != "NA") { try { dur_s = std::stod(duration); } catch (...) {} }

  std::fprintf(stdout,
    "{\"type\":\"probe\",\"title\":\"%s\",\"duration_s\":%.3f,\"uploader\":\"%s\"}\n",
    escape(title).c_str(), dur_s, escape(uploader == "NA" ? "" : uploader).c_str());
  return 0;
}

// `latch update` — runs `yt-dlp.exe -U` and streams its output as
// newline-delimited update events. The wrapper doesn't try to parse
// yt-dlp's output beyond start/done — yt-dlp's self-update is short
// enough that surfacing the raw lines as `log` events is enough for a
// progress feed in the GUI.
int run_update() {
  namespace fs = std::filesystem;
#ifdef _WIN32
  fs::path ytdlp = fs::path(latch::utf8_to_utf16(latch::exe_dir())) / L"yt-dlp.exe";
  std::string ytdlp_utf8 = latch::utf16_to_utf8(ytdlp.wstring());
#else
  fs::path ytdlp = fs::path(latch::exe_dir()) / "yt-dlp.exe";
  std::string ytdlp_utf8 = ytdlp.string();
#endif
  std::error_code ec;
  if (!fs::exists(ytdlp, ec)) {
    latch::progress_error("yt-dlp.exe not found alongside latch executable; run `latch bootstrap` first");
    return 1;
  }

  // Emit start event so the GUI can flip into "updating" state.
  std::fputs("{\"type\":\"update\",\"stage\":\"start\"}\n", stdout);
  std::fflush(stdout);

  std::vector<std::string> argv = { ytdlp_utf8, "-U" };
  std::string accumulated;
  int code = latch::run_subprocess(argv, [&](const std::string& line) {
    accumulated += line;
    accumulated += '\n';
    // Stream each line as a structured `log` event so the GUI can
    // append it to a status feed.
    std::string buf;
    buf.reserve(line.size() + 32);
    buf += "{\"type\":\"update\",\"stage\":\"log\",\"line\":\"";
    for (char c : line) {
      switch (c) {
        case '"':  buf += "\\\""; break;
        case '\\': buf += "\\\\"; break;
        case '\n': buf += "\\n";  break;
        case '\r': buf += "\\r";  break;
        case '\t': buf += "\\t";  break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char esc[8];
            std::snprintf(esc, sizeof(esc), "\\u%04x", static_cast<unsigned char>(c));
            buf += esc;
          } else buf += c;
      }
    }
    buf += "\"}\n";
    std::fputs(buf.c_str(), stdout);
    std::fflush(stdout);
  });

  if (code == 0) {
    std::fputs("{\"type\":\"update\",\"stage\":\"done\",\"code\":0}\n", stdout);
  } else {
    std::fprintf(stdout, "{\"type\":\"update\",\"stage\":\"failed\",\"code\":%d}\n", code);
  }
  std::fflush(stdout);
  return code;
}

bool parse_kv(const std::string& a, const std::string& key, std::string* out) {
  if (a.rfind("--" + key + "=", 0) == 0) {
    *out = a.substr(2 + key.size() + 1);
    return true;
  }
  return false;
}

int run_cli(const std::vector<std::string>& args) {
  if (args.size() < 2) return print_help();

  const std::string& cmd = args[1];

  if (cmd == "--help" || cmd == "-h") return print_help();
  if (cmd == "--version" || cmd == "-v") {
    std::puts("latch 0.2.0");
    return 0;
  }

  if (cmd == "bootstrap") {
    return latch::ensure_required() ? 0 : 1;
  }

  if (cmd == "update") {
    return run_update();
  }

  if (cmd == "probe") {
    return run_probe(args);
  }

  if (cmd == "extract") {
    if (args.size() < 4) {
      std::fputs("error: extract requires <url> <output-dir>\n", stderr);
      return 2;
    }
    std::string url     = args[2];
    std::string out_dir = args[3];
    latch::ExtractOptions opts;
    // Default to empty audio_format = no conversion (source codec
    // preserved). Caller passes --format=<f> to opt INTO conversion.
    for (size_t i = 4; i < args.size(); ++i) {
      const std::string& a = args[i];
      if      (parse_kv(a, "format",                &opts.audio_format))         continue;
      else if (parse_kv(a, "audio-quality",         &opts.audio_quality))        continue;
      else if (parse_kv(a, "cookies-from-browser",  &opts.cookies_from_browser)) continue;
      else if (parse_kv(a, "section",               &opts.section))              continue;
      else if (a == "--playlist")        { opts.no_playlist = false; continue; }
      else if (a == "--no-playlist")     { opts.no_playlist = true;  continue; }
      else if (a == "--embed-metadata")  { opts.embed_metadata = true;  continue; }
      else if (a == "--embed-thumbnail") { opts.embed_thumbnail = true; continue; }
      // Tolerate the older positional --format style for backwards compat.
      else if (a == "--format"                && i + 1 < args.size()) { opts.audio_format         = args[++i]; continue; }
      else if (a == "--cookies-from-browser"  && i + 1 < args.size()) { opts.cookies_from_browser = args[++i]; continue; }
      else if (a == "--section"               && i + 1 < args.size()) { opts.section              = args[++i]; continue; }
      std::fprintf(stderr, "error: unknown argument '%s'\n", a.c_str());
      return 2;
    }
    auto r = latch::extract(url, out_dir, opts);
    switch (r) {
      case latch::ExtractResult::Ok:               return 0;
      case latch::ExtractResult::Cancelled:        return 130;
      case latch::ExtractResult::DownloadFailed:   return 1;
      case latch::ExtractResult::YtdlpMissing:     return 1;
      case latch::ExtractResult::BootstrapFailed:  return 1;
    }
    return 1;
  }

  std::fprintf(stderr, "error: unknown command '%s'\n", cmd.c_str());
  return 2;
}

}

int main(int /*argc*/, char** /*argv*/) {
#ifdef _WIN32
  int wargc = 0;
  LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
  if (!wargv) return 1;
  std::vector<std::string> args;
  args.reserve(static_cast<size_t>(wargc));
  for (int i = 0; i < wargc; ++i) {
    args.push_back(latch::utf16_to_utf8(wargv[i]));
  }
  LocalFree(wargv);

  SetConsoleOutputCP(CP_UTF8);
  return run_cli(args);
#else
  std::vector<std::string> args;
  args.reserve(static_cast<size_t>(argc));
  for (int i = 0; i < argc; ++i) args.emplace_back(argv[i]);
  return run_cli(args);
#endif
}
