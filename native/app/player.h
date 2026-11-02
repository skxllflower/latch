// Audition: one file played as a stream on Latch's output (audio_out.h), decoded by the suite's ffmpeg as a child (the
// decoder that handles YouTube bestaudio, opus and m4a: CLAUDE.md's audio iron rule), born in a kill-on-close job like
// every other child. The ffmpeg pipe feeds an AudioRing the stream's pull drains; a seek restarts the decoder at that
// time. Another stream taking the output (the chop window) stops it.
#pragma once
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>


namespace latch {

struct PlayerFeed;
class AudioOut;

class Player {
public:
    explicit Player(AudioOut& out);
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
    AudioOut& out_;
    uint64_t token_ = 0;
    std::unique_ptr<PlayerFeed> feed_;
    static void pull(float* out, uint32_t frames, uint32_t channels, void* user);
    std::thread decoder_, prober_;
    std::atomic<bool> stopDecoder_{false}, stopProbe_{false};
    std::atomic<double> duration_{0};
    void startDecoder(double from);
    void stopDecoderNow();
    void flush();
};

}  // namespace latch
