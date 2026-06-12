// Standalone audition engine for the Chop window. WAVdesk plays through
// its wavdesk-audio-daemon; standalone Latch owns a small rodio engine
// instead (decision: no shared daemon binary). A dedicated thread owns
// the cpal/rodio output (OutputStream is !Send, so it can never live in
// shared state); commands arrive over a channel, and the thread emits
// `audio-pos` events (~30 Hz while audible) that feed the JS playback
// context. The region loop runs HERE, checked every ~4 ms — tighter
// than a JS-side position watcher could be.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub enum Cmd {
    Play { path: String, start_sec: f64 },
    Pause,
    Resume,
    Stop,
    Seek(f64),
    SetLoop { start_sec: f64, end_sec: f64 },
    ClearLoop,
    // Video deck — the audio half of the native video engine: a Rust
    // port of WAVdesk's audio_daemon va_* core (user-approved clone).
    // Speaks the exact `vaudio_pos` / `vaudio_state` contract, so the
    // ported nativeVideoStream sync code runs unchanged.
    VStart { path: String, start_sec: f64, lathe: String },
    VPause,
    VResume,
    VStop,
    VSeek { sec: f64, dir: i32 },
    VSetVolume(f32),
    VSetRate(f32),
    VSetLoop { in_sec: f64, out_sec: f64 },
}

static TX: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

fn ensure_thread(app: &AppHandle) -> Sender<Cmd> {
    let tx = TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Cmd>();
        let app = app.clone();
        std::thread::spawn(move || audio_thread(app, rx));
        Mutex::new(tx)
    });
    tx.lock().unwrap().clone()
}

struct EngineState {
    sink: Option<rodio::Sink>,
    path: String,
    looping: Option<(f64, f64)>,
}

// stream-audio's forced layout (see lathe's stream_audio): interleaved
// f32le, 48 kHz stereo. Position derives from samples CONSUMED by the
// audio callback — so it advances at the sink's speed automatically
// (set_speed pulls source samples faster), which is exactly the
// daemon's tape-style rate contract.
// Output-latency compensation on emitted positions. ZERO = the daemon's
// exact contract (it emits raw engine frames-played), and the engine's
// gapless-loop seam GEOMETRY depends on the cursor wrapping exactly at
// the out-point — a nonzero comp shifts every wrap and smears short
// loops. The earlier 0.15 was tuned against the pre-clone deck, whose
// position counting ran further ahead. Ear-tunable if A/V drifts.
const VA_OUTPUT_LATENCY_SEC: f64 = 0.0;

// ── Video-audio deck — Rust port of WAVdesk's audio_daemon va_* core ──
// (user-approved clone of the proven implementation). ONE persistent
// `lathe decode-server <path> --audio` per session; its stdout is
// chunked [u64 LE pts µs][u32 LE len][f32le PCM] where len==0 is a
// SEEK MARKER (flush + position rebase + live direction flip) and
// len==0xFFFFFFFF is a WRAP MARKER (gapless loop continuity — the
// position rebases when the wrapped samples actually PLAY). Seeks,
// loop bounds, and pause are JSON lines on its stdin: the DECODER owns
// loop wraps and reverse-ordered PCM (TRUE reverse audio); this side
// plays bytes and keeps the books. Forward-only `stream-audio` raw
// pipe (seek = respawn) is the fallback when decode-server is
// unavailable.

const VA_Q_CAP_SEC: usize = 2; // PCM queue depth before reader backpressure

// Seconds since first use — stamps the dev trace so user-action gaps
// are distinguishable from programmatic back-to-back ops.
#[cfg(debug_assertions)]
fn va_ts() -> f64 {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_secs_f64()
}

struct VaPos {
    base: f64,
    base_frames: u64,
    frames_written: u64, // reader-side, since last flush
    wraps: std::collections::VecDeque<(u64, f64)>, // (frames_written at wrap, new base)
}

struct VaShared {
    q: Mutex<std::collections::VecDeque<f32>>,
    // Bumped on every flush — PcmSource drops its stale local batch.
    flush_gen: std::sync::atomic::AtomicU64,
    // Samples handed to the mixer since the last flush.
    consumed: std::sync::atomic::AtomicU64,
    seek_pending: std::sync::atomic::AtomicI32,
    // When the most recent seek was sent — feeds the lost-marker
    // watchdog (a marker that never returns would otherwise gate
    // position emission FOREVER: the engine clock free-runs past every
    // loop boundary and nothing in-app can fix it).
    seek_sent_at: Mutex<Option<Instant>>,
    done: std::sync::atomic::AtomicBool,
    dir: std::sync::atomic::AtomicI32,
    dir_staged: std::sync::atomic::AtomicI32,
    sr: u32,
    ch: u16,
    pos: Mutex<VaPos>,
}

impl VaShared {
    fn new(sr: u32, ch: u16, base: f64) -> Self {
        VaShared {
            q: Mutex::new(std::collections::VecDeque::new()),
            flush_gen: std::sync::atomic::AtomicU64::new(0),
            consumed: std::sync::atomic::AtomicU64::new(0),
            seek_pending: std::sync::atomic::AtomicI32::new(0),
            seek_sent_at: Mutex::new(None),
            done: std::sync::atomic::AtomicBool::new(false),
            dir: std::sync::atomic::AtomicI32::new(1),
            dir_staged: std::sync::atomic::AtomicI32::new(1),
            sr,
            ch,
            pos: Mutex::new(VaPos {
                base,
                base_frames: 0,
                frames_written: 0,
                wraps: std::collections::VecDeque::new(),
            }),
        }
    }

    // Seek-marker handling: everything buffered predates the seek.
    fn flush_and_rebase(&self, base: f64) {
        if let Ok(mut q) = self.q.lock() {
            q.clear();
        }
        self.flush_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.consumed.store(0, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut p) = self.pos.lock() {
            p.base = base;
            p.base_frames = 0;
            p.frames_written = 0;
            p.wraps.clear();
        }
        self.dir.store(
            self.dir_staged.load(std::sync::atomic::Ordering::SeqCst),
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    // Port of va_position(): wrap rebases apply once playback CONSUMES
    // past the frames the reader had written at the wrap; reverse
    // descends from the base.
    fn position(&self) -> f64 {
        let sr = self.sr.max(1) as f64;
        let ch = self.ch.max(1) as u64;
        let fp = self.consumed.load(std::sync::atomic::Ordering::Relaxed) / ch;
        let mut p = self.pos.lock().unwrap();
        while let Some(&(fw, base)) = p.wraps.front() {
            if fp >= fw {
                #[cfg(debug_assertions)]
                eprintln!("[vaudio {:9.3}] wrap rebase applied: fp={fp} base={base:.3}", va_ts());
                p.base = base;
                p.base_frames = fw;
                p.wraps.pop_front();
            } else {
                break;
            }
        }
        let played = fp.saturating_sub(p.base_frames) as f64 / sr;
        let pos = p.base
            + if self.dir.load(std::sync::atomic::Ordering::Relaxed) < 0 {
                -played
            } else {
                played
            };
        pos.max(0.0)
    }
}

// rodio Source over the shared queue. Locks ONCE per ~1024-sample batch
// (never per sample — that contention class caused audible slow-mo in
// an earlier design). Underruns play silence WITHOUT counting, so the
// position holds rather than drifting ahead of real audio.
struct PcmSource {
    shared: std::sync::Arc<VaShared>,
    local: std::collections::VecDeque<f32>,
    local_gen: u64,
}

impl Iterator for PcmSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let gen = self.shared.flush_gen.load(std::sync::atomic::Ordering::Acquire);
        if gen != self.local_gen {
            self.local.clear();
            self.local_gen = gen;
        }
        if self.local.is_empty() {
            if let Ok(mut q) = self.shared.q.try_lock() {
                let take = q.len().min(1024);
                for _ in 0..take {
                    if let Some(s) = q.pop_front() {
                        self.local.push_back(s);
                    }
                }
            }
        }
        if let Some(v) = self.local.pop_front() {
            self.shared.consumed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Some(v);
        }
        if self.shared.done.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        Some(0.0)
    }
}

impl rodio::Source for PcmSource {
    fn current_frame_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { self.shared.ch }
    fn sample_rate(&self) -> u32 { self.shared.sr }
    fn total_duration(&self) -> Option<Duration> { None }
}

// Read stderr lines until the WAVDESK_APCM layout line lathe emits
// before any PCM. None = no audio track / spawn failure.
fn va_read_apcm(stderr: &mut std::process::ChildStderr) -> Option<(u32, u16)> {
    use std::io::Read;
    let mut line = String::new();
    let mut byte = [0u8; 1];
    while stderr.read(&mut byte).ok()? == 1 {
        let c = byte[0] as char;
        if c == '\n' || c == '\r' {
            if line.contains("WAVDESK_APCM") {
                let grab = |key: &str, def: u32| -> u32 {
                    line.find(key)
                        .and_then(|p| line[p + key.len()..]
                            .chars()
                            .take_while(|c| c.is_ascii_digit())
                            .collect::<String>()
                            .parse()
                            .ok())
                        .unwrap_or(def)
                };
                return Some((grab("sr=", 48_000), grab("ch=", 2) as u16));
            }
            line.clear();
        } else {
            line.push(c);
        }
    }
    None
}

struct VideoDeck {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
    shared: Option<std::sync::Arc<VaShared>>,
    sink: Option<rodio::Sink>,
    persistent: bool,
    path: String,
    lathe: String,
    playing: bool,
    rate: f32,
    volume: f32,
}

impl VideoDeck {
    fn new() -> Self {
        VideoDeck {
            child: None,
            stdin: None,
            shared: None,
            sink: None,
            persistent: false,
            path: String::new(),
            lathe: String::new(),
            playing: false,
            rate: 1.0,
            volume: 1.0,
        }
    }

    fn stop(&mut self) {
        if let Some(sh) = &self.shared {
            sh.done.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.stdin = None; // closing stdin lets decode-server exit on its own
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(s) = self.sink.take() {
            s.stop();
        }
        self.shared = None;
        self.persistent = false;
    }

    fn send(&mut self, line: &str) -> bool {
        use std::io::Write;
        if let Some(stdin) = &mut self.stdin {
            return stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_ok();
        }
        false
    }

    fn spawn_lathe(&self, args: &[String], with_stdin: bool) -> Option<std::process::Child> {
        let bin = crate::tools::find_tool_binary("lathe", &self.lathe).ok()?;
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(args)
            .stdin(if with_stdin {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().ok()?;
        crate::job_object::assign_child(&child);
        Some(child)
    }

    // Port of va_start_locked: decode-server first, stream-audio raw
    // fallback; parse WAVDESK_APCM, launch the reader + stderr drain,
    // build the sink. False = no audio track (the GUI leaves the video
    // muted on its wall clock).
    fn start(
        &mut self,
        handle: &rodio::OutputStreamHandle,
        path: String,
        start: f64,
        lathe: String,
    ) -> bool {
        self.stop();
        self.path = path.clone();
        self.lathe = lathe;
        let start = start.max(0.0);

        let mut persistent = true;
        let mut child = self.spawn_lathe(
            &["decode-server".into(), path.clone(), "--audio".into(), format!("--start={start}")],
            true,
        );
        let mut apcm = child
            .as_mut()
            .and_then(|c| c.stderr.as_mut())
            .and_then(va_read_apcm);
        if apcm.is_none() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            persistent = false;
            child = self.spawn_lathe(
                &["stream-audio".into(), path.clone(), format!("--start={start}")],
                false,
            );
            apcm = child
                .as_mut()
                .and_then(|c| c.stderr.as_mut())
                .and_then(va_read_apcm);
        }
        let (Some(mut child), Some((sr, ch))) = (child, apcm) else {
            if let Some(mut c) = self.child.take() {
                let _ = c.kill();
            }
            return false;
        };

        let shared = std::sync::Arc::new(VaShared::new(sr, ch, start));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        self.stdin = child.stdin.take();
        self.persistent = persistent;

        // Drain the rest of stderr so lathe never blocks on a full pipe.
        if let Some(mut e) = stderr {
            std::thread::spawn(move || {
                use std::io::Read;
                let mut b = [0u8; 1024];
                while matches!(e.read(&mut b), Ok(n) if n > 0) {}
            });
        }

        if let Some(stdout) = stdout {
            let rs = shared.clone();
            if persistent {
                std::thread::spawn(move || va_reader_chunked(stdout, rs));
            } else {
                std::thread::spawn(move || va_reader_raw(stdout, rs));
            }
        }

        let Ok(sink) = rodio::Sink::try_new(handle) else {
            shared.done.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = child.kill();
            return false;
        };
        sink.append(PcmSource { shared: shared.clone(), local: std::collections::VecDeque::new(), local_gen: 0 });
        sink.set_speed(self.rate);
        sink.set_volume(self.volume);
        if self.playing {
            sink.play();
        } else {
            sink.pause();
        }
        self.sink = Some(sink);
        self.shared = Some(shared);
        self.child = Some(child);
        true
    }

    // Port of va_seek: stage the direction and bump pending FIRST so the
    // reader discards stale chunks immediately, then command the decoder
    // (its marker flushes, rebases, and flips the live direction). The
    // raw fallback restarts the pipe (forward-only).
    fn seek(&mut self, handle: &rodio::OutputStreamHandle, t: f64, dir: i32) {
        let d = if dir < 0 { -1 } else { 1 };
        if self.persistent && self.stdin.is_some() {
            if let Some(sh) = &self.shared {
                sh.dir_staged.store(d, std::sync::atomic::Ordering::SeqCst);
                sh.seek_pending.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if let Ok(mut at) = sh.seek_sent_at.lock() {
                    *at = Some(Instant::now());
                }
            }
            #[cfg(debug_assertions)]
            eprintln!("[vaudio {:9.3}] seek op sec={t:.3} dir={d}", va_ts());
            let cmd = format!("{{\"op\":\"seek\",\"sec\":{:.6},\"dir\":{}}}\n", t, d);
            if self.send(&cmd) {
                return;
            }
            if let Some(sh) = &self.shared {
                sh.seek_pending.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        if self.path.is_empty() {
            return;
        }
        let (p, l) = (self.path.clone(), self.lathe.clone());
        self.start(handle, p, t.max(0.0), l);
    }
}

// Persistent-path reader: port of va_reader_chunked.
fn va_reader_chunked(mut stdout: std::process::ChildStdout, shared: std::sync::Arc<VaShared>) {
    use std::io::Read;
    let ch = shared.ch.max(1) as usize;
    let q_cap = shared.sr as usize * ch * VA_Q_CAP_SEC;
    let mut payload: Vec<u8> = Vec::new();
    let mut rebase = true; // adopt the next data chunk's pts as the base
    let mut read_exact = |dst: &mut [u8]| -> bool {
        let mut off = 0;
        while off < dst.len() {
            match stdout.read(&mut dst[off..]) {
                Ok(0) | Err(_) => return false,
                Ok(n) => off += n,
            }
        }
        true
    };
    loop {
        if shared.done.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let mut hdr = [0u8; 12];
        if !read_exact(&mut hdr) {
            break;
        }
        let pts_us = u64::from_le_bytes(hdr[0..8].try_into().unwrap());
        let len = u32::from_le_bytes(hdr[8..12].try_into().unwrap());
        let pts = pts_us as f64 / 1e6;
        if len == 0 {
            // Seek marker.
            #[cfg(debug_assertions)]
            eprintln!("[vaudio {:9.3}] seek marker pts={pts:.3}", va_ts());
            shared.flush_and_rebase(pts);
            rebase = true;
            let _ = shared.seek_pending.fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |p| if p > 0 { Some(p - 1) } else { None },
            );
            continue;
        }
        if len == 0xFFFF_FFFF {
            // Wrap marker (gapless loop): pure continuity — nothing
            // flushes; rebase applies when playback consumes past here.
            if let Ok(mut p) = shared.pos.lock() {
                let fw = p.frames_written;
                #[cfg(debug_assertions)]
                eprintln!("[vaudio {:9.3}] wrap marker queued at fw={fw} -> base={pts:.3}", va_ts());
                p.wraps.push_back((fw, pts));
            }
            continue;
        }
        if len > (1 << 22) {
            break; // protocol desync — bail, silence beats noise
        }
        payload.resize(len as usize, 0);
        if !read_exact(&mut payload) {
            break;
        }
        // Chunks ahead of an in-flight seek's marker are stale — discard.
        if shared.seek_pending.load(std::sync::atomic::Ordering::Relaxed) > 0 {
            continue;
        }
        if rebase {
            shared.flush_and_rebase(pts);
            rebase = false;
        }
        let samples: Vec<f32> = payload
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let mut off = 0;
        while off < samples.len() {
            if shared.done.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            if shared.seek_pending.load(std::sync::atomic::Ordering::Relaxed) > 0 {
                break; // chunk just went stale
            }
            let pushed = {
                let mut q = match shared.q.lock() {
                    Ok(q) => q,
                    Err(_) => return,
                };
                let room = q_cap.saturating_sub(q.len());
                let n = room.min(samples.len() - off);
                q.extend(samples[off..off + n].iter().copied());
                n
            };
            if pushed > 0 {
                if let Ok(mut p) = shared.pos.lock() {
                    p.frames_written += (pushed / ch) as u64;
                }
                off += pushed;
            } else {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    shared.done.store(true, std::sync::atomic::Ordering::SeqCst);
}

// Fallback reader: raw forward-only PCM, backpressure throttles ffmpeg.
fn va_reader_raw(mut stdout: std::process::ChildStdout, shared: std::sync::Arc<VaShared>) {
    use std::io::Read;
    let ch = shared.ch.max(1) as usize;
    let q_cap = shared.sr as usize * ch * VA_Q_CAP_SEC;
    let mut buf = [0u8; 32768];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        if shared.done.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let n = match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let usable = carry.len() / 4 * 4;
        let samples: Vec<f32> = carry[..usable]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        carry.drain(..usable);
        let mut off = 0;
        while off < samples.len() {
            if shared.done.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            let pushed = {
                let mut q = match shared.q.lock() {
                    Ok(q) => q,
                    Err(_) => return,
                };
                let room = q_cap.saturating_sub(q.len());
                let n = room.min(samples.len() - off);
                q.extend(samples[off..off + n].iter().copied());
                n
            };
            if pushed > 0 {
                if let Ok(mut p) = shared.pos.lock() {
                    p.frames_written += (pushed / ch) as u64;
                }
                off += pushed;
            } else {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    shared.done.store(true, std::sync::atomic::Ordering::SeqCst);
}


fn open_sink(
    handle: &rodio::OutputStreamHandle,
    path: &str,
    start_sec: f64,
) -> Result<rodio::Sink, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let decoder = rodio::Decoder::new(std::io::BufReader::new(file))
        .map_err(|e| format!("decode {path}: {e}"))?;
    let sink = rodio::Sink::try_new(handle).map_err(|e| format!("sink: {e}"))?;
    sink.append(decoder);
    if start_sec > 0.0 {
        let _ = sink.try_seek(Duration::from_secs_f64(start_sec.max(0.0)));
    }
    sink.play();
    Ok(sink)
}

fn audio_thread(app: AppHandle, rx: Receiver<Cmd>) {
    // The stream must outlive every sink — owned here for the thread's life.
    let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
        // No output device: report once; commands drain into the void.
        let _ = app.emit_to("chop", "audio-pos", serde_json::json!({
            "path": "", "posSec": 0.0, "state": "error",
            "message": "no audio output device",
        }));
        for _ in rx { /* drain forever */ }
        return;
    };

    let mut st = EngineState { sink: None, path: String::new(), looping: None };
    let mut vd = VideoDeck::new();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_vemit = Instant::now() - Duration::from_secs(1);

    let emit_vstate = |app: &AppHandle, active: bool| {
        let _ = app.emit("audio_event", serde_json::json!({
            "event": "vaudio_state",
            "active": active,
        }));
    };

    loop {
        // Drive commands with a short poll so the loop check stays tight.
        match rx.recv_timeout(Duration::from_millis(4)) {
            Ok(cmd) => match cmd {
                Cmd::Play { path, start_sec } => {
                    if let Some(s) = st.sink.take() { s.stop(); }
                    st.looping = None;
                    match open_sink(&handle, &path, start_sec) {
                        Ok(sink) => {
                            st.sink = Some(sink);
                            st.path = path;
                        }
                        Err(e) => {
                            st.path = String::new();
                            let _ = app.emit_to("chop", "audio-pos", serde_json::json!({
                                "path": path, "posSec": 0.0, "state": "error", "message": e,
                            }));
                        }
                    }
                }
                Cmd::Pause => { if let Some(s) = &st.sink { s.pause(); } }
                Cmd::Resume => { if let Some(s) = &st.sink { s.play(); } }
                Cmd::Stop => {
                    if let Some(s) = st.sink.take() { s.stop(); }
                    st.looping = None;
                }
                Cmd::Seek(sec) => {
                    if let Some(s) = &st.sink {
                        let _ = s.try_seek(Duration::from_secs_f64(sec.max(0.0)));
                    }
                }
                Cmd::SetLoop { start_sec, end_sec } => {
                    if end_sec > start_sec { st.looping = Some((start_sec, end_sec)); }
                }
                Cmd::ClearLoop => { st.looping = None; }
                Cmd::VStart { path, start_sec, lathe } => {
                    #[cfg(debug_assertions)]
                    eprintln!("[vaudio {:9.3}] START start={start_sec:.3}", va_ts());
                    vd.playing = true;
                    // Per-stream volume/rate reset at begin — mirrors the
                    // daemon contract (the engine re-applies its own).
                    vd.rate = 1.0;
                    vd.volume = 1.0;
                    if !vd.start(&handle, path, start_sec, lathe) {
                        // No audio track / lathe unresolvable → wall-clock
                        // muted video.
                        emit_vstate(&app, false);
                    }
                }
                Cmd::VPause => {
                    vd.playing = false;
                    if let Some(s) = &vd.sink { s.pause(); }
                    // Stop the decoder too so it doesn't decode into a
                    // backpressured pipe all pause long (daemon parity).
                    if vd.persistent { let _ = vd.send("{\"op\":\"pause\"}\n"); }
                }
                Cmd::VResume => {
                    vd.playing = true;
                    if let Some(s) = &vd.sink { s.play(); }
                    if vd.persistent { let _ = vd.send("{\"op\":\"play\"}\n"); }
                }
                Cmd::VStop => {
                    vd.stop();
                    vd.path = String::new();
                }
                Cmd::VSeek { sec, dir } => {
                    // The decoder owns BOTH directions: dir=-1 streams
                    // reverse-ordered PCM (true reverse audio) and the
                    // position slope flips at the seek marker.
                    vd.seek(&handle, sec, dir);
                }
                Cmd::VSetVolume(v) => {
                    vd.volume = v.clamp(0.0, 1.0);
                    if let Some(s) = &vd.sink { s.set_volume(vd.volume); }
                }
                Cmd::VSetRate(r) => {
                    vd.rate = r.clamp(0.25, 4.0);
                    if let Some(s) = &vd.sink { s.set_speed(vd.rate); }
                }
                Cmd::VSetLoop { in_sec, out_sec } => {
                    // The DECODER owns the loop: it wraps gaplessly and
                    // separates cycles with wrap markers (out <= in
                    // clears). DO NOT touch the queued wrap rebases here:
                    // the decoder runs AHEAD of playback, so a pending
                    // rebase is normal — clearing it on a re-arm (resize
                    // effect, activation, engine reconnect) orphans the
                    // already-wrapped PCM and the position sails straight
                    // past the region. The daemon clears wraps ONLY at
                    // seek-marker flushes; so do we.
                    #[cfg(debug_assertions)]
                    eprintln!("[vaudio {:9.3}] loop op in={in_sec:.3} out={out_sec:.3}", va_ts());
                    let cmd = format!(
                        "{{\"op\":\"loop\",\"in\":{:.6},\"out\":{:.6}}}\n",
                        in_sec, out_sec,
                    );
                    let _ = vd.send(&cmd);
                }
            },
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }

        // Loop check + position broadcast.
        let mut state = "stopped";
        let mut pos = 0.0f64;
        if let Some(sink) = &st.sink {
            if sink.empty() {
                st.sink = None;
                st.looping = None;
            } else {
                pos = sink.get_pos().as_secs_f64();
                state = if sink.is_paused() { "paused" } else { "playing" };
                if state == "playing" {
                    if let Some((lo, hi)) = st.looping {
                        if pos >= hi {
                            let _ = sink.try_seek(Duration::from_secs_f64(lo.max(0.0)));
                            pos = lo;
                        }
                    }
                }
            }
        }
        if last_emit.elapsed() >= Duration::from_millis(33) {
            last_emit = Instant::now();
            let _ = app.emit_to("chop", "audio-pos", serde_json::json!({
                "path": st.path,
                "posSec": pos,
                "state": state,
            }));
        }

        // Video deck: vaudio_pos broadcast (~30 Hz, daemon cadence). The
        // deck has NO loop logic — the decoder wraps itself and position
        // rebases ride the wrap markers (va_position port). Emission
        // pauses while a seek is in flight (the cursor still reflects
        // the OLD location — emitting would yank the GUI clock back). A
        // drained stream goes inactive so the video clock owns the tail.
        let mut v_drained = false;
        if let (Some(shared), Some(sink)) = (&vd.shared, &vd.sink) {
            let done = shared.done.load(std::sync::atomic::Ordering::Relaxed);
            if done && sink.empty() {
                v_drained = true;
            } else if shared.seek_pending.load(std::sync::atomic::Ordering::Relaxed) > 0 {
                // Lost-marker watchdog: a real seek turns its marker
                // around in well under a second; past 1.5s assume the
                // marker is gone and reopen position emission (the next
                // event re-anchors the engine clock). Without this, one
                // lost marker mutes positions for the whole session.
                let stale = shared
                    .seek_sent_at
                    .lock()
                    .ok()
                    .and_then(|at| *at)
                    .map(|t| t.elapsed() > Duration::from_millis(1500))
                    .unwrap_or(false);
                if stale {
                    eprintln!("[vaudio] WATCHDOG: seek marker lost - force-clearing the emission gate");
                    shared.seek_pending.store(0, std::sync::atomic::Ordering::SeqCst);
                    if let Ok(mut at) = shared.seek_sent_at.lock() {
                        *at = None;
                    }
                }
            } else if last_vemit.elapsed() >= Duration::from_millis(33) {
                last_vemit = Instant::now();
                let _ = app.emit("audio_event", serde_json::json!({
                    "event": "vaudio_pos",
                    "sec": (shared.position() - VA_OUTPUT_LATENCY_SEC).max(0.0),
                }));
            }
        }
        if v_drained {
            vd.stop();
            emit_vstate(&app, false);
        }
    }
}

// ── vaudio command surface ─────────────────────────────────────────────
// Names + parameter shapes match WAVdesk's daemon bridge exactly, so the
// ported nativeVideoStream.ts invokes them verbatim. `lathe` seeds the
// decode-server resolution (the daemon used it the same way; this
// deck decodes the file's own audio track via symphonia).

/// Stop BOTH decks (audition WAV + video audio with its decode-server
/// child). Called from the chop window's Destroyed hook so closing the
/// window can never leave audio playing.
pub fn stop_everything(app: &AppHandle) {
    let tx = ensure_thread(app);
    let _ = tx.send(Cmd::Stop);
    let _ = tx.send(Cmd::VStop);
}

#[tauri::command]
pub fn start_video_audio(
    app: AppHandle,
    path: String,
    start: f64,
    lathe: String,
) -> Result<(), String> {
    let tx = ensure_thread(&app);
    tx.send(Cmd::VStart { path, start_sec: start, lathe })
        .map_err(|e| format!("audio thread gone: {e}"))
}

#[tauri::command]
pub fn pause_video_audio(app: AppHandle) -> Result<(), String> {
    ensure_thread(&app).send(Cmd::VPause).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resume_video_audio(app: AppHandle) -> Result<(), String> {
    ensure_thread(&app).send(Cmd::VResume).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_video_audio(app: AppHandle) -> Result<(), String> {
    ensure_thread(&app).send(Cmd::VStop).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn seek_video_audio(app: AppHandle, sec: f64, dir: Option<i32>) -> Result<(), String> {
    ensure_thread(&app)
        .send(Cmd::VSeek { sec, dir: dir.unwrap_or(1) })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_video_audio_volume(app: AppHandle, vol: f64) -> Result<(), String> {
    ensure_thread(&app)
        .send(Cmd::VSetVolume(vol as f32))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_video_audio_rate(app: AppHandle, rate: f64) -> Result<(), String> {
    ensure_thread(&app)
        .send(Cmd::VSetRate(rate as f32))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_video_audio_loop(app: AppHandle, in_sec: f64, out_sec: f64) -> Result<(), String> {
    ensure_thread(&app)
        .send(Cmd::VSetLoop { in_sec, out_sec })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn audio_cmd(
    app: AppHandle,
    action: String,
    path: Option<String>,
    sec: Option<f64>,
    end_sec: Option<f64>,
) -> Result<(), String> {
    let tx = ensure_thread(&app);
    let cmd = match action.as_str() {
        "play" => Cmd::Play {
            path: path.ok_or("play needs path")?,
            start_sec: sec.unwrap_or(0.0),
        },
        "pause" => Cmd::Pause,
        "resume" => Cmd::Resume,
        "stop" => Cmd::Stop,
        "seek" => Cmd::Seek(sec.ok_or("seek needs sec")?),
        "set-loop" => Cmd::SetLoop {
            start_sec: sec.ok_or("set-loop needs sec")?,
            end_sec: end_sec.ok_or("set-loop needs endSec")?,
        },
        "clear-loop" => Cmd::ClearLoop,
        other => return Err(format!("unknown audio action: {other}")),
    };
    tx.send(cmd).map_err(|e| format!("audio thread gone: {e}"))
}
