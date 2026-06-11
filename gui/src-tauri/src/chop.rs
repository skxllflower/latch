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
#[tauri::command]
pub fn latch_chop_alloc_dir(_window_label: String) -> Result<String, String> {
    let n = CHOP_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = chop_root().join(format!("{}-{}", std::process::id(), n));
    std::fs::create_dir_all(&dir).map_err(|e| format!("alloc chop dir: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Remove a chop session's temp dir. Only ever pointed at paths
/// latch_chop_alloc_dir produced — guard on the marker root so a bad
/// argument can never delete outside it.
#[tauri::command]
pub fn latch_chop_cleanup_dir(dir: String) -> Result<(), String> {
    let p = PathBuf::from(&dir);
    if !p.starts_with(chop_root()) {
        return Err("refusing to remove a dir outside the chop temp root".into());
    }
    let _ = std::fs::remove_dir_all(&p);
    Ok(())
}

/// Persistent clips folder (Documents\Latch Clips) — exported + rendered
/// clips land here so DAW references survive the temp-dir sweep.
#[tauri::command]
pub fn latch_clips_dir() -> Result<String, String> {
    let docs = std::env::var_os("USERPROFILE")
        .map(|h| PathBuf::from(h).join("Documents"))
        .ok_or_else(|| "no home directory".to_string())?;
    let dir = docs.join("Latch Clips");
    std::fs::create_dir_all(&dir).map_err(|e| format!("clips dir: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

// Pick a non-colliding output path: "<stem> (2).<ext>", … on collision.
fn unique_output(output: &str) -> String {
    let p = std::path::Path::new(output);
    if !p.exists() {
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
        if !cand.exists() {
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
    if video {
        args.push("--video".to_string());
    } else if preview.unwrap_or(false) {
        // Display-only companion track: tiny mono low-rate WAV.
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
