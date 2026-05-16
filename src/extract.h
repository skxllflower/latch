#pragma once

#include <string>

namespace latch {

enum class ExtractResult {
  Ok,
  DownloadFailed,
  YtdlpMissing,
  Cancelled,
  BootstrapFailed,
};

struct ExtractOptions {
  // Output audio container/codec passed straight to yt-dlp's
  // --audio-format. Empty defaults to mp3.
  std::string audio_format;
  // Default true. Mirrors yt-dlp's --no-playlist — pasting a video that
  // happens to be IN a playlist accidentally pulls the whole playlist
  // otherwise. Off to opt INTO a full playlist download.
  bool        no_playlist = true;
  // yt-dlp --audio-quality 0..10 (0 = best). Empty leaves the default.
  std::string audio_quality;
  // yt-dlp --embed-metadata: embeds title / artist / etc. into the
  // output container.
  bool        embed_metadata = false;
  // yt-dlp --embed-thumbnail: writes the cover art into the output
  // (useful for mp3 / m4a / opus).
  bool        embed_thumbnail = false;
  // yt-dlp --cookies-from-browser <browser>. Empty = don't pass.
  // Workaround for sites (notably YouTube) that gate downloads behind
  // bot-detection checks unless yt-dlp is sending a logged-in session
  // cookie. Common values: chrome, firefox, edge, brave, safari, opera,
  // chromium, vivaldi.
  std::string cookies_from_browser;
  // Time-range trim — passed straight to yt-dlp's --download-sections
  // as "*<section>". Format is yt-dlp's own (HH:MM:SS-HH:MM:SS, or
  // MM:SS-MM:SS, or seconds). Empty = full media. Useful for ripping a
  // 90s clip from a 40-minute mix.
  std::string section;
  // Download video instead of extracting audio. Flips off yt-dlp's -x
  // mode and selects bestvideo+bestaudio for merge. Default false
  // keeps Latch backwards-compatible as an audio-first tool — video
  // mode is opt-in via the GUI's mode toggle or the --video CLI flag.
  bool video = false;
  // Video container preference passed to yt-dlp's --merge-output-format
  // when video is true: mp4, webm, mkv, mov. Empty = let yt-dlp pick
  // the best container for the chosen video+audio streams. Ignored
  // when video is false.
  std::string video_format;
};

ExtractResult extract(const std::string& url,
                      const std::string& output_dir,
                      const ExtractOptions& opts);

}
