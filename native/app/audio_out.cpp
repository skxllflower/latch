#include "audio_out.h"
#include "data_root.h"
#include <algorithm>
#include <cmath>
#include <vpf/audio/standalone_audio.h>
#include <vpf/gui/editor.h>

namespace latch {

namespace {

struct OutShared : vpf::PluginShared { AudioOut* out = nullptr; };

class OutProcessor : public vpf::Processor {
public:
    void setShared(std::shared_ptr<vpf::PluginShared> s) override { shared_ = std::static_pointer_cast<OutShared>(s); }
    void prepare(double, int) override {}
    void reset() override {}
    void setParameter(uint32_t, double) override {}
    void process(const float* const*, float* const* out, int nch, int frames) override {
        if (shared_ && shared_->out) shared_->out->render(out, nch, frames);
        else for (int c = 0; c < nch; ++c) std::fill(out[c], out[c] + frames, 0.f);
    }
private:
    std::shared_ptr<OutShared> shared_;
};

const vpf::PluginDef& outDef() {
    static vpf::PluginDef d = [] {
        vpf::PluginDef p;
        p.info.id = "com.vacantsystems.latch.output";
        p.info.name = "Latch";
        p.createProcessor = [] { return std::unique_ptr<vpf::Processor>(new OutProcessor()); };
        return p;
    }();
    return d;
}

constexpr int kMaxPull = 8192;   // frames a block may ask of a stream at 4x speed (a device block of 2048)

}  // namespace

AudioOut::AudioOut(std::shared_ptr<vpf::gui::UiQueue> ui) : ui_(std::move(ui)), uiThread_(std::this_thread::get_id()) {}

AudioOut::~AudioOut() {
    swap(nullptr);
    closeNow();
}

bool AudioOut::openNow() {
    if (audio_ && audio_->running()) return true;
    auto shared = std::make_shared<OutShared>();
    shared->out = this;
    driver_ = std::make_unique<vpf::audio::ProcessorDriver>(outDef(), shared);
    audio_ = std::make_unique<vpf::audio::StandaloneAudio>(vpf::audio::systemBackends(), "", driver_.get());
    audio_->appName = "Latch";
    if (!audio_->start() || audio_->sampleRate() <= 0) {
        log("audio: no output (" + audio_->status() + ")");
        audio_->stop();
        return false;
    }
    rate_ = (uint32_t)std::lround(audio_->sampleRate());
    latency_ = audio_->bufferSize() > 0 ? 2.0 * audio_->bufferSize() / audio_->sampleRate() : 0.0;
    idle_ = false;
    log("audio: " + audio_->outputName() + " at " + std::to_string(rate_.load()) + " Hz");
    return true;
}

void AudioOut::closeNow() {
    swap(nullptr);
    if (audio_) audio_->stop();
    audio_.reset();
    driver_.reset();
    rate_ = 0;
}

bool AudioOut::openEngine(int waitMs) {
    if (std::this_thread::get_id() == uiThread_) return openNow();
    if (rate_.load() > 0) return true;
    struct Wait { std::mutex m; std::condition_variable cv; bool done = false, ok = false; };
    auto w = std::make_shared<Wait>();
    ui_->post([this, w] {
        const bool ok = openNow();
        std::lock_guard<std::mutex> g(w->m);
        w->done = true;
        w->ok = ok;
        w->cv.notify_all();
    });
    std::unique_lock<std::mutex> g(w->m);
    w->cv.wait_for(g, std::chrono::milliseconds(std::max(0, waitMs)), [&] { return w->done; });
    return w->done && w->ok;
}

std::string AudioOut::status() const { return audio_ ? audio_->status() : std::string("Audio is off"); }

void AudioOut::swap(Stream* next) {
    std::lock_guard<std::recursive_mutex> g(lock_);
    Stream* old = cur_.exchange(next);
    live_ = next ? next->token : 0;
    while (inRender_.load()) std::this_thread::yield();   // (a block that took the old one finishes with it)
    delete old;
}

uint64_t AudioOut::streamBeginPull(int rate, int channels, StreamPull pull, void* user) {
    if (!pull || rate_.load() == 0 || (uint32_t)rate != rate_.load()) return 0;
    std::lock_guard<std::recursive_mutex> g(lock_);
    auto* s = new Stream();
    s->pull = pull;
    s->user = user;
    s->channels = std::clamp(channels, 1, 8);
    s->token = nextToken_++;
    s->buf.assign((size_t)(kMaxPull + 2) * s->channels, 0.f);
    swap(s);
    return s->token;
}

void AudioOut::streamEnd(uint64_t token) {
    std::lock_guard<std::recursive_mutex> g(lock_);
    if (token && token == live_.load()) swap(nullptr);
}

void AudioOut::streamRate(uint64_t token, float rate) {
    std::lock_guard<std::recursive_mutex> g(lock_);
    if (Stream* s = cur_.load(); s && s->token == token) s->rate = std::clamp(rate, 0.25f, 4.f);
}

void AudioOut::streamVolume(uint64_t token, float gain) {
    std::lock_guard<std::recursive_mutex> g(lock_);
    if (Stream* s = cur_.load(); s && s->token == token) s->gain = std::clamp(gain, 0.f, 1.f);
}

void AudioOut::poll() {
    if (!audio_) return;
    audio_->poll();
    const uint32_t r = audio_->running() ? (uint32_t)std::lround(audio_->sampleRate()) : 0;
    if (r != rate_.load()) {   // (another rate, or the device gone: the stream's owner opens it again)
        swap(nullptr);
        rate_ = r;
        if (r) latency_ = audio_->bufferSize() > 0 ? 2.0 * audio_->bufferSize() / r : 0.0;
    }
    const auto now = std::chrono::steady_clock::now();
    if (cur_.load()) { idle_ = false; return; }
    if (!idle_) { idle_ = true; idleSince_ = now; return; }
    if (std::chrono::duration<double>(now - idleSince_).count() > kIdleSeconds) { closeNow(); log("audio: closed (idle)"); }
}

void AudioOut::render(float* const* out, int nch, int frames) {
    inRender_.store(1);
    Stream* s = cur_.load();
    if (!s || frames <= 0) {
        for (int c = 0; c < nch; ++c) std::fill(out[c], out[c] + frames, 0.f);
        inRender_.store(0);
        return;
    }
    const int ch = s->channels;
    const float gain = s->gain.load(std::memory_order_relaxed);
    const double rate = s->rate.load(std::memory_order_relaxed);
    float* b = s->buf.data();
    auto side = [ch](int c) { return ch == 1 ? 0 : std::min(c, 1); };
    for (int done = 0; done < frames;) {
        const int n = std::min(frames - done, 2048);
        if (std::fabs(rate - 1.0) < 1e-6 && s->phase == 0) {
            s->pull(b, (uint32_t)n, (uint32_t)ch, s->user);
            for (int c = 0; c < nch; ++c) {
                const int k = side(c);
                for (int i = 0; i < n; ++i) out[c][done + i] = b[(size_t)i * ch + k] * gain;
            }
            for (int k = 0; k < 2; ++k) s->prev[k] = b[(size_t)(n - 1) * ch + side(k)];
        } else {
            // frame 0 is prev (the last one heard), 1.. the pulled ones; t steps by the rate
            const double end = s->phase + n * rate;
            const int got = std::min(kMaxPull, (int)std::floor(end));
            if (got > 0) s->pull(b, (uint32_t)got, (uint32_t)ch, s->user);
            auto at = [&](int i, int k) { return i <= 0 ? s->prev[k] : b[(size_t)(std::min(i, got) - 1) * ch + side(k)]; };
            for (int i = 0; i < n; ++i) {
                const double t = s->phase + i * rate;
                const int i0 = (int)std::floor(t);
                const float f = (float)(t - i0);
                for (int c = 0; c < nch; ++c) {
                    const int k = std::min(c, 1);
                    out[c][done + i] = (at(i0, k) + (at(i0 + 1, k) - at(i0, k)) * f) * gain;
                }
            }
            for (int k = 0; k < 2; ++k) s->prev[k] = at(got, k);
            s->phase = end - std::floor(end);
            if (std::fabs(rate - 1.0) < 1e-6) s->phase = 0;   // (back to 1: straight pulls again)
        }
        done += n;
    }
    inRender_.store(0);
}

}  // namespace latch
