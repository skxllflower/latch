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

void emit(const std::string& json) {
  std::lock_guard<std::mutex> lock(g_emit_mutex);
  std::fputs(json.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

}

void progress_start(const std::string& url) {
  char buf[2048];
  std::snprintf(buf, sizeof(buf),
    "{\"type\":\"start\",\"url\":\"%s\"}",
    json_escape(url).c_str());
  emit(buf);
}

void progress_info(const std::string& title, double duration_s) {
  char buf[2048];
  std::snprintf(buf, sizeof(buf),
    "{\"type\":\"info\",\"title\":\"%s\",\"duration_s\":%.3f}",
    json_escape(title).c_str(), duration_s);
  emit(buf);
}

void progress_update(double percent,
                     const std::string& speed,
                     const std::string& eta) {
  char buf[1024];
  std::snprintf(buf, sizeof(buf),
    "{\"type\":\"progress\",\"percent\":%.2f,\"speed\":\"%s\",\"eta\":\"%s\"}",
    percent, json_escape(speed).c_str(), json_escape(eta).c_str());
  emit(buf);
}

void progress_done(const std::string& output) {
  char buf[2048];
  std::snprintf(buf, sizeof(buf),
    "{\"type\":\"done\",\"output\":\"%s\"}",
    json_escape(output).c_str());
  emit(buf);
}

void progress_cancelled() {
  emit("{\"type\":\"cancelled\"}");
}

void progress_error(const std::string& message) {
  char buf[4096];
  std::snprintf(buf, sizeof(buf),
    "{\"type\":\"error\",\"message\":\"%s\"}",
    json_escape(message).c_str());
  emit(buf);
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
