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

// Dev-checkout candidates at %USERPROFILE%\Dev\{name}\build\{Release,Debug}.
// See build_tiers for the full ordering — this tier is DEBUG-ONLY (a stray dev
// core must not shadow the installed binary in a shipped build). Release first
// within the tier: a Debug-built decoder can't sustain realtime video (decode
// throughput caps near 1x — shuttle/reverse starve), so it must win over Debug.
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

// ffmpeg's managed home, matching the C++ core's resolver
// (paths.cpp shared_bin_path -> shared_root()/Shared/bin):
// %ProgramData%\Vacant Systems\Shared\bin. This is the SHARED bin (not Latch's
// own bin where yt-dlp lives) — all three Vacant Systems apps resolve ffmpeg
// here. The installer ACL-grants Users write so the unelevated GUI can seed it.
#[cfg(target_os = "windows")]
fn shared_bin_dir() -> Option<PathBuf> {
    std::env::var_os("ProgramData")
        .map(|p| PathBuf::from(p).join("Vacant Systems").join("Shared").join("bin"))
        .or_else(|| Some(PathBuf::from(r"C:\ProgramData\Vacant Systems\Shared\bin")))
}

/// Copy the bundled ffmpeg.exe AND ffprobe.exe into the shared managed bin dir on
/// launch so a fresh, standalone install (no WAVdesk) has both for the chop/clip
/// video features and yt-dlp post-processing. yt-dlp discovers ffprobe next to
/// ffmpeg (--ffmpeg-location), so both must land in the same shared bin. The C++
/// core only downloads from GitHub when they're absent, so seeding non-zero
/// copies here makes that a no-op. Best-effort; each binary is checked/copied
/// INDEPENDENTLY so a pre-existing ffmpeg (from an older bundle that shipped no
/// ffprobe) doesn't short-circuit ffprobe delivery.
#[cfg(target_os = "windows")]
pub fn provision_ffmpeg(resource_dir: &std::path::Path) {
    let Some(dest_dir) = shared_bin_dir() else { return };
    if std::fs::create_dir_all(&dest_dir).is_err() {
        return;
    }
    let src_dir = resource_dir.join("resources").join("ffmpeg");
    for bin in ["ffmpeg.exe", "ffprobe.exe"] {
        let dest = dest_dir.join(bin);
        if dest.exists() {
            continue; // already provisioned / downloaded — don't clobber
        }
        let src = src_dir.join(bin);
        if src.exists() {
            let _ = std::fs::copy(&src, &dest);
        }
        // else: dev run / -SkipFfmpeg — no bundle, core downloads at runtime
    }
}

#[cfg(not(target_os = "windows"))]
pub fn provision_ffmpeg(_resource_dir: &std::path::Path) {}

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
            // next to the GUI exe (NSIS resource_dir == install root). This is
            // THIS app's own coredist — the self-resolution path for latch.exe.
            out.push(dir.join("coredist").join(&exe_name));
            // Installed layout: the CLI ships right next to this GUI exe.
            out.push(dir.join(&exe_name));
            if let Some(vendor) = dir.parent() {
                // Sibling app under one vendor root. The CLI core lives under
                // its OWN coredist\ (e.g. Lathe\coredist\lathe.exe), so check
                // that before the legacy flat sibling — otherwise a standalone
                // Latch never finds an installed Lathe (the laptop bug).
                out.push(vendor.join(&app_dir).join("coredist").join(&exe_name));
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
        // The Tauri NSIS perMachine layout puts each GUI at
        // <Program Files>\Vacant Systems\<App>\ and its CLI core one level
        // deeper under coredist\ (bundled resource). Check that first, then the
        // legacy flat layouts. This is what resolves a sibling Lathe install at
        // …\Vacant Systems\Lathe\coredist\lathe.exe.
        out.push(vendor.join(&app_dir).join("coredist").join(&exe_name));
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

// ---------------------------------------------------------------------------
// Lathe capability probe (mirror of WAVdesk external_tools.rs — keep in sync).
//
// The chop window's video decode spawns `lathe decode-server`. If resolution
// lands on an ANCIENT lathe.exe — a stale %USERPROFILE%\Dev checkout, or a
// stale-configured/latheStatus-supplied path — that PREDATES decode-server, the
// audio track loads but video shows "Couldn't load this video". Such a build
// still runs basic converts, so exists() looks fine.
//
// `lathe libav-version` is the cheapest discriminator: a modern build prints
// the linked ffmpeg versions and exits 0; a build predating the subcommand
// errors "unknown command" and exits nonzero; a build compiled WITHOUT libav
// prints "libav not built in" (exit 0) and can't decode. Accept only the first.
//
// Verdicts are cached per (path, size, mtime) — the cache IS the spawn-storm
// guard (a same-path repeat is an O(1) cache hit). A reinstall changes
// size/mtime, yielding a fresh key that re-probes.
type ProbeKey = (String, u64, u64);

fn lathe_probe_cache() -> &'static Mutex<HashMap<ProbeKey, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<ProbeKey, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_key(path: &std::path::Path) -> Option<ProbeKey> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((path.to_string_lossy().into_owned(), md.len(), mtime))
}

// Map a `lathe libav-version` result to accept (Ok) / reject-with-reason (Err).
// Pure, so the semantics are unit-tested without spawning a real subprocess.
fn interpret_probe(success: bool, code: Option<i32>, stdout: &str, stderr_tail: &str) -> Result<(), String> {
    if !success {
        let code = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        return Err(if stderr_tail.is_empty() {
            format!("exit {code}")
        } else {
            format!("exit {code}: {stderr_tail}")
        });
    }
    if stdout.contains("not built in") {
        return Err("libav not built in (decode-server would be a stub)".into());
    }
    Ok(())
}

fn run_lathe_probe(path: &std::path::Path) -> Result<(), String> {
    let mut cmd = Command::new(path);
    cmd.arg("libav-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("spawn failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let tail = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .unwrap_or("");
    interpret_probe(out.status.success(), out.status.code(), &stdout, tail)
}

fn cached_verdict<F: FnOnce() -> bool>(key: ProbeKey, compute: F) -> bool {
    if let Ok(cache) = lathe_probe_cache().lock() {
        if let Some(v) = cache.get(&key) {
            return *v;
        }
    }
    let ok = compute();
    if let Ok(mut cache) = lathe_probe_cache().lock() {
        cache.insert(key, ok);
    }
    ok
}

fn lathe_capable(path: &std::path::Path) -> bool {
    let key = match probe_key(path) {
        Some(k) => k,
        None => return run_lathe_probe(path).is_ok(),
    };
    cached_verdict(key, || match run_lathe_probe(path) {
        Ok(()) => true,
        Err(detail) => {
            log::warn!(
                "[tools] {}: lathe capability probe failed ({detail}); trying next tier",
                path.display()
            );
            false
        }
    })
}

// Acceptable if it exists AND — for lathe only — passes the capability probe.
fn candidate_ok(name: &str, cand: &std::path::Path) -> bool {
    cand.exists() && (name != "lathe" || lathe_capable(cand))
}

// One resolution tier: candidates sharing a source label. `enabled=false` skips
// the tier without disturbing the ordering (makes the dev tier debug-only).
struct Tier {
    source: &'static str,
    message: String,
    cands: Vec<PathBuf>,
    enabled: bool,
}

// Ordered resolution tiers for `name` — SINGLE source of ordering truth shared
// by find_tool_binary and tool_binary_probe. Release order: configured → env →
// registry → installed. The registry tier reads the shared discovery manifest
// (…\Vacant Systems\Shared\registry.json) that WAVdesk / Lathe write on
// install, so a sibling Lathe is found at its recorded path even if it lives
// outside the default install layout. The dev-checkout tier is DEBUG-ONLY so an
// ancient dev core never shadows the installed binary in a shipped build. A
// stale/missing (or, for lathe, incapable) candidate is skipped and resolution
// falls through.
fn build_tiers(name: &str, configured: &str) -> Vec<Tier> {
    let mut tiers = Vec::new();
    let configured = configured.trim();
    if !configured.is_empty() {
        tiers.push(Tier {
            source: "configured",
            message: String::new(),
            cands: vec![PathBuf::from(configured)],
            enabled: true,
        });
    }
    let env_var = format!("{}_EXE", name.to_uppercase());
    if let Ok(p) = std::env::var(&env_var) {
        tiers.push(Tier {
            source: "env",
            message: format!("from {}", env_var),
            cands: vec![PathBuf::from(p)],
            enabled: true,
        });
    }
    tiers.push(Tier {
        source: "dev",
        message: "dev fallback".into(),
        cands: dev_tool_fallbacks(name),
        enabled: cfg!(debug_assertions),
    });
    tiers.push(Tier {
        source: "registry",
        message: "shared registry".into(),
        cands: crate::registry::resolved_binary(name).into_iter().collect(),
        enabled: true,
    });
    tiers.push(Tier {
        source: "installed",
        message: "default install location".into(),
        cands: installed_tool_fallbacks(name),
        enabled: true,
    });
    tiers
}

fn resolve_tiers<'a>(
    tiers: &'a [Tier],
    accept: &dyn Fn(&std::path::Path) -> bool,
) -> Option<(&'a Tier, PathBuf)> {
    for t in tiers {
        if !t.enabled {
            continue;
        }
        for c in &t.cands {
            if accept(c) {
                return Some((t, c.clone()));
            }
        }
    }
    None
}

// The effective `configured` override: an explicit caller value wins; otherwise
// the persisted Settings override for tools that expose one (lathe here — the
// core's own yt-dlp/ffmpeg overrides reach the C++ resolver via env instead, see
// settings::apply_tool_env). Unknown names (our own latch core) pass through.
fn effective_configured(name: &str, configured: &str) -> String {
    let c = configured.trim();
    if !c.is_empty() {
        return c.to_string();
    }
    crate::settings::tool_override(name)
}

pub(crate) fn find_tool_binary(name: &str, configured: &str) -> Result<PathBuf, String> {
    let configured = effective_configured(name, configured);
    let tiers = build_tiers(name, &configured);
    if let Some((_, p)) = resolve_tiers(&tiers, &|c| candidate_ok(name, c)) {
        return Ok(p);
    }
    let env_var = format!("{}_EXE", name.to_uppercase());
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

// --version output cached per (path, size, mtime) so a receipt at every job
// start doesn't respawn the binary — a reinstall changes size/mtime and forces
// a re-read. The version string alone does NOT distinguish a stale binary from
// a fresh one (both can report the same CARGO/compiled version across a rebuild
// that changed behaviour), which is exactly why the receipt also carries size +
// mtime — the fields that actually prove which build ran.
fn latch_version_cache() -> &'static Mutex<HashMap<ProbeKey, String>> {
    static CACHE: OnceLock<Mutex<HashMap<ProbeKey, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tool_version(bin: &std::path::Path) -> String {
    let mut cmd = Command::new(bin);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines().next().unwrap_or("").trim().to_string()
        }
        Err(_) => "unknown".to_string(),
    }
}

/// Write a binary-identity receipt to the always-on log: the ABSOLUTE resolved
/// path, file size, mtime (unix secs), and `--version` of the latch core about
/// to run. `context` names the caller ("chop/extract", "chop/probe", ...). This
/// makes a stale-install situation provable from any future owner log — path +
/// size + mtime pin down exactly which build handled the job, where the version
/// string alone cannot. Cheap: one metadata stat + a cached version read.
pub(crate) fn log_binary_receipt(bin: &std::path::Path, context: &str) {
    let (size, mtime) = match probe_key(bin) {
        Some((_, size, mtime)) => (size, mtime),
        None => (0, 0),
    };
    let version = {
        let key = (bin.to_string_lossy().into_owned(), size, mtime);
        let cached = latch_version_cache()
            .lock()
            .ok()
            .and_then(|c| c.get(&key).cloned());
        match cached {
            Some(v) => v,
            None => {
                let v = tool_version(bin);
                if let Ok(mut c) = latch_version_cache().lock() {
                    c.insert(key, v.clone());
                }
                v
            }
        }
    };
    crate::logger::log(&format!(
        "[binary] {context}: latch core = {} (version \"{}\", size {}, mtime {})",
        bin.display(),
        version,
        size,
        mtime
    ));
}

pub(crate) fn spawn_tool(
    binary: PathBuf,
    args: Vec<String>,
) -> Result<(Child, std::process::ChildStdout), String> {
    let mut cmd = Command::new(&binary);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Thread the user's yt-dlp / ffmpeg overrides down to the C++ core (no-op
    // for a lathe child, which reads its own env).
    crate::settings::apply_tool_env(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", binary.display(), e))?;
    crate::job_object::assign_child(&child);
    // Drain stderr on a detached thread. We pipe it (above) but the reader only
    // ever consumes stdout — a chatty child (yt-dlp/ffmpeg noise) could fill the
    // OS stderr pipe buffer and block its own writes, wedging the whole download
    // ("hung forever" with no output). Reading to EOF keeps it flowing and
    // surfaces the tail for post-mortem.
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            if !buf.is_empty() {
                let text = String::from_utf8_lossy(&buf);
                let lines: Vec<&str> = text.lines().collect();
                let start = lines.len().saturating_sub(20);
                let tail = lines[start..].join("\n");
                if !tail.trim().is_empty() {
                    eprintln!("[latch child stderr]\n{tail}");
                }
            }
        });
    }
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
        // Read raw bytes, not `.lines()`: a single line of invalid UTF-8 (a
        // Windows child relaying a title in the ANSI codepage) makes
        // BufRead::lines() yield Err, which used to BREAK this loop and drop
        // every event after it — including the terminal `done`, so the session
        // saw only the later `exit` and reported "download exited (code 0)" on
        // a download that actually succeeded. from_utf8_lossy keeps the stream
        // alive: a bad line degrades to replacement chars instead of killing
        // the reader. (latch.exe now also emits valid UTF-8 at the source; this
        // is the belt-and-braces half, and it covers lathe.exe too.)
        let mut reader = BufReader::new(stdout);
        let mut raw: Vec<u8> = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) => break, // EOF
                Ok(_) => {}
                Err(_) => break,
            }
            while matches!(raw.last(), Some(b'\n') | Some(b'\r')) {
                raw.pop();
            }
            if raw.is_empty() {
                continue;
            }
            let line = String::from_utf8_lossy(&raw);
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
    log_binary_receipt(&bin, if options.video { "chop/extract-video" } else { "chop/extract-audio" });
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
    log_binary_receipt(&bin, "chop/probe");
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
    crate::settings::apply_tool_env(&mut cmd);
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
    if line.is_empty() {
        // The core produced no JSON line — surface yt-dlp / core stderr + the
        // exit code instead of the opaque "EOF" parse error, so the real cause
        // (a yt-dlp extraction failure on a stale binary, a SmartScreen/AV
        // kill, a missing/blocked exe) is visible and actionable.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        return Err(if msg.is_empty() {
            format!("probe failed (core exit {:?}) with no output — the link may be unsupported, or yt-dlp may need updating.", output.status.code())
        } else {
            format!("probe failed: {}", msg.lines().last().unwrap_or(msg))
        });
    }
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
    crate::settings::apply_tool_env(&mut cmd);
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
    pub source:   String, // "configured" | "env" | "dev" | "registry" | "installed" | "missing"
    pub message:  String,
}

// Pure tier resolution for `name` under an exact `configured` value (no Settings
// fallback). Shares find_tool_binary's chain (build_tiers) — including the cached
// lathe capability probe, so an ancient/incapable lathe is skipped here too and
// the GUI never reports a dead lathe as connected.
fn probe_impl(name: &str, configured: &str) -> ToolBinaryStatus {
    let tiers = build_tiers(name, configured);
    if let Some((t, p)) = resolve_tiers(&tiers, &|c| candidate_ok(name, c)) {
        return ToolBinaryStatus {
            resolved: true,
            path:     p.display().to_string(),
            source:   t.source.into(),
            message:  t.message.clone(),
        };
    }
    let env_var = format!("{}_EXE", name.to_uppercase());
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

// Tauri v2 runs non-async commands INLINE on the main (UI) thread. probe_impl
// sweeps candidate paths on disk (.exists()) AND, for lathe, spawns the binary
// and WAITS on `libav-version` (cached, but the first hit blocks) — exactly the
// stall the round-18 audit flags. Hop to a blocking pool thread; the frontend
// contract (invoke name/args/return) is unchanged.
#[tauri::command]
pub async fn tool_binary_probe(name: String, configured: String) -> ToolBinaryStatus {
    tauri::async_runtime::spawn_blocking(move || {
        // Settings-aware: an empty caller value falls back to the persisted
        // override (lathe), so latheStatus reflects what the chop video path
        // would resolve.
        let configured = effective_configured(&name, &configured);
        probe_impl(&name, &configured)
    })
    .await
    .unwrap_or_else(|e| ToolBinaryStatus {
        resolved: false,
        path: String::new(),
        source: "error".into(),
        message: format!("probe join: {e}"),
    })
}

fn core_tool_exe(name: &str) -> &'static str {
    match name {
        "yt-dlp" => if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" },
        "ffmpeg" => if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" },
        _ => "",
    }
}

// Managed home mirroring paths.cpp: ffmpeg in the SHARED bin, yt-dlp in Latch's
// own bin, under the machine-wide vendor root (ProgramData on Windows).
fn core_tool_managed_dir(name: &str) -> Option<PathBuf> {
    let shared = name == "ffmpeg";
    #[cfg(windows)]
    {
        let pd = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        let root = pd.join("Vacant Systems");
        Some(if shared {
            root.join("Shared").join("bin")
        } else {
            root.join("Latch").join("bin")
        })
    }
    #[cfg(target_os = "macos")]
    {
        let root = PathBuf::from(std::env::var_os("HOME")?)
            .join("Library/Application Support/Vacant Systems");
        Some(if shared { root.join("Shared/bin") } else { root.join("Latch/bin") })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
        let root = base.join("vacant-systems");
        Some(if shared { root.join("shared/bin") } else { root.join("latch/bin") })
    }
}

fn core_tool_status(exists: bool, path: &std::path::Path, source: &str, message: &str) -> ToolBinaryStatus {
    ToolBinaryStatus {
        resolved: exists,
        path:     path.display().to_string(),
        source:   source.into(),
        message:  message.into(),
    }
}

// Mirror of the C++ core's resolve_binary (paths.cpp) for the tools latch.exe
// owns — yt-dlp and ffmpeg: explicit override → LATCH_<TOOL> env → portable copy
// next to the core → managed home. Reported for the Settings readout so it
// matches what the core actually uses at runtime. KEEP IN LOCKSTEP with
// paths.cpp resolved_ffmpeg / resolved_ytdlp.
fn resolve_core_tool(name: &str, configured: &str) -> ToolBinaryStatus {
    let exe = core_tool_exe(name);
    let env_var = match name {
        "yt-dlp" => "LATCH_YTDLP",
        "ffmpeg" => "LATCH_FFMPEG",
        _ => "",
    };
    // 1. explicit override (the configured tier)
    let c = configured.trim();
    if !c.is_empty() {
        let p = PathBuf::from(c);
        return core_tool_status(p.exists(), &p, "configured", "explicit override");
    }
    // 2. env var the C++ core reads
    if let Ok(v) = std::env::var(env_var) {
        if !v.is_empty() {
            let p = PathBuf::from(&v);
            return core_tool_status(p.exists(), &p, "env", &format!("from {env_var}"));
        }
    }
    // 3. portable copy next to the latch core
    let core = resolve_self_core();
    if let Some(dir) = core.as_deref().and_then(std::path::Path::parent) {
        let p = dir.join(exe);
        if p.exists() {
            return core_tool_status(true, &p, "portable", "next to latch core");
        }
    }
    // 4. managed home (bootstrap's download target)
    if let Some(dir) = core_tool_managed_dir(name) {
        let p = dir.join(exe);
        let exists = p.exists();
        return core_tool_status(
            exists,
            &p,
            if exists { "managed" } else { "missing" },
            if exists { "managed install" } else { "not installed (fetched on first use)" },
        );
    }
    core_tool_status(false, std::path::Path::new(""), "missing", "unresolved")
}

/// Settings-window readout: resolve `name` under an EXPLICIT `configured`
/// override, with NO Settings fallback — the field value IS the override, and an
/// empty value previews the auto resolution. yt-dlp / ffmpeg mirror the C++
/// core; lathe (and the latch core) use the shared tier chain.
#[tauri::command]
pub async fn resolve_tool_status(name: String, configured: String) -> ToolBinaryStatus {
    // Same reasoning as tool_binary_probe: disk resolution + a possible lathe
    // spawn, off the UI thread.
    tauri::async_runtime::spawn_blocking(move || match name.as_str() {
        "yt-dlp" | "ffmpeg" => resolve_core_tool(&name, &configured),
        _ => probe_impl(&name, &configured),
    })
    .await
    .unwrap_or_else(|e| ToolBinaryStatus {
        resolved: false,
        path: String::new(),
        source: "error".into(),
        message: format!("resolve join: {e}"),
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tier(source: &'static str, path: &str, enabled: bool) -> Tier {
        Tier {
            source,
            message: source.to_string(),
            cands: vec![PathBuf::from(path)],
            enabled,
        }
    }

    #[test]
    fn probe_semantics() {
        assert!(interpret_probe(true, Some(0), "libav linked OK\n  avcodec 62", "").is_ok());
        assert!(interpret_probe(false, Some(2), "", "error: unknown command 'libav-version'").is_err());
        assert!(interpret_probe(true, Some(0), "libav not built in (LGPL ...)\n", "").is_err());
    }

    #[test]
    fn release_skips_dev_tier() {
        let tiers = vec![
            tier("dev", r"C:\Dev\lathe\build\Release\lathe.exe", false),
            tier("installed", r"C:\Program Files\Vacant Systems\Lathe\coredist\lathe.exe", true),
        ];
        let (t, _) = resolve_tiers(&tiers, &|_| true).expect("resolves");
        assert_eq!(t.source, "installed");
    }

    #[test]
    fn debug_prefers_dev_tier() {
        let tiers = vec![
            tier("dev", r"C:\Dev\lathe\build\Release\lathe.exe", true),
            tier("installed", r"C:\Program Files\Vacant Systems\Lathe\lathe.exe", true),
        ];
        let (t, _) = resolve_tiers(&tiers, &|_| true).expect("resolves");
        assert_eq!(t.source, "dev");
    }

    #[test]
    fn registry_wins_over_installed() {
        // The shared-registry tier sits ahead of the installed-guess tier, so a
        // manifest-recorded Lathe path is preferred over the layout guess.
        let tiers = vec![
            tier("registry", r"C:\Program Files\Vacant Systems\Lathe\coredist\lathe.exe", true),
            tier("installed", r"C:\Program Files\Vacant Systems\Lathe\lathe.exe", true),
        ];
        let (t, _) = resolve_tiers(&tiers, &|_| true).expect("resolves");
        assert_eq!(t.source, "registry");
    }

    // The sibling-app install layout is <Program Files>\Vacant Systems\<App>\
    // coredist\<app>.exe. That coredist path MUST be an installed candidate or a
    // standalone Latch can't find an installed Lathe (the laptop bug).
    #[cfg(windows)]
    #[test]
    fn installed_fallbacks_include_vendor_coredist() {
        std::env::set_var("ProgramFiles", r"C:\Program Files");
        let cands = installed_tool_fallbacks("lathe");
        let want =
            PathBuf::from(r"C:\Program Files\Vacant Systems\Lathe\coredist\lathe.exe");
        assert!(cands.contains(&want), "expected {want:?} among {cands:?}");
    }

    #[test]
    fn lathe_falls_through_incapable() {
        let ancient = r"C:\Dev\lathe\build\Release\lathe.exe";
        let installed = r"C:\Program Files\Vacant Systems\Lathe\coredist\lathe.exe";
        let tiers = vec![
            tier("configured", ancient, true),
            tier("installed", installed, true),
        ];
        let (t, p) = resolve_tiers(&tiers, &|c| c != std::path::Path::new(ancient))
            .expect("resolves");
        assert_eq!(t.source, "installed");
        assert_eq!(p, PathBuf::from(installed));
    }

    #[test]
    fn cached_verdict_computes_once() {
        let calls = AtomicUsize::new(0);
        let key: ProbeKey = ("test-unique-cache-key".into(), 42, 1234);
        let v1 = cached_verdict(key.clone(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            true
        });
        let v2 = cached_verdict(key, || {
            calls.fetch_add(1, Ordering::SeqCst);
            false
        });
        assert!(v1);
        assert!(v2);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
