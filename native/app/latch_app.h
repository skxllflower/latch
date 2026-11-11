// The standalone Latch: WAVdesk's native Latch window (latch_window.h, shared, unchanged) as the whole of an app's
// window instead of a popup over WAVdesk's main one. What it adds is what the Tauri ExtractApp's own frame had:
//   the title strip as the window's frame (dragged to move it), Minimize beside the X, Settings (settings_window.h), the look chooser (the skins:
//   1-Bit (skin id "dev"), VX, Focused, Zen Dark) and About (about_window.h); the window's own refresh (latch update) stays
//   the window's toasts (onToast: in WAVdesk they go to its status line), a short line over the status bar
//   take: a launch's URLs and files (the command line, a second launch's handoff) queued as if typed into the prompt
//   Audition (onAudition): the player (player.h) and its strip over the status bar: stop, the file, a seek track, the time
//   the cards' thumbnails (thumbs.h) and, under the playing row, its waveform: a click there seeks (wireHooks)
//   Escape: nothing (in WAVdesk it closes the tool window; here it would quit the app)
#pragma once
#include "latch_window.h"
#include "audio_out.h"
#include "player.h"
#include "thumbs.h"
#include <memory>
#include <functional>
#include <string>

namespace latch {

class LatchApp : public wdn::LatchWindow {
public:
    // (WAVdesk's Latch window's size, LatchWindow::kWidth / kHeight, and the minimum: the owner, 2026-11-03, over
    // tauri.conf's 700 x 440)
    static constexpr int kWidth = 600, kHeight = 340;
    LatchApp();
    std::function<void()> onAbout, onSettings;
    std::function<void(const std::string& skin)> onSkin;
    std::function<void()> onTick;   // (every tick: the chop's MIDI input, main.cpp)   // (a look picked: the app applies it and keeps it)
    std::string skinName = "dev";

    void toast(const std::string& message);
    void take(const std::vector<std::string>& args);
    void audition(const std::string& path);   // (the same file again, or "": stop)
    void stopAudition() { if (player_) player_->stop(); refresh(); }
    void setAudio(AudioOut* out) { player_.reset(); out_ = out; if (out) player_ = std::make_unique<Player>(*out); }   // (null: gone)
    void wireHooks(std::shared_ptr<vpf::gui::UiQueue> ui);   // (thumbnails, the fold-out: once the editor is up)
    std::function<void()> onTeardown;   // (the destructor: the chop engine and the output let go, once)
    ~LatchApp() override;
    // (1-Bit: the app's own mark in the strip's ink, app_icon.cpp; the other looks keep the window's download glyph)
    bool drawTitleIcon(const vpf::gui::Paint& p, int cx, int cy, int px) const override;
    bool onMouseDown(const vpf::gui::MouseEvent& e) override;
    void onMouseDrag(const vpf::gui::MouseEvent& e) override;
    void onMouseUp(const vpf::gui::MouseEvent& e) override;
    bool onKey(const vpf::gui::KeyEvent& e) override;
    void tick() override;
    void draw(const vpf::gui::Paint& p) override;

protected:
    void titleExtras(std::vector<El>& out, int& right) override;
    void act(const std::string& id, const vpf::gui::MouseEvent& e) override;

private:
    std::string toast_;
    double toastUntil_ = 0;
    AudioOut* out_ = nullptr;
    std::unique_ptr<Player> player_;
    bool playing() const { return player_ && player_->playing(); }
    bool seeking_ = false;
    std::unique_ptr<Thumbs> thumbs_;
    struct Peaks;
    std::shared_ptr<Peaks> peaks_;
    std::shared_ptr<vpf::gui::UiQueue> ui_;
    std::string folded_;   // (the output the fold-out was laid out for: a change relays out)
    void readPeaks(const std::string& path);
    vpf::gui::Rect stripRect() const;
    vpf::gui::Rect stopRect() const;
    vpf::gui::Rect trackRect() const;
    void seekTo(int x);
};

}  // namespace latch
