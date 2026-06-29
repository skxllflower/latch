// Latch spawn + stream plumbing — fork of WAVdesk's external_tools.rs
// (the latch half). The two stay behaviorally aligned: NDJSON events on
// `latch-event`, kill-on-close job objects on every spawn. When this
// logic changes in either home, port the change to the other
// (shared-crate promotion is the planned fix for the duplication).

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type JobMap = Mutex<HashMap<String, Arc<Mutex<Child>>>>;

static LATCH_JOBS: OnceLock<JobMap> = OnceLock::new();

fn latch_jobs() -> &'static JobMap {
    LATCH_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Resolution order:
//   1) {NAME}_EXE env override (shell-launched testing)
//   2) sibling dev checkout at %USERPROFILE%\Dev\{name}\build\Debug
//   3) installed locations (exe-relative siblings, then the default
//      vendor spaces — Program Files\Vacant Systems on Windows)
// Release first: a Debug-built decoder can't sustain realtime video
// (decode throughput caps near 1x — shuttle/reverse starve), so when
// both configurations exist the Release build must win.
fn dev_tool_fallbacks(name: &str) -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return Vec::new();
    };
    let base = PathBuf::from(home).join("Dev").join(name).join("build");
    vec![
        base.join("Release").join(format!("{}.exe", name)),
        base.join("Debug").join(format!("{}.exe", name)),
    ]
}

fn tool_dir_name(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// yt-dlp's managed home, matching the C++ core's resolver
// (paths.cpp latch_bin_path): %ProgramData%\Vacant Systems\Latch\bin. The
// installer ACL-grants Users write here so the unelevated GUI can populate it.
#[cfg(target_os = "windows")]
fn latch_bin_dir() -> Option<PathBuf> {
    std::env::var_os("ProgramData")
        .map(|p| PathBuf::from(p).join("Vacant Systems").join("Latch").join("bin"))
        .or_else(|| Some(PathBuf::from(r"C:\ProgramData\Vacant Systems\Latch\bin")))
}

/// Copy the bundled yt-dlp.exe into the core's managed bin dir on launch so a
/// fresh install works fully offline. The C++ core only downloads yt-dlp from
/// GitHub when it's absent, so seeding a non-zero copy here makes that a no-op.
/// Idempotent (never overwrites an existing copy) and best-effort.
#[cfg(target_os = "windows")]
pub fn provision_ytdlp(resource_dir: &std::path::Path) {
    let Some(dest_dir) = latch_bin_dir() else { return };
    let dest = dest_dir.join("yt-dlp.exe");
    if dest.exists() {
        return; // already provisioned / downloaded — don't clobber a newer copy
    }
    let src = resource_dir.join("resources").join("ytdlp").join("yt-dlp.exe");
    if !src.exists() {
        return; // dev run / -SkipYtdlp: no bundle, core downloads at runtime
    }
    if std::fs::create_dir_all(&dest_dir).is_err() {
        return;
    }
    let _ = std::fs::copy(&src, &dest);
}

#[cfg(not(target_os = "windows"))]
pub fn provision_ytdlp(_resource_dir: &std::path::Path) {}

fn installed_tool_fallbacks(name: &str) -> Vec<PathBuf> {
    let exe_name = if cfg!(windows) {
        format!("{}.exe", name)
    } else {
        name.to_string()
    };
    let app_dir = tool_dir_name(name);
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Bundled core: tauri resources install into <install>/coredist/
            // next to the GUI exe (NSIS resource_dir == install root).
            out.push(dir.join("coredist").join(&exe_name));
            // Installed layout: the CLI ships right next to this GUI exe.
            out.push(dir.join(&exe_name));
            if let Some(vendor) = dir.parent() {
                out.push(vendor.join(&app_dir).join(&exe_name));
            }
        }
    }
    #[cfg(windows)]
    {
        let pf = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let vendor = pf.join("Vacant Systems");
        out.push(vendor.join(&app_dir).join(&exe_name));
        out.push(vendor.join(&exe_name));
    }
    #[cfg(target_os = "macos")]
    {
        let vendor = PathBuf::from("/Library/Application Support/Vacant Systems");
        out.push(vendor.join(&app_dir).join(&exe_name));
        if let Some(home) = std::env::var_os("HOME") {
            out.push(
                PathBuf::from(home)
                    .join("Library/Application Support/Vacant Systems")
                    .join(&app_dir)
                    .join(&exe_name),
            );
        }
    }
    out
}

pub(crate) fn find_tool_binary(name: &str, configured: &str) -> Result<PathBuf, String> {
    if !configured.trim().is_empty() {
        let pb = PathBuf::from(configured.trim());
        if pb.exists() {
            return Ok(pb);
        }
        return Err(format!(
            "{}: configured path does not exist: {}",
            name,
            pb.display()
        ));
    }
    let env_var = format!("{}_EXE", name.to_uppercase());
    if let Ok(p) = std::env::var(&env_var) {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    for cand in dev_tool_fallbacks(name) {
        if cand.exists() {
            return Ok(cand);
        }
    }
    for cand in installed_tool_fallbacks(name) {
        if cand.exists() {
            return Ok(cand);
        }
    }
    Err(format!(
        "{}.exe not found. Set {} env, reinstall {}, or build at {}.",
        name,
        env_var,
        tool_dir_name(name),
        format!(r"%USERPROFILE%\Dev\{}\build", name),
    ))
}

/// Resolve this app's own CLI core (latch.exe) for self-registration into the
/// shared discovery manifest. Returns None if it can't be found.
pub(crate) fn resolve_self_core() -> Option<PathBuf> {
    find_tool_binary("latch", "").ok()
}

pub(crate) fn spawn_tool(
    binary: PathBuf,
    args: Vec<String>,
) -> Result<(Child, std::process::ChildStdout), String> {
    let mut cmd = Command::new(&binary);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", binary.display(), e))?;
    crate::job_object::assign_child(&child);
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    Ok((child, stdout))
}

pub(crate) fn register_job(job_id: String, child: Arc<Mutex<Child>>) {
    if let Ok(mut map) = latch_jobs().lock() {
        map.insert(job_id, child);
    }
}

pub(crate) fn run_reader(
    tool: &'static str,
    job_id: String,
    window_label: String,
    app: AppHandle,
    stdout: std::process::ChildStdout,
    child_arc: Arc<Mutex<Child>>,
) {
    let jobs = latch_jobs();
    std::thread::spawn(move || {
        let event_name = format!("{}-event", tool);
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            let payload = match serde_json::from_str::<Value>(&line) {
                Ok(v) => serde_json::json!({
                    "tool": tool,
                    "jobId": job_id,
                    "event": v,
                }),
                Err(_) => serde_json::json!({
                    "tool": tool,
                    "jobId": job_id,
                    "event": { "type": "raw", "line": line },
                }),
            };
            let _ = app.emit_to(window_label.as_str(), event_name.as_str(), payload);
        }

        let exit_code: i32 = {
            let mut guard = child_arc.lock().unwrap();
            match guard.wait() {
                Ok(status) => status.code().unwrap_or(-1),
                Err(_) => -1,
            }
        };

        let final_payload = serde_json::json!({
            "tool": tool,
            "jobId": job_id,
            "event": { "type": "exit", "code": exit_code },
        });
        let _ = app.emit_to(window_label.as_str(), event_name.as_str(), final_payload);

        if let Ok(mut map) = jobs.lock() {
            map.remove(&job_id);
        }
    });
}

#[derive(serde::Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LatchOptions {
    pub audio_format: String,
    pub no_playlist: bool,
    pub audio_quality: String,
    pub embed_metadata: bool,
    pub embed_thumbnail: bool,
    pub write_thumbnail: bool,
    pub crop_thumbnail: bool,
    pub cookies_from_browser: String,
    // yt-dlp --cookies <file>: a Netscape cookies.txt exported from a
    // browser. The escape hatch when --cookies-from-browser can't read a
    // locked/encrypted store. yt-dlp accepts both flags together.
    pub cookies_file: String,
    pub section: String,
    pub video: bool,
    pub video_format: String,
    #[serde(default)]
    pub video_max_height: u32,
    #[serde(default)]
    pub restrict_filenames: bool,
}

#[tauri::command]
pub async fn latch_extract(
    app: AppHandle,
    window_label: String,
    job_id: String,
    binary_path: String,
    url: String,
    output_dir: String,
    options: LatchOptions,
) -> Result<(), String> {
    let bin = find_tool_binary("latch", &binary_path)?;
    let mut args = vec!["extract".to_string(), url, output_dir];
    let fmt = if options.audio_format.is_empty() {
        "mp3".to_string()
    } else {
        options.audio_format.clone()
    };
    args.push(format!("--format={}", fmt));
    if options.no_playlist {
        args.push("--no-playlist".to_string());
    } else {
        args.push("--playlist".to_string());
    }
    if !options.audio_quality.is_empty() {
        args.push(format!("--audio-quality={}", options.audio_quality));
    }
    if options.embed_metadata {
        args.push("--embed-metadata".to_string());
    }
    if options.embed_thumbnail {
        args.push("--embed-thumbnail".to_string());
    }
    if options.write_thumbnail {
        args.push("--write-thumbnail".to_string());
    }
    if options.crop_thumbnail {
        args.push("--crop-thumbnail".to_string());
    }
    if !options.cookies_from_browser.trim().is_empty() {
        args.push(format!(
            "--cookies-from-browser={}",
            options.cookies_from_browser.trim()
        ));
    }
    if !options.cookies_file.trim().is_empty() {
        args.push(format!("--cookies={}", options.cookies_file.trim()));
    }
    if !options.section.trim().is_empty() {
        args.push(format!("--section={}", options.section.trim()));
    }
    if options.restrict_filenames {
        args.push("--restrict-filenames".to_string());
    }
    if options.video {
        args.push("--video".to_string());
        if !options.video_format.trim().is_empty() {
            args.push(format!("--video-format={}", options.video_format.trim()));
        }
        if options.video_max_height > 0 {
            args.push(format!("--video-max-height={}", options.video_max_height));
        }
    }
    let (child, stdout) = spawn_tool(bin, args)?;
    let child_arc = Arc::new(Mutex::new(child));

    if let Ok(mut map) = latch_jobs().lock() {
        map.insert(job_id.clone(), child_arc.clone());
    }

    run_reader("latch", job_id, window_label, app, stdout, child_arc);
    Ok(())
}

#[tauri::command]
pub fn latch_cancel(job_id: String) -> Result<(), String> {
    if let Ok(map) = latch_jobs().lock() {
        if let Some(child_arc) = map.get(&job_id) {
            if let Ok(mut child) = child_arc.lock() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize, Debug)]
pub struct LatchProbeResult {
    pub title:      String,
    pub duration_s: f64,
    pub uploader:   String,
    pub error:      String,
    // yt-dlp chapter objects ({title, start_time, end_time}), passed
    // through verbatim. [] when absent or on an old wrapper.
    pub chapters:   serde_json::Value,
}

#[tauri::command]
pub async fn latch_probe(
    binary_path: String,
    url:         String,
    cookies_from_browser: String,
    // Optional so older invoke sites that don't pass it still deserialize.
    cookies_file: Option<String>,
) -> Result<LatchProbeResult, String> {
    let bin = find_tool_binary("latch", &binary_path)?;
    let mut args = vec!["probe".to_string(), url];
    if !cookies_from_browser.trim().is_empty() {
        args.push(format!("--cookies-from-browser={}", cookies_from_browser.trim()));
    }
    if let Some(cf) = cookies_file.as_deref() {
        let cf = cf.trim();
        if !cf.is_empty() { args.push(format!("--cookies={}", cf)); }
    }

    let mut cmd = Command::new(&bin);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("probe spawn join: {e}"))?
        .map_err(|e| format!("probe spawn: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().last().unwrap_or("").trim();
    let v: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| format!("probe parse: {e} (raw: {line})"))?;

    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        return Ok(LatchProbeResult {
            title: String::new(),
            duration_s: 0.0,
            uploader: String::new(),
            error: err.to_string(),
            chapters: serde_json::Value::Array(Vec::new()),
        });
    }
    Ok(LatchProbeResult {
        title:      v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        duration_s: v.get("duration_s").and_then(|x| x.as_f64()).unwrap_or(0.0),
        uploader:   v.get("uploader").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        error:      String::new(),
        chapters:   v.get("chapters")
                     .filter(|x| x.is_array())
                     .cloned()
                     .unwrap_or(serde_json::Value::Array(Vec::new())),
    })
}

#[derive(serde::Serialize, Debug, Clone)]
pub struct LatchExpandTrack {
    pub url:        String,
    pub title:      String,
    pub duration_s: f64,
    pub uploader:   String,
    pub thumbnail:  String,
}

#[derive(serde::Serialize, Debug)]
pub struct LatchExpandResult {
    pub tracks: Vec<LatchExpandTrack>,
    pub error:  String,
}

#[tauri::command]
pub async fn latch_expand_url(
    binary_path: String,
    url:         String,
    cookies_from_browser: String,
    cookies_file: Option<String>,
) -> Result<LatchExpandResult, String> {
    let bin = find_tool_binary("latch", &binary_path)?;
    let mut args = vec!["expand".to_string(), url];
    if !cookies_from_browser.trim().is_empty() {
        args.push(format!("--cookies-from-browser={}", cookies_from_browser.trim()));
    }
    if let Some(cf) = cookies_file.as_deref() {
        let cf = cf.trim();
        if !cf.is_empty() { args.push(format!("--cookies={}", cf)); }
    }

    let mut cmd = Command::new(&bin);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("expand spawn join: {e}"))?
        .map_err(|e| format!("expand spawn: {e}"))?;

    if !output.status.success() {
        return Ok(LatchExpandResult {
            tracks: Vec::new(),
            error:  String::new(),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut tracks: Vec<LatchExpandTrack> = Vec::new();
    let mut error_msg = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()) {
            Some("track") => {
                tracks.push(LatchExpandTrack {
                    url:        v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    title:      v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    duration_s: v.get("duration_s").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    uploader:   v.get("uploader").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    thumbnail:  v.get("thumbnail").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                });
            }
            Some("error") => {
                error_msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
            }
            _ => {}
        }
    }

    Ok(LatchExpandResult { tracks, error: error_msg })
}

#[tauri::command]
pub async fn latch_update_ytdlp(
    app: AppHandle,
    window_label: String,
    job_id: String,
    binary_path: String,
) -> Result<(), String> {
    let bin = find_tool_binary("latch", &binary_path)?;
    let args = vec!["update".to_string()];
    let (child, stdout) = spawn_tool(bin, args)?;
    let child_arc = Arc::new(Mutex::new(child));
    if let Ok(mut map) = latch_jobs().lock() {
        map.insert(job_id.clone(), child_arc.clone());
    }
    run_reader("latch", job_id, window_label, app, stdout, child_arc);
    Ok(())
}

#[tauri::command]
pub async fn latch_bootstrap(
    app: AppHandle,
    window_label: String,
    job_id: String,
    binary_path: String,
) -> Result<(), String> {
    let bin = find_tool_binary("latch", &binary_path)?;
    let args = vec!["bootstrap".to_string()];
    let (child, stdout) = spawn_tool(bin, args)?;
    let child_arc = Arc::new(Mutex::new(child));
    if let Ok(mut map) = latch_jobs().lock() {
        map.insert(job_id.clone(), child_arc.clone());
    }
    run_reader("latch", job_id, window_label, app, stdout, child_arc);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ToolBinaryStatus {
    pub resolved: bool,
    pub path:     String,
    pub source:   String, // "configured" | "env" | "dev" | "installed" | "missing"
    pub message:  String,
}

#[tauri::command]
pub fn tool_binary_probe(name: String, configured: String) -> ToolBinaryStatus {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let pb = PathBuf::from(trimmed);
        if pb.exists() {
            return ToolBinaryStatus {
                resolved: true,
                path:     pb.display().to_string(),
                source:   "configured".into(),
                message:  String::new(),
            };
        }
        return ToolBinaryStatus {
            resolved: false,
            path:     pb.display().to_string(),
            source:   "missing".into(),
            message:  format!("configured path does not exist: {}", pb.display()),
        };
    }
    let env_var = format!("{}_EXE", name.to_uppercase());
    if let Ok(p) = std::env::var(&env_var) {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return ToolBinaryStatus {
                resolved: true,
                path:     pb.display().to_string(),
                source:   "env".into(),
                message:  format!("from {}", env_var),
            };
        }
    }
    for cand in dev_tool_fallbacks(&name) {
        if cand.exists() {
            return ToolBinaryStatus {
                resolved: true,
                path:     cand.display().to_string(),
                source:   "dev".into(),
                message:  "dev fallback".into(),
            };
        }
    }
    for cand in installed_tool_fallbacks(&name) {
        if cand.exists() {
            return ToolBinaryStatus {
                resolved: true,
                path:     cand.display().to_string(),
                source:   "installed".into(),
                message:  "default install location".into(),
            };
        }
    }
    ToolBinaryStatus {
        resolved: false,
        path:     String::new(),
        source:   "missing".into(),
        message:  format!(
            "{}.exe not found. Set {} env, reinstall, or build at {}.",
            name,
            env_var,
            format!(r"%USERPROFILE%\Dev\{}\build", name),
        ),
    }
}

/// Tear the whole app down: kill every tracked child, sweep the chop
/// temp root, exit. The main window's close flow calls this so the
/// satellite windows (chop, the pre-spawned drag overlay) never keep a
/// headless app alive, and no yt-dlp/ffmpeg tree outlives the GUI.
#[tauri::command]
pub fn app_exit(app: AppHandle) {
    if let Ok(mut map) = latch_jobs().lock() {
        for (_, child) in map.drain() {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        }
    }
    crate::chop::sweep_temp_root();
    app.exit(0);
}

/// Whole-track audio peak bins for the video preview's scrubber waveform.
/// Runs `lathe audio-peaks`, which decodes once and emits
/// {"bins":N,"dur":<sec>,"peaks":[..]}. Fork of WAVdesk's video_audio_peaks.
#[tauri::command]
pub async fn video_audio_peaks(
    binary_path: String,
    path: String,
    bins: Option<u32>,
) -> Result<serde_json::Value, String> {
    let bin = find_tool_binary("lathe", &binary_path)?;
    let n = bins.unwrap_or(2000).max(1);
    let mut cmd = Command::new(&bin);
    cmd.args(["audio-peaks", &path, &format!("--bins={n}")])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("audio-peaks join: {e}"))?
        .map_err(|e| format!("audio-peaks spawn: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().last().unwrap_or("").trim();
    serde_json::from_str(line).map_err(|e| format!("audio-peaks parse: {e} (raw: {line})"))
}

/// Open a directory (or file) with the OS default handler — the clips
/// folder button. ShellExecute-equivalent via the platform opener.
#[tauri::command]
pub fn os_open_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("os_open_path: empty path".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer spawn: {}", e))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open spawn: {}", e))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("xdg-open spawn: {}", e))
    }
}

/// Reveal a file in the OS file manager. Fork of WAVdesk's os_reveal_path
/// — see that function for the explorer.exe raw_arg quoting rationale.
#[tauri::command]
pub fn os_reveal_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("os_reveal_path: empty path".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        // explorer parses its own command line: the comma must sit OUTSIDE
        // the quoted region, which Rust's default arg-quoting can't produce.
        let normalized = path.replace('/', "\\");
        let raw = format!("/select,\"{}\"", normalized);
        Command::new("explorer")
            .raw_arg(&raw)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer /select spawn: {}", e))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open -R spawn: {}", e))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .ok_or_else(|| "os_reveal_path: no parent directory".to_string())?;
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("xdg-open spawn: {}", e))
    }
}

/// Open an http/https URL in the user's default browser. Used by the About
/// window's license links. Scheme-gated so a stray value can't launch an
/// arbitrary protocol handler.
#[tauri::command]
pub fn os_open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("os_open_url: only http/https URLs are allowed".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer url spawn: {}", e))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open url spawn: {}", e))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("xdg-open url spawn: {}", e))
    }
}
