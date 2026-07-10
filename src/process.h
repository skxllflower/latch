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

// Guarantee a byte string is valid UTF-8 before it rides an NDJSON line.
// yt-dlp / ffmpeg on Windows emit non-ASCII text in the console's ANSI
// codepage (cp1252 etc.) when their stdout is a pipe, not UTF-8 — so a title
// like "Manco" with a cedilla arrives as a lone 0xE7 byte, which is invalid
// UTF-8. Relaying that verbatim produced an NDJSON line the GUI's line reader
// rejected, silently dropping every event after it (including the terminal
// `done`). Returns s unchanged when already valid UTF-8; otherwise transcodes
// from the active ANSI codepage, which recovers the real glyphs. No-op on POSIX
// (tools there already emit UTF-8).
std::string to_valid_utf8(const std::string& s);

#ifdef _WIN32
std::wstring utf8_to_utf16(const std::string& s);
std::string  utf16_to_utf8(const std::wstring& s);
#endif

}
