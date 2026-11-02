#include "thumbs.h"
#include "data_root.h"
#include "pipe_run.h"
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>
#include <vpf/gui/editor.h>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <urlmon.h>
#endif

namespace fs = std::filesystem;

namespace latch {

struct Thumbs::Shared {
    std::mutex m;
    std::condition_variable cv;
    std::deque<std::string> todo;
    bool quit = false, running = false;
    std::atomic<bool> stop{false};
    std::shared_ptr<vpf::gui::UiQueue> ui;
    std::function<void(const std::string& url, vpf::gui::Bitmap bm)> landed;   // (UI thread, through ui)
};

namespace {

std::string key(const std::string& url) {
    uint64_t h = 1469598103934665603ull;   // (FNV-1a)
    for (unsigned char c : url) { h ^= c; h *= 1099511628211ull; }
    char b[24];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)h);
    return b;
}

bool download(const std::string& url, const fs::path& to) {
#if defined(_WIN32)
    if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0) return false;
    return SUCCEEDED(URLDownloadToFileW(nullptr, fs::u8path(url).wstring().c_str(), to.wstring().c_str(), 0, nullptr));
#else
    (void)url; (void)to;
    return false;   // (the Mac build: NSURLSession, not yet)
#endif
}

vpf::gui::Bitmap fromBgra(const std::string& bytes) {
    vpf::gui::Bitmap bm;
    const int n = Thumbs::kSize;
    if (bytes.size() != (size_t)n * n * 4) return bm;
    bm.w = bm.h = n;
    bm.px.resize((size_t)n * n);
    std::memcpy(bm.px.data(), bytes.data(), bytes.size());   // (BGRA bytes = 0xAARRGGBB little-endian)
    return bm;
}

std::string readAll(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    std::ostringstream ss;
    if (in) ss << in.rdbuf();
    return ss.str();
}

// one URL: the cached square, else downloaded and cropped by ffmpeg (then cached)
vpf::gui::Bitmap fetch(const std::string& url, const std::atomic<bool>& stop) {
    const fs::path dir = fs::u8path(dataRoot()) / "cache" / "thumbs";
    const fs::path cached = dir / (key(url) + ".bgra");
    if (vpf::gui::Bitmap bm = fromBgra(readAll(cached)); bm.valid()) return bm;
    const std::string ffmpeg = toolPath("ffmpeg");
    if (ffmpeg.empty()) return {};
    std::error_code ec;
    fs::create_directories(dir, ec);
    const fs::path src = dir / (key(url) + ".src");
    if (!download(url, src)) { fs::remove(src, ec); return {}; }
    const std::string n = std::to_string(Thumbs::kSize);
    std::string out;
    runPiped(ffmpeg, {"-nostdin", "-v", "error", "-i", src.u8string(), "-frames:v", "1",
                      "-vf", "scale=" + n + ":" + n + ":force_original_aspect_ratio=increase,crop=" + n + ":" + n,
                      "-f", "rawvideo", "-pix_fmt", "bgra", "-"},
             [&out](const char* d, size_t k) { out.append(d, k); }, stop);
    fs::remove(src, ec);
    vpf::gui::Bitmap bm = fromBgra(out);
    if (bm.valid() && isWritable()) {
        std::ofstream f(cached, std::ios::binary);
        f << out;
    }
    return bm;
}

}  // namespace

Thumbs::Thumbs(std::shared_ptr<vpf::gui::UiQueue> ui, std::function<void()> onLanded) : s_(std::make_shared<Shared>()) {
    s_->ui = std::move(ui);
    s_->landed = [this, onLanded](const std::string& url, vpf::gui::Bitmap bm) {
        if (bm.valid()) { ready_[url] = std::move(bm); if (onLanded) onLanded(); }
    };
}

Thumbs::~Thumbs() {
    std::lock_guard<std::mutex> g(s_->m);
    s_->quit = true;
    s_->stop = true;
    s_->landed = nullptr;
    s_->cv.notify_all();
}

const vpf::gui::Bitmap* Thumbs::get(const std::string& url) {
    if (url.empty()) return nullptr;
    if (auto it = ready_.find(url); it != ready_.end()) return &it->second;
    static std::set<std::string> asked;   // (once a run, a failure included)
    if (!asked.insert(url).second) return nullptr;
    std::lock_guard<std::mutex> g(s_->m);
    s_->todo.push_back(url);
    if (!s_->running) {
        s_->running = true;
        std::thread([s = s_] {
            for (;;) {
                std::string url;
                {
                    std::unique_lock<std::mutex> g(s->m);
                    s->cv.wait(g, [&] { return s->quit || !s->todo.empty(); });
                    if (s->quit) return;
                    url = s->todo.front();
                    s->todo.pop_front();
                }
                vpf::gui::Bitmap bm = fetch(url, s->stop);
                if (!bm.valid()) log("thumbnail: none for " + url);
                std::lock_guard<std::mutex> g(s->m);
                if (s->quit) return;
                s->ui->post([s, url, bm = std::move(bm)]() mutable {
                    if (s->landed) s->landed(url, std::move(bm));   // (the UI thread's, as the destructor that clears it)
                });
            }
        }).detach();
    }
    s_->cv.notify_all();
    return nullptr;
}

}  // namespace latch
