// Self-registration into the cross-product discovery manifest at
// ...\Vacant Systems\Shared\registry.json. WAVdesk reads this file to locate
// Latch's CLI core (latch.exe) without a registry dependency or platform
// lookup. We only WRITE our own "latch" entry and preserve any siblings.
//
// Best-effort and atomic: a missing/corrupt file is replaced; the write goes
// to a temp file then renames, so a half-written file can't poison a reader.
// Uses serde_json::Value only (no derive).

use std::path::PathBuf;

use serde_json::{json, Value};

#[cfg(windows)]
fn vendor_root() -> Option<PathBuf> {
    // Machine-wide shared root (ProgramData) so registry.json + ffmpeg/yt-dlp land
    // where WAVdesk reads them; the installer ACL-grants Users write on this tree.
    std::env::var_os("ProgramData")
        .map(|l| PathBuf::from(l).join("Vacant Systems"))
        .or_else(|| Some(PathBuf::from(r"C:\ProgramData\Vacant Systems")))
}
#[cfg(target_os = "macos")]
fn vendor_root() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support/Vacant Systems"))
}
#[cfg(all(unix, not(target_os = "macos")))]
fn vendor_root() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("vacant-systems"))
}

fn registry_path() -> Option<PathBuf> {
    #[cfg(any(windows, target_os = "macos"))]
    let shared = "Shared";
    #[cfg(all(unix, not(target_os = "macos")))]
    let shared = "shared";
    Some(vendor_root()?.join(shared).join("registry.json"))
}

/// Resolve our CLI core and record it under "latch" so WAVdesk can drive it.
/// No-op if the core can't be found or the shared dir can't be resolved.
pub fn register_self() {
    let Some(core) = crate::tools::resolve_self_core() else { return };
    let Some(p) = registry_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut root: Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    root["latch"] = json!({
        "path": core.to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    if let Ok(s) = serde_json::to_string_pretty(&root) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}
