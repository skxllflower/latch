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
    // tuned constants) runs unchanged. rodio + symphonia decode the
    // video file's own audio track (the chop pipeline always lands mp4).
    VStart { path: String, start_sec: f64 },
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

// The video deck. `playing` mirrors the GUI's intent across sink rebuilds
// (a reverse engage tears the sink down; returning forward rebuilds it in
// the same play/pause state). dir=-1 = TRUE-reverse video upstream; audio
// can't run backward through rodio, so the deck goes inactive (the engine
// reports vaudio_state{active:false} and the video falls to its wall
// clock — reverse plays muted).
struct VideoDeck {
    sink: Option<rodio::Sink>,
    path: String,
    playing: bool,
    rate: f32,
    volume: f32,
    looping: Option<(f64, f64)>,
    dir: i32,
}

impl VideoDeck {
    fn new() -> Self {
        VideoDeck {
            sink: None,
            path: String::new(),
            playing: false,
            rate: 1.0,
            volume: 1.0,
            looping: None,
            dir: 1,
        }
    }

    fn drop_sink(&mut self) {
        if let Some(s) = self.sink.take() {
            s.stop();
        }
    }

    // (Re)build the sink at `at_sec`, applying the deck's rate/volume/
    // play-state. Returns false when the file has no decodable audio.
    fn rebuild(&mut self, handle: &rodio::OutputStreamHandle, at_sec: f64) -> bool {
        self.drop_sink();
        let Ok(file) = std::fs::File::open(&self.path) else { return false };
        let Ok(decoder) = rodio::Decoder::new(std::io::BufReader::new(file)) else {
            return false;
        };
        let Ok(sink) = rodio::Sink::try_new(handle) else { return false };
        sink.append(decoder);
        if at_sec > 0.0 {
            let _ = sink.try_seek(Duration::from_secs_f64(at_sec.max(0.0)));
        }
        sink.set_speed(self.rate);
        sink.set_volume(self.volume);
        if self.playing {
            sink.play();
        } else {
            sink.pause();
        }
        self.sink = Some(sink);
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
                Cmd::VStart { path, start_sec } => {
                    vd.path = path;
                    vd.playing = true;
                    vd.dir = 1;
                    // Per-stream volume/rate reset at begin — mirrors the
                    // daemon contract (the engine re-applies its own).
                    vd.rate = 1.0;
                    vd.volume = 1.0;
                    vd.looping = None;
                    if !vd.rebuild(&handle, start_sec) {
                        // No decodable audio track → wall-clock muted video.
                        vd.drop_sink();
                        vd.path = String::new();
                        emit_vstate(&app, false);
                    }
                }
                Cmd::VPause => {
                    vd.playing = false;
                    if let Some(s) = &vd.sink { s.pause(); }
                }
                Cmd::VResume => {
                    vd.playing = true;
                    if let Some(s) = &vd.sink { s.play(); }
                }
                Cmd::VStop => {
                    vd.drop_sink();
                    vd.path = String::new();
                    vd.looping = None;
                }
                Cmd::VSeek { sec, dir } => {
                    vd.dir = dir;
                    if dir < 0 {
                        // TRUE-reverse upstream: audio can't run backward
                        // here — go inactive so the video wall-clocks it
                        // (reverse plays muted), resume on the next dir=1.
                        vd.drop_sink();
                        emit_vstate(&app, false);
                    } else if !vd.path.is_empty() {
                        let mut sought = false;
                        if let Some(s) = &vd.sink {
                            sought = s.try_seek(Duration::from_secs_f64(sec.max(0.0))).is_ok();
                            if sought {
                                if vd.playing { s.play(); } else { s.pause(); }
                            }
                        }
                        if !sought && !vd.rebuild(&handle, sec) {
                            emit_vstate(&app, false);
                        }
                    }
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

        // Video deck: loop wrap + vaudio_pos broadcast. Position events
        // carry the ease anchor the engine clock needs; cadence mirrors
        // the daemon's (~30 Hz). A drained sink (end of audio) goes
        // inactive so the video clock owns the tail.
        if let Some(sink) = &vd.sink {
            if sink.empty() {
                vd.drop_sink();
                emit_vstate(&app, false);
            } else {
                let mut vpos = sink.get_pos().as_secs_f64();
                if vd.playing && !sink.is_paused() {
                    if let Some((lo, hi)) = vd.looping {
                        if vpos >= hi {
                            let _ = sink.try_seek(Duration::from_secs_f64(lo.max(0.0)));
                            vpos = lo;
                        }
                    }
                }
                if last_vemit.elapsed() >= Duration::from_millis(33) {
                    last_vemit = Instant::now();
                    let _ = app.emit("audio_event", serde_json::json!({
                        "event": "vaudio_pos",
                        "sec": vpos,
                    }));
                }
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
    #[allow(unused_variables)] lathe: String,
) -> Result<(), String> {
    let tx = ensure_thread(&app);
    tx.send(Cmd::VStart { path, start_sec: start })
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
