// The app's own icon (gui/src/assets/app-icon.png, 128 x 128; the copy of Lathe's app_icon.cpp), embedded and
// drawn at the device size asked for: an area-averaged downscale of the source, made once per size (the canvas's own
// stretch is nearest-neighbour, which shreds a 128 px picture shown at 14).
#include "app_icon.h"
#include <vpf/gui/assets.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <utility>

extern const vpf::EmbeddedFile kLatchIcon[];
extern const size_t kLatchIcon_count;

namespace latch {

namespace {

const vpf::gui::Bitmap& source() {
    static const vpf::gui::Bitmap bm = kLatchIcon_count > 0 ? vpf::gui::Bitmap::loadMemory(kLatchIcon[0].data, kLatchIcon[0].size) : vpf::gui::Bitmap{};
    return bm;
}

// each destination pixel the alpha-weighted mean of the source pixels it covers (straight alpha in, straight out)
vpf::gui::Bitmap scaled(int n) {
    const vpf::gui::Bitmap& s = source();
    vpf::gui::Bitmap out;
    if (!s.valid() || n <= 0) return out;
    out.w = out.h = n;
    out.px.assign((size_t)n * n, 0);
    for (int y = 0; y < n; ++y)
        for (int x = 0; x < n; ++x) {
            const double x0 = (double)x * s.w / n, x1 = (double)(x + 1) * s.w / n, y0 = (double)y * s.h / n, y1 = (double)(y + 1) * s.h / n;
            double a = 0, r = 0, g = 0, b = 0, area = 0;
            for (int sy = (int)y0; sy < std::min(s.h, (int)std::ceil(y1)); ++sy)
                for (int sx = (int)x0; sx < std::min(s.w, (int)std::ceil(x1)); ++sx) {
                    const double wx = std::min<double>(sx + 1, x1) - std::max<double>(sx, x0), wy = std::min<double>(sy + 1, y1) - std::max<double>(sy, y0);
                    const double w = wx * wy;
                    if (w <= 0) continue;
                    const uint32_t p = s.px[(size_t)sy * s.w + sx];
                    const double pa = (p >> 24) / 255.0;
                    a += pa * w;
                    r += ((p >> 16) & 255) * pa * w; g += ((p >> 8) & 255) * pa * w; b += (p & 255) * pa * w;
                    area += w;
                }
            if (area <= 0 || a <= 0) continue;
            const auto ch = [&](double v) { return (uint32_t)std::clamp((int)std::lround(v / a), 0, 255); };
            out.px[(size_t)y * n + x] = (uint32_t)std::clamp((int)std::lround(a / area * 255), 0, 255) << 24 | ch(r) << 16 | ch(g) << 8 | ch(b);
        }
    return out;
}

}  // namespace

bool drawAppIcon(const vpf::gui::Paint& p, int cx, int cy, int px) {
    const int n = std::max(1, (int)std::lround(px * p.scale));
    static std::map<int, vpf::gui::Bitmap> cache;
    auto it = cache.find(n);
    if (it == cache.end()) it = cache.emplace(n, scaled(n)).first;
    if (!it->second.valid()) return false;
    const vpf::gui::Rect d = p.dev({cx - px / 2, cy - px / 2, px, px});
    p.canvas.drawBitmap(it->second, d.x, d.y);
    return true;
}

bool drawAppIconInk(const vpf::gui::Paint& p, int cx, int cy, int px, vpf::gui::Color ink) {
    const int n = std::max(1, (int)std::lround(px * p.scale));
    const uint32_t argb = (uint32_t)ink.a << 24 | (uint32_t)ink.r << 16 | (uint32_t)ink.g << 8 | ink.b;
    static std::map<std::pair<int, uint32_t>, vpf::gui::Bitmap> cache;
    auto it = cache.find({n, argb});
    if (it == cache.end()) {
        vpf::gui::Bitmap m = scaled(n);
        for (uint32_t& q : m.px) {   // (a pixel is the mark's where the picture is opaque and light: half way, no blend)
            const int luma = (int)(((q >> 16) & 255) * 299 + ((q >> 8) & 255) * 587 + (q & 255) * 114) / 1000;
            q = (q >> 24) >= 128 && luma >= 128 ? argb : 0;
        }
        it = cache.emplace(std::make_pair(n, argb), std::move(m)).first;
    }
    if (!it->second.valid()) return false;
    const vpf::gui::Rect d = p.dev({cx - px / 2, cy - px / 2, px, px});
    p.canvas.drawBitmap(it->second, d.x, d.y);
    return true;
}

}  // namespace latch
