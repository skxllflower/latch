// Chop-window plumbing: temp working dirs, the persistent clips folder,
// and `latch clip` invocation. Forked from WAVdesk's latch_chop.rs +
// latch_clip — events stream on `latch-event` like every other job, so
// latch_cancel aborts a clip too.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

static CHOP_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

fn chop_root() -> PathBuf {
    std::env::temp_dir().join("latch-chop")
}

/// Fresh temp working dir for one chop session. Swept by cleanup on
/// window close; the pid in the name keeps two instances apart.
///
/// Tauri v2 runs non-async commands INLINE on the main (UI) thread, so the
/// dir creation / removal / clips-dir resolution in these three commands all
/// hop to a blocking pool thread — a cold-disk mkdir or a big-session
/// remove_dir_all would otherwise stall the window. Frontend contract
/// unchanged (invoke already awaits a Promise).
#[tauri::command]
pub async fn latch_chop_alloc_dir(_window_label: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let n = CHOP_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = chop_root().join(format!("{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).map_err(|e| format!("alloc chop dir: {e}"))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("alloc chop dir join: {e}"))?
}

/// Remove a chop session's temp dir. Only ever pointed at paths
/// latch_chop_alloc_dir produced — guard on the marker root so a bad
/// argument can never delete outside it.
#[tauri::command]
pub async fn latch_chop_cleanup_dir(dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&dir);
        if !p.starts_with(chop_root()) {
            return Err("refusing to remove a dir outside the chop temp root".into());
        }
        let _ = std::fs::remove_dir_all(&p);
        Ok(())
    })
    .await
    .map_err(|e| format!("cleanup chop dir join: {e}"))?
}

/// Remove the whole chop temp root — app-exit cleanup so cancelled
/// sessions never strand downloads in %TEMP%.
pub fn sweep_temp_root() {
    let _ = std::fs::remove_dir_all(chop_root());
}

/// Existence probe for a pre-rendered clip path — lets the drag-out path
/// trust (and reuse) a settle-time pre-render instead of re-rendering
/// under the held gesture. Async: a cold-disk stat would stall the UI.
#[tauri::command]
pub async fn clip_path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || std::path::Path::new(&path).is_file())
        .await
        .unwrap_or(false)
}

/// Persistent clips folder (Documents\Vacant Systems\Latch Clips) —
/// exported + rendered clips land here so DAW references survive the
/// temp-dir sweep. One vendor folder for the whole ecosystem (a
/// Latch-only user shouldn't get a WAVdesk-branded folder). Resolved
/// through the OS known-folder API (NOT %USERPROFILE%\Documents string
/// math) so OneDrive-redirected Documents folders land correctly.
#[tauri::command]
pub async fn latch_clips_dir(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        // A configured clips folder (Settings) wins; empty falls back to the
        // Documents default below. settings::load() + create_dir_all are disk
        // touches, so the whole resolution runs off the UI thread.
        let configured = crate::settings::load().clips_dir;
        let dir = if !configured.trim().is_empty() {
            PathBuf::from(configured.trim())
        } else {
            let docs = app
                .path()
                .document_dir()
                .map_err(|e| format!("no Documents dir: {e}"))?;
            docs.join("Vacant Systems").join("Latch Clips")
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("clips dir: {e}"))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("clips dir join: {e}"))?
}

// Pick a non-colliding output path: "<stem> (2).<ext>", … on collision, and
// ATOMICALLY reserve it. create_new succeeds only if the file doesn't already
// exist, so two processes racing the same name (e.g. standalone Latch + the
// in-WAVdesk chop, both writing to Documents/Latch Clips) can't both pick it —
// the loser's create_new fails and it moves to the next candidate. The clip
// render (ffmpeg -y) overwrites this empty reservation. Plain existence checks
// raced: both apps saw "doesn't exist" before either wrote, then clobbered.
fn unique_output(output: &str) -> String {
    let reserve = |path: &std::path::Path| -> bool {
        std::fs::OpenOptions::new().write(true).create_new(true).open(path).is_ok()
    };
    let p = std::path::Path::new(output);
    if reserve(p) {
        return output.to_string();
    }
    let dir = p.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for n in 2..=9999u32 {
        let cand = dir.join(format!("{stem} ({n}){ext}"));
        if reserve(&cand) {
            return cand.to_string_lossy().into_owned();
        }
    }
    output.to_string()
}

/// Cut [start_sec, end_sec) out of a LOCAL file into `output` via the
/// wrapper's `clip` subcommand. Re-encodes for an exact cut. `overwrite`
/// defaults false (no-clobber sibling); the chop window passes true for
/// its own temp renders.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn latch_clip(
    app: AppHandle,
    window_label: String,
    job_id: String,
    binary_path: String,
    input: String,
    output: String,
    start_sec: f64,
    end_sec: f64,
    video: bool,
    audio_format: String,
    overwrite: Option<bool>,
    preview: Option<bool>,
    speed: Option<f64>,
    pitch_mode: Option<String>,
) -> Result<(), String> {
    let bin = crate::tools::find_tool_binary("latch", &binary_path)?;
    let output = if overwrite.unwrap_or(false) {
        output
    } else {
        unique_output(&output)
    };
    let mut args = vec![
        "clip".to_string(),
        input,
        output,
        format!("--start={}", start_sec),
        format!("--end={}", end_sec),
    ];
    // Speed multiplier: only pass when it actually changes playback. Never
    // for the preview WAV (the waveform source must stay 1x).
    let speed = speed.unwrap_or(1.0);
    if !preview.unwrap_or(false) && (speed - 1.0).abs() > 1e-6 {
        args.push(format!("--speed={}", speed));
        // Pitch behavior at speed != 1: "tape" (pitch follows speed) or
        // "preserve" (keep pitch, the default). Parsed before latch's
        // unknown-arg reject.
        args.push(format!("--pitch-mode={}", pitch_mode.as_deref().unwrap_or("preserve")));
    }
    if video {
        args.push("--video".to_string());
    } else if preview.unwrap_or(false) {
        // Display-only companion track: small low-rate stereo WAV.
        args.push("--audio-only".to_string());
        args.push("--preview".to_string());
    } else {
        args.push("--audio-only".to_string());
        if !audio_format.trim().is_empty() {
            args.push(format!("--audio-format={}", audio_format.trim()));
        }
    }
    let (child, stdout) = crate::tools::spawn_tool(bin, args)?;
    let child_arc = Arc::new(Mutex::new(child));
    crate::tools::register_job(job_id.clone(), child_arc.clone());
    crate::tools::run_reader("latch", job_id, window_label, app, stdout, child_arc);
    Ok(())
}
