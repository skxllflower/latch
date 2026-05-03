#pragma once

#include <string>

namespace latch {

void progress_start(const std::string& url);
void progress_info(const std::string& title, double duration_s);
void progress_update(double percent,
                     const std::string& speed,
                     const std::string& eta);
void progress_done(const std::string& output);
void progress_cancelled();
void progress_error(const std::string& message);

}
