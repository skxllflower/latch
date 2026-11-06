#include "progress.h"

#include <cstdio>
#include <mutex>
#include <string>

namespace latch {

namespace {

// Serialize every emit: progress lines come from the subprocess reader thread
// while the stall watchdog writes from its own thread. Without the lock two
// NDJSON lines could interleave and corrupt the stream.
std::mutex g_emit_mutex;

std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

// A JSON number (NaN / inf are not JSON, and nothing sent is near 1e15: 0).
std::string number(double v, const char* fmt) {
  if (!(v == v) || v > 1e15 || v < -1e15) v = 0.0;
  char buf[64];
  std::snprintf(buf, sizeof(buf), fmt, v);
  return buf;
}

void emit(const std::string& json) {
  std::lock_guard<std::mutex> lock(g_emit_mutex);
  std::fputs(json.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

}

// Every line is built as a std::string: a fixed snprintf buffer cut a long
// escaped title / path / message mid-string (or mid-escape), and the GUI's
// reader drops an invalid NDJSON line along with the event it carried.
void progress_start(const std::string& url) {
  emit("{\"type\":\"start\",\"url\":\"" + json_escape(url) + "\"}");
}

void progress_info(const std::string& title, double duration_s) {
  emit("{\"type\":\"info\",\"title\":\"" + json_escape(title) +
       "\",\"duration_s\":" + number(duration_s, "%.3f") + "}");
}

void progress_update(double percent,
                     const std::string& speed,
                     const std::string& eta) {
  emit("{\"type\":\"progress\",\"percent\":" + number(percent, "%.2f") +
       ",\"speed\":\"" + json_escape(speed) + "\",\"eta\":\"" + json_escape(eta) + "\"}");
}

void progress_done(const std::string& output) {
  emit("{\"type\":\"done\",\"output\":\"" + json_escape(output) + "\"}");
}

void progress_cancelled() {
  emit("{\"type\":\"cancelled\"}");
}

void progress_error(const std::string& message) {
  emit("{\"type\":\"error\",\"message\":\"" + json_escape(message) + "\"}");
}

void progress_log(const std::string& phase, const std::string& message) {
  // std::string (not a fixed buffer) — an invocation summary or a stderr line
  // can run past a couple KB and must not be silently truncated.
  std::string json = "{\"type\":\"log\",\"phase\":\"";
  json += json_escape(phase);
  json += "\",\"message\":\"";
  json += json_escape(message);
  json += "\"}";
  emit(json);
}

}
