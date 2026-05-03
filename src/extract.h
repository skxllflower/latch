#pragma once

#include <string>

namespace latch {

enum class ExtractResult {
  Ok,
  DownloadFailed,
  YtdlpMissing,
  Cancelled,
};

ExtractResult extract(const std::string& url,
                      const std::string& output_dir,
                      const std::string& audio_format);

}
