// OS drag-source — fork of WAVdesk's start_os_file_drag (ipc.rs). The
// drag source is the dedicated `drag-overlay` window, NOT the calling
// window: DoDragDrop suppresses Drop notifications back to the SOURCE
// HWND, so sourcing from the passthrough overlay keeps every app window
// a regular drop target. A 1x1 transparent PNG is the OS drag image —
// the chip (native layered window on Windows, the overlay webview
// elsewhere) is the sole visual. Fork delta: WAVdesk's popularity-bump
// on drop is stripped (no index here).

use tauri::{AppHandle, Emitter, Manager};

/// True if the drop just landed on an Explorer folder window or the
/// desktop (a real filesystem copy), rather than an application window.
/// Conservative: unknown classes count as an app, so a referenced file
/// is never deleted.
#[cfg(windows)]
fn dropped_on_shell_surface() -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetCursorPos, WindowFromPoint, GA_ROOT,
    };
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return false;
        }
        let hwnd = WindowFromPoint(pt);
        if hwnd.0.is_null() {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.0.is_null() { hwnd } else { root };
        let mut buf = [0u16; 256];
        let n = GetClassNameW(target, &mut buf);
        if n <= 0 {
            return false;
        }
        matches!(
            String::from_utf16_lossy(&buf[..n as usize]).as_str(),
            "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
        )
    }
}

#[cfg(not(windows))]
fn dropped_on_shell_surface() -> bool {
    false
}

/// `cleanup_temp_on_shell_drop`: the dragged paths are disposable temp
/// renders — if the drop landed on a shell surface (the OS made the
/// user's copy), delete ours shortly after. Only chop-style drag-outs
/// set this.
#[tauri::command]
pub fn start_os_file_drag(
    app: AppHandle,
    paths: Vec<String>,
    #[allow(unused_variables)] preview_png: Option<Vec<u8>>,
    #[allow(unused_variables)] transparent: Option<bool>,
    cleanup_temp_on_shell_drop: Option<bool>,
) -> Result<(), String> {
    use std::path::PathBuf;

    if paths.is_empty() {
        return Ok(());
    }
    let overlay = app
        .get_webview_window("drag-overlay")
        .ok_or_else(|| "drag-overlay window not found".to_string())?;

    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let dragged_paths: Vec<String> = files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let source = overlay.clone();
    // 1×1 transparent PNG — DoDragDrop requires a valid image; the
    // chip is the sole visual.
    const TRANSPARENT_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let image_bytes: Vec<u8> = TRANSPARENT_PNG.to_vec();
    let app_for_cleanup: AppHandle = app.clone();
    let cleanup_temp = cleanup_temp_on_shell_drop.unwrap_or(false);
    overlay
        .run_on_main_thread(move || {
            let app = app_for_cleanup;
            let app_for_err = app.clone();
            let res = drag::start_drag(
                &source,
                drag::DragItem::Files(files),
                drag::Image::Raw(image_bytes),
                move |result, _pos| {
                    // Disposable temp render dropped onto a folder / the
                    // desktop → the OS copied it; delete our redundant
                    // source with backoff (Explorer may still hold it).
                    if cleanup_temp
                        && matches!(result, drag::DragResult::Dropped)
                        && dropped_on_shell_surface()
                    {
                        let to_remove = dragged_paths.clone();
                        std::thread::spawn(move || {
                            for delay in [2u64, 4, 8] {
                                std::thread::sleep(std::time::Duration::from_secs(delay));
                                let pending = to_remove.iter().any(|p| {
                                    let path = std::path::Path::new(p);
                                    path.exists() && std::fs::remove_file(path).is_err()
                                });
                                if !pending {
                                    break;
                                }
                            }
                        });
                    }
                    // Always clean up the floating chip when the OS drag
                    // finishes — dropped or cancelled.
                    let _ = app.emit("wd-overlay-hide", serde_json::json!({}));
                    let _ = app.emit("wd-drag-ended", serde_json::json!({}));
                    if let Some(overlay) = app.get_webview_window("drag-overlay") {
                        let _ = overlay.hide();
                    }
                    crate::drag_overlay::mark_drag_inactive();
                },
                drag::Options::default(),
            );
            // start_drag failing (e.g. the button already released by the
            // time a slow clip render finished) never invokes the drop
            // callback — clean the chip up here or it sticks to the cursor
            // forever.
            if res.is_err() {
                let _ = app_for_err.emit("wd-overlay-hide", serde_json::json!({}));
                let _ = app_for_err.emit("wd-drag-ended", serde_json::json!({}));
                if let Some(overlay) = app_for_err.get_webview_window("drag-overlay") {
                    let _ = overlay.hide();
                }
                crate::drag_overlay::mark_drag_inactive();
            }
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))
}
