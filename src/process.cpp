#include "process.h"

#include <atomic>
#include <cstdio>
#include <string>
#include <vector>

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
#else
  #include <signal.h>
  #include <sys/wait.h>
  #include <unistd.h>
  #if defined(__APPLE__)
    #include <cstdint>
    #include <filesystem>
    #include <mach-o/dyld.h>
  #endif
#endif

namespace latch {

namespace {

std::atomic<bool> g_cancelled{false};
std::string       g_last_error;

#ifdef _WIN32

HANDLE g_job = nullptr;

BOOL WINAPI ctrl_handler(DWORD dw_type) {
  switch (dw_type) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
      g_cancelled.store(true);
      if (g_job) TerminateJobObject(g_job, 1);
      return TRUE;
    default:
      return FALSE;
  }
}

std::wstring quote_arg_w(const std::wstring& arg) {
  bool needs = arg.empty() ||
               arg.find_first_of(L" \t\n\v\"") != std::wstring::npos;
  if (!needs) return arg;
  std::wstring out;
  out.push_back(L'"');
  for (size_t i = 0; i < arg.size(); ++i) {
    size_t bs = 0;
    while (i < arg.size() && arg[i] == L'\\') { ++bs; ++i; }
    if (i == arg.size()) {
      out.append(bs * 2, L'\\');
      break;
    }
    if (arg[i] == L'"') {
      out.append(bs * 2 + 1, L'\\');
      out.push_back(L'"');
    } else {
      out.append(bs, L'\\');
      out.push_back(arg[i]);
    }
  }
  out.push_back(L'"');
  return out;
}

#endif

}

#ifdef _WIN32

std::wstring utf8_to_utf16(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(),
                              nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n);
  return out;
}

std::string utf16_to_utf8(const std::wstring& s) {
  if (s.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(),
                              nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(),
                      &out[0], n, nullptr, nullptr);
  return out;
}

std::string to_valid_utf8(const std::string& s) {
  if (s.empty()) return s;
  // Already valid UTF-8? MB_ERR_INVALID_CHARS makes the decode fail (returns 0)
  // on any malformed sequence, so a positive result means "leave it alone".
  int ok = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                               s.data(), (int)s.size(), nullptr, 0);
  if (ok > 0) return s;
  // Not valid UTF-8: treat the bytes as the active ANSI codepage (what a piped
  // Python/ffmpeg child emits on Windows) and re-encode to UTF-8.
  int wn = MultiByteToWideChar(CP_ACP, 0, s.data(), (int)s.size(), nullptr, 0);
  if (wn <= 0) return s;
  std::wstring w(static_cast<size_t>(wn), L'\0');
  MultiByteToWideChar(CP_ACP, 0, s.data(), (int)s.size(), &w[0], wn);
  return utf16_to_utf8(w);
}

int run_subprocess(const std::vector<std::string>& argv,
                   const std::function<void(const std::string&)>& on_line,
                   const std::function<void()>& on_idle) {
  g_cancelled.store(false);
  g_last_error.clear();
  if (argv.empty()) { g_last_error = "empty argv"; return -1; }

  std::wstring cmd_line;
  for (size_t i = 0; i < argv.size(); ++i) {
    if (i) cmd_line.push_back(L' ');
    cmd_line += quote_arg_w(utf8_to_utf16(argv[i]));
  }

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) {
    g_last_error = "CreatePipe failed";
    return -1;
  }
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    CloseHandle(rd); CloseHandle(wr);
    g_last_error = "CreateJobObjectW failed";
    return -1;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
  jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                          &jeli, sizeof(jeli));

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = wr;
  si.hStdError  = wr;
  si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);

  PROCESS_INFORMATION pi{};
  std::wstring cmd_buf = cmd_line;

  BOOL ok = CreateProcessW(
    nullptr,
    &cmd_buf[0],
    nullptr, nullptr,
    TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW,
    nullptr, nullptr,
    &si, &pi);

  if (!ok) {
    DWORD err = GetLastError();
    char msg[128];
    std::snprintf(msg, sizeof(msg),
                  "CreateProcessW failed (GetLastError=%lu)", err);
    g_last_error = msg;
    CloseHandle(rd); CloseHandle(wr); CloseHandle(job);
    return -1;
  }

  AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread);

  CloseHandle(wr);

  g_job = job;
  SetConsoleCtrlHandler(ctrl_handler, TRUE);

  std::string line;
  char buf[4096];
  // Poll the pipe instead of a blocking ReadFile so a running-but-silent child
  // (a stalled download) can be surfaced via on_idle. PeekNamedPipe tells us
  // how much is buffered without consuming it; on an empty buffer we wait
  // briefly on the process and, if it's still alive, fire the idle hook.
  for (;;) {
    DWORD avail = 0;
    if (!PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr)) {
      break;  // write end closed → EOF
    }
    if (avail == 0) {
      if (WaitForSingleObject(pi.hProcess, 50) == WAIT_OBJECT_0) {
        // Child exited — one more drain pass for anything still buffered.
        if (!PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr) || avail == 0) {
          break;
        }
      } else {
        if (on_idle) on_idle();  // running + silent → stall check
        continue;
      }
    }
    DWORD want = avail < sizeof(buf) ? avail : static_cast<DWORD>(sizeof(buf));
    DWORD n = 0;
    if (!ReadFile(rd, buf, want, &n, nullptr) || n == 0) break;
    for (DWORD i = 0; i < n; ++i) {
      char c = buf[i];
      if (c == '\n' || c == '\r') {
        if (!line.empty()) {
          if (on_line) on_line(to_valid_utf8(line));
          line.clear();
        }
      } else {
        line.push_back(c);
      }
    }
  }
  if (!line.empty() && on_line) on_line(to_valid_utf8(line));

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD exit_code = 0;
  GetExitCodeProcess(pi.hProcess, &exit_code);

  SetConsoleCtrlHandler(ctrl_handler, FALSE);
  g_job = nullptr;

  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  CloseHandle(rd);
  CloseHandle(job);

  return static_cast<int>(exit_code);
}

std::string exe_dir() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (n == 0) return ".";
  std::wstring s(buf, n);
  auto slash = s.find_last_of(L"\\/");
  std::wstring dir = (slash == std::wstring::npos) ? L"." : s.substr(0, slash);
  return utf16_to_utf8(dir);
}

#else  // POSIX

int run_subprocess(const std::vector<std::string>& argv,
                   const std::function<void(const std::string&)>& on_line,
                   const std::function<void()>& /*on_idle*/) {
  g_cancelled.store(false);
  g_last_error.clear();
  if (argv.empty()) { g_last_error = "empty argv"; return -1; }

  std::string cmd;
  for (size_t i = 0; i < argv.size(); ++i) {
    if (i) cmd += " ";
    cmd += "\"";
    for (char c : argv[i]) {
      if (c == '"' || c == '\\' || c == '$' || c == '`') cmd += '\\';
      cmd += c;
    }
    cmd += "\"";
  }
  cmd += " 2>&1";

  FILE* pipe = popen(cmd.c_str(), "r");
  if (!pipe) { g_last_error = "popen failed"; return -1; }

  char buf[4096];
  while (std::fgets(buf, sizeof(buf), pipe)) {
    std::string line(buf);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r'))
      line.pop_back();
    if (!line.empty() && on_line) on_line(line);
  }
  int rc = pclose(pipe);
  if (WIFEXITED(rc)) rc = WEXITSTATUS(rc);
  return rc;
}

std::string exe_dir() {
#if defined(__APPLE__)
  // macOS has no /proc; ask dyld for our own image path. First call with a null
  // buffer reports the needed size, then we fill it. The result can contain
  // symlinks or ".." components, so canonicalize before taking the parent.
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string buf(size, '\0');
  if (_NSGetExecutablePath(&buf[0], &size) != 0) return ".";
  if (!buf.empty() && buf.back() == '\0') buf.pop_back();
  std::error_code ec;
  std::filesystem::path p = std::filesystem::canonical(buf, ec);
  if (ec) p = std::filesystem::path(buf);
  std::filesystem::path dir = p.parent_path();
  return dir.empty() ? std::string(".") : dir.string();
#else
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n <= 0) return ".";
  std::string s(buf, n);
  auto slash = s.find_last_of('/');
  return slash == std::string::npos ? std::string(".") : s.substr(0, slash);
#endif
}

// POSIX tools already emit UTF-8; nothing to recover.
std::string to_valid_utf8(const std::string& s) { return s; }

#endif

bool was_cancelled() { return g_cancelled.load(); }
std::string last_subprocess_error() { return g_last_error; }

}
