// MIDI input for the chop window (WAVdesk's app/mw_midi.cpp + mw_chop.cpp chopMidiDevice, without its sampler): one
// input device, its notes to the chop's voices (Etch's keymap, Pitch / Regions, its pads) from the driver's thread,
// the window's readout posted to the UI thread. settings.json "midiInput": empty (the default) = the first input
// plugged in, "off" = none, else a device by name. The inputs are listed again every 2 s, so a keyboard plugged in
// later (or the setting changed in Settings) is taken without a restart.
#pragma once
#include "midi_input.h"
#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace vpf::gui { class UiQueue; }

namespace latch {

class ChopMidi {
public:
    static constexpr const char* kKey = "midiInput";
    explicit ChopMidi(std::shared_ptr<vpf::gui::UiQueue> q);
    ~ChopMidi();
    void tick(double now);                       // (UI thread) the device list and the setting looked at, every 2 s
    void close();                                // (quitting: before the chop engine shuts down)
    std::string status() const;                  // what Settings shows under the row
    static std::vector<std::string> devices();   // the inputs plugged in now

private:
    void connect(const std::vector<std::string>& names);
    void onMessage(const wdn::midi::Message& m);   // (the driver's thread)
    std::shared_ptr<vpf::gui::UiQueue> q_;
    wdn::midi::Input in_;
    std::array<std::atomic<bool>, 128> held_{};   // (a note the voices took: its note off goes to them too)
    std::vector<std::string> names_;
    std::string want_, err_;
    double listAt_ = 0;
    bool closed_ = false;
};

}  // namespace latch
