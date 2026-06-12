#include "extract.h"

#include "bootstrap.h"
#include "paths.h"
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
  return resolved_ytdlp();
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
    progress_error("yt-dlp.exe not found; run `latch bootstrap` first");
    return ExtractResult::YtdlpMissing;
  }

  progress_start(url);

  std::string out_template = path_to_utf8(out_dir_path / "%(title)s.%(ext)s");

  // Mode-agnostic base argv. Audio vs video is decided below by
  // (a) whether `-x` is emitted and (b) which `-f` selector runs.
  //
  // --js-runtimes deno --js-runtimes node:
  //   YouTube's "n-parameter" challenge requires a JS runtime to
  //   solve; without one yt-dlp only sees image-only formats for
  //   signed-in users and fails format selection entirely. We try
  //   deno first (yt-dlp's preferred), then Node — both pulled from
  //   PATH. If neither is installed yt-dlp falls back gracefully.
  std::vector<std::string> argv = {
    ytdlp_path(),
    // A user's global yt-dlp config (%APPDATA%\yt-dlp\config) can inject
    // options that alter the --print/--progress-template protocol below;
    // Latch's invocations must be hermetic.
    "--ignore-config",
    // Keep yt-dlp's signature/token cache inside the vendor folder
    // instead of its default %LOCALAPPDATA%\yt-dlp.
    "--cache-dir", ytdlp_cache_dir(),
    "--no-warnings",
    "--no-colors",
    "--newline",
    // Force the progress-template to emit even though we use --print: yt-dlp
    // otherwise suppresses progress when --print is active, leaving the GUI's
    // bar frozen.
    "--progress",
    "--js-runtimes", "deno",
    "--js-runtimes", "node",
    // Full binary path (yt-dlp accepts a file or a dir) — strictly faithful
    // to the resolution order; a dir-only value would mismatch an env
    // override that names a nonstandard ffmpeg binary.
    "--ffmpeg-location", resolved_ffmpeg(),
    "--progress-template",
    "download:LATCH_PROG\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s",
    "--print", "before_dl:LATCH_INFO\t%(title)s\t%(duration)s",
    "--print", "after_move:LATCH_DONE\t%(filepath)s",
    "-o", out_template,
  };

  if (opts.video) {
    // Video mode — best video + best audio, merged. yt-dlp picks the
    // highest-resolution video stream and the best audio stream and
    // muxes them via ffmpeg. `bestvideo*` (the splat) lets yt-dlp
    // consider video-only AND combined streams; without it, sites
    // that don't serve separate streams (e.g. SoundCloud's video
    // mode if it ever launches) fall through to /best.
    argv.push_back("-f");
    if (opts.video_max_height > 0) {
      // Cap video height for a fast low-res grab; audio stays bestaudio so
      // audio quality is untouched. Fallbacks keep it robust for sites that
      // only serve combined streams.
      char fmt[160];
      std::snprintf(fmt, sizeof(fmt),
        "bestvideo[height<=%d]+bestaudio/best[height<=%d]/bestvideo*+bestaudio/best",
        opts.video_max_height, opts.video_max_height);
      argv.push_back(fmt);
    } else {
      argv.push_back("bestvideo*+bestaudio/best");
    }
    if (!opts.video_format.empty()) {
      // --merge-output-format constrains the final container after
      // muxing. Without it yt-dlp picks a container based on the
      // input streams (usually mkv for arbitrary combos).
      argv.push_back("--merge-output-format");
      argv.push_back(opts.video_format);
    }
  } else {
    // Audio mode (default). -x extracts audio post-download; without
    // --audio-format the source codec/container is preserved (m4a
    // from YouTube DASH, opus from WebM, etc.) — the user can re-
    // encode in Lathe if they want a specific format. Passing an
    // explicit audio_format still works — yt-dlp converts via ffmpeg
    // post-extraction.
    //
    // -f bestaudio: explicit audio-only format selector. Without it,
    // yt-dlp's defaults pick the best video+audio merge which fails
    // for -x mode on certain signed-in accounts (YouTube serves DRM-
    // protected combined streams to logged-in users that yt-dlp
    // can't decrypt).
    argv.push_back("-x");
    argv.push_back("-f");
    argv.push_back("bestaudio");
    if (!opts.audio_format.empty()) {
      argv.push_back("--audio-format");
      argv.push_back(opts.audio_format);
    }
  }

  if (opts.restrict_filenames) {
    // ASCII-only, space-free, no trailing space, no Unicode. Used for the
    // chop window's temp downloads (never user-facing) so the reported
    // %(filepath)s always round-trips byte-for-byte to disk — otherwise an
    // emoji/CJK title yields a path whose non-ASCII chars get dropped on
    // stdout, and the file can't be reopened ("No such file or directory").
    argv.push_back("--restrict-filenames");
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

  // Cover-art / thumbnail handling. Three independent toggles that all
  // operate on the same source thumbnail:
  //   write_thumbnail  -> keep a sidecar image next to the media
  //   crop_thumbnail   -> centre-crop it to a square (album-cover shape)
  //   embed_thumbnail  -> mux it into the output container
  // Whenever we touch the thumbnail at all we force PNG output so the
  // saved sidecar matches the GUI's "save as PNG" promise and the crop
  // filter has a deterministic raster target. The crop runs inside
  // yt-dlp's ThumbnailsConvertor ffmpeg pass via --postprocessor-args,
  // so BOTH the saved sidecar AND the embedded copy come out square —
  // they share the one converted thumbnail.
  const bool touches_thumbnail = opts.write_thumbnail || opts.embed_thumbnail;
  if (opts.write_thumbnail) {
    argv.push_back("--write-thumbnail");
  }
  if (touches_thumbnail) {
    argv.push_back("--convert-thumbnails");
    argv.push_back("png");
    if (opts.crop_thumbnail) {
      // crop=ih:ih = a centred square the height of the source (ffmpeg's
      // crop filter centres by default). Comma-free on purpose: every
      // comma inside -vf is a filtergraph separator, and routing
      // min(iw,ih) through yt-dlp's shlex + ffmpeg's own unescaping is
      // brittle. Music thumbnails are landscape (YouTube 16:9) or
      // already square (SoundCloud / Bandcamp), so taking the height as
      // the side is correct; the only unhandled case is a portrait
      // source, which is effectively nonexistent for these platforms.
      argv.push_back("--ppa");
      argv.push_back("ThumbnailsConvertor+ffmpeg_o:-vf crop=ih:ih");
    }
  }
  if (opts.embed_thumbnail) {
    argv.push_back("--embed-thumbnail");
  }

  if (!opts.cookies_from_browser.empty()) {
    argv.push_back("--cookies-from-browser");
    argv.push_back(opts.cookies_from_browser);
  }
  if (!opts.cookies_file.empty()) {
    argv.push_back("--cookies");
    argv.push_back(opts.cookies_file);
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
