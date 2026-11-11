#include "chop_midi.h"
#include "chop_engine.h"
#include "data_root.h"
#include "settings_store.h"
#include <algorithm>
#include <vpf/gui/editor.h>
#include <vpf/plugin.h>

namespace latch {

ChopMidi::ChopMidi(std::shared_ptr<vpf::gui::UiQueue> q) : q_(std::move(q)) {}
ChopMidi::~ChopMidi() { close(); }

std::vector<std::string> ChopMidi::devices() { return wdn::midi::inputNames(); }

void ChopMidi::close() {
    closed_ = true;
    if (in_.isOpen()) in_.close();
}

std::string ChopMidi::status() const {
    if (want_ == "off") return "Off";
    if (in_.isOpen()) return "Listening to " + in_.name();
    if (!err_.empty()) return err_;
    return want_.empty() ? "No MIDI input plugged in" : want_ + " is not plugged in";
}

void ChopMidi::tick(double now) {
    if (closed_) return;
    const std::string want = wdn::settings::text(kKey, "");
    if (now < listAt_ && want == want_) return;
    listAt_ = now + 2.0;
    std::vector<std::string> names = devices();
    if (names == names_ && want == want_ && (in_.isOpen() || want == "off")) return;
    names_ = std::move(names);
    want_ = want;
    connect(names_);
}

void ChopMidi::connect(const std::vector<std::string>& names) {
    std::string pick;
    if (want_ != "off") {
        if (want_.empty()) { if (!names.empty()) pick = names.front(); }
        else if (std::find(names.begin(), names.end(), want_) != names.end()) pick = want_;
    }
    if (pick.empty()) {
        if (in_.isOpen()) { in_.close(); log("midi: input closed"); }
        err_.clear();
        return;
    }
    if (in_.isOpen() && in_.name() == pick) return;
    std::string err;
    if (in_.open(pick, [this](const wdn::midi::Message& m) { onMessage(m); }, err)) {
        err_.clear();
        log("midi: input open: " + pick);
    } else {
        err_ = pick + ": " + err;
        log("midi: " + err_);
    }
}

// the driver's thread: the note straight to the voices' queue (the sound, no UI thread in its way), then the window's
// readout posted (WAVdesk's chopMidiDevice + chopMidiSeen). A note the chop maps nothing to is dropped: Latch has no
// sampler to play the file with
void ChopMidi::onMessage(const wdn::midi::Message& m) {
    using K = wdn::midi::Message;
    vpf::NoteEvent e;
    e.channel = m.channel;
    if (m.kind == K::Cc) {   // (123 / 120: the panic)
        if ((m.note == 123 || m.note == 120) && wdn::ChopEngine::takesMidi()) {
            e.type = vpf::NoteEvent::Type::AllNotesOff;
            wdn::ChopEngine::postNote(e);
            for (auto& h : held_) h.store(false);
        }
        return;
    }
    if ((m.kind != K::NoteOn && m.kind != K::NoteOff) || m.note < 0 || m.note > 127) return;
    e.key = m.note;
    const bool on = m.kind == K::NoteOn;
    if (!on) {
        if (!held_[(size_t)m.note].exchange(false)) return;
        e.type = vpf::NoteEvent::Type::NoteOff;
        wdn::ChopEngine::postNote(e);
    } else {
        if (!wdn::ChopEngine::mapsNote(m.note)) return;
        e.type = vpf::NoteEvent::Type::NoteOn;
        e.velocity = std::max(1, std::min(127, m.velocity)) / 127.0f;
        if (!wdn::ChopEngine::postNote(e)) return;
        held_[(size_t)m.note].store(true);
    }
    if (q_) q_->post([note = m.note, vel = m.velocity, on] {
        if (wdn::ChopEngine* ce = wdn::ChopEngine::existing()) ce->midiNote(note, vel, on);
    });
}

}  // namespace latch
