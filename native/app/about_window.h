// About Latch (AboutApp.tsx, 420 x 500): the app's name, maker and version, Open Log File, then the third-party notices
// (yt-dlp and FFmpeg, both fetched as separate programs), their links opened in the browser.
#pragma once
#include "ext_window.h"

namespace latch {

class AboutWindow : public wdn::ExtWindow {
public:
    static constexpr int kWidth = 420, kHeight = 500;
    AboutWindow() { name = "latch-about"; }
    bool onKey(const vpf::gui::KeyEvent& e) override;
    bool wantsShortcuts() const override { return true; }
    static bool openUrl(const std::string& url);   // (the system's browser)

protected:
    std::string titleText() const override { return "About"; }
    std::string titleIcon() const override { return "info"; }
    void layout() override;
    void act(const std::string& id, const vpf::gui::MouseEvent& e) override;
};

}  // namespace latch
