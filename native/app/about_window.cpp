#include "about_window.h"
#include "data_root.h"
#include "look.h"
#include "skin.h"
#include <algorithm>
#include <cstdlib>
#include <vpf/gui/editor.h>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#include <filesystem>
#else
#include <spawn.h>
#include <sys/wait.h>
extern char** environ;
#endif

namespace latch {

using vpf::gui::Rect;
using wdn::Style;
using wdn::skin;

namespace {

struct Notice { const char* title; const char* body; const char* url; };
// (AboutApp.tsx's notices, word for word; "Other components" names this GUI's own parts)
const Notice kNotices[] = {
    {"yt-dlp",
     "Downloading is performed by yt-dlp, which Latch fetches on first run and invokes as a separate program. yt-dlp is "
     "released into the public domain under The Unlicense. Source:",
     "https://github.com/yt-dlp/yt-dlp"},
    {"FFmpeg",
     "Latch uses FFmpeg, which it downloads from the project's official builds on first run and invokes as a separate "
     "program. FFmpeg is free software licensed under the GNU General Public License (GPL) v3 and the GNU Lesser General "
     "Public License (LGPL); the bundled build is the GPL build. FFmpeg is a trademark of Fabrice Bellard. Source and "
     "full license text:",
     "https://ffmpeg.org"},
    {"Other components",
     "Latch also includes software distributed under permissive licenses (MIT, BSD, Boost), including the vpf framework, "
     "nlohmann/json, stb and the Lucide icons. Full license texts are available on request.",
     nullptr},
};

}  // namespace

bool AboutWindow::openUrl(const std::string& url) {
#if defined(_WIN32)
    const std::wstring w = std::filesystem::u8path(url).wstring();
    return (INT_PTR)ShellExecuteW(nullptr, L"open", w.c_str(), nullptr, nullptr, SW_SHOWNORMAL) > 32;
#else
    pid_t pid = 0;
    const char* argv[] = {"/usr/bin/open", url.c_str(), nullptr};
    if (posix_spawn(&pid, argv[0], nullptr, nullptr, const_cast<char* const*>(argv), environ) != 0) return false;
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) && WEXITSTATUS(st) == 0;
#endif
}

bool AboutWindow::onKey(const vpf::gui::KeyEvent& e) {
    if (e.key == vpf::gui::Key::Escape) { if (onClose) onClose(); return true; }
    return false;
}

void AboutWindow::layout() {
    const int W = bounds.w > 0 ? bounds.w : kWidth, H = bounds.h > 0 ? bounds.h : kHeight;
    const Rect all{0, 0, W, H};
    const Style& lab = skin().style("tool.label"), &grid = skin().style("tool.grid"), &title = skin().style("tool.title");
    const Style& tones = skin().style("ext.tones");
    const vpf::gui::Color line = skin().style("tool.footer").line, muted = lab.ink, primary = grid.ink, secondary = title.soft;
    auto fill = [&](Rect r, vpf::gui::Color c) { add(r, all, "", true, [c](const vpf::gui::Paint& p, const Rect& rr, bool) { p.canvas.fillRect(p.dev(rr), c); }); };

    // identity
    int y = kTitle + 22;
    auto centred = [&](const std::string& s, float px, vpf::gui::Color c, bool bold) {
        label(all, (W - measure(s, px, bold)) / 2, y, s, px, c, bold);
        y += (int)px + 6;
    };
    centred("LATCH", 18, primary, true);
    centred("BY VACANT SYSTEMS", 8, muted, false);
    centred("Version " LATCH_VERSION, 8, secondary, false);
    {
        const std::string s = "OPEN LOG FILE";
        const int w = measure(s, 8, false, 0.6f) + 12;
        add({(W - w) / 2, y - 2, w, 14}, all, "log", true, [s, muted, primary](const vpf::gui::Paint& p, const Rect& r, bool hot) {
            const wdn::look::TextScope ts(8, false, false, 0.6f);
            wdn::look::text(p, r.x + 6, r.y + 10, s, hot ? primary : muted);
            if (hot) p.canvas.fillRect(p.dev({r.x + 6, r.y + 12, r.w - 12, 1}), primary);
        });
        y += 16;
    }
    y += 8;
    fill({0, y, W, 1}, line);

    // the notices, scrolling
    const Rect view{0, y + 1, W, H - y - 1};
    Region& g = region("notices", view);
    int cy = view.y + 10 - g.scroll;
    const int textW = W - 32;
    auto para = [&](const std::string& text, vpf::gui::Color c) {
        for (const std::string& l : wrap(text, textW, 9)) { label(view, 16, cy, l, 9, c); cy += 13; }
    };
    para("Latch is a standalone media downloader and clipper. It builds on open-source software, used and distributed under the terms below.", muted);
    cy += 8;
    int i = 0;
    for (const Notice& n : kNotices) {
        label(view, 16, cy, n.title, 9, primary, true, true);
        cy += 15;
        para(n.body, muted);
        if (n.url) {
            const std::string u = n.url;
            add({16, cy, std::min(textW, measure(u, 9) + 2), 13}, view, "url:" + std::to_string(i), true, [u, tones](const vpf::gui::Paint& p, const Rect& r, bool hot) {
                const wdn::look::TextScope ts(9);
                vpf::gui::Color c = tones.ink;
                if (!hot) c.a = (uint8_t)(c.a * 0.8);
                wdn::look::text(p, r.x, r.y + 9, u, c);
                if (hot) p.canvas.fillRect(p.dev({r.x, r.y + 11, r.w - 2, 1}), tones.ink);
            });
            cy += 13;
        }
        cy += 10;
        ++i;
    }
    fill({16, cy, textW, 1}, line);
    cy += 10;
    para("\xC2\xA9 2026 Vacant Systems. All rights reserved. Latch is proprietary software. Latch is a download tool; users are responsible for complying with the terms of service of any site they access and with applicable copyright law.", secondary);
    g.content = cy + g.scroll - view.y + 10;
    g.scroll = std::clamp(g.scroll, 0, std::max(0, g.content - view.h));
}

void AboutWindow::act(const std::string& id, const vpf::gui::MouseEvent&) {
    if (id == "close") { if (onClose) onClose(); return; }
    if (id == "log") { openUrl(std::filesystem::u8path(logPath()).make_preferred().u8string()); return; }   // (lib.rs open_log_file: the system's viewer)
    if (id.rfind("url:", 0) == 0) {
        const int i = std::atoi(id.c_str() + 4);
        if (i >= 0 && i < (int)(sizeof kNotices / sizeof kNotices[0]) && kNotices[i].url) openUrl(kNotices[i].url);
    }
}

}  // namespace latch
