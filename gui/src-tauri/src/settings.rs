// Latch's own per-user preferences: tool-path overrides + download / clips
// folders. Persisted as JSON under the PER-USER vendor tree
// (%LOCALAPPDATA%\Vacant Systems\Latch\settings.json) — NOT the machine-wide
// ProgramData tree where the managed binaries live; preferences are per-user.
//
// Writes are read-merge-write at the JSON-object level (never rewrite the whole
// file from possibly-default in-memory state): a partial patch preserves keys
// it doesn't mention, so a save can't clobber a sibling field and a future key
// this build doesn't model yet (e.g. a Theme section) survives a round-trip.
// Atomic temp+rename so a concurrent reader never sees a half-written file.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LatchSettings {
    // Explicit tool-path overrides. Empty = auto-resolve (the resolver's
    // env/portable/managed tiers decide). Set = the `configured` override tier.
    pub ytdlp_path:  String,
    pub ffmpeg_path: String,
    pub lathe_path:  String,
    // Default folder for extraction output when the user hasn't picked one
    // (empty = fall back to the OS Downloads folder).
    pub download_dir: String,
    // Chop clips output folder (empty = Documents/Vacant Systems/Latch Clips).
    pub clips_dir: String,
}

fn settings_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|l| {
            PathBuf::from(l)
                .join("Vacant Systems")
                .join("Latch")
                .join("settings.json")
        })
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library/Application Support/Vacant Systems/Latch/settings.json")
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
        Some(base.join("vacant-systems/latch/settings.json"))
    }
}

pub fn load() -> LatchSettings {
    settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<LatchSettings>(&s).ok())
        .unwrap_or_default()
}

/// The persisted override for a resolver `name`, or "" when none / unknown.
/// Only the tools with a Settings field are looked up — everything else (our
/// own latch core) returns "" without touching disk.
pub fn tool_override(name: &str) -> String {
    match name {
        "lathe" | "yt-dlp" | "ffmpeg" => {
            let s = load();
            match name {
                "lathe" => s.lathe_path,
                "yt-dlp" => s.ytdlp_path,
                "ffmpeg" => s.ffmpeg_path,
                _ => String::new(),
            }
        }
        _ => String::new(),
    }
}

/// Apply the yt-dlp / ffmpeg overrides as the env vars the C++ core reads
/// (paths.cpp resolve_binary) onto a child latch.exe command. Only set when the
/// override is non-empty; the core ignores an env path that doesn't exist, so a
/// stale value is harmless. ffprobe rides along next to a custom ffmpeg.
pub fn apply_tool_env(cmd: &mut Command) {
    let s = load();
    let y = s.ytdlp_path.trim();
    if !y.is_empty() {
        cmd.env("LATCH_YTDLP", y);
    }
    let f = s.ffmpeg_path.trim();
    if !f.is_empty() {
        cmd.env("LATCH_FFMPEG", f);
        // yt-dlp discovers ffprobe via --ffmpeg-location, but the core also
        // resolves ffprobe independently (LATCH_FFPROBE) — point it at the
        // sibling next to a custom ffmpeg when one is present.
        if let Some(dir) = std::path::Path::new(f).parent() {
            let probe = dir.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
            if probe.exists() {
                cmd.env("LATCH_FFPROBE", probe);
            }
        }
    }
}

#[tauri::command]
pub fn settings_get() -> LatchSettings {
    load()
}

#[tauri::command]
pub fn settings_set(patch: Value) -> Result<(), String> {
    let path = settings_path().ok_or("settings: no vendor dir")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir settings: {e}"))?;
    }
    // Read-merge-write: start from the on-disk object (or {}), overlay only the
    // patch's keys, so keys the caller didn't send — including future ones —
    // stay intact.
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()));
    let patch_map = match patch {
        Value::Object(m) => m,
        _ => return Err("settings_set: patch must be a JSON object".into()),
    };
    let root_map = root.as_object_mut().expect("root is an object");
    for (k, v) in patch_map {
        root_map.insert(k, v);
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
