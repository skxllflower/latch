// Latch's one audio output: vpf's standalone audio (the system's default output) with one pulled stream at a time,
// the shape the chop library asks of its host (wdn::ChopSound, shell/chop_sound.h). Audition (player.h) is one stream,
// the chop window's engine another: a new stream ends the one before it (streamLive goes false), as WAVdesk's Audition
// plays one source at a time. The device opens on the first stream and closes after a while with none, so Latch never
// holds an output it does not use. A stream's speed (tape-style, the chop window's Speed preview) is a linear
// resampler over its pull; its volume a gain.
#pragma once
#include "chop_sound.h"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace vpf::audio { class StandaloneAudio; class ProcessorDriver; }
namespace vpf::gui { class UiQueue; }

namespace latch {

class AudioOut : public wdn::ChopSound {
public:
    explicit AudioOut(std::shared_ptr<vpf::gui::UiQueue> ui);   // (made on the UI thread)
    ~AudioOut() override;

    // ---- ChopSound ----
    bool openEngine(int waitMs = 4000) override;   // (off the UI thread: done on it, waited for)
    uint32_t engineRate() const override { return rate_.load(); }
    uint64_t streamBeginPull(int rate, int channels, StreamPull pull, void* user) override;
    bool streamLive(uint64_t token) const override { return token && token == live_.load(); }
    void streamEnd(uint64_t token) override;
    void streamRate(uint64_t token, float rate) override;
    void streamVolume(uint64_t token, float gain) override;
    double streamLatency() const override { return latency_.load(); }

    // UI thread, every tick: the device's changes (another rate ends the stream: its owner opens it again), and the
    // device closed after kIdleSeconds with no stream
    void poll();
    std::string status() const;   // (why it would not open)
    bool busy() const { return live_.load() != 0; }   // (a stream is live)
    static constexpr double kIdleSeconds = 10.0;

    // the device's thread (the processor): one block into planar out
    void render(float* const* out, int nch, int frames);

private:
    struct Stream {
        StreamPull pull = nullptr;
        void* user = nullptr;
        int channels = 2;
        uint64_t token = 0;
        std::atomic<float> rate{1.f}, gain{1.f};
        double phase = 0;            // (the resampler: where between prev and the next pulled frame)
        float prev[2] = {0, 0};
        std::vector<float> buf;      // (interleaved pulls)
    };
    std::shared_ptr<vpf::gui::UiQueue> ui_;
    std::thread::id uiThread_;
    std::unique_ptr<vpf::audio::ProcessorDriver> driver_;
    std::unique_ptr<vpf::audio::StandaloneAudio> audio_;
    std::atomic<uint32_t> rate_{0};
    std::atomic<double> latency_{0};
    std::atomic<Stream*> cur_{nullptr};
    std::atomic<uint64_t> live_{0}, nextToken_{1};
    std::atomic<int> inRender_{0};
    std::recursive_mutex lock_;   // (the stream's changes: any thread)
    std::chrono::steady_clock::time_point idleSince_;
    bool idle_ = false;
    bool openNow();      // (UI thread)
    void closeNow();     // (UI thread)
    void swap(Stream* next);   // the current stream replaced (null: none), the old one freed once the device let go
};

}  // namespace latch
