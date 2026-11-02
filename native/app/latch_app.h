// The standalone Latch: WAVdesk's native Latch window (latch_window.h, shared, unchanged) as the whole of an app's
// window instead of a popup over WAVdesk's main one. What it adds is what the Tauri ExtractApp's own frame had:
//   the title strip as the window's frame (dragged to move it), Minimize beside the X, the look chooser (the skins:
//   Dev look, VX, Focused, Zen Dark) and About (about_window.h); the window's own refresh (latch update) stays
//   the window's toasts (onToast: in WAVdesk they go to its status line), a short line over the status bar
//   take: a launch's URLs and files (the command line, a second launch's handoff) queued as if typed into the prompt
//   Audition (onAudition): the player (player.h) and its strip over the status bar: stop, the file, a seek track, the time
//   Escape: nothing (in WAVdesk it closes the tool window; here it would quit the app)
#pragma once
#include "latch_window.h"
#include "player.h"
#include <functional>
#include <string>

namespace latch {

class LatchApp : public wdn::LatchWindow {
public:
    static constexpr int kWidth = 700, kHeight = 440;   // (tauri.conf's main window: its size and its minimum)
    LatchApp();
    std::function<void()> onAbout;
    std::function<void(const std::string& skin)> onSkin;   // (a look picked: the app applies it and keeps it)
    std::string skinName = "dev";

    void toast(const std::string& message);
    void take(const std::vector<std::string>& args);
    void audition(const std::string& path);   // (the same file again, or "": stop)
    void stopAudition() { player_.stop(); repaint(); }
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
    Player player_;
    bool seeking_ = false;
    vpf::gui::Rect stripRect() const;
    vpf::gui::Rect stopRect() const;
    vpf::gui::Rect trackRect() const;
    void seekTo(int x);
};

}  // namespace latch
