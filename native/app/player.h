// Audition: one file played through vpf's standalone audio (the system's default output), decoded by the suite's
// ffmpeg as a child (the decoder that handles YouTube bestaudio, opus and m4a: CLAUDE.md's audio iron rule), born in
// a kill-on-close job like every other child. The ffmpeg pipe feeds an AudioRing the device's thread drains; a seek
// restarts the decoder at that time. The device is open only while something plays (stop closes it), so Latch never
// holds an output it does not use.
#pragma once
#include <atomic>
#include <memory>
#include <string>
#include <thread>

namespace vpf::audio { class StandaloneAudio; class ProcessorDriver; }

namespace latch {

struct PlayerFeed;

class Player {
public:
    Player();
    ~Player();
    Player(const Player&) = delete;
    Player& operator=(const Player&) = delete;

    // UI thread. false = nothing plays (*err says why: no ffmpeg, no output device)
    bool play(const std::string& path, std::string* err = nullptr);
    void stop();
    void seek(double seconds);
    // UI thread, every tick: the device's changes, the end of the file (stops). true = it stopped by itself
    bool poll();

    bool playing() const { return !path_.empty(); }
    const std::string& path() const { return path_; }
    double position() const;
    bool endedEmpty() const { return endedEmpty_; }   // (the last stop by itself played nothing: ffmpeg could not read it)
    double duration() const { return duration_.load(std::memory_order_relaxed); }   // (0 until ffprobe answers)

private:
    std::string path_;
    double from_ = 0, rate_ = 0;
    bool endedEmpty_ = false;
    std::shared_ptr<PlayerFeed> feed_;
    std::unique_ptr<vpf::audio::ProcessorDriver> driver_;
    std::unique_ptr<vpf::audio::StandaloneAudio> audio_;
    std::thread decoder_, prober_;
    std::atomic<bool> stopDecoder_{false}, stopProbe_{false};
    std::atomic<double> duration_{0};
    void startDecoder(double from);
    void stopDecoderNow();
    void flush();
};

}  // namespace latch
