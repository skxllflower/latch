#include "latch_app.h"
#include "look.h"
#include "skin.h"
#include <algorithm>
#include <vpf/app/text_field.h>
#include <vpf/gui/editor.h>

namespace latch {

using vpf::gui::Paint;
using vpf::gui::Rect;
using wdn::Style;
using wdn::skin;

LatchApp::LatchApp() { name = "latch-app"; }

// the title strip is the window's frame: a press on it (not on a button) moves the window, as the Tauri drag region did
bool LatchApp::onMouseDown(const vpf::gui::MouseEvent& e) {
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
    if (!toast_.empty() && vpf::gui::Editor::now() > toastUntil_) { toast_.clear(); repaint(); }
}

void LatchApp::draw(const Paint& p) {
    LatchWindow::draw(p);
    if (toast_.empty()) return;
    const Style& t = skin().style("tool.titlebar");
    const wdn::look::TextScope ts(9);
    const int w = std::min(bounds.w - 24, measure(toast_, 9) + 20), h = 20;
    const Rect r{(bounds.w - w) / 2, bounds.h - kStatus - h - 8, w, h};
    p.canvas.fillRect(p.dev(r), skin().style("tool.footer").line);
    p.canvas.fillRect(p.dev({r.x + 1, r.y + 1, r.w - 2, r.h - 2}), t.fill);
    wdn::look::text(p, r.x + 10, wdn::look::baselineIn(p, r.y, r.h, false), toast_, t.ink);
}

// right to left, left of the X: Minimize, the window's own refresh (latch update), the look, About
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
    textButton("app:about", "ABOUT");
}

void LatchApp::act(const std::string& id, const vpf::gui::MouseEvent& e) {
    if (id == "app:minimize") { if (editor()) editor()->minimizeWindow(); return; }
    if (id == "app:about") { if (onAbout) onAbout(); return; }
    if (id == "app:skin") {
        std::vector<Opt> opts;
        for (const auto& c : wdn::skinChoices()) opts.push_back({c.first, c.second});
        openSelectList(id, opts, skinName, [this](const std::string& v) { if (v != skinName && onSkin) onSkin(v); });
        return;
    }
    LatchWindow::act(id, e);
}

}  // namespace latch
