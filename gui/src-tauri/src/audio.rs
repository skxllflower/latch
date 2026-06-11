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
    let mut last_emit = Instant::now() - Duration::from_secs(1);

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
    }
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
