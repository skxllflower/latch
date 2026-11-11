#include "settings_window.h"
#include "chop_midi.h"
#include "data_root.h"
#include "external_tools.h"
#include "look.h"
#include "settings_store.h"
#include "skin.h"
#include <algorithm>
#include <filesystem>
#include <thread>
#include <vpf/app/text_field.h>
#include <vpf/gui/editor.h>

namespace latch {

using vpf::gui::Rect;
using wdn::Style;
using wdn::skin;

namespace {

struct ToolRow { const char* key; const char* name; const char* label; const char* blurb; };
const ToolRow kTools[] = {
    {"ytdlpPath", "yt-dlp", "yt-dlp", "Downloader"},
    {"ffmpegPath", "ffmpeg", "ffmpeg", "Audio / video encode"},
    {"lathePath", "lathe", "lathe", "Chop video decode"},
};
struct FolderRow { const char* key; const char* label; const char* placeholder; };
const FolderRow kFolders[] = {
    {"downloadDir", "Download folder", "Auto (your Downloads folder)"},
    {"clipsDir", "Clip export folder", "Auto (Documents / Vacant Systems / Latch Clips)"},
};

std::string trimmed(std::string s) {
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.pop_back();
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.erase(0, 1);
    return s;
}

bool isFile(const std::string& p) { std::error_code ec; return !p.empty() && std::filesystem::is_regular_file(std::filesystem::u8path(p), ec); }

}  // namespace

SettingsWindow::SettingsWindow() {
    name = "latch-settings";
    for (const ToolRow& t : kTools) {
        vpf::app::TextField* f = field(t.key, "Auto", 9, true);
        f->setValue(wdn::settings::text(t.key, ""));
        const std::string key = t.key;
        f->onChange = [this, key](const std::string& v) { save(key, v); };
    }
    for (const FolderRow& r : kFolders) {
        vpf::app::TextField* f = field(r.key, r.placeholder, 9, true);
        f->setValue(wdn::settings::text(r.key, ""));
        const std::string key = r.key;
        f->onChange = [this, key](const std::string& v) { save(key, v); };
    }
}

bool SettingsWindow::onKey(const vpf::gui::KeyEvent& e) {
    if (e.key == vpf::gui::Key::Escape) { if (onClose) onClose(); return true; }
    return false;
}

// each edit saved at once (settings.rs settings_set: one key, the others kept)
void SettingsWindow::save(const std::string& key, const std::string& value) {
    const std::string v = trimmed(value);
    if (v.empty()) wdn::settings::erase(key); else wdn::settings::set(key, v);
    if (key != "downloadDir" && key != "clipsDir") {
        if (onToolsChanged) onToolsChanged();
        if (key == "lathePath") probeLathe();
    }
    changed();
}

// lathe's resolution spawns `lathe libav-version` (the capability probe): off the UI thread
void SettingsWindow::probeLathe() {
    const std::string o = trimmed(wdn::settings::text("lathePath", ""));
    if (!o.empty()) { latheOk_ = isFile(o); latheReadout_ = latheOk_ ? o : "not found"; return; }
    if (!editor()) return;
    latheReadout_ = "Resolving...";
    std::shared_ptr<vpf::gui::UiQueue> q = editor()->uiQueue();
    std::weak_ptr<bool> alive = alive_;
    std::thread([q, alive, this] {
        const wdn::ext::ToolStatus st = wdn::ext::probeTool("lathe");
        q->post([alive, this, st] {
            if (alive.expired()) return;
            latheOk_ = st.resolved;
            latheReadout_ = st.resolved ? st.source + "  " + st.path : "not found (Chop's video preview only)";
            changed();
        });
    }).detach();
}

void SettingsWindow::layout() {
    const int W = bounds.w > 0 ? bounds.w : kWidth, H = bounds.h > 0 ? bounds.h : kHeight;
    const Style& lab = skin().style("tool.label"), &grid = skin().style("tool.grid"), &title = skin().style("tool.title");
    const Style& tones = skin().style("ext.tones");
    const vpf::gui::Color line = skin().style("tool.footer").line, muted = lab.ink, primary = grid.ink, faint = title.soft;
    const vpf::gui::Color ok = tones.ink, warn = tones.mark;
    if (!probed_ && editor()) { probed_ = true; probeLathe(); }

    const int x = 16, fw = W - 32;
    const Rect view{0, (int)kTitle, W, H - (int)kTitle};
    Region& g = region("body", view);
    const Rect body = view;
    int y = view.y + 14 - g.scroll;
    auto section = [&](const std::string& t) {
        label(body, x, y, t, 8, muted, true, true);
        y += 13;
        add({x, y, fw, 1}, body, "", true, [line](const vpf::gui::Paint& p, const Rect& r, bool) { p.canvas.fillRect(p.dev(r), line); });
        y += 10;
    };
    auto fieldRow = [&](const std::string& key, const std::string& browseId, const std::string& icon, bool set) {
        const int bw = 22, n = set ? 2 : 1;
        placeField(key, {x, y, fw - n * (bw + 2), 20}, body, true);
        int bx = x + fw - n * (bw + 2) + 2;
        iconButton(body, {bx, y, bw, 20}, browseId, icon, 12, true, muted, primary);
        if (set) iconButton(body, {bx + bw + 2, y, bw, 20}, "clear:" + key, "rotate-ccw", 12, true, muted, primary);
        y += 24;
    };

    section("Look");
    {
        std::vector<Opt> looks;
        for (const auto& l : wdn::skinChoices()) looks.push_back({l.first, l.second});
        select(body, {x, y, std::min(fw, 200), 20}, "select:skin", looks, skinName, true);
        y += 20 + 16;
    }

    section("MIDI");
    {
        // (settings.json midiInput: "" the first input plugged in, "off", or a device; chop_midi.h)
        std::vector<Opt> opts{{"", "Auto (the first plugged in)"}};
        const std::string cur = wdn::settings::text(ChopMidi::kKey, "");
        std::vector<std::string> names = ChopMidi::devices();
        if (!cur.empty() && cur != "off" && std::find(names.begin(), names.end(), cur) == names.end()) names.push_back(cur);
        for (const std::string& n : names) opts.push_back({n, n});
        opts.push_back({"off", "Off"});
        select(body, {x, y, std::min(fw, 260), 20}, "select:midi", opts, cur, true);
        y += 24;
        const std::string st = midiStatus ? midiStatus() : std::string();
        label(body, x, y, "Plays the chop window's regions and pads from a MIDI keyboard. " + st + ".", 8, faint, false, false, fw);
        y += 12 + 16;
    }

    section("Tool paths");
    for (const std::string& l : wrap("Leave a field empty to auto-resolve. Set a path to override. The resolved path in use is shown under each field.", fw, 9)) {
        label(body, x, y, l, 9, faint);
        y += 13;
    }
    y += 6;
    for (const ToolRow& t : kTools) {
        label(body, x, y, t.label, 10, primary, true);
        label(body, x + measure(t.label, 10, true) + 8, y + 1, t.blurb, 8, faint, false, true);
        y += 16;
        const bool set = !trimmed(wdn::settings::text(t.key, "")).empty();
        fieldRow(t.key, std::string("browse:") + t.key, "folder-open", set);
        std::string src, path, shown;
        bool good = true;
        if (std::string(t.name) == "lathe") { good = latheOk_; shown = (set ? std::string("override  ") : std::string()) + latheReadout_; }
        else {
            path = toolPath(t.name, &src);
            if (set && src != "override") { good = false; shown = "override not found, using " + (path.empty() ? std::string("nothing") : src + "  " + path); }
            else if (path.empty()) { good = false; shown = "missing: downloaded on the first extract"; }
            else shown = src + "  " + path;
        }
        label(body, x, y, good ? "\xE2\x97\x8F" : "\xE2\x97\x8B", 8, good ? ok : warn);
        label(body, x + 12, y, shown, 8, good ? muted : warn, false, false, fw - 12);
        y += 22;
    }

    y += 4;
    section("Downloads");
    for (const FolderRow& r : kFolders) {
        label(body, x, y, r.label, 10, primary, true);
        y += 16;
        const bool set = !trimmed(wdn::settings::text(r.key, "")).empty();
        fieldRow(r.key, std::string("folder:") + r.key, "folder-open", set);
        const std::string def = std::string(r.key) == "downloadDir"
            ? "Default: " + wdn::ext::downloadsFolder() + ". Save To in the window picks the folder for that window; this one is where it starts."
            : "Default: Documents / Vacant Systems / Latch Clips";
        for (const std::string& l : wrap(def, fw, 8)) { label(body, x, y, l, 8, faint); y += 12; }
        y += 10;
    }
    g.content = y + g.scroll - view.y;
    g.scroll = std::clamp(g.scroll, 0, std::max(0, g.content - view.h));
}

int SettingsWindow::wantedHeight() {
    changed();
    const auto it = regions_.find("body");
    const int content = it == regions_.end() ? 0 : it->second.content;
    return std::clamp((int)kTitle + content, (int)kHeight, (int)kMaxHeight);
}

void SettingsWindow::act(const std::string& id, const vpf::gui::MouseEvent&) {
    if (id == "close") { if (onClose) onClose(); return; }
    if (id == "select:skin") {
        if (!selectOpts_.count(id)) return;
        openSelectList(id, selectOpts_[id], skinName, [this](const std::string& v) { if (v != skinName && onSkin) onSkin(v); });
        return;
    }
    if (id == "select:midi") {
        if (!selectOpts_.count(id)) return;
        openSelectList(id, selectOpts_[id], wdn::settings::text(ChopMidi::kKey, ""), [this](const std::string& v) {
            if (v.empty()) wdn::settings::erase(ChopMidi::kKey); else wdn::settings::set(ChopMidi::kKey, v);
            if (onMidiChanged) onMidiChanged();
            changed();
        });
        return;
    }
    auto setField = [this](const std::string& key, const std::string& v) {
        if (fields_.count(key)) fields_[key]->setValue(v);
        save(key, v);
    };
    if (id.rfind("clear:", 0) == 0) { setField(id.substr(6), ""); return; }
    if (id.rfind("browse:", 0) == 0) {
        const std::string key = id.substr(7);
        const std::string cur = trimmed(wdn::settings::text(key, ""));
        std::string dir = cur.empty() ? std::string() : std::filesystem::u8path(cur).parent_path().u8string(), out;
#if defined(_WIN32)
        const std::string ext = ".exe";
#else
        const std::string ext;
#endif
        if (editor() && editor()->fileDialog(false, dir, ext, "", out) && !out.empty()) setField(key, out);
        return;
    }
    if (id.rfind("folder:", 0) == 0) {
        const std::string key = id.substr(7);
        std::string cur = trimmed(wdn::settings::text(key, "")), out;
        if (cur.empty() && key == "downloadDir") cur = wdn::ext::downloadsFolder();
        if (editor() && editor()->folderDialog(cur, out) && !out.empty()) setField(key, out);
    }
}

}  // namespace latch
