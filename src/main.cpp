#include "bootstrap.h"
#include "clip.h"
#include "extract.h"
#include "paths.h"
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
    "latch " "0.4.0" " - URL media extractor (yt-dlp wrapper)\n"
    "\n"
    "Usage:\n"
    "  latch extract <url> <output-dir> [options]\n"
    "  latch clip    <input> <output> --start=<sec> --end=<sec> [--video|--audio-only]\n"
    "  latch probe   <url> [--cookies-from-browser=<name>]\n"
    "  latch expand  <url> [--cookies-from-browser=<name>]\n"
    "  latch bootstrap\n"
    "  latch update\n"
    "  latch --version\n"
    "  latch --help\n"
    "\n"
    "Clip options (cuts a local file with ffmpeg, re-encoding for an\n"
    "exact sample/frame cut — no keyframe snapping):\n"
    "  --start=<sec>                    clip start in seconds (e.g. 12.5)\n"
    "  --end=<sec>                      clip end in seconds (must exceed start)\n"
    "  --video                          re-encode video+audio (frame-accurate)\n"
    "  --audio-only                     drop video, encode audio (default)\n"
    "  --audio-format=<f>               audio-only output codec: wav (default) /\n"
    "                                   flac / mp3 / m4a / aac / opus\n"
    "  --preview                        audio-only: small stereo 22.05k 16-bit\n"
    "                                   WAV for waveform display / audition\n"
    "  --speed=<x>                      playback speed multiplier (1.0 default,\n"
    "                                   e.g. 0.5 = half, 2.0 = double). Never\n"
    "                                   applied to --preview.\n"
    "  --pitch-mode=<m>                 how pitch behaves when --speed != 1:\n"
    "                                   preserve (default, atempo — keep pitch) /\n"
    "                                   tape (asetrate varispeed — pitch follows\n"
    "                                   speed, like a tape machine).\n"
    "\n"
    "Extract options (all optional):\n"
    "  --format=<f>                     audio format: mp3 / m4a / wav / opus /\n"
    "                                   flac. Default is empty = leave the source\n"
    "                                   codec (highest quality, no re-encode).\n"
    "                                   Ignored when --video is set.\n"
    "  --video                          download video instead of audio (keeps\n"
    "                                   bestvideo+bestaudio, muxes via ffmpeg)\n"
    "  --video-format=<f>               video container preference: mp4 / webm /\n"
    "                                   mkv / mov. Empty = let yt-dlp pick. Only\n"
    "                                   takes effect when --video is set.\n"
    "  --video-max-height=<n>           cap video height (e.g. 480) for a fast\n"
    "                                   low-res grab; audio stays bestaudio.\n"
    "                                   Only with --video.\n"
    "  --restrict-filenames             ASCII-only output names (no spaces /\n"
    "                                   Unicode) so the reported path always\n"
    "                                   matches disk; for internal temp use\n"
    "  --playlist                       opt-INTO downloading a full playlist\n"
    "  --no-playlist                    explicit single-video (default)\n"
    "  --audio-quality=<n>              yt-dlp -q 0..10 (0 = best)\n"
    "  --embed-metadata                 embed title / artist / album tags\n"
    "  --embed-thumbnail                embed cover-art thumbnail (mp3 / m4a / opus)\n"
    "  --write-thumbnail                save the cover art as a sidecar .png next\n"
    "                                   to the output (always converted to PNG)\n"
    "  --crop-thumbnail                 centre-crop the cover art to a square\n"
    "                                   before saving / embedding. No-op unless\n"
    "                                   --write-thumbnail or --embed-thumbnail set.\n"
    "  --cookies-from-browser=<name>    pull cookies from an installed browser\n"
    "                                   (chrome / firefox / edge / brave / safari /\n"
    "                                   opera / chromium / vivaldi). Required for\n"
    "                                   YouTube downloads since the bot-detection\n"
    "                                   wall went up; only matters per-host.\n"
    "  --section=<start-end>            time-range trim, e.g. 00:30-02:15. Mapped\n"
    "                                   to yt-dlp --download-sections \"*<section>\".\n"
    "                                   Snaps to keyframes for speed.\n"
    "\n"
    "`latch update` runs `yt-dlp -U` against the managed yt-dlp.exe to pull the\n"
    "latest release. Use this when extractors break against an updated site.\n"
    "\n"
    "yt-dlp.exe and ffmpeg.exe are resolved from the LATCH_YTDLP /\n"
    "LATCH_FFMPEG env vars, then next to the executable (portable\n"
    "override), then their managed homes (yt-dlp: Vacant Systems\\Latch,\n"
    "ffmpeg: the Vacant Systems shared bin) — and downloaded there on\n"
    "first run when missing. Run `latch bootstrap` to pre-fetch without\n"
    "doing an extraction.\n"
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
  std::string cookies_file;
  for (size_t i = 3; i < args.size(); ++i) {
    const std::string& a = args[i];
    if (a.rfind("--cookies-from-browser=", 0) == 0) cookies = a.substr(23);
    else if (a == "--cookies-from-browser" && i + 1 < args.size()) cookies = args[++i];
    else if (a.rfind("--cookies=", 0) == 0) cookies_file = a.substr(10);
    else if (a == "--cookies" && i + 1 < args.size()) cookies_file = args[++i];
  }

  namespace fs = std::filesystem;
  std::string ytdlp_utf8 = latch::resolved_ytdlp();
#ifdef _WIN32
  fs::path ytdlp = fs::path(latch::utf8_to_utf16(ytdlp_utf8));
#else
  fs::path ytdlp = fs::path(ytdlp_utf8);
#endif
  std::error_code ec;
  if (!fs::exists(ytdlp, ec)) {
    std::fputs("{\"type\":\"probe\",\"error\":\"yt-dlp.exe not found\"}\n", stdout);
    return 1;
  }

  // We pull title / duration / uploader from yt-dlp's --print pipe.
  // Tab-separated keeps parsing trivial — none of the three fields can
  // legitimately contain a tab (yt-dlp strips them during extraction).
  //
  // METADATA ONLY — deliberately NO `-f bestaudio` and NO `--js-runtimes`.
  // Title/duration/uploader/chapters all come from the player response and
  // need zero format selection. Selecting a format (the old `-f bestaudio`)
  // forced YouTube's nsig JS challenge, which (a) is slow and (b) needs a JS
  // runtime on PATH — absent when the GUI is launched from Explorer, so the
  // probe stalled for many seconds (the "preview timed out" the user saw).
  // `--ignore-no-formats-error` is the piece that lets us drop `-f`: it stops
  // yt-dlp aborting before it prints when no playable format is resolved (the
  // abort the old `-f bestaudio` was added to avoid). The expensive format /
  // nsig work now happens ONLY at real download time, not on every paste.
  // --ignore-config / --cache-dir mirror extract: a user's global yt-dlp
  // config could alter the --print protocol, and the cache belongs in
  // the vendor folder.
  std::vector<std::string> argv = {
    ytdlp_utf8,
    "--ignore-config",
    "--cache-dir", latch::ytdlp_cache_dir(),
    "--no-warnings",
    "--no-colors",
    "--skip-download",
    "--no-playlist",
    "--ignore-no-formats-error",
    // %(chapters)j renders the chapter list as JSON (a j-converted field
    // never contains a raw tab — control chars are escaped), so it can ride
    // the same tab-separated line. Missing chapters print as "NA".
    "--print", "LATCH_PROBE\t%(title)s\t%(duration)s\t%(uploader)s\t%(chapters)j",
  };
  if (!cookies.empty()) {
    argv.push_back("--cookies-from-browser");
    argv.push_back(cookies);
  }
  if (!cookies_file.empty()) {
    argv.push_back("--cookies");
    argv.push_back(cookies_file);
  }
  argv.push_back(url);

  std::string title, duration, uploader, chapters_json, error_msg;
  bool got_line = false;
  latch::run_subprocess(argv, [&](const std::string& line) {
    if (line.rfind("LATCH_PROBE\t", 0) == 0) {
      got_line = true;
      std::string rest = line.substr(12);
      std::string fields[4];
      size_t fi = 0, start = 0;
      for (size_t j = 0; j < rest.size() && fi < 3; ++j) {
        if (rest[j] == '\t') {
          fields[fi++] = rest.substr(start, j - start);
          start = j + 1;
        }
      }
      fields[fi] = rest.substr(start);
      title         = fields[0];
      duration      = fields[1];
      uploader      = fields[2];
      chapters_json = fields[3];
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

  // chapters_json is yt-dlp's own JSON (or "NA"/"null" when absent) —
  // embed it raw, gated on it actually being a JSON array.
  const bool has_chapters = !chapters_json.empty() && chapters_json[0] == '[';
  std::fprintf(stdout,
    "{\"type\":\"probe\",\"title\":\"%s\",\"duration_s\":%.3f,\"uploader\":\"%s\",\"chapters\":%s}\n",
    escape(title).c_str(), dur_s, escape(uploader == "NA" ? "" : uploader).c_str(),
    has_chapters ? chapters_json.c_str() : "[]");
  return 0;
}

// `latch expand <url> [--cookies-from-browser=X]` — resolves a URL
// into a list of one or more individual track entries. Drives the
// GUI's pre-extract playlist expansion: a pasted YouTube/SoundCloud
// playlist URL gets turned into N separate queue items, each a
// single-track URL with title/duration pre-filled, BEFORE any
// download starts. A non-playlist URL just returns a single entry
// — the GUI uses the same code path for both and looks at how many
// tracks come back to decide whether to expand into multiple rows.
//
// Output (NDJSON to stdout, one event per line):
//   {"type":"track","url":"...","title":"...","duration_s":N.N,"uploader":"..."}
//   ... repeated for each track ...
//   {"type":"end"}
// On hard failure (yt-dlp missing, network error, unresolvable URL):
//   {"type":"error","message":"..."}
//
// Exit code 0 on success, non-zero on failure.
//
// Implementation note: yt-dlp's `--flat-playlist --skip-download
// --print` returns one tab-separated line per track without doing
// any media download. Single-video URLs return one line; playlist
// URLs return N lines (one per track). We parse and re-emit each
// line as our `{"type":"track",...}` JSON shape so the GUI side
// doesn't have to know yt-dlp's output template syntax.
int run_expand(const std::vector<std::string>& args) {
  if (args.size() < 3) {
    std::fputs("{\"type\":\"error\",\"message\":\"expand requires <url>\"}\n", stdout);
    return 2;
  }
  std::string url = args[2];
  std::string cookies;
  std::string cookies_file;
  for (size_t i = 3; i < args.size(); ++i) {
    const std::string& a = args[i];
    if (a.rfind("--cookies-from-browser=", 0) == 0) cookies = a.substr(23);
    else if (a == "--cookies-from-browser" && i + 1 < args.size()) cookies = args[++i];
    else if (a.rfind("--cookies=", 0) == 0) cookies_file = a.substr(10);
    else if (a == "--cookies" && i + 1 < args.size()) cookies_file = args[++i];
  }

  namespace fs = std::filesystem;
  std::string ytdlp_utf8 = latch::resolved_ytdlp();
#ifdef _WIN32
  fs::path ytdlp = fs::path(latch::utf8_to_utf16(ytdlp_utf8));
#else
  fs::path ytdlp = fs::path(ytdlp_utf8);
#endif
  std::error_code ec;
  if (!fs::exists(ytdlp, ec)) {
    std::fputs("{\"type\":\"error\",\"message\":\"yt-dlp.exe not found\"}\n", stdout);
    return 1;
  }

  // Tab-separated print line — same parsing pattern as probe.
  // Deliberately NOT passing --no-playlist; playlist URLs are
  // SUPPOSED to expand here. For ambiguous watch+list URLs the
  // user's "Single video only" toggle in the GUI handles trimming
  // post-expansion (JS slices to first track).
  // Field fallbacks (comma-separated, first non-NA wins): we want the
  // CANONICAL webpage URL so the GUI can pass it back to extract.
  // webpage_url is reliable for both flat-playlist tracks and single
  // videos; `url` is sometimes overridden to the direct media URL once
  // a -f selector kicks in. Uploader has the same shape — some
  // extractors only populate uploader_id or channel.
  //
  // Thumbnail: %(thumbnail)s returns the best-resolution thumbnail URL
  // for the track. yt-dlp emits this in flat-playlist mode for most
  // sites (YouTube, SoundCloud, Bandcamp); when missing it's NA and
  // we emit empty string. The GUI uses this for the card-view preview.
  //
  // METADATA ONLY (mirrors probe). --flat-playlist lists entries without
  // per-entry format extraction, so every printed field (url/title/duration/
  // uploader/thumbnail) is available with NO format selection. The old
  // `-f bestaudio` + `--js-runtimes` forced YouTube's nsig JS challenge, which
  // needs a JS runtime on PATH — absent when the GUI is launched from Explorer,
  // so the Inputs-side resolve (this command) stalled and tripped the
  // "preview timed out" warning. --ignore-no-formats-error keeps yt-dlp from
  // aborting before it prints when no playable format is resolved. The heavy
  // format/nsig work now happens ONLY at real download time.
  std::vector<std::string> argv = {
    ytdlp_utf8,
    "--ignore-config",
    "--cache-dir", latch::ytdlp_cache_dir(),
    "--no-warnings",
    "--no-colors",
    "--skip-download",
    "--flat-playlist",
    "--ignore-no-formats-error",
    "--print", "LATCH_TRACK\t%(webpage_url,url,original_url)s\t%(title)s\t%(duration)s\t%(uploader,uploader_id,channel)s\t%(thumbnail)s",
  };
  if (!cookies.empty()) {
    argv.push_back("--cookies-from-browser");
    argv.push_back(cookies);
  }
  if (!cookies_file.empty()) {
    argv.push_back("--cookies");
    argv.push_back(cookies_file);
  }
  argv.push_back(url);

  // Inline JSON escape — kept local for the same reason probe does.
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

  int track_count = 0;
  std::string error_msg;
  int code = latch::run_subprocess(argv, [&](const std::string& line) {
    if (line.rfind("LATCH_TRACK\t", 0) == 0) {
      // 12 = strlen("LATCH_TRACK\t"). Tab-separated layout, in order:
      //   url \t title \t duration \t uploader \t thumbnail
      std::string rest = line.substr(12);
      std::string fields[5];
      size_t fi = 0, start = 0;
      for (size_t j = 0; j < rest.size() && fi < 5; ++j) {
        if (rest[j] == '\t') {
          fields[fi++] = rest.substr(start, j - start);
          start = j + 1;
        }
      }
      if (fi < 5) fields[fi] = rest.substr(start);

      std::string url_s   = fields[0];
      std::string title   = fields[1];
      std::string dur_str = fields[2];
      std::string uploader= fields[3];
      std::string thumb   = fields[4];

      // Skip empty URL lines defensively — yt-dlp sometimes emits a
      // header/footer when a playlist fails partway.
      if (url_s.empty() || url_s == "NA") return;

      double dur_s = 0.0;
      if (!dur_str.empty() && dur_str != "NA") {
        try { dur_s = std::stod(dur_str); } catch (...) {}
      }

      auto clean = [](const std::string& s) {
        return (s == "NA") ? std::string() : s;
      };

      std::fprintf(stdout,
        "{\"type\":\"track\",\"url\":\"%s\",\"title\":\"%s\",\"duration_s\":%.3f,\"uploader\":\"%s\",\"thumbnail\":\"%s\"}\n",
        escape(url_s).c_str(),
        escape(clean(title)).c_str(),
        dur_s,
        escape(clean(uploader)).c_str(),
        escape(clean(thumb)).c_str()
      );
      std::fflush(stdout);
      ++track_count;
    } else if (line.rfind("ERROR:", 0) == 0) {
      error_msg = line;
    }
  });

  if (track_count == 0) {
    std::fprintf(stdout, "{\"type\":\"error\",\"message\":\"%s\"}\n",
      escape(error_msg.empty() ? "no tracks returned" : error_msg).c_str());
    std::fflush(stdout);
    return code == 0 ? 1 : code;
  }

  std::fputs("{\"type\":\"end\"}\n", stdout);
  std::fflush(stdout);
  return 0;
}

// `latch update` — runs `yt-dlp.exe -U` and streams its output as
// newline-delimited update events. The wrapper doesn't try to parse
// yt-dlp's output beyond start/done — yt-dlp's self-update is short
// enough that surfacing the raw lines as `log` events is enough for a
// progress feed in the GUI.
int run_update() {
  namespace fs = std::filesystem;
  std::string ytdlp_utf8 = latch::resolved_ytdlp();
#ifdef _WIN32
  fs::path ytdlp = fs::path(latch::utf8_to_utf16(ytdlp_utf8));
#else
  fs::path ytdlp = fs::path(ytdlp_utf8);
#endif
  std::error_code ec;
  if (!fs::exists(ytdlp, ec)) {
    latch::progress_error("yt-dlp.exe not found; run `latch bootstrap` first");
    return 1;
  }

  // Emit start event so the GUI can flip into "updating" state.
  std::fputs("{\"type\":\"update\",\"stage\":\"start\"}\n", stdout);
  std::fflush(stdout);

  std::vector<std::string> argv = { ytdlp_utf8, "--ignore-config", "-U" };
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
    std::puts("latch 0.4.0");
    return 0;
  }

  // Pre-vendor-folder bootstraps left yt-dlp.exe / ffmpeg.exe next to the
  // executable; adopt them into their managed homes once so they aren't
  // re-downloaded. After the trivial --help/--version returns so a pure
  // help query never triggers a migration move or a -version subprocess.
  latch::migrate_legacy_binaries();

  if (cmd == "bootstrap") {
    return latch::ensure_required() ? 0 : 1;
  }

  if (cmd == "update") {
    return run_update();
  }

  if (cmd == "probe") {
    return run_probe(args);
  }

  if (cmd == "expand") {
    return run_expand(args);
  }

  if (cmd == "extract") {
    if (args.size() < 4) {
      std::fputs("error: extract requires <url> <output-dir>\n", stderr);
      return 2;
    }
    std::string url     = args[2];
    std::string out_dir = args[3];
    latch::ExtractOptions opts;
    std::string vmh_str;
    // Default to empty audio_format = no conversion (source codec
    // preserved). Caller passes --format=<f> to opt INTO conversion.
    for (size_t i = 4; i < args.size(); ++i) {
      const std::string& a = args[i];
      if      (parse_kv(a, "format",                &opts.audio_format))         continue;
      else if (parse_kv(a, "video-format",          &opts.video_format))         continue;
      else if (parse_kv(a, "audio-quality",         &opts.audio_quality))        continue;
      else if (parse_kv(a, "video-max-height",      &vmh_str))                   { try { opts.video_max_height = std::stoi(vmh_str); } catch (...) {} continue; }
      else if (parse_kv(a, "cookies-from-browser",  &opts.cookies_from_browser)) continue;
      else if (parse_kv(a, "cookies",               &opts.cookies_file))         continue;
      else if (parse_kv(a, "section",               &opts.section))              continue;
      else if (a == "--video")           { opts.video = true; continue; }
      else if (a == "--restrict-filenames") { opts.restrict_filenames = true; continue; }
      else if (a == "--playlist")        { opts.no_playlist = false; continue; }
      else if (a == "--no-playlist")     { opts.no_playlist = true;  continue; }
      else if (a == "--embed-metadata")  { opts.embed_metadata = true;  continue; }
      else if (a == "--embed-thumbnail") { opts.embed_thumbnail = true; continue; }
      else if (a == "--write-thumbnail") { opts.write_thumbnail = true; continue; }
      else if (a == "--crop-thumbnail")  { opts.crop_thumbnail = true;  continue; }
      // Tolerate the older positional --format style for backwards compat.
      else if (a == "--format"                && i + 1 < args.size()) { opts.audio_format         = args[++i]; continue; }
      else if (a == "--video-format"          && i + 1 < args.size()) { opts.video_format         = args[++i]; continue; }
      else if (a == "--cookies-from-browser"  && i + 1 < args.size()) { opts.cookies_from_browser = args[++i]; continue; }
      else if (a == "--cookies"               && i + 1 < args.size()) { opts.cookies_file         = args[++i]; continue; }
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

  if (cmd == "clip") {
    if (args.size() < 4) {
      std::fputs("error: clip requires <input> <output>\n", stderr);
      return 2;
    }
    std::string input  = args[2];
    std::string output = args[3];
    latch::ClipOptions opts;
    double start_sec = 0.0, end_sec = 0.0;
    bool have_start = false, have_end = false;
    for (size_t i = 4; i < args.size(); ++i) {
      const std::string& a = args[i];
      std::string v;
      if (parse_kv(a, "start", &v)) { try { start_sec = std::stod(v); have_start = true; } catch (...) {} continue; }
      if (parse_kv(a, "end",   &v)) { try { end_sec   = std::stod(v); have_end   = true; } catch (...) {} continue; }
      if (parse_kv(a, "speed", &v)) { try { opts.speed = std::stod(v); } catch (...) {} continue; }
      if (parse_kv(a, "pitch-mode", &opts.pitch_mode)) continue;
      if (parse_kv(a, "audio-format", &opts.audio_format)) continue;
      if (a == "--video")      { opts.video = true;  continue; }
      if (a == "--audio-only") { opts.video = false; continue; }
      if (a == "--preview")    { opts.preview = true; continue; }
      if (a == "--start" && i + 1 < args.size()) { try { start_sec = std::stod(args[++i]); have_start = true; } catch (...) {} continue; }
      if (a == "--end"   && i + 1 < args.size()) { try { end_sec   = std::stod(args[++i]); have_end   = true; } catch (...) {} continue; }
      if (a == "--speed" && i + 1 < args.size()) { try { opts.speed = std::stod(args[++i]); } catch (...) {} continue; }
      if (a == "--pitch-mode" && i + 1 < args.size()) { opts.pitch_mode = args[++i]; continue; }
      std::fprintf(stderr, "error: unknown argument '%s'\n", a.c_str());
      return 2;
    }
    if (!have_start || !have_end) {
      std::fputs("error: clip requires --start=<sec> and --end=<sec>\n", stderr);
      return 2;
    }
    auto r = latch::clip(input, output, start_sec, end_sec, opts);
    switch (r) {
      case latch::ClipResult::Ok:            return 0;
      case latch::ClipResult::Cancelled:     return 130;
      case latch::ClipResult::Failed:        return 1;
      case latch::ClipResult::FfmpegMissing: return 1;
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
