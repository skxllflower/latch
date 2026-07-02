#pragma once

#include <functional>
#include <string>
#include <vector>

namespace latch {

// `on_idle` (optional) fires while the child is running but has produced no
// output for a poll interval (~50ms) — the hook a caller uses to detect a
// stalled download without a watchdog thread. No-op on POSIX (blocking read).
int run_subprocess(const std::vector<std::string>& argv,
                   const std::function<void(const std::string&)>& on_line,
                   const std::function<void()>& on_idle = nullptr);

bool was_cancelled();
std::string last_subprocess_error();
std::string exe_dir();

#ifdef _WIN32
std::wstring utf8_to_utf16(const std::string& s);
std::string  utf16_to_utf8(const std::wstring& s);
#endif

}
