#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>

namespace latch {

bool download_with_progress(
  const std::string& url,
  const std::filesystem::path& dest,
  const std::function<void(uint64_t bytes, uint64_t total)>& on_progress);

}
