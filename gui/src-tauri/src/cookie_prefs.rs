// Cross-app cookie preferences. A single JSON file under the shared Vacant
// Systems tree (…\Vacant Systems\Shared\cookies.json) so the standalone Latch
// app and the in-WAVdesk Latch tool share ONE cookie source — set it up in
// either, it's live in both. WAVdesk writes the identical path via its
// paths::shared_cookies_path(); keep the two in lockstep.
//
// `configured` distinguishes "never set up" (first run may auto-default to
// Firefox) from "deliberately set to none" (respect the user's empty choice).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CookiePrefs {
    pub configured: bool,
    pub cookies_from_browser: String,
    pub cookies_file: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDetection {
    pub detected: Vec<String>,
    // "firefox" when a Firefox cookie store is present (the only reliably
    // readable one on Windows), else "" — we never auto-pick a Chromium
    // browser, since its locked/encrypted cookie DB usually just errors.
    pub recommended: String,
}

// `…\Vacant Systems\Shared\cookies.json`, matching WAVdesk's
// paths::shared_cookies_path() exactly on every platform.
fn shared_cookies_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(PathBuf::from(local).join("Vacant Systems").join("Shared").join("cookies.json"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home)
            .join("Library/Application Support/Vacant Systems/Shared/cookies.json"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME").ok().map(PathBuf::from).or_else(|| {
            std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local/share"))
        })?;
        Some(base.join("vacant-systems/shared/cookies.json"))
    }
}

// Tauri v2 runs non-async commands INLINE on the main (UI) thread, so the
// file read/write and the profile-directory sweep below all hop to a blocking
// pool thread — otherwise a cold-disk cookies.json read or a slow browser
// profile enumeration would stall the window. Frontend contract unchanged.
#[tauri::command]
pub async fn cookie_prefs_get() -> CookiePrefs {
    tauri::async_runtime::spawn_blocking(cookie_prefs_get_impl)
        .await
        .unwrap_or_default()
}

fn cookie_prefs_get_impl() -> CookiePrefs {
    shared_cookies_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<CookiePrefs>(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn cookie_prefs_set(prefs: CookiePrefs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cookie_prefs_set_impl(prefs))
        .await
        .map_err(|e| format!("cookie_prefs_set join: {e}"))?
}

fn cookie_prefs_set_impl(prefs: CookiePrefs) -> Result<(), String> {
    let path = shared_cookies_path().ok_or("cookie_prefs: no shared dir")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir shared: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    // Temp + rename so a concurrent reader in the sibling app never sees a
    // half-written file (cross-app races are rare but cheap to rule out).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn detect_cookie_browsers() -> BrowserDetection {
    tauri::async_runtime::spawn_blocking(detect_cookie_browsers_impl)
        .await
        .unwrap_or_else(|_| BrowserDetection { detected: Vec::new(), recommended: String::new() })
}

fn detect_cookie_browsers_impl() -> BrowserDetection {
    let mut detected = Vec::new();
    if firefox_has_cookies() {
        detected.push("firefox".to_string());
    }
    for (name, candidates) in chromium_candidates() {
        if candidates.iter().any(|p| p.exists()) {
            detected.push(name.to_string());
        }
    }
    let recommended = if detected.iter().any(|b| b == "firefox") {
        "firefox".to_string()
    } else {
        String::new()
    };
    BrowserDetection { detected, recommended }
}

fn firefox_profile_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        v.push(PathBuf::from(appdata).join("Mozilla").join("Firefox").join("Profiles"));
    }
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        v.push(PathBuf::from(home).join("Library/Application Support/Firefox/Profiles"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Ok(home) = std::env::var("HOME") {
        v.push(PathBuf::from(home).join(".mozilla/firefox"));
    }
    v
}

fn firefox_has_cookies() -> bool {
    for root in firefox_profile_roots() {
        if let Ok(rd) = std::fs::read_dir(&root) {
            for entry in rd.flatten() {
                if entry.path().join("cookies.sqlite").exists() {
                    return true;
                }
            }
        }
    }
    false
}

// (browser-id, candidate cookie-DB paths). A browser counts as "present"
// if any candidate exists — newer Chromium keeps Cookies under Network/.
fn chromium_candidates() -> Vec<(&'static str, Vec<PathBuf>)> {
    let mut out: Vec<(&'static str, Vec<PathBuf>)> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let l = PathBuf::from(&local);
            let families: &[(&str, &str)] = &[
                ("chrome",   "Google/Chrome/User Data"),
                ("edge",     "Microsoft/Edge/User Data"),
                ("brave",    "BraveSoftware/Brave-Browser/User Data"),
                ("vivaldi",  "Vivaldi/User Data"),
                ("chromium", "Chromium/User Data"),
            ];
            for (name, rel) in families {
                let def = l.join(rel).join("Default");
                out.push((*name, vec![def.join("Network").join("Cookies"), def.join("Cookies")]));
            }
        }
        if let Ok(roaming) = std::env::var("APPDATA") {
            let opera = PathBuf::from(roaming).join("Opera Software").join("Opera Stable");
            out.push(("opera", vec![opera.join("Network").join("Cookies"), opera.join("Cookies")]));
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        let app = PathBuf::from(home).join("Library/Application Support");
        out.push(("chrome", vec![app.join("Google/Chrome/Default/Cookies")]));
        out.push(("edge",   vec![app.join("Microsoft Edge/Default/Cookies")]));
        out.push(("brave",  vec![app.join("BraveSoftware/Brave-Browser/Default/Cookies")]));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Ok(home) = std::env::var("HOME") {
        let cfg = PathBuf::from(home).join(".config");
        out.push(("chrome",   vec![cfg.join("google-chrome/Default/Cookies")]));
        out.push(("brave",    vec![cfg.join("BraveSoftware/Brave-Browser/Default/Cookies")]));
        out.push(("chromium", vec![cfg.join("chromium/Default/Cookies")]));
    }
    out
}
