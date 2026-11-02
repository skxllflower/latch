// A child's stdout, read as it comes (player.cpp): ffmpeg / ffprobe for Audition, its peaks and the card thumbnails.
#pragma once
#include <atomic>
#include <cstddef>
#include <functional>
#include <string>
#include <vector>

namespace latch {

// `exe args` with its stdout handed to onData until it exits or `stop` (then killed, with its job); stderr dropped.
// Polled, never a blocking read (a sibling child may hold the pipe's write end). false = it did not start
bool runPiped(const std::string& exe, const std::vector<std::string>& args, const std::function<void(const char*, size_t)>& onData,
              const std::atomic<bool>& stop);

}  // namespace latch
