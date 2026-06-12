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
  // Keep a sidecar cover-art image next to the media file. Maps to
  // yt-dlp --write-thumbnail; always paired with --convert-thumbnails
  // png so the saved file is a predictable PNG regardless of the
  // source format (YouTube serves webp, others jpg).
  bool        write_thumbnail = false;
  // Centre-crop the cover art to a square (album-cover shape) before it
  // is saved and/or embedded. Applied during yt-dlp's thumbnail
  // conversion pass, so the saved sidecar and the embedded copy are
  // both square — they share the one converted image. No-op unless
  // write_thumbnail or embed_thumbnail is also set.
  bool        crop_thumbnail = false;
  // yt-dlp --cookies-from-browser <browser>. Empty = don't pass.
  // Workaround for sites (notably YouTube) that gate downloads behind
  // bot-detection checks unless yt-dlp is sending a logged-in session
  // cookie. Common values: chrome, firefox, edge, brave, safari, opera,
  // chromium, vivaldi.
  std::string cookies_from_browser;
  // yt-dlp --cookies <file>: a Netscape cookies.txt exported from a browser.
  // The escape hatch when --cookies-from-browser can't read a locked or
  // encrypted store. Empty = don't pass. yt-dlp accepts both together.
  std::string cookies_file;
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
  // Cap the video stream's height (e.g. 480) for a fast low-res download.
  // The audio stream is still bestaudio, so audio quality is unaffected.
  // 0 = no cap (best available). Ignored when video is false.
  int video_max_height = 0;
  // Restrict output filenames to ASCII (no spaces/Unicode/trailing space).
  // For internal temp downloads (the chop window) so the reported filepath
  // round-trips to disk regardless of emoji/CJK titles.
  bool restrict_filenames = false;
};

ExtractResult extract(const std::string& url,
                      const std::string& output_dir,
                      const ExtractOptions& opts);

}
