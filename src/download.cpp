#include "download.h"

#include "process.h"  // utf8_to_utf16

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <vector>

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <winhttp.h>
  #pragma comment(lib, "winhttp.lib")
#endif

namespace latch {

#ifdef _WIN32

namespace {

class HInternetGuard {
 public:
  explicit HInternetGuard(HINTERNET h) : h_(h) {}
  ~HInternetGuard() { if (h_) WinHttpCloseHandle(h_); }
  HInternetGuard(const HInternetGuard&) = delete;
  HInternetGuard& operator=(const HInternetGuard&) = delete;
  HINTERNET get() const { return h_; }
  explicit operator bool() const { return h_ != nullptr; }
 private:
  HINTERNET h_;
};

uint64_t query_content_length(HINTERNET req) {
  wchar_t buf[64] = {0};
  DWORD size = sizeof(buf);
  if (!WinHttpQueryHeaders(req,
        WINHTTP_QUERY_CONTENT_LENGTH,
        WINHTTP_HEADER_NAME_BY_INDEX,
        buf, &size,
        WINHTTP_NO_HEADER_INDEX)) {
    return 0;
  }
  return static_cast<uint64_t>(_wtoi64(buf));
}

}

bool download_with_progress(
    const std::string& url,
    const std::filesystem::path& dest,
    const std::function<void(uint64_t, uint64_t)>& on_progress) {

  std::wstring wurl = utf8_to_utf16(url);

  URL_COMPONENTSW uc{};
  uc.dwStructSize = sizeof(uc);
  uc.dwSchemeLength    = static_cast<DWORD>(-1);
  uc.dwHostNameLength  = static_cast<DWORD>(-1);
  uc.dwUrlPathLength   = static_cast<DWORD>(-1);
  uc.dwExtraInfoLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) {
    return false;
  }

  std::wstring host(uc.lpszHostName, uc.dwHostNameLength);
  std::wstring path_and_query(uc.lpszUrlPath,
                              uc.dwUrlPathLength + uc.dwExtraInfoLength);

  HInternetGuard session(WinHttpOpen(
      L"latch-bootstrap/0.3",
      WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
      WINHTTP_NO_PROXY_NAME,
      WINHTTP_NO_PROXY_BYPASS,
      0));
  if (!session) return false;

  HInternetGuard connect(WinHttpConnect(session.get(), host.c_str(), uc.nPort, 0));
  if (!connect) return false;

  DWORD flags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
  HInternetGuard req(WinHttpOpenRequest(
      connect.get(),
      L"GET",
      path_and_query.c_str(),
      nullptr,
      WINHTTP_NO_REFERER,
      WINHTTP_DEFAULT_ACCEPT_TYPES,
      flags));
  if (!req) return false;

  DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
  WinHttpSetOption(req.get(), WINHTTP_OPTION_REDIRECT_POLICY,
                   &policy, sizeof(policy));

  if (!WinHttpSendRequest(req.get(),
        WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0,
        0, 0)) {
    return false;
  }
  if (!WinHttpReceiveResponse(req.get(), nullptr)) {
    return false;
  }

  DWORD status = 0;
  DWORD status_size = sizeof(status);
  if (WinHttpQueryHeaders(req.get(),
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &status, &status_size,
        WINHTTP_NO_HEADER_INDEX)) {
    if (status < 200 || status >= 300) return false;
  }

  uint64_t total = query_content_length(req.get());

  std::ofstream f(dest, std::ios::binary | std::ios::trunc);
  if (!f) return false;

  std::vector<char> buffer(64 * 1024);
  uint64_t done = 0;
  auto last_emit = std::chrono::steady_clock::now();

  if (on_progress) on_progress(0, total);

  while (true) {
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(req.get(), &avail)) return false;
    if (avail == 0) break;

    DWORD chunk = std::min<DWORD>(avail, static_cast<DWORD>(buffer.size()));
    DWORD read = 0;
    if (!WinHttpReadData(req.get(), buffer.data(), chunk, &read)) return false;
    if (read == 0) break;

    f.write(buffer.data(), read);
    if (!f) return false;
    done += read;

    auto now = std::chrono::steady_clock::now();
    if (now - last_emit > std::chrono::milliseconds(150)) {
      if (on_progress) on_progress(done, total);
      last_emit = now;
    }
  }

  f.flush();
  if (!f) return false;
  if (on_progress) on_progress(done, total);
  return true;
}

#else  // POSIX

// No WinHTTP off Windows; drive curl through the existing run_subprocess
// plumbing (no new deps). curl is present on every macOS. We can't cheaply
// stream byte-level progress out of a blocking popen, so we mirror the WinHTTP
// path's *shape*: an opening on_progress(0, total) so the UI leaves the idle
// state, then a closing on_progress(size, size) at 100%. Callers only consume
// these to emit bootstrap NDJSON events, so the contract (bool return + the
// two callback bookends) is preserved.
bool download_with_progress(
    const std::string& url,
    const std::filesystem::path& dest,
    const std::function<void(uint64_t, uint64_t)>& on_progress) {

  if (on_progress) on_progress(0, 0);

  std::error_code ec;
  std::filesystem::remove(dest, ec);

  // -f fails the transfer on HTTP >= 400 (no half-written error pages),
  // -L follows redirects (GitHub releases -> CDN, evermeet -> its host),
  // --retry 3 rides out transient blips.
  std::vector<std::string> argv = {
    "curl", "-fL", "--retry", "3",
    "-o", dest.string(),
    url,
  };
  int rc = run_subprocess(argv, [](const std::string&) {});

  std::error_code size_ec;
  std::uintmax_t size = std::filesystem::file_size(dest, size_ec);
  bool ok = (rc == 0) && !size_ec && size > 0;
  if (!ok) {
    std::filesystem::remove(dest, ec);
    return false;
  }

  if (on_progress) on_progress(size, size);
  return true;
}

#endif

}
