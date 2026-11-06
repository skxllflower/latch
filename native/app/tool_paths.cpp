// The yt-dlp / ffmpeg / ffprobe the core runs (src/paths.cpp resolve_binary), seen from the GUI: the Settings
// window's readouts, Audition's decoder, and the overrides handed to every child core (settings.rs apply_tool_env).
#include "data_root.h"
#include "external_tools.h"
#include "settings_store.h"
#include <cstdlib>
#include <filesystem>
#include <map>

namespace fs = std::filesystem;

namespace latch {

namespace {
#if defined(_WIN32)
const char* const kExe = ".exe";
#else
const char* const kExe = "";
#endif

bool isFile(const fs::path& p) { std::error_code ec; return fs::is_regular_file(p, ec) && fs::file_size(p, ec) > 0 && !ec; }

std::string trimmed(std::string s) {
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '"')) s.pop_back();
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '"')) s.erase(0, 1);
    return s;
}

void setEnv(const char* var, const std::string& value) {
#if defined(_WIN32)
    _wputenv_s(fs::u8path(var).wstring().c_str(), fs::u8path(value).wstring().c_str());   // ("" removes it)
#else
    if (value.empty()) ::unsetenv(var); else ::setenv(var, value.c_str(), 1);
#endif
}

struct Tool { const char* setting; const char* env; const char* file; bool shared; };
const std::map<std::string, Tool>& tools() {
    static const std::map<std::string, Tool> t = {
        {"yt-dlp", {"ytdlpPath", "LATCH_YTDLP", "yt-dlp", false}},
        {"ffmpeg", {"ffmpegPath", "LATCH_FFMPEG", "ffmpeg", true}},
        {"ffprobe", {"", "LATCH_FFPROBE", "ffprobe", true}},
    };
    return t;
}

std::map<std::string, std::string>& ours() { static std::map<std::string, std::string> m; return m; }   // (what applyToolEnv set)
}  // namespace

std::string toolOverride(const std::string& name) {
    const auto it = tools().find(name);
    if (it == tools().end() || !*it->second.setting) return {};
    return trimmed(wdn::settings::text(it->second.setting, ""));
}

std::string toolPath(const std::string& name, std::string* source) {
    const auto it = tools().find(name);
    if (it == tools().end()) return {};
    const Tool& t = it->second;
    const std::string file = std::string(t.file) + kExe;
    auto found = [&](const fs::path& p, const char* src) { if (source) *source = src; return p.generic_u8string(); };
    if (const std::string o = toolOverride(name); !o.empty() && isFile(fs::u8path(o))) return found(fs::u8path(o), "override");
    if (name == "ffprobe")
        if (const std::string o = toolOverride("ffmpeg"); !o.empty() && isFile(fs::u8path(o).parent_path() / file))
            return found(fs::u8path(o).parent_path() / file, "override");
    if (const std::string e = envUtf8(t.env); !e.empty() && isFile(fs::u8path(e))) return found(fs::u8path(e), "env");
    if (const std::string core = ownCore(); !core.empty() && isFile(fs::u8path(core).parent_path() / file))
        return found(fs::u8path(core).parent_path() / file, "portable");
    const std::string shared = wdn::vendorSharedDir();
    if (!shared.empty()) {
        const fs::path home = t.shared ? fs::u8path(shared) / "bin" : fs::u8path(shared).parent_path() / "Latch" / "bin";
        if (isFile(home / file)) return found(home / file, "managed");
    }
    if (source) *source = "missing";
    return {};
}

void applyToolEnv() {
    auto put = [](const char* var, const std::string& v) {
        std::string& mine = ours()[var];
        if (v.empty() && mine.empty()) return;   // (not ours: a dev run's own variable stays)
        setEnv(var, v);
        mine = v;
    };
    const std::string y = toolOverride("yt-dlp"), f = toolOverride("ffmpeg");
    put("LATCH_YTDLP", y);
    put("LATCH_FFMPEG", f);
    std::string probe;
    if (!f.empty()) {
        const fs::path p = fs::u8path(f).parent_path() / (std::string("ffprobe") + kExe);
        if (isFile(p)) probe = p.u8string();
    }
    put("LATCH_FFPROBE", probe);
}

}  // namespace latch
