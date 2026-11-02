// The cards' thumbnails (LatchWindow::drawThumbnail): a link's image (latch expand's `thumbnail` URL) downloaded once,
// cropped square by the suite's ffmpeg (YouTube serves WebP; ffmpeg reads it, JPEG and PNG alike) to 80 x 80 BGRA, kept
// under <data root>/cache/thumbs, drawn from memory. One worker, a URL at a time; a failed one is not tried again this
// run. The worker owns only shared state, so quitting never waits on a download.
#pragma once
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vpf/gui/canvas.h>

namespace vpf::gui { class UiQueue; }

namespace latch {

class Thumbs {
public:
    static constexpr int kSize = 80;
    // onLanded: on the UI thread, an image arrived (the window relays out)
    Thumbs(std::shared_ptr<vpf::gui::UiQueue> ui, std::function<void()> onLanded);
    ~Thumbs();
    // UI thread: the image, or null (not yet: fetched in the background; or none)
    const vpf::gui::Bitmap* get(const std::string& url);

private:
    struct Shared;
    std::shared_ptr<Shared> s_;
    std::map<std::string, vpf::gui::Bitmap> ready_;
};

}  // namespace latch
