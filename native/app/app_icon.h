// The app's own icon picture (app_icon.cpp), for the title strip and About
#pragma once
#include <vpf/gui/widget.h>

namespace latch {

// centred at cx, cy (logical), px logical pixels square; false when the picture is not there
bool drawAppIcon(const vpf::gui::Paint& p, int cx, int cy, int px);
// the 1-Bit look's (the dev skin): the same picture's light mark alone, on whole pixels, in `ink` (the strip's own
// dark), its dark tile left out so the strip shows through, in place of the black and white picture
bool drawAppIconInk(const vpf::gui::Paint& p, int cx, int cy, int px, vpf::gui::Color ink);

}  // namespace latch
