// registry.rs register_self and tools.rs find_tool_binary's own-core half (data_root.h).
#include "data_root.h"
#include "dev_run.h"
#include "external_tools.h"
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <sstream>

namespace fs = std::filesystem;

namespace latch {

namespace {
bool isFile(const fs::path& p) { std::error_code ec; return fs::is_regular_file(p, ec); }
#if defined(_WIN32)
const char* const kCore = "latch.exe";
#else
const char* const kCore = "latch";
#endif
}  // namespace

std::string ownCore() {
    const std::string own = wdn::vendorExeDir();
    if (own.empty()) return {};
    const fs::path dir = fs::u8path(own);
    for (const fs::path& c : {dir / "coredist" / kCore, dir / kCore})
        if (isFile(c)) return c.generic_u8string();
    if (!wdn::dev::devRun()) return {};
    // native/build/bin/Release/latch-gui.exe (or native/build/bin/latch-gui): the repo is the folder over native/
    for (fs::path d = dir; !d.empty() && d != d.parent_path(); d = d.parent_path()) {
        if (d.filename() != "native") continue;
        const fs::path b = d.parent_path() / "build";
        for (const fs::path& c : {b / "Release" / kCore, b / kCore, b / "Debug" / kCore})
            if (isFile(c)) return c.generic_u8string();
        break;
    }
    return {};
}

namespace {
nlohmann::json readRegistry(const fs::path& p) {
    nlohmann::json root;
    std::ifstream in(p, std::ios::binary);
    if (in) { std::ostringstream ss; ss << in.rdbuf(); root = nlohmann::json::parse(ss.str(), nullptr, false); }
    return root.is_object() ? root : nlohmann::json::object();
}

bool writeRegistry(const fs::path& p, const nlohmann::json& root) {
    const fs::path tmp = fs::path(p).concat(".tmp");
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) return false;
        out << root.dump(2);
        if (!out) return false;
    }
    std::error_code ec;
    fs::rename(tmp, p, ec);
    if (ec) fs::remove(tmp, ec);
    return !ec;
}
}  // namespace

void registerSelf(const std::string& core, const std::string& sharedDir) {
    if (core.empty() || !isWritable()) return;
    const std::string shared = sharedDir.empty() ? wdn::vendorSharedDir() : sharedDir;
    if (shared.empty()) return;
    const fs::path p = fs::u8path(shared + "/registry.json");
    std::error_code ec;
    fs::create_directories(p.parent_path(), ec);
    nlohmann::json root = readRegistry(p);
#if defined(_WIN32)
    std::string native = core;
    for (char& c : native) if (c == '/') c = '\\';   // (the Tauri app wrote the OS's own separators)
#else
    const std::string& native = core;
#endif
    root["latch"] = {{"path", native}, {"version", LATCH_VERSION}};
    writeRegistry(p, root);
}

void unregisterSelf(const std::string& sharedDir) {
    const std::string shared = sharedDir.empty() ? wdn::vendorSharedDir() : sharedDir;
    if (shared.empty()) return;
    const fs::path p = fs::u8path(shared + "/registry.json");
    std::error_code ec;
    if (!fs::exists(p, ec)) return;
    nlohmann::json root = readRegistry(p);
    if (!root.contains("latch")) return;
    root.erase("latch");
    if (root.empty()) fs::remove(p, ec);
    else writeRegistry(p, root);
}

}  // namespace latch
