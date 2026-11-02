#include "latch_app.h"
#include "data_root.h"
#include "look.h"
#include "skin.h"
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <vpf/app/text_field.h>
#include <vpf/gui/editor.h>

namespace latch {

using vpf::gui::Paint;
using vpf::gui::Rect;
using wdn::Style;
using wdn::skin;

LatchApp::LatchApp() { name = "latch-app"; }

// the title strip is the window's frame: a press on it (not on a button) moves the window, as the Tauri drag region did
namespace {
std::string clock(double s) {
    const int t = (int)std::max(0.0, s);
    char b[24];
    if (t >= 3600) std::snprintf(b, sizeof b, "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60);
    else std::snprintf(b, sizeof b, "%d:%02d", t / 60, t % 60);
    return b;
}
bool inside(const Rect& r, int x, int y) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
}  // namespace

void LatchApp::audition(const std::string& path) {
    if (path.empty() || path == player_.path()) { stopAudition(); return; }
    std::string err;
    if (!player_.play(path, &err)) toast(err);
    repaint();
}

// the strip: 12 px in from the sides, over the status bar
Rect LatchApp::stripRect() const { return {12, bounds.h - kStatus - 34, bounds.w - 24, 26}; }
Rect LatchApp::stopRect() const { const Rect s = stripRect(); return {s.x + 3, s.y + 3, 20, 20}; }
Rect LatchApp::trackRect() const {
    const Rect s = stripRect();
    const int timeW = measure("00:00 / 00:00", 9) + 16, nameW = std::min(220, s.w / 3);
    const int x = s.x + 28 + nameW + 8;
    return {x, s.y + 8, std::max(20, s.x + s.w - timeW - x), 10};
}

void LatchApp::seekTo(int x) {
    const Rect t = trackRect();
    if (player_.duration() <= 0 || t.w <= 0) return;
    player_.seek(std::clamp((x - t.x) / (double)t.w, 0.0, 1.0) * player_.duration());
    repaint();
}

void LatchApp::onMouseDrag(const vpf::gui::MouseEvent& e) {
    if (seeking_) { seekTo(e.x); return; }
    LatchWindow::onMouseDrag(e);
}

void LatchApp::onMouseUp(const vpf::gui::MouseEvent& e) {
    if (seeking_) { seeking_ = false; return; }
    LatchWindow::onMouseUp(e);
}

bool LatchApp::onMouseDown(const vpf::gui::MouseEvent& e) {
    if (player_.playing() && inside(stripRect(), e.x, e.y)) {
        if (inside(stopRect(), e.x, e.y)) { stopAudition(); return true; }
        const Rect t = trackRect();
        if (e.x >= t.x - 4 && e.x < t.x + t.w + 4) { seeking_ = true; seekTo(e.x); }
        return true;
    }
    if (e.y < kTitle && hit(e.x, e.y).empty() && editor()) { editor()->beginWindowDrag(); return true; }
    return LatchWindow::onMouseDown(e);
}

bool LatchApp::onKey(const vpf::gui::KeyEvent& e) {
    if (e.key == vpf::gui::Key::Escape && !e.ctrl && !e.alt && !e.shift) return true;
    return LatchWindow::onKey(e);
}

void LatchApp::toast(const std::string& message) {
    toast_ = message;
    toastUntil_ = vpf::gui::Editor::now() + 4.0;
    repaint();
}

// each one through the prompt's own Enter (a URL, a path, else a search), whichever of the two prompts the view shows;
// what the user had typed in either is put back
void LatchApp::take(const std::vector<std::string>& args) {
    vpf::app::TextField* line = fields_.count("prompt") ? fields_["prompt"] : nullptr;
    vpf::app::TextField* card = fields_.count("cardprompt") ? fields_["cardprompt"] : nullptr;
    if (!line || !card || !line->onEnter) return;
    for (const std::string& a : args) {
        if (a.empty()) continue;
        const std::string oldLine = line->value(), oldCard = card->value();
        line->setValue(a);
        card->setValue(a);
        line->onEnter();
        for (auto [f, old] : {std::pair{line, oldLine}, std::pair{card, oldCard}})
            if (f->value() == a || f->value().empty()) f->setValue(old);
    }
    repaint();
}

void LatchApp::tick() {
    LatchWindow::tick();
    if (player_.playing()) {
        if (player_.poll() && player_.endedEmpty()) toast("This file did not play");
        repaint();
    }
    if (!toast_.empty() && vpf::gui::Editor::now() > toastUntil_) { toast_.clear(); repaint(); }
}

void LatchApp::draw(const Paint& p) {
    LatchWindow::draw(p);
    const Style& t = skin().style("tool.titlebar");
    const vpf::gui::Color line = skin().style("tool.footer").line;
    auto box = [&](const Rect& r) {
        p.canvas.fillRect(p.dev(r), line);
        p.canvas.fillRect(p.dev({r.x + 1, r.y + 1, r.w - 2, r.h - 2}), t.fill);
    };
    if (player_.playing()) {
        const Rect s = stripRect(), st = stopRect(), tr = trackRect();
        box(s);
        p.canvas.fillRect(p.dev({st.x + 6, st.y + 6, 8, 8}), t.ink);
        const wdn::look::TextScope ts(9);
        std::string name = std::filesystem::u8path(player_.path()).filename().u8string();
        const int nameW = tr.x - 8 - (s.x + 28);
        if (measure(name, 9) > nameW) {
            while (!name.empty() && measure(name + "...", 9) > nameW) {
                name.pop_back();
                while (!name.empty() && ((unsigned char)name.back() & 0xC0) == 0x80) name.pop_back();
            }
            name += "...";
        }
        const int base = wdn::look::baselineIn(p, s.y, s.h, false);
        wdn::look::text(p, s.x + 28, base, name, t.ink);
        p.canvas.fillRect(p.dev({tr.x, tr.y + 4, tr.w, 2}), line);
        const double d = player_.duration(), at = std::min(player_.position(), d > 0 ? d : 1e9);
        if (d > 0) {
            const int fx = tr.x + (int)(tr.w * std::clamp(at / d, 0.0, 1.0));
            p.canvas.fillRect(p.dev({tr.x, tr.y + 4, fx - tr.x, 2}), t.ink);
            p.canvas.fillRect(p.dev({fx - 1, tr.y, 3, tr.h}), t.ink);
        }
        const std::string time = clock(at) + (d > 0 ? " / " + clock(d) : "");
        wdn::look::text(p, s.x + s.w - 8 - measure(time, 9), base, time, t.soft);
    }
    if (toast_.empty()) return;
    const wdn::look::TextScope ts(9);
    const int w = std::min(bounds.w - 24, measure(toast_, 9) + 20), h = 20;
    const Rect r{(bounds.w - w) / 2, (player_.playing() ? stripRect().y : bounds.h - kStatus) - h - 8, w, h};
    box(r);
    wdn::look::text(p, r.x + 10, wdn::look::baselineIn(p, r.y, r.h, false), toast_, t.ink);
}

// right to left, left of the X: Minimize, the window's own refresh (latch update), the look, Settings, About
void LatchApp::titleExtras(std::vector<El>& out, int& right) {
    const Rect all{0, 0, bounds.w, bounds.h};
    const Style& t = skin().style("tool.titlebar");
    const int h = kTitle;
    {
        const Rect r = wdn::look::stripButton({right - 28, 0, 28, h}, bounds.w, 1, h);
        right = r.x;
        add(r, all, "app:minimize", true, [t](const Paint& p, const Rect& rr, bool hot) {
            if (wdn::look::spriteSquare(p, rr, "win:minimize", hot, false, t.mark)
                || wdn::look::squareButton(p, rr.x + rr.w / 2.0, rr.y + rr.h / 2.0, wdn::look::Square::Minimize, hot, t.ink, t.fill)) return;
            if (hot) p.canvas.fillRect(p.dev({rr.x + 7, rr.y + 7, 14, 14}), skin().style("tool.button", wdn::SkinState::Hover).fill);
            p.canvas.fillRect(p.dev({rr.x + rr.w / 2 - 4, rr.y + rr.h / 2, 9, 1}), hot ? t.ink : t.soft);
        });
    }
    LatchWindow::titleExtras(out, right);
    auto textButton = [&](const std::string& id, const std::string& text) {
        const int w = measure(text, 8, false, 0.6f) + 14;
        right -= w + 2;
        const int bh = std::min<int>(18, h);
        add({right, (h - bh) / 2, w, bh}, all, id, true, [t, text](const Paint& p, const Rect& rr, bool hot) {
            if (hot) p.canvas.fillRect(p.dev(rr), skin().style("tool.button", wdn::SkinState::Hover).fill);
            const wdn::look::TextScope ts(8, false, false, 0.6f);
            wdn::look::text(p, rr.x + 7, wdn::look::baselineIn(p, rr.y, rr.h, true), text, hot ? t.ink : t.soft);
        });
    };
    std::string lookLabel = skinName;
    for (const auto& c : wdn::skinChoices()) if (c.first == skinName) lookLabel = c.second;
    textButton("app:skin", upper(lookLabel));
    textButton("app:settings", "SETTINGS");
    textButton("app:about", "ABOUT");
}

void LatchApp::act(const std::string& id, const vpf::gui::MouseEvent& e) {
    if (id == "app:minimize") { if (editor()) editor()->minimizeWindow(); return; }
    if (id == "app:about") { if (onAbout) onAbout(); return; }
    if (id == "app:settings") { if (onSettings) onSettings(); return; }
    if (id == "app:skin") {
        std::vector<Opt> opts;
        for (const auto& c : wdn::skinChoices()) opts.push_back({c.first, c.second});
        openSelectList(id, opts, skinName, [this](const std::string& v) { if (v != skinName && onSkin) onSkin(v); });
        return;
    }
    LatchWindow::act(id, e);
}

}  // namespace latch
