#pragma once

#include <functional>
#include <string>
#include <vector>

namespace latch {

int run_subprocess(const std::vector<std::string>& argv,
                   const std::function<void(const std::string&)>& on_line);

bool was_cancelled();
std::string last_subprocess_error();
std::string exe_dir();

#ifdef _WIN32
std::wstring utf8_to_utf16(const std::string& s);
std::string  utf16_to_utf8(const std::wstring& s);
#endif

}
