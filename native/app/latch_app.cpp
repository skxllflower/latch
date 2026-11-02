#include "latch_app.h"
#include "data_root.h"
#include "pipe_run.h"
#include "chop_engine.h"
#include "look.h"
#include "skin.h"
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <thread>
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

struct LatchApp::Peaks {
    std::string path;
    std::vector<float> lo, hi;   // (kBins columns, -1..1)
    bool ready = false;
    std::atomic<bool> stop{false};
    static constexpr int kBins = 600;
};

// one ffmpeg pass at 8 kHz mono, min / max per column
void LatchApp::readPeaks(const std::string& path) {
    if (peaks_ && peaks_->path == path) return;
    if (peaks_) peaks_->stop = true;
    peaks_ = std::make_shared<Peaks>();
    peaks_->path = path;
    const std::string ffmpeg = toolPath("ffmpeg");
    if (ffmpeg.empty() || !ui_) return;
    std::thread([pk = peaks_, ffmpeg, ui = ui_, this] {
        std::string raw;
        runPiped(ffmpeg, {"-nostdin", "-v", "error", "-i", pk->path, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"},
                 [&raw](const char* d, size_t n) { raw.append(d, n); }, pk->stop);
        if (pk->stop) return;
        const size_t n = raw.size() / sizeof(float);
        const float* f = reinterpret_cast<const float*>(raw.data());
        std::vector<float> lo(Peaks::kBins, 0.f), hi(Peaks::kBins, 0.f);
        for (size_t i = 0; i < n; ++i) {
            const size_t b = std::min<size_t>(Peaks::kBins - 1, i * Peaks::kBins / std::max<size_t>(1, n));
            lo[b] = std::min(lo[b], f[i]);
            hi[b] = std::max(hi[b], f[i]);
        }
        ui->post([pk, lo = std::move(lo), hi = std::move(hi), this]() mutable {
            if (pk->stop) return;
            pk->lo = std::move(lo);
            pk->hi = std::move(hi);
            pk->ready = true;
            repaint();
        });
    }).detach();
}

void LatchApp::wireHooks(std::shared_ptr<vpf::gui::UiQueue> ui) {
    ui_ = ui;
    thumbs_ = std::make_unique<Thumbs>(ui, [this] { refresh(); });
    drawThumbnail = [this](const Paint& p, const Rect& slot, const std::string&, const std::string& thumb) {
        const vpf::gui::Bitmap* bm = thumbs_ ? thumbs_->get(thumb) : nullptr;
        if (!bm) return false;
        p.canvas.drawBitmapScaled(*bm, {0, 0, bm->w, bm->h}, p.dev(slot));
        return true;
    };
    auditionFoldHeight = [this](const std::string& output) { return playing() && player_->path() == output ? 30 : 0; };
    drawAuditionFold = [this](const Paint& p, const Rect& r, const std::string& output) {
        struct { vpf::gui::Color ink, soft; } t{skin().style("tool.grid").ink, skin().style("tool.label").ink};   // (the list's own text tones)
        const vpf::gui::Color line = skin().style("tool.footer").line;
        const Rect box{r.x + 6, r.y + 2, r.w - 12, r.h - 6};
        p.canvas.fillRect(p.dev(box), line);
        p.canvas.fillRect(p.dev({box.x + 1, box.y + 1, box.w - 2, box.h - 2}), skin().style("tool.head").fill);
        const bool mine = playing() && player_->path() == output;
        const double d = mine ? player_->duration() : 0, frac = d > 0 ? std::clamp(player_->position() / d, 0.0, 1.0) : 0.0;
        const int inner = box.w - 4, mid = box.y + box.h / 2, half = box.h / 2 - 3;
        const int playX = box.x + 2 + (int)(inner * frac);
        if (peaks_ && peaks_->ready && peaks_->path == output) {
            for (int x = 0; x < inner; ++x) {
                const size_t b = std::min<size_t>(Peaks::kBins - 1, (size_t)x * Peaks::kBins / std::max(1, inner));
                const int y0 = mid - (int)std::lround(peaks_->hi[b] * half), y1 = mid - (int)std::lround(peaks_->lo[b] * half);
                p.canvas.fillRect(p.dev({box.x + 2 + x, y0, 1, std::max(1, y1 - y0)}), box.x + 2 + x < playX ? t.ink : t.soft);
            }
        } else {
            const wdn::look::TextScope ts(8);
            wdn::look::text(p, box.x + 8, wdn::look::baselineIn(p, box.y, box.h, false), "Reading the waveform...", t.soft);
        }
        if (d > 0) p.canvas.fillRect(p.dev({playX, box.y + 1, 1, box.h - 2}), t.ink);
    };
    onAuditionSeek = [this](const std::string& output, double fraction) {
        if (playing() && player_->path() == output && player_->duration() > 0) { player_->seek(fraction * player_->duration()); repaint(); }
    };
}

LatchApp::~LatchApp() {
    if (peaks_) peaks_->stop = true;
    thumbs_.reset();
    if (auto f = std::move(onTeardown)) f();
    player_.reset();
}

void LatchApp::audition(const std::string& path) {
    if (!player_) return;
    if (path.empty() || path == player_->path()) { stopAudition(); return; }
    std::string err;
    if (!player_->play(path, &err)) toast(err);
    else readPeaks(path);
    refresh();
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
    if (player_->duration() <= 0 || t.w <= 0) return;
    player_->seek(std::clamp((x - t.x) / (double)t.w, 0.0, 1.0) * player_->duration());
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
    if (playing() && inside(stripRect(), e.x, e.y)) {
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

// each one as the prompt's Enter takes it (a URL, a path, else a search); the prompts untouched
void LatchApp::take(const std::vector<std::string>& args) {
    enqueue(args);
    repaint();
}

void LatchApp::tick() {
    LatchWindow::tick();
    if (out_) out_->poll();
    wdn::ChopEngine::housekeeping();   // (a chop session left unshown 30 s closes; the caches trimmed)
    if (playing()) {
        if (player_->poll() && player_->endedEmpty()) toast("This file did not play");
        repaint();
    }
    if (const std::string now = playing() ? player_->path() : std::string(); now != folded_) {   // (stopped, or another file)
        folded_ = now;
        refresh();
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
    if (playing()) {
        const Rect s = stripRect(), st = stopRect(), tr = trackRect();
        box(s);
        p.canvas.fillRect(p.dev({st.x + 6, st.y + 6, 8, 8}), t.ink);
        const wdn::look::TextScope ts(9);
        std::string name = std::filesystem::u8path(player_->path()).filename().u8string();
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
        const double d = player_->duration(), at = std::min(player_->position(), d > 0 ? d : 1e9);
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
    const Rect r{(bounds.w - w) / 2, (playing() ? stripRect().y : bounds.h - kStatus) - h - 8, w, h};
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
