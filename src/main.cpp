#include "bootstrap.h"
#include "extract.h"
#include "process.h"

#include <cstdio>
#include <cstring>
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
    "  latch bootstrap\n"
    "  latch --version\n"
    "  latch --help\n"
    "\n"
    "Extract options (all optional):\n"
    "  --format=<f>            mp3 / m4a / wav / opus / flac (default mp3)\n"
    "  --playlist              opt-INTO downloading a full playlist\n"
    "                          (default is single video — yt-dlp's\n"
    "                          --no-playlist flag is set unless this is\n"
    "                          passed)\n"
    "  --audio-quality=<n>     yt-dlp -q 0..10 (0 = best)\n"
    "  --embed-metadata        embed title / artist / album tags\n"
    "  --embed-thumbnail       embed cover-art thumbnail (mp3 / m4a / opus)\n"
    "\n"
    "If yt-dlp.exe or ffmpeg.exe is missing from the executable's\n"
    "directory, latch will download both on first run. Run\n"
    "`latch bootstrap` to pre-fetch without doing an extraction.\n"
    "\n"
    "Progress is emitted as newline-delimited JSON on stdout, one event\n"
    "per line: bootstrap / start / info / progress / done / cancelled / error.\n"
  );
  return 0;
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

  if (cmd == "extract") {
    if (args.size() < 4) {
      std::fputs("error: extract requires <url> <output-dir>\n", stderr);
      return 2;
    }
    std::string url     = args[2];
    std::string out_dir = args[3];
    latch::ExtractOptions opts;
    opts.audio_format = "mp3";
    for (size_t i = 4; i < args.size(); ++i) {
      const std::string& a = args[i];
      if      (parse_kv(a, "format",        &opts.audio_format))   continue;
      else if (parse_kv(a, "audio-quality", &opts.audio_quality))  continue;
      else if (a == "--playlist")        { opts.no_playlist = false; continue; }
      else if (a == "--no-playlist")     { opts.no_playlist = true;  continue; }
      else if (a == "--embed-metadata")  { opts.embed_metadata = true;  continue; }
      else if (a == "--embed-thumbnail") { opts.embed_thumbnail = true; continue; }
      // Tolerate the older positional --format style for backwards compat.
      else if (a == "--format" && i + 1 < args.size()) { opts.audio_format = args[++i]; continue; }
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
