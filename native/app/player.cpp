#include "player.h"
#include "data_root.h"
#include "external_tools.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <functional>
#include <vector>
#include <vpf/audio/standalone_audio.h>
#include <vpf/audio_ring.h>
#if defined(_WIN32)
#include "win_spawn.h"
#else
#include <csignal>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace fs = std::filesystem;

namespace latch {

// what the decoder thread and the device's thread share
struct PlayerFeed : vpf::PluginShared {
    vpf::AudioRing ring;
    std::atomic<uint64_t> played{0};   // frames out since the last flush
    std::atomic<bool> flushAsked{false}, eof{false};
};

namespace {

class FeedProcessor : public vpf::Processor {
public:
    void setShared(std::shared_ptr<vpf::PluginShared> s) override { feed_ = std::static_pointer_cast<PlayerFeed>(s); }
    void prepare(double, int) override {}
    void reset() override {}
    void setParameter(uint32_t, double) override {}
    void process(const float* const*, float* const* out, int nch, int frames) override {
        size_t n = 0;
        if (feed_) {
            if (feed_->flushAsked.load(std::memory_order_acquire)) {
                feed_->ring.discard();
                feed_->played.store(0, std::memory_order_relaxed);
                feed_->flushAsked.store(false, std::memory_order_release);
            } else {
                n = feed_->ring.read(out, nch, (size_t)frames);
                feed_->played.fetch_add(n, std::memory_order_relaxed);
            }
        }
        for (int c = 0; c < nch; ++c) std::fill(out[c] + n, out[c] + frames, 0.f);
    }
private:
    std::shared_ptr<PlayerFeed> feed_;
};

const vpf::PluginDef& feedDef() {
    static vpf::PluginDef d = [] {
        vpf::PluginDef p;
        p.info.id = "com.vacantsystems.latch.audition";
        p.info.name = "Latch";
        p.createProcessor = [] { return std::unique_ptr<vpf::Processor>(new FeedProcessor()); };
        return p;
    }();
    return d;
}

std::string seconds(double s) { char b[32]; std::snprintf(b, sizeof b, "%.3f", std::max(0.0, s)); return b; }

// `exe args` with its stdout handed to onData until it exits or *stop (then killed); its stderr dropped. Polled, never
// a blocking read: another child spawned meanwhile may inherit the pipe's write end, so its EOF can come late; the
// process's exit with nothing left in the pipe is the end. false = it did not start
bool runPiped(const std::string& exe, const std::vector<std::string>& args, const std::function<void(const char*, size_t)>& onData,
              const std::atomic<bool>& stop) {
#if defined(_WIN32)
    std::wstring cmd = L"\"" + fs::u8path(exe).wstring() + L"\"";
    for (const std::string& a : args) {
        std::wstring q = L"\"";
        for (wchar_t c : fs::u8path(a).wstring()) { if (c == L'"') q += L'\\'; q += c; }
        cmd += L" " + q + L"\"";
    }
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 1 << 16)) return false;
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW si{};
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul;
    si.hStdOutput = wr;
    si.hStdError = nul;
    PROCESS_INFORMATION pi{};
    HANDLE job = nullptr;
    const bool ok = wdn::createProcessInJob(cmd, CREATE_NO_WINDOW, si, pi, job);
    const DWORD why = GetLastError();
    CloseHandle(wr);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!ok) { CloseHandle(rd); log("audition: " + fs::u8path(exe).filename().u8string() + " did not start (" + std::to_string(why) + ")"); return false; }
    char buf[1 << 16];
    while (!stop) {
        DWORD avail = 0;
        if (!PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr)) break;
        if (!avail) {
            if (WaitForSingleObject(pi.hProcess, 5) == WAIT_OBJECT_0) {
                if (PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr) && avail) continue;
                break;
            }
            continue;
        }
        DWORD got = 0;
        if (!ReadFile(rd, buf, std::min<DWORD>(avail, sizeof buf), &got, nullptr) || !got) break;
        onData(buf, got);
    }
    if (job) { TerminateJobObject(job, 1); CloseHandle(job); } else TerminateProcess(pi.hProcess, 1);
    WaitForSingleObject(pi.hProcess, 2000);
    CloseHandle(pi.hProcess);
    CloseHandle(rd);
#else
    int fds[2];
    if (pipe(fds) != 0) return false;
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, fds[1], 1);
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addclose(&fa, fds[0]);
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);   // (killChildProcesses's group)
    std::vector<std::string> all = {exe};
    all.insert(all.end(), args.begin(), args.end());
    std::vector<char*> argv;
    for (std::string& a : all) argv.push_back(a.data());
    argv.push_back(nullptr);
    pid_t pid = 0;
    const int rc = posix_spawn(&pid, exe.c_str(), &fa, &at, argv.data(), environ);
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&at);
    close(fds[1]);
    if (rc != 0) { close(fds[0]); return false; }
    fcntl(fds[0], F_SETFL, O_NONBLOCK);
    char buf[1 << 16];
    while (!stop) {
        const ssize_t got = read(fds[0], buf, sizeof buf);
        if (got > 0) { onData(buf, (size_t)got); continue; }
        if (got == 0) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    kill(pid, SIGKILL);
    waitpid(pid, nullptr, 0);
    close(fds[0]);
#endif
    return true;
}

// ffmpeg's f32le stereo at `rate` from `from` seconds, into the ring until the end or *stop
void decode(const std::string& ffmpeg, const std::string& path, double from, double rate, PlayerFeed& feed, const std::atomic<bool>& stop) {
    const std::vector<std::string> args = {"-nostdin", "-hide_banner", "-loglevel", "error", "-ss", seconds(from), "-i", path,
                                           "-vn", "-sn", "-dn", "-f", "f32le", "-ac", "2", "-ar", std::to_string((int)rate), "-"};
    std::vector<float> l, r;
    std::vector<char> pending;
    auto push = [&](const char* data, size_t bytes) {
        pending.insert(pending.end(), data, data + bytes);
        const size_t frames = pending.size() / (2 * sizeof(float));
        if (!frames) return;
        l.resize(frames);
        r.resize(frames);
        const float* f = reinterpret_cast<const float*>(pending.data());
        for (size_t i = 0; i < frames; ++i) { l[i] = f[2 * i]; r[i] = f[2 * i + 1]; }
        pending.erase(pending.begin(), pending.begin() + (ptrdiff_t)(frames * 2 * sizeof(float)));
        size_t done = 0;
        while (done < frames && !stop) {
            const size_t room = feed.ring.capacity() - feed.ring.available();
            if (!room) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
            const size_t n = std::min(room, frames - done);
            const float* src[2] = {l.data() + done, r.data() + done};
            done += feed.ring.write(src, 2, n);
        }
    };
    runPiped(ffmpeg, args, push, stop);
    if (!stop) feed.eof = true;
}

}  // namespace

Player::Player() = default;
Player::~Player() {
    stop();
    stopProbe_ = true;
    if (prober_.joinable()) prober_.join();
}

bool Player::play(const std::string& path, std::string* err) {
    stop();
    endedEmpty_ = false;
    const std::string ffmpeg = toolPath("ffmpeg");
    if (ffmpeg.empty()) { if (err) *err = "No ffmpeg yet: extract something first"; return false; }
    feed_ = std::make_shared<PlayerFeed>();
    feed_->ring.allocate(2, 1 << 18);   // (before the device runs: its thread reads it; ~5 s at 48 k)
    driver_ = std::make_unique<vpf::audio::ProcessorDriver>(feedDef(), feed_);
    audio_ = std::make_unique<vpf::audio::StandaloneAudio>(vpf::audio::systemBackends(), "", driver_.get());
    audio_->appName = "Latch";
    if (!audio_->start() || audio_->sampleRate() <= 0) {
        if (err) *err = audio_->status().empty() ? "No audio output" : audio_->status();
        audio_.reset();
        driver_.reset();
        feed_.reset();
        return false;
    }
    rate_ = audio_->sampleRate();
    path_ = path;
    startDecoder(0);

    duration_ = 0;
    stopProbe_ = true;
    if (prober_.joinable()) prober_.join();
    stopProbe_ = false;
    const std::string ffprobe = toolPath("ffprobe");
    if (!ffprobe.empty())
        prober_ = std::thread([this, ffprobe, path] {
            std::string out;
            runPiped(ffprobe, {"-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path},
                     [&out](const char* d, size_t n) { out.append(d, n); }, stopProbe_);
            try { duration_ = std::stod(out); } catch (...) {}
        });
    log("audition: " + path + " at " + std::to_string((int)rate_) + " Hz");
    return true;
}

void Player::startDecoder(double from) {
    from_ = from;
    feed_->eof = false;
    stopDecoder_ = false;
    decoder_ = std::thread([ffmpeg = toolPath("ffmpeg"), path = path_, from, rate = rate_, feed = feed_, this] {
        decode(ffmpeg, path, from, rate, *feed, stopDecoder_);
    });
}

void Player::stopDecoderNow() {
    stopDecoder_ = true;
    if (decoder_.joinable()) decoder_.join();
}

// the ring emptied by the device's thread (it is the reader); without one running, here
void Player::flush() {
    if (!feed_) return;
    if (audio_ && audio_->running()) {
        feed_->flushAsked.store(true, std::memory_order_release);
        for (int i = 0; i < 100 && feed_->flushAsked.load(std::memory_order_acquire); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(2));
        if (!feed_->flushAsked.exchange(false)) return;
    }
    feed_->ring.discard();
    feed_->played = 0;
}

void Player::stop() {
    stopDecoderNow();
    if (audio_) audio_->stop();
    audio_.reset();
    driver_.reset();
    feed_.reset();
    path_.clear();
    from_ = 0;
}

void Player::seek(double s) {
    if (!playing()) return;
    if (duration() > 0) s = std::min(s, std::max(0.0, duration() - 0.05));
    stopDecoderNow();
    flush();
    startDecoder(std::max(0.0, s));
}

double Player::position() const {
    if (!feed_ || rate_ <= 0) return 0;
    return from_ + (double)feed_->played.load(std::memory_order_relaxed) / rate_;
}

bool Player::poll() {
    if (!audio_) return false;
    audio_->poll();
    // another rate (the device changed under it): the decoder again at the new one, from here
    if (audio_->running() && audio_->sampleRate() > 0 && audio_->sampleRate() != rate_) {
        const double at = position();
        stopDecoderNow();
        flush();
        rate_ = audio_->sampleRate();
        startDecoder(at);
        return false;
    }
    if (feed_->eof && feed_->ring.available() == 0) {
        endedEmpty_ = from_ == 0 && feed_->played == 0;
        stop();
        return true;
    }
    return false;
}

}  // namespace latch
