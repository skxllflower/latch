// logger.rs's always-on file log, and tools.rs's first-launch provisioning of the bundled tools (data_root.h).
#include "data_root.h"
#include "external_tools.h"
#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>
#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace latch {

std::string logPath() { return dataRoot() + "/logs/latch.log"; }

void log(const std::string& line) {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char stamp[32];
    std::strftime(stamp, sizeof stamp, "%Y-%m-%d %H:%M:%SZ", &tm);
    const std::string out = std::string("[") + stamp + "] " + line + "\n";
    std::fputs(out.c_str(), stderr);
    if (!isWritable()) return;
    static std::mutex lock;
    std::lock_guard<std::mutex> hold(lock);
    std::error_code ec;
    const fs::path p = fs::u8path(logPath());
    fs::create_directories(p.parent_path(), ec);
    std::ofstream f(p, std::ios::binary | std::ios::app);
    f << out;
}

void logInit() {
    std::error_code ec;
    const fs::path p = fs::u8path(logPath());
    if (isWritable() && fs::file_size(p, ec) > 1000000 && !ec) fs::remove(p, ec);
    log("==== Latch session start (v" LATCH_VERSION ", native) ====");
}

#if defined(_WIN32)
namespace {
// the copy into place: a sibling temp name, then a rename that never replaces (a tool that got there meanwhile, the
// core's own download in a first extract, stays). A partial copy (a quit mid-copy) only ever sits under the temp name,
// which the next launch clears: one Latch at a time, so a temp of ours is never a live one
void seed(const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    if (fs::exists(dst, ec) || !fs::is_regular_file(src, ec)) return;
    fs::create_directories(dst.parent_path(), ec);
    const std::wstring stem = dst.filename().wstring() + L".provision-";
    for (auto& e : fs::directory_iterator(dst.parent_path(), ec)) {
        if (e.path().filename().wstring().rfind(stem, 0) == 0) { std::error_code rm; fs::remove(e.path(), rm); }
    }
    const fs::path tmp = dst.parent_path() / (stem + std::to_wstring(GetCurrentProcessId()));
    fs::copy_file(src, tmp, fs::copy_options::overwrite_existing, ec);
    if (!ec && !MoveFileExW(tmp.c_str(), dst.c_str(), MOVEFILE_WRITE_THROUGH)) {
        const DWORD why = GetLastError();
        if (why != ERROR_ALREADY_EXISTS && why != ERROR_FILE_EXISTS) ec = std::error_code((int)why, std::system_category());
        else log("provision: " + dst.u8string() + " appeared meanwhile, kept");
    }
    std::error_code rm;
    fs::remove(tmp, rm);
    log(ec ? "provision: " + dst.u8string() + " failed: " + ec.message() : "provision: seeded " + dst.u8string());
}

// the copy's thread, joined at exit: a quit during a first launch's copy (~150 MB) waits for it rather than leaving
// the thread writing as the process tears down
struct ProvisionThread {
    std::thread t;
    ~ProvisionThread() { if (t.joinable()) t.join(); }
};
}  // namespace
#endif

void provisionBundled() {
#if defined(_WIN32)
    if (!isWritable()) return;
    const std::string own = wdn::vendorExeDir();
    if (own.empty()) return;
    const fs::path res = fs::u8path(own) / "resources";
    const wchar_t* pd = _wgetenv(L"ProgramData");
    const fs::path vendor = fs::path(pd && *pd ? pd : L"C:\\ProgramData") / L"Vacant Systems";
    // off the UI thread (the window opens at once). An extract started before it lands finds the tool missing and the
    // core downloads it, which the non-replacing rename above keeps. yt-dlp first: every extract needs it
    static ProvisionThread worker;
    if (worker.t.joinable()) return;
    worker.t = std::thread([res, vendor] {
        seed(res / "ytdlp" / "yt-dlp.exe", vendor / "Latch" / "bin" / "yt-dlp.exe");
        for (const char* b : {"ffmpeg.exe", "ffprobe.exe"}) seed(res / "ffmpeg" / b, vendor / "Shared" / "bin" / b);
    });
#endif
}

}  // namespace latch
