// The Tauri app's window settings, once: its webview kept them in localStorage under the same wd-latch-* (and latch-chop-*) names the
// native window reads from native_ui.json (the save folder, format, mode, thumbnails, cookies browser ...). WebView2
// keeps localStorage in a LevelDB: <LOCALAPPDATA>\com.vacantsystems.latch\EBWebView\Default\Local Storage\leveldb.
// Its write-ahead logs (*.log) hold every write as a record (the table files a compaction makes are not read: that
// store is a handful of keys and stays in its log). Keys are "_<origin>\0" + an encoding byte + the name, values an
// encoding byte + the text: 1 = Latin-1, 0 = UTF-16LE. The last write wins, a delete removes.
// Then the profile goes (the installer used to remove it; it waits for this now): it is only the old webview's.
#include "data_root.h"
#include "dev_run.h"
#include "settings_store.h"
#include "ui_state.h"
#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <sstream>
#include <vector>

namespace fs = std::filesystem;

namespace latch {

namespace {

std::string latin1(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c < 0x80) o += (char)c;
        else { o += (char)(0xC0 | (c >> 6)); o += (char)(0x80 | (c & 0x3F)); }
    }
    return o;
}

std::string utf16le(const std::string& s) {
    std::u16string w;
    for (size_t i = 0; i + 1 < s.size(); i += 2) w += (char16_t)((unsigned char)s[i] | ((unsigned char)s[i + 1] << 8));
    std::string o;
    for (size_t i = 0; i < w.size(); ++i) {
        uint32_t c = w[i];
        if (c >= 0xD800 && c < 0xDC00 && i + 1 < w.size() && w[i + 1] >= 0xDC00 && w[i + 1] < 0xE000) c = 0x10000 + ((c - 0xD800) << 10) + (w[++i] - 0xDC00);
        if (c < 0x80) o += (char)c;
        else if (c < 0x800) { o += (char)(0xC0 | (c >> 6)); o += (char)(0x80 | (c & 0x3F)); }
        else if (c < 0x10000) { o += (char)(0xE0 | (c >> 12)); o += (char)(0x80 | ((c >> 6) & 0x3F)); o += (char)(0x80 | (c & 0x3F)); }
        else { o += (char)(0xF0 | (c >> 18)); o += (char)(0x80 | ((c >> 12) & 0x3F)); o += (char)(0x80 | ((c >> 6) & 0x3F)); o += (char)(0x80 | (c & 0x3F)); }
    }
    return o;
}

std::optional<std::string> decodeText(const std::string& s) {
    if (s.empty()) return std::nullopt;
    if (s[0] == 1) return latin1(s.substr(1));
    if (s[0] == 0) return utf16le(s.substr(1));
    return std::nullopt;
}

bool varint(const std::string& b, size_t& at, uint32_t& out) {
    out = 0;
    for (int shift = 0; shift <= 28 && at < b.size(); shift += 7) {
        const unsigned char c = (unsigned char)b[at++];
        out |= (uint32_t)(c & 0x7F) << shift;
        if (!(c & 0x80)) return true;
    }
    return false;
}

// one LevelDB log's write batches, in order, into `kv` (wd-latch-* and latch-chop-* of the tauri.localhost origins only)
void readLog(const fs::path& p, std::map<std::string, std::optional<std::string>>& kv) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return;
    std::ostringstream ss;
    ss << in.rdbuf();
    const std::string data = ss.str();
    constexpr size_t kBlock = 32768;
    std::string record;
    auto batch = [&kv](const std::string& b) {
        if (b.size() < 12) return;
        size_t at = 12;   // (sequence, count)
        while (at < b.size()) {
            const unsigned char tag = (unsigned char)b[at++];
            uint32_t kl = 0, vl = 0;
            if (!varint(b, at, kl) || at + kl > b.size()) return;
            const std::string key = b.substr(at, kl);
            at += kl;
            std::optional<std::string> val;
            if (tag == 1) {
                if (!varint(b, at, vl) || at + vl > b.size()) return;
                val = b.substr(at, vl);
                at += vl;
            } else if (tag != 0) return;
            const size_t nul = key.find('\0');
            if (nul == std::string::npos) continue;
            const std::string origin = key.substr(0, nul);
            if (origin != "_http://tauri.localhost" && origin != "_https://tauri.localhost") continue;
            const std::optional<std::string> name = decodeText(key.substr(nul + 1));
            if (!name || (name->rfind("wd-latch-", 0) != 0 && name->rfind("latch-chop-", 0) != 0)) continue;   // (the chop window's too)
            kv[*name] = val ? decodeText(*val) : std::nullopt;
        }
    };
    for (size_t at = 0; at + 7 <= data.size();) {
        const size_t left = kBlock - at % kBlock;
        if (left < 7) { at += left; continue; }
        const size_t len = (unsigned char)data[at + 4] | ((unsigned char)data[at + 5] << 8);
        const int type = (unsigned char)data[at + 6];
        if (at + 7 + len > data.size()) break;
        const std::string frag = data.substr(at + 7, len);
        at += 7 + len;
        if (type == 1) batch(frag);
        else if (type == 2) record = frag;
        else if (type == 3) record += frag;
        else if (type == 4) { record += frag; batch(record); record.clear(); }
    }
}

}  // namespace

void importTauriState() {
#if defined(_WIN32)
    if (!isWritable() || wdn::settings::flag("tauriImported", false)) return;
    if (wdn::dev::devRun() && !_wgetenv(L"LATCH_TAURI_IMPORT")) return;   // (a dev run beside an installed Tauri Latch: never its profile)
    const wchar_t* la = _wgetenv(L"LOCALAPPDATA");
    if (!la || !*la) return;
    const fs::path profile = fs::path(la) / L"com.vacantsystems.latch";
    const fs::path db = profile / L"EBWebView" / L"Default" / L"Local Storage" / L"leveldb";
    std::error_code ec;
    std::vector<fs::path> logs;
    for (fs::directory_iterator it(db, ec), end; !ec && it != end; it.increment(ec))
        if (it->path().extension() == L".log") logs.push_back(it->path());
    std::sort(logs.begin(), logs.end());   // (numbered: oldest first)
    std::map<std::string, std::optional<std::string>> kv;
    for (const fs::path& p : logs) readLog(p, kv);
    int n = 0;
    for (const auto& [k, v] : kv) {
        if (!v || wdn::ui_state::get(k, "\x01") != "\x01") continue;   // (deleted there, or the native window has its own)
        wdn::ui_state::set(k, *v);
        ++n;
    }
    log("tauri import: " + std::to_string(n) + " window setting(s) from " + std::to_string(logs.size()) + " webview log(s)");
    wdn::settings::set("tauriImported", true);
    if (fs::exists(profile, ec)) {
        fs::remove_all(profile, ec);
        log(ec ? "tauri import: the old webview profile stays (" + ec.message() + ")" : "tauri import: removed the old webview profile");
    }
#endif
}

// settings.json's downloadDir (Settings: where downloads start) for a window that has no folder of its own yet
void seedDownloadDir() {
    const std::string d = wdn::settings::text("downloadDir", "");
    if (!d.empty() && wdn::ui_state::get("wd-latch-output-dir", "").empty()) wdn::ui_state::set("wd-latch-output-dir", d);
}

}  // namespace latch
