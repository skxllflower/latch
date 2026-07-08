// Minimal always-on file log for standalone Latch. Latch previously logged only
// to stderr + the webview console, so a field failure like the audition decode
// couldn't be inspected after the fact (the user has no diagnostics window).
// Mirrors WAVdesk's lightweight logger: one timestamped line per event,
// appended to a session file under the Latch appdata tree and echoed to stderr.
// Surfaced to the user via the About window's "Open Log File".

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// `%LOCALAPPDATA%\Vacant Systems\Latch\logs` (macOS / Linux equivalents),
/// matching the settings.rs appdata resolver.
fn log_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|l| PathBuf::from(l).join("Vacant Systems").join("Latch").join("logs"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h).join("Library/Application Support/Vacant Systems/Latch/logs")
        })
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".local/share/vacant-systems/latch/logs"))
    }
}

/// Absolute path to the log file. `None` only if the home/appdata var is unset.
pub fn log_path() -> Option<PathBuf> {
    log_dir().map(|d| d.join("latch.log"))
}

// UTC "YYYY-MM-DD HH:MM:SSZ" without pulling a date crate (Hinnant's
// days-from-civil, inverted). Good enough to correlate a log line with a run.
fn now_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}Z")
}

/// Append one timestamped line (also echoed to stderr). Open-append-per-line —
/// the event rate is low (app lifecycle + decode failures), so a persistent
/// handle isn't worth the global-state complexity.
pub fn log(msg: &str) {
    let line = format!("[{}] {}\n", now_utc(), msg);
    eprint!("{line}");
    if let Some(path) = log_path() {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Session header + a coarse size cap so the log can't grow without bound.
pub fn init() {
    if let Some(path) = log_path() {
        if let Ok(m) = fs::metadata(&path) {
            if m.len() > 1_000_000 {
                let _ = fs::remove_file(&path);
            }
        }
    }
    log(&format!(
        "==== Latch session start (v{}) ====",
        env!("CARGO_PKG_VERSION")
    ));
}
