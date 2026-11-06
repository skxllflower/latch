// Settings (SettingsApp.tsx + settings.rs): the tool-path overrides (yt-dlp, ffmpeg, lathe; empty = auto, the path in
// use shown under each) and the folders (downloads, chop clips), each saved as it is edited into settings.json under
// the Tauri app's own keys (ytdlpPath, ffmpegPath, lathePath, downloadDir, clipsDir), so either app reads the other's.
#pragma once
#include "ext_window.h"
#include <memory>

namespace latch {

class SettingsWindow : public wdn::ExtWindow {
public:
    static constexpr int kWidth = 460, kHeight = 440, kMaxHeight = 720;
    SettingsWindow();
    // the height that shows the whole body (laid out at its width), within kHeight..kMaxHeight; a taller one scrolls
    int wantedHeight();
    bool onKey(const vpf::gui::KeyEvent& e) override;
    bool wantsShortcuts() const override { return true; }
    std::function<void()> onToolsChanged;   // (an override edited: the app hands it to the children it starts)
    // the look (the skins: wdn::skinChoices), here rather than on the title strip (the owner, 2026-11-03): the one in use,
    // and a pick handed to the app, which applies it and keeps it
    std::string skinName = "dev";
    std::function<void(const std::string& skin)> onSkin;

protected:
    std::string titleText() const override { return "Settings"; }
    std::string titleIcon() const override { return "settings"; }
    void layout() override;
    void act(const std::string& id, const vpf::gui::MouseEvent& e) override;

private:
    std::string latheReadout_ = "Resolving...";
    bool latheOk_ = false, probed_ = false;
    void save(const std::string& key, const std::string& value);
    void probeLathe();
};

}  // namespace latch
