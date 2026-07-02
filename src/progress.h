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

// Diagnostic line for the GUI's log stream (invocation summary, elapsed +
// exit code, stall notices, stderr tail). Emitted as {"type":"log",...} so
// the event listener ignores it for job state but a diagnostics reader can
// surface it. Safe to call from a watchdog thread — emit() is mutex-guarded.
void progress_log(const std::string& phase, const std::string& message);

}
