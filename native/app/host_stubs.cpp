// The WAVdesk-library calls the shared window files make (WAVdesk's native/shell/library.cpp and commands.cpp define
// them there), here for Latch: its data root is Latch's own folder, not WAVdesk's index copy. settings.json (the skin,
// the Tauri app's tool paths and folders) and native_ui.json (the window's settings, under the Tauri localStorage key names) live in it.
#include "library.h"
#include "commands.h"
#include "data_root.h"
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <nlohmann/json.hpp>
#include <sstream>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace latch {

namespace {
std::string slashes(std::string s) { for (char& c : s) if (c == '\\') c = '/'; return s; }

std::string readFile(const std::string& path) {
    std::ifstream in(fs::u8path(path), std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

std::atomic<bool> writable{true};
}  // namespace

// %LOCALAPPDATA%\Vacant Systems\Latch (the uninstaller's "delete app data" folder), ~/Library/Application
// Support/Vacant Systems/Latch on the Mac; LATCH_DATA_ROOT another (a test's scratch folder)
std::string dataRoot() {
    static const std::string root = [] {
        if (const char* d = std::getenv("LATCH_DATA_ROOT"); d && *d) return slashes(d);
#if defined(_WIN32)
        const wchar_t* la = _wgetenv(L"LOCALAPPDATA");
        const fs::path base = la && *la ? fs::path(la) : fs::path(L"C:\\Users\\Default\\AppData\\Local");
        return slashes((base / L"Vacant Systems" / L"Latch").u8string());
#else
        const char* home = std::getenv("HOME");
        return std::string(home ? home : "") + "/Library/Application Support/Vacant Systems/Latch";
#endif
    }();
    return root;
}

void setWritable(bool on) { writable = on; }
bool isWritable() { return writable; }

}  // namespace latch

namespace wdn {

std::string appDataRoot() { return latch::dataRoot(); }

std::string readDataFile(const std::string& name) { return latch::readFile(appDataRoot() + "/" + name); }

// library.cpp writeSettings: settings.json read fresh, these keys replaced, written to a temp sibling and renamed over
bool writeSettings(const std::vector<std::pair<std::string, std::string>>& keyJson) {
    if (!latch::isWritable()) return false;
    static std::mutex lock;
    std::lock_guard<std::mutex> hold(lock);
    const std::string path = appDataRoot() + "/settings.json";
    nlohmann::json doc = nlohmann::json::parse(latch::readFile(path), nullptr, false);
    if (doc.is_discarded() || !doc.is_object()) doc = nlohmann::json::object();
    for (const auto& kv : keyJson) {
        nlohmann::json v = nlohmann::json::parse(kv.second, nullptr, false);
        if (v.is_discarded()) return false;
        doc[kv.first] = std::move(v);
    }
    std::error_code ec;
    fs::create_directories(fs::u8path(appDataRoot()), ec);
#if defined(_WIN32)
    const unsigned long pid = GetCurrentProcessId();
#else
    const unsigned long pid = (unsigned long)getpid();
#endif
    const fs::path file = fs::u8path(path), tmp = fs::u8path(path + ".tmp." + std::to_string(pid));
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) return false;
        out << doc.dump(4);
        if (!out) return false;
    }
    fs::rename(tmp, file, ec);
    if (ec) { fs::remove(tmp, ec); return false; }
    return true;
}

std::string upperAscii(std::string s) {
    for (char& c : s) if ((unsigned char)c < 0x80) c = (char)std::toupper((unsigned char)c);
    return s;
}

// (commands.cpp: the Mac's key chords in a row label; Latch's menus carry no shortcuts)
std::string menuLabel(const std::string& label) { return label; }

// (commands.cpp: "Ctrl+Enter" in a hint written as the Mac's chord there; the Mac build still owes that form)
std::string keyText(const std::string& text) { return text; }

}  // namespace wdn
