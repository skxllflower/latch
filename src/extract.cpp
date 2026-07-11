#include "extract.h"

#include "bootstrap.h"
#include "paths.h"
#include "process.h"
#include "progress.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <functional>
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
  return resolved_ytdlp();
}

static std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

namespace {

// What one yt-dlp invocation produced. The ladder inspects this to decide
// whether a rung succeeded and, on total failure, what to surface.
struct Attempt {
  int rc = -1;
  bool had_error = false;                // saw an "ERROR:" line
  bool cancelled = false;                // user aborted mid-run
  std::string final_path;                // from LATCH_DONE (after_move)
  std::string last_error;                // the last "ERROR:" line, verbatim
  std::deque<std::string> raw_tail;      // trailing non-protocol output
};

// The human-readable cause of a failed attempt: the yt-dlp/ffmpeg error line
// if there was one, else the last thing the child printed, else the exit code.
std::string essence_of(const Attempt& at) {
  if (!at.last_error.empty()) return at.last_error;
  for (auto it = at.raw_tail.rbegin(); it != at.raw_tail.rend(); ++it) {
    if (!it->empty()) return *it;
  }
  return "exit " + std::to_string(at.rc);
}

// One rung of a resilience ladder: a human label for the log and the yt-dlp
// -f selector it tries. Shared by the audio and video ladders below.
struct Rung {
  std::string label;
  std::string selector;
};

// Target container + ffmpeg encoder for a rung-3 local extraction. `codec_args`
// empty means "let the muxer pick the default encoder for the extension".
struct AudioTarget {
  std::string ext;
  std::vector<std::string> codec_args;
};

AudioTarget audio_target_for(const std::string& fmt) {
  if (fmt == "mp3")                  return {"mp3",  {"-c:a", "libmp3lame", "-q:a", "2"}};
  if (fmt == "m4a" || fmt == "aac")  return {"m4a",  {"-c:a", "aac", "-b:a", "192k"}};
  if (fmt == "opus")                 return {"opus", {"-c:a", "libopus", "-b:a", "160k"}};
  if (fmt == "ogg" || fmt == "vorbis") return {"ogg", {"-c:a", "libvorbis", "-q:a", "5"}};
  if (fmt == "flac")                 return {"flac", {"-c:a", "flac"}};
  if (fmt == "wav")                  return {"wav",  {"-c:a", "pcm_s16le"}};
  // Unknown label: trust the extension to drive ffmpeg's default encoder.
  return {fmt.empty() ? "m4a" : fmt, {}};
}

// Extension a raw stream copy can safely land in, keyed by ffprobe codec_name.
// Empty = no clean copy container known, so the caller transcodes instead.
std::string copy_ext_for_codec(const std::string& codec) {
  if (codec == "aac" || codec == "alac") return "m4a";
  if (codec == "mp3")                    return "mp3";
  if (codec == "opus")                   return "opus";
  if (codec == "vorbis")                 return "ogg";
  if (codec == "flac")                   return "flac";
  if (codec == "ac3")                    return "ac3";
  return "";
}

std::string probe_audio_codec(const std::string& file) {
  std::vector<std::string> argv = {
    resolved_ffprobe(),
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name",
    "-of", "default=nokey=1:noprint_wrappers=1",
    file,
  };
  std::string codec;
  run_subprocess(argv, [&](const std::string& line) {
    std::string t = trim(line);
    if (codec.empty() && !t.empty()) codec = t;
  });
  return codec;
}

// remove_all a directory tree when it goes out of scope unless disarmed.
struct DirSweeper {
  fs::path dir;
  bool armed = true;
  ~DirSweeper() {
    if (armed) { std::error_code ec; fs::remove_all(dir, ec); }
  }
};

}  // namespace

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
    progress_error("yt-dlp.exe not found; run `latch bootstrap` first");
    return ExtractResult::YtdlpMissing;
  }

  progress_start(url);

  std::string out_template = path_to_utf8(out_dir_path / "%(title)s.%(ext)s");

  // Base argv shared by every mode and every rung: process-hermetic flags,
  // vendor cache dir, the progress/print protocol, and the resolved ffmpeg.
  //
  // --js-runtimes deno --js-runtimes node:
  //   YouTube's "n-parameter" challenge needs a JS runtime to solve; without
  //   one yt-dlp sees only a restricted format set for some videos and format
  //   selection fails outright. We try deno first (yt-dlp's preferred) then
  //   Node, both from PATH; if neither is installed yt-dlp falls back to
  //   clients that don't require nsig, which is exactly the case the download
  //   ladder below exists to recover from.
  std::vector<std::string> base = {
    ytdlp_path(),
    "--ignore-config",
    "--cache-dir", ytdlp_cache_dir(),
    "--no-warnings",
    "--no-colors",
    "--newline",
    "--progress",
    "--js-runtimes", "deno",
    "--js-runtimes", "node",
    "--ffmpeg-location", resolved_ffmpeg(),
    "--progress-template",
    "download:LATCH_PROG\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s",
    "--print", "before_dl:LATCH_INFO\t%(title)s\t%(duration)s",
    "--print", "after_move:LATCH_DONE\t%(filepath)s",
  };

  if (opts.restrict_filenames) {
    // ASCII-only, space-free names so a reported %(filepath)s round-trips
    // byte-for-byte (used by the chop window's internal temp downloads).
    base.push_back("--restrict-filenames");
  }
  if (opts.no_playlist) {
    base.push_back("--no-playlist");
  } else {
    base.push_back("--yes-playlist");
  }
  if (!opts.cookies_from_browser.empty()) {
    base.push_back("--cookies-from-browser");
    base.push_back(opts.cookies_from_browser);
  }
  if (!opts.cookies_file.empty()) {
    base.push_back("--cookies");
    base.push_back(opts.cookies_file);
  }
  if (!opts.section.empty()) {
    base.push_back("--download-sections");
    base.push_back(std::string("*") + opts.section);
    base.push_back("--force-keyframes-at-cuts");
  }

  // Post-processing extras that only make sense when yt-dlp owns the output
  // (video mode + audio rungs 1/2). Rung 3 extracts audio itself, so it omits
  // them deliberately.
  std::vector<std::string> extras;
  if (!opts.audio_quality.empty()) {
    extras.push_back("--audio-quality");
    extras.push_back(opts.audio_quality);
  }
  if (opts.embed_metadata) {
    extras.push_back("--embed-metadata");
  }
  const bool touches_thumbnail = opts.write_thumbnail || opts.embed_thumbnail;
  if (opts.write_thumbnail) {
    extras.push_back("--write-thumbnail");
  }
  if (touches_thumbnail) {
    extras.push_back("--convert-thumbnails");
    extras.push_back("png");
    if (opts.crop_thumbnail) {
      // crop=ih:ih = a centred square the height of the source. Comma-free on
      // purpose: every comma inside -vf is a filtergraph separator.
      extras.push_back("--ppa");
      extras.push_back("ThumbnailsConvertor+ffmpeg_o:-vf crop=ih:ih");
    }
  }
  if (opts.embed_thumbnail) {
    extras.push_back("--embed-thumbnail");
  }

  using clock = std::chrono::steady_clock;
  auto now_ms = [] {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
             clock::now().time_since_epoch()).count();
  };
  auto fmt1 = [](double v) {
    char b[32]; std::snprintf(b, sizeof(b), "%.1f", v); return std::string(b);
  };

  // Run one yt-dlp invocation, streaming its progress/info to the GUI and
  // capturing the outcome. `phase` labels the stall log ("resolving" until the
  // first byte, then "downloading"). Does NOT emit the terminal done/error
  // event: the ladder decides that after inspecting the result.
  auto run_ytdlp = [&](const std::vector<std::string>& argv) -> Attempt {
    Attempt at;

    // Log the exact invocation (cookie file path redacted) so a failed or slow
    // download names itself in the log stream.
    {
      std::string summary;
      summary.reserve(512);
      for (size_t i = 0; i < argv.size(); ++i) {
        if (i) summary += ' ';
        if (i > 0 && argv[i - 1] == "--cookies") { summary += "<redacted>"; continue; }
        summary += argv[i];
      }
      progress_log("invoke", summary);
    }

    const size_t kRawTailMax = 12;
    long long last_activity  = now_ms();
    long long last_stall_log = 0;
    bool      downloading    = false;
    auto t0 = clock::now();

    auto on_idle = [&] {
      long long n = now_ms();
      if (n - last_activity >= 30000 && n - last_stall_log >= 30000) {
        last_stall_log = n;
        progress_log("stall",
          "no progress for " + std::to_string((n - last_activity) / 1000) +
          "s (phase: " + (downloading ? "downloading" : "resolving") + ")");
      }
    };

    at.rc = run_subprocess(argv, [&](const std::string& line) {
      last_activity = now_ms();
      if (line.rfind("LATCH_PROG\t", 0) == 0) {
        downloading = true;
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
        downloading = true;
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
        at.final_path = line.substr(11);
        return;
      }
      if (line.rfind("ERROR:", 0) == 0) {
        at.last_error = line;
        at.had_error = true;
        // fall through so the error also lands in the tail buffer
      }
      at.raw_tail.push_back(line);
      if (at.raw_tail.size() > kRawTailMax) at.raw_tail.pop_front();
    }, on_idle);

    double elapsed_s = std::chrono::duration<double>(clock::now() - t0).count();

    if (was_cancelled()) {
      at.cancelled = true;
      progress_log("cancelled",
        "yt-dlp cancelled after " + fmt1(elapsed_s) + "s (exit " +
        std::to_string(at.rc) + ")");
      return at;
    }

    const bool failed = at.had_error || at.final_path.empty();
    if (failed) {
      progress_log("failed",
        "yt-dlp exit " + std::to_string(at.rc) + " after " + fmt1(elapsed_s) + "s");
      for (const auto& l : at.raw_tail) progress_log("stderr", l);
    } else {
      progress_log("done", "yt-dlp ok in " + fmt1(elapsed_s) + "s (exit " +
        std::to_string(at.rc) + ")");
    }
    return at;
  };

  // Build argv for one VIDEO rung: a muxed/merged download yt-dlp writes
  // straight to out_template. This IS the media a chop session wants (its
  // audio companion is pulled later by `latch clip --preview`), so unlike the
  // audio ladder there is no local re-extract step — the rungs just relax the
  // format selector.
  auto build_video_argv = [&](const std::string& selector) {
    std::vector<std::string> argv = base;
    argv.insert(argv.end(), extras.begin(), extras.end());
    argv.push_back("-o");
    argv.push_back(out_template);
    argv.push_back("-f");
    argv.push_back(selector);
    if (!opts.video_format.empty()) {
      argv.push_back("--merge-output-format");
      argv.push_back(opts.video_format);
    }
    argv.push_back(url);
    return argv;
  };

  // Build argv for one AUDIO rung: yt-dlp extracts the audio track (-x) to
  // out_template.
  auto build_audio_argv = [&](const std::string& selector) {
    std::vector<std::string> argv = base;
    argv.insert(argv.end(), extras.begin(), extras.end());
    argv.push_back("-o");
    argv.push_back(out_template);
    argv.push_back("-x");
    argv.push_back("-f");
    argv.push_back(selector);
    if (!opts.audio_format.empty()) {
      argv.push_back("--audio-format");
      argv.push_back(opts.audio_format);
    }
    argv.push_back(url);
    return argv;
  };

  // Try each selector rung in turn; first success wins. Every rung is its OWN
  // yt-dlp invocation with its own receipts, so an extractor error that aborts
  // one selector (not merely a format-unavailable) still lets the next rung
  // recover — yt-dlp's in-selector `A/B/C` chaining can't do that. Returns:
  //    1  a rung landed a file (progress_done already emitted)
  //    0  every rung failed (last_essence holds the cause to surface)
  //   -1  the user cancelled mid-rung
  auto run_ladder = [&](const std::vector<Rung>& rungs,
                        const std::function<std::vector<std::string>(const std::string&)>& build,
                        std::string& last_essence) -> int {
    for (const auto& r : rungs) {
      progress_log("rung", r.label + ": -f " + r.selector);
      Attempt at = run_ytdlp(build(r.selector));
      if (at.cancelled) return -1;
      if (!at.had_error && !at.final_path.empty()) {
        progress_done(at.final_path);
        return 1;
      }
      last_essence = essence_of(at);
      progress_log("rung", r.label + " failed: " + last_essence);
    }
    return 0;
  };

  // ---- Video mode: resilience ladder (mirrors audio, first success wins) ---
  // Chop was failing here: the old video path was a SINGLE yt-dlp attempt, so
  // one aborted extraction sank the whole session with no recovery — while the
  // audio path already laddered. Each rung below is a fresh invocation that
  // relaxes the selector: the quality target first, then any merge, then a
  // bare `best` single muxed stream as the last resort.
  if (opts.video) {
    std::vector<Rung> vrungs;
    if (opts.video_max_height > 0) {
      // A height cap means this is the chop window's low-res PREVIEW proxy, and
      // the preview is played by the native decoder (`lathe decode-server`), NOT
      // <video>. That decoder has no software AV1 path — on macOS AV1 is
      // hardware-only ("Your platform doesn't support hardware accelerated AV1
      // decoding" -> zero frames -> a black pane while audio still plays). But
      // YouTube's `bestvideo` under any height cap is usually AV1/VP9, so the
      // proxy has to be pinned to H.264 (avc1) or the preview never paints.
      // rung 1 prefers avc1; the any-codec rungs below still recover if a link
      // truly has no H.264 (rare on YouTube; the HD export path stays uncapped
      // best and is decoder-agnostic, so quality there is unaffected).
      const std::string cap =
          std::string("[height<=") + std::to_string(opts.video_max_height) + "]";
      vrungs.push_back({std::string("1/4 ") + std::to_string(opts.video_max_height) +
                          "p H.264 preview (avc1)",
                        std::string("bestvideo[vcodec^=avc1]") + cap +
                          "+bestaudio/best[vcodec^=avc1]" + cap});
      vrungs.push_back({std::string("2/4 ") + std::to_string(opts.video_max_height) +
                          "p (bestvideo+bestaudio, any codec)",
                        std::string("bestvideo") + cap + "+bestaudio/best" + cap});
      vrungs.push_back({"3/4 uncapped bestvideo+bestaudio", "bestvideo*+bestaudio/best"});
      vrungs.push_back({"4/4 best (any single muxed stream)", "best"});
    } else {
      vrungs.push_back({"1/2 bestvideo+bestaudio", "bestvideo*+bestaudio/best"});
      vrungs.push_back({"2/2 best (any single muxed stream)", "best"});
    }

    std::string last_essence;
    int rc = run_ladder(vrungs, build_video_argv, last_essence);
    if (rc < 0) { progress_cancelled(); return ExtractResult::Cancelled; }
    if (rc == 1) return ExtractResult::Ok;
    progress_error("all video download methods failed. last error: " +
      (last_essence.empty() ? std::string("no video stream could be downloaded")
                            : last_essence));
    return ExtractResult::DownloadFailed;
  }

  // ---- Audio mode: resilience ladder, first success wins -------------------
  // Rung 1: -f bestaudio               (audio-only; the historical default)
  // Rung 2: -f bestaudio/best          (fall back to a muxed stream, still -x)
  // Rung 3: -f best, no -x; download a muxed file and extract audio locally
  //         with the shared-bin ffmpeg. Covers the case where yt-dlp's own
  //         audio post-processor is what's failing, or where nothing but a
  //         progressive stream is offered at all.
  std::string last_essence;
  {
    const std::vector<Rung> rungs = {
      {"1/3 bestaudio (audio-only)", "bestaudio"},
      {"2/3 bestaudio/best (fallback chain)", "bestaudio/best"},
    };
    int rc = run_ladder(rungs, build_audio_argv, last_essence);
    if (rc < 0) { progress_cancelled(); return ExtractResult::Cancelled; }
    if (rc == 1) return ExtractResult::Ok;
  }

  // Rung 3: download a muxed video into our own temp area, then extract the
  // audio with ffmpeg. Sweep the temp on every exit path.
  {
    const char* kRung3 = "3/3 video + local extract";
    progress_log("rung", std::string(kRung3) +
      ": downloading a muxed stream (-f best/bestvideo*+bestaudio)");

    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
    fs::path tempdir = path_from_utf8(latch_temp_dir()) /
                       path_from_utf8("rungc-" + std::to_string(ms));
    fs::remove_all(tempdir, ec);
    fs::create_directories(tempdir, ec);
    DirSweeper sweeper{tempdir};

    std::string temp_template = path_to_utf8(tempdir / "%(title)s.%(ext)s");
    std::vector<std::string> argv = base;
    argv.push_back("-o");
    argv.push_back(temp_template);
    argv.push_back("-f");
    argv.push_back("best/bestvideo*+bestaudio");
    argv.push_back(url);

    Attempt at = run_ytdlp(argv);
    if (at.cancelled) { progress_cancelled(); return ExtractResult::Cancelled; }
    if (at.had_error && at.final_path.empty()) {
      last_essence = essence_of(at);
      progress_log("rung", std::string(kRung3) + " download failed: " + last_essence);
      progress_error("all download methods failed. last error: " + last_essence);
      return ExtractResult::DownloadFailed;
    }

    // The reported %(filepath)s can lose non-ASCII characters on stdout, so we
    // never reopen it by that name: enumerate the temp dir for the one media
    // file we just wrote (its on-disk name is correct Unicode).
    fs::path video_path;
    for (auto& e : fs::directory_iterator(tempdir, ec)) {
      if (!e.is_regular_file(ec)) continue;
      std::string x = path_to_utf8(e.path().extension());
      if (x == ".part" || x == ".ytdl" || x == ".temp") continue;
      video_path = e.path();
      break;
    }
    if (video_path.empty()) {
      progress_log("rung", std::string(kRung3) + " failed: no file landed in temp");
      progress_error("all download methods failed. last error: " +
        (last_essence.empty() ? std::string("rung 3 produced no file") : last_essence));
      return ExtractResult::DownloadFailed;
    }

    // Pick the output container/codec. An explicit --format transcodes to it;
    // with no format requested we preserve the source codec via a stream copy
    // (matching audio mode's default), falling back to mp3 for codecs that have
    // no clean copy container.
    std::string fmt = opts.audio_format;
    AudioTarget tgt;
    bool copy = false;
    if (fmt.empty()) {
      std::string codec = probe_audio_codec(path_to_utf8(video_path));
      std::string cext = copy_ext_for_codec(codec);
      if (!cext.empty()) { copy = true; tgt.ext = cext; }
      else { tgt = audio_target_for("mp3"); }
    } else {
      tgt = audio_target_for(fmt);
    }

    std::string stem = path_to_utf8(video_path.stem());
    fs::path out_audio = out_dir_path / path_from_utf8(stem + "." + tgt.ext);
    for (int n = 1; fs::exists(out_audio, ec); ++n) {
      out_audio = out_dir_path /
        path_from_utf8(stem + " (" + std::to_string(n) + ")." + tgt.ext);
    }

    progress_log("rung", std::string(kRung3) + ": extracting audio via ffmpeg -> " +
      tgt.ext + (copy ? " (stream copy)" : " (transcode)"));

    std::vector<std::string> fargv = {
      resolved_ffmpeg(),
      "-hide_banner", "-nostdin", "-y",
      "-i", path_to_utf8(video_path),
      "-vn", "-map", "0:a:0",
    };
    if (copy) {
      fargv.push_back("-c:a");
      fargv.push_back("copy");
    } else {
      for (const auto& a : tgt.codec_args) fargv.push_back(a);
    }
    fargv.push_back(path_to_utf8(out_audio));

    std::deque<std::string> ff_tail;
    bool ff_error = false;
    int frc = run_subprocess(fargv, [&](const std::string& line) {
      if (line.find("Error") != std::string::npos ||
          line.rfind("[error]", 0) == 0) {
        ff_error = true;
      }
      ff_tail.push_back(line);
      if (ff_tail.size() > 12) ff_tail.pop_front();
    });

    if (was_cancelled()) { progress_cancelled(); return ExtractResult::Cancelled; }

    std::error_code out_ec;
    const bool wrote = fs::exists(out_audio, out_ec) &&
                       fs::file_size(out_audio, out_ec) > 0;
    if (frc != 0 || ff_error || !wrote) {
      std::string tail;
      for (auto it = ff_tail.rbegin(); it != ff_tail.rend(); ++it) {
        if (!it->empty()) { tail = *it; break; }
      }
      if (tail.empty()) tail = "ffmpeg exit " + std::to_string(frc);
      fs::remove(out_audio, out_ec);
      progress_log("rung", std::string(kRung3) + " extract failed: " + tail);
      progress_error("all download methods failed. audio extraction error: " + tail);
      return ExtractResult::DownloadFailed;
    }

    progress_log("rung", std::string(kRung3) + " ok");
    progress_done(path_to_utf8(out_audio));
    return ExtractResult::Ok;
  }
}

}
