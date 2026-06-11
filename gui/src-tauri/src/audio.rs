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
    // Video deck — the audio half of the native video engine. Speaks the
    // same `vaudio_pos` / `vaudio_state` event contract WAVdesk's audio
    // daemon does, so the ported nativeVideoStream sync code (and its
    // tuned constants) runs unchanged. Audio comes from `lathe
    // stream-audio` (ffmpeg-decoded f32le 48k stereo PCM on stdout) —
    // rodio's own decoder can't be trusted on video containers (it grabs
    // the DEFAULT track, which in an mp4 is the video track → silence).
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
const VA_SR: u32 = 48_000;
const VA_CH: u16 = 2;
// Ring cap ~4s of PCM. When full the reader sleeps, the pipe fills,
// ffmpeg blocks — decode paces itself and a paused deck stops pulling
// without unbounded growth.
const VA_RING_CAP: usize = (VA_SR as usize) * (VA_CH as usize) * 4;

// Samples are counted when PULLED into the device pipeline, which runs
// a couple hundred ms ahead of what's audible — report position minus
// this estimate so the video lands on the HEARD audio. Ear-tunable:
// raise if audio still trails the picture, lower if it leads.
const VA_OUTPUT_LATENCY_SEC: f64 = 0.15;

struct VaShared {
    ring: std::sync::Mutex<std::collections::VecDeque<f32>>,
    done: std::sync::atomic::AtomicBool,
    consumed: std::sync::atomic::AtomicU64, // samples handed to the audio callback
}

// rodio Source pulling from the shared ring. Underrun plays silence
// WITHOUT counting it (position stalls rather than drifting ahead of
// real audio); done+empty ends the source (sink drains → deck reports
// vaudio inactive, the video clock owns the tail).
struct PcmSource {
    shared: std::sync::Arc<VaShared>,
}

impl Iterator for PcmSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        // try_lock: never stall the device callback on the reader thread.
        if let Ok(mut ring) = self.shared.ring.try_lock() {
            if let Some(s) = ring.pop_front() {
                self.shared.consumed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Some(s);
            }
        }
        if self.shared.done.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        Some(0.0) // underrun — keep the sink alive, position holds
    }
}

impl rodio::Source for PcmSource {
    fn current_frame_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { VA_CH }
    fn sample_rate(&self) -> u32 { VA_SR }
    fn total_duration(&self) -> Option<Duration> { None }
}

// One live stream-audio child + its sink. Dropped wholesale on
// stop/seek/reverse (seek = respawn at --start, which is also how the
// region-loop wraps — a respawn-latency seam, not sample-gapless).
struct VaStream {
    child: std::process::Child,
    shared: std::sync::Arc<VaShared>,
    sink: rodio::Sink,
    start_sec: f64,
}

impl VaStream {
    fn position(&self) -> f64 {
        let consumed = self.shared.consumed.load(std::sync::atomic::Ordering::Relaxed);
        self.start_sec + (consumed as f64) / (VA_SR as f64 * VA_CH as f64)
    }
    fn kill(mut self) {
        self.shared.done.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.sink.stop();
    }
}

// The video deck. `playing` mirrors the GUI's intent across stream
// rebuilds (a reverse engage tears the stream down; returning forward
// rebuilds it in the same play/pause state). dir=-1 = TRUE-reverse video
// upstream; this deck can't run backward, so it goes inactive (the
// engine reports vaudio_state{active:false} and the video falls to its
// wall clock — reverse plays muted).
struct VideoDeck {
    stream: Option<VaStream>,
    path: String,
    lathe: String,
    playing: bool,
    rate: f32,
    volume: f32,
    looping: Option<(f64, f64)>,
    dir: i32,
}

impl VideoDeck {
    fn new() -> Self {
        VideoDeck {
            stream: None,
            path: String::new(),
            lathe: String::new(),
            playing: false,
            rate: 1.0,
            volume: 1.0,
            looping: None,
            dir: 1,
        }
    }

    fn drop_stream(&mut self) {
        if let Some(s) = self.stream.take() {
            s.kill();
        }
    }

    // (Re)spawn `lathe stream-audio --start=<at>` and a sink over its
    // PCM, applying the deck's rate/volume/play-state. False when lathe
    // is unresolvable or won't spawn (no audio → the child just EOFs
    // fast, which reads as a drained sink → vaudio inactive).
    fn rebuild(&mut self, handle: &rodio::OutputStreamHandle, at_sec: f64) -> bool {
        self.drop_stream();
        let Ok(bin) = crate::tools::find_tool_binary("lathe", &self.lathe) else {
            return false;
        };
        let mut cmd = std::process::Command::new(&bin);
        cmd.args([
            "stream-audio",
            &self.path,
            &format!("--start={}", at_sec.max(0.0)),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let Ok(mut child) = cmd.spawn() else { return false };
        crate::job_object::assign_child(&child);
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return false;
        };

        let shared = std::sync::Arc::new(VaShared {
            ring: std::sync::Mutex::new(std::collections::VecDeque::with_capacity(VA_RING_CAP)),
            done: std::sync::atomic::AtomicBool::new(false),
            consumed: std::sync::atomic::AtomicU64::new(0),
        });
        let reader_shared = shared.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdout = stdout;
            let mut buf = [0u8; 32768];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                if reader_shared.done.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                // Backpressure: nap while the ring is full (paused deck).
                {
                    let full = reader_shared
                        .ring
                        .lock()
                        .map(|r| r.len() >= VA_RING_CAP)
                        .unwrap_or(false);
                    if full {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                }
                let n = match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        reader_shared.done.store(true, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                    Ok(n) => n,
                };
                carry.extend_from_slice(&buf[..n]);
                let floats = carry.len() / 4;
                if floats > 0 {
                    if let Ok(mut ring) = reader_shared.ring.lock() {
                        for i in 0..floats {
                            let o = i * 4;
                            ring.push_back(f32::from_le_bytes([
                                carry[o], carry[o + 1], carry[o + 2], carry[o + 3],
                            ]));
                        }
                    }
                    carry.drain(..floats * 4);
                }
            }
        });

        let Ok(sink) = rodio::Sink::try_new(handle) else {
            shared.done.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = child.kill();
            return false;
        };
        sink.append(PcmSource { shared: shared.clone() });
        sink.set_speed(self.rate);
        sink.set_volume(self.volume);
        if self.playing {
            sink.play();
        } else {
            sink.pause();
        }
        self.stream = Some(VaStream { child, shared, sink, start_sec: at_sec.max(0.0) });
        true
    }
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
                    vd.path = path;
                    vd.lathe = lathe;
                    vd.playing = true;
                    vd.dir = 1;
                    // Per-stream volume/rate reset at begin — mirrors the
                    // daemon contract (the engine re-applies its own).
                    vd.rate = 1.0;
                    vd.volume = 1.0;
                    vd.looping = None;
                    if !vd.rebuild(&handle, start_sec) {
                        // lathe unresolvable → wall-clock muted video.
                        vd.path = String::new();
                        emit_vstate(&app, false);
                    }
                }
                Cmd::VPause => {
                    vd.playing = false;
                    if let Some(s) = &vd.stream { s.sink.pause(); }
                }
                Cmd::VResume => {
                    vd.playing = true;
                    if let Some(s) = &vd.stream { s.sink.play(); }
                }
                Cmd::VStop => {
                    vd.drop_stream();
                    vd.path = String::new();
                    vd.looping = None;
                }
                Cmd::VSeek { sec, dir } => {
                    vd.dir = dir;
                    if dir < 0 {
                        // TRUE-reverse upstream: this deck can't run
                        // backward — go inactive so the video wall-clocks
                        // it (reverse plays muted), resume on the next
                        // dir=1 seek.
                        vd.drop_stream();
                        emit_vstate(&app, false);
                    } else if !vd.path.is_empty() {
                        // Seek = respawn the PCM stream at --start=sec.
                        if !vd.rebuild(&handle, sec) {
                            emit_vstate(&app, false);
                        }
                    }
                }
                Cmd::VSetVolume(v) => {
                    vd.volume = v.clamp(0.0, 1.0);
                    if let Some(s) = &vd.stream { s.sink.set_volume(vd.volume); }
                }
                Cmd::VSetRate(r) => {
                    vd.rate = r.clamp(0.25, 4.0);
                    if let Some(s) = &vd.stream { s.sink.set_speed(vd.rate); }
                }
                Cmd::VSetLoop { in_sec, out_sec } => {
                    vd.looping = if out_sec > in_sec { Some((in_sec, out_sec)) } else { None };
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

        // Video deck: loop wrap + vaudio_pos broadcast. Position derives
        // from samples consumed (so it tracks set_speed automatically);
        // cadence mirrors the daemon's (~30 Hz). A drained stream (PCM
        // EOF + ring empty) goes inactive so the video clock owns the
        // tail.
        let mut v_drained = false;
        let mut v_wrap_to: Option<f64> = None;
        if let Some(stream) = &vd.stream {
            let done = stream.shared.done.load(std::sync::atomic::Ordering::Relaxed);
            let empty = stream
                .shared
                .ring
                .lock()
                .map(|r| r.is_empty())
                .unwrap_or(false);
            if done && empty {
                v_drained = true;
            } else {
                let raw = stream.position();
                let vpos = (raw - VA_OUTPUT_LATENCY_SEC).max(stream.start_sec);
                // Loop wraps on the RAW (pulled) position — the compensated
                // one would let 150ms past the out-point reach the speakers.
                if vd.playing {
                    if let Some((lo, hi)) = vd.looping {
                        if raw >= hi {
                            v_wrap_to = Some(lo);
                        }
                    }
                }
                if v_wrap_to.is_none() && last_vemit.elapsed() >= Duration::from_millis(33) {
                    last_vemit = Instant::now();
                    let _ = app.emit("audio_event", serde_json::json!({
                        "event": "vaudio_pos",
                        "sec": vpos,
                    }));
                }
            }
        }
        if v_drained {
            vd.drop_stream();
            emit_vstate(&app, false);
        } else if let Some(lo) = v_wrap_to {
            if !vd.rebuild(&handle, lo) {
                emit_vstate(&app, false);
            }
        }
    }
}

// ── vaudio command surface ─────────────────────────────────────────────
// Names + parameter shapes match WAVdesk's daemon bridge exactly, so the
// ported nativeVideoStream.ts invokes them verbatim. `lathe` is accepted
// for parity and ignored (the daemon used it for its decode path; this
// deck decodes the file's own audio track via symphonia).

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
