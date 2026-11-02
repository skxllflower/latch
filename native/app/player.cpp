#include "player.h"
#include "data_root.h"
#include "external_tools.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <functional>
#include <vector>
#include "audio_out.h"
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
struct PlayerFeed {
    vpf::AudioRing ring;
    std::atomic<uint64_t> played{0};   // frames out since the last flush
    std::atomic<bool> flushAsked{false}, eof{false};
    float l[2048], r[2048];            // (the pull's planar scratch)
};

namespace {

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

// the device's thread: the ring into the stream's interleaved block (a flush asked: emptied first)
void Player::pull(float* out, uint32_t frames, uint32_t channels, void* user) {
    PlayerFeed& f = *static_cast<PlayerFeed*>(user);
    if (f.flushAsked.load(std::memory_order_acquire)) {
        f.ring.discard();
        f.played.store(0, std::memory_order_relaxed);
        f.flushAsked.store(false, std::memory_order_release);
    }
    for (uint32_t done = 0; done < frames;) {
        const uint32_t n = std::min<uint32_t>(frames - done, 2048);
        float* planes[2] = {f.l, f.r};
        const size_t got = f.ring.read(planes, 2, n);
        f.played.fetch_add(got, std::memory_order_relaxed);
        for (uint32_t i = 0; i < n; ++i) {
            float* o = out + (size_t)(done + i) * channels;
            const float L = i < got ? f.l[i] : 0.f, R = i < got ? f.r[i] : 0.f;
            if (channels == 1) o[0] = 0.5f * (L + R);
            else { o[0] = L; o[1] = R; for (uint32_t c = 2; c < channels; ++c) o[c] = 0.f; }
        }
        done += n;
    }
}

Player::Player(AudioOut& out) : out_(out) {}
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
    if (!out_.openEngine() || out_.engineRate() == 0) {
        if (err) *err = out_.status().empty() ? "No audio output" : out_.status();
        return false;
    }
    rate_ = out_.engineRate();
    feed_ = std::make_unique<PlayerFeed>();
    feed_->ring.allocate(2, 1 << 18);   // (~5 s at 48 k)
    token_ = out_.streamBeginPull((int)rate_, 2, &Player::pull, feed_.get());
    if (!token_) { feed_.reset(); if (err) *err = "No audio output"; return false; }
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
    decoder_ = std::thread([ffmpeg = toolPath("ffmpeg"), path = path_, from, rate = rate_, feed = feed_.get(), this] {
        decode(ffmpeg, path, from, rate, *feed, stopDecoder_);
    });
}

void Player::stopDecoderNow() {
    stopDecoder_ = true;
    if (decoder_.joinable()) decoder_.join();
}

// the ring emptied by the device's thread (it is the reader); with the stream gone, here
void Player::flush() {
    if (!feed_) return;
    if (out_.streamLive(token_)) {
        feed_->flushAsked.store(true, std::memory_order_release);
        for (int i = 0; i < 100 && feed_->flushAsked.load(std::memory_order_acquire); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(2));
        if (!feed_->flushAsked.exchange(false)) return;
    }
    feed_->ring.discard();
    feed_->played = 0;
}

void Player::stop() {
    stopDecoderNow();
    out_.streamEnd(token_);
    token_ = 0;
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
    if (!playing()) return false;
    // the stream gone: another sound took the device (the chop window), or its rate changed (then on at the new one)
    if (!out_.streamLive(token_)) {
        const uint32_t r = out_.engineRate();
        if (r && r != (uint32_t)rate_ && !out_.busy()) {
            const double at = position();
            stopDecoderNow();
            feed_->ring.discard();
            feed_->played = 0;
            rate_ = r;
            token_ = out_.streamBeginPull((int)rate_, 2, &Player::pull, feed_.get());
            if (token_) { startDecoder(at); return false; }
        }
        stop();
        return true;
    }
    if (feed_->eof && feed_->ring.available() == 0) {
        endedEmpty_ = from_ == 0 && feed_->played == 0;
        stop();
        return true;
    }
    return false;
}

}  // namespace latch
