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
    "latch " "0.1.0" " - URL media extractor (yt-dlp wrapper)\n"
    "\n"
    "Usage:\n"
    "  latch extract <url> <output-dir> [--format mp3|m4a|wav|opus|flac]\n"
    "  latch --version\n"
    "  latch --help\n"
    "\n"
    "Default audio format is mp3. Audio is extracted (video discarded) and\n"
    "written into <output-dir>. Paths are UTF-8 (Windows).\n"
    "\n"
    "Progress is emitted as newline-delimited JSON on stdout, one event per line:\n"
    "  {\"type\":\"start\",     \"url\":...}\n"
    "  {\"type\":\"info\",      \"title\":..., \"duration_s\":...}\n"
    "  {\"type\":\"progress\",  \"percent\":..., \"speed\":..., \"eta\":...}\n"
    "  {\"type\":\"done\",      \"output\":...}\n"
    "  {\"type\":\"cancelled\"}\n"
    "  {\"type\":\"error\",     \"message\":...}\n"
    "\n"
    "Cancellation: terminate the process (Ctrl+C, or TerminateProcess from a\n"
    "parent). The yt-dlp + ffmpeg children die with us via Windows Job Object.\n"
  );
  return 0;
}

int run_cli(const std::vector<std::string>& args) {
  if (args.size() < 2) return print_help();

  const std::string& cmd = args[1];

  if (cmd == "--help" || cmd == "-h") return print_help();
  if (cmd == "--version" || cmd == "-v") {
    std::puts("latch 0.1.0");
    return 0;
  }

  if (cmd == "extract") {
    if (args.size() < 4) {
      std::fputs("error: extract requires <url> <output-dir>\n", stderr);
      return 2;
    }
    std::string url     = args[2];
    std::string out_dir = args[3];
    std::string format  = "mp3";
    for (size_t i = 4; i < args.size(); ++i) {
      const std::string& a = args[i];
      if (a == "--format" && i + 1 < args.size()) {
        format = args[++i];
      } else {
        std::fprintf(stderr, "error: unknown argument '%s'\n", a.c_str());
        return 2;
      }
    }
    auto r = latch::extract(url, out_dir, format);
    switch (r) {
      case latch::ExtractResult::Ok:             return 0;
      case latch::ExtractResult::Cancelled:      return 130;
      case latch::ExtractResult::DownloadFailed: return 1;
      case latch::ExtractResult::YtdlpMissing:   return 1;
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
