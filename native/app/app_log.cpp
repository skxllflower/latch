// logger.rs's always-on file log, and tools.rs's first-launch provisioning of the bundled tools (data_root.h).
#include "data_root.h"
#include "external_tools.h"
#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <mutex>

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

void provisionBundled() {
#if defined(_WIN32)
    if (!isWritable()) return;
    const std::string own = wdn::vendorExeDir();
    if (own.empty()) return;
    const fs::path res = fs::u8path(own) / "resources";
    const wchar_t* pd = _wgetenv(L"ProgramData");
    const fs::path vendor = fs::path(pd && *pd ? pd : L"C:\ProgramData") / L"Vacant Systems";
    auto seed = [](const fs::path& src, const fs::path& dst) {
        std::error_code ec;
        if (fs::exists(dst, ec) || !fs::is_regular_file(src, ec)) return;
        fs::create_directories(dst.parent_path(), ec);
        fs::copy_file(src, dst, fs::copy_options::none, ec);
        log(ec ? "provision: " + dst.u8string() + " failed: " + ec.message() : "provision: seeded " + dst.u8string());
    };
    seed(res / "ytdlp" / "yt-dlp.exe", vendor / "Latch" / "bin" / "yt-dlp.exe");
    for (const char* b : {"ffmpeg.exe", "ffprobe.exe"}) seed(res / "ffmpeg" / b, vendor / "Shared" / "bin" / b);
#endif
}

}  // namespace latch
