// OS drag-source — fork of WAVdesk's start_os_file_drag (ipc.rs). The
// drag source is the dedicated `drag-overlay` window, NOT the calling
// window: DoDragDrop suppresses Drop notifications back to the SOURCE
// HWND, so sourcing from the passthrough overlay keeps every app window
// a regular drop target. A 1x1 transparent PNG is the OS drag image —
// the chip (native layered window on Windows, the overlay webview
// elsewhere) is the sole visual. Fork delta: WAVdesk's popularity-bump
// on drop is stripped (no index here), and no `movable` mode — Latch
// clip drags offer COPY only (Latch Clips is the canonical home).
//
// Round 21 robustness port (see WAVdesk ipc.rs for the full history):
//   • ASYNC shell paste (vendored drag crate): Explorer's copy — and its
//     "Replace or Skip Files" conflict prompt — runs on an Explorer
//     background thread; DoDragDrop returns immediately instead of
//     wedging the UI thread until the user answers.
//   • stale gate — refuse a DoDragDrop whose gesture already died (its
//     modal loop would never see a button-up and wedges the UI thread).
//   • generation-tagged single-flight gate + per-drag settle latch —
//     release is guaranteed on EVERY outcome; a late completion can
//     never release a newer drag's gate.
//   • watchdog — force-releases the gate + chip if DoDragDrop hasn't
//     settled 10s after the button went up (a wedged modal loop).
//   • fate-based cleanup replaces the blind delete: with async pastes
//     the drop effect is INTENT, not outcome, so the disposable-source
//     reclaim now observes the filesystem: on effect None the source is
//     NEVER deleted (a declined "Skip" left no copy anywhere — deleting
//     destroyed the user's only clip); on Copy the source is deleted
//     only once the copy VERIFIABLY arrived at the resolved destination
//     folder (existence + size + mtime — bare existence would misread a
//     Skip, the old same-named file already sits there).

use tauri::{AppHandle, Emitter, Manager};

/// Which shell surface (if any) sits under the cursor.
#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
enum ShellSurface {
    Explorer(isize),
    Desktop,
}

#[cfg(windows)]
fn shell_surface_under_cursor() -> Option<ShellSurface> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetCursorPos, WindowFromPoint, GA_ROOT,
    };
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return None;
        }
        let hwnd = WindowFromPoint(pt);
        if hwnd.0.is_null() {
            return None;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.0.is_null() { hwnd } else { root };
        let mut buf = [0u16; 256];
        let n = GetClassNameW(target, &mut buf);
        if n <= 0 {
            return None;
        }
        match String::from_utf16_lossy(&buf[..n as usize]).as_str() {
            "CabinetWClass" | "ExploreWClass" => Some(ShellSurface::Explorer(target.0 as isize)),
            "Progman" | "WorkerW" => Some(ShellSurface::Desktop),
            _ => None,
        }
    }
}

#[cfg(not(windows))]
#[derive(Clone, Copy, Debug)]
enum ShellSurface {}

#[cfg(not(windows))]
fn shell_surface_under_cursor() -> Option<ShellSurface> {
    None
}

#[cfg(windows)]
fn shell_surface_dest_dir(app: &AppHandle, surface: ShellSurface) -> Option<String> {
    match surface {
        ShellSurface::Explorer(hwnd) => crate::explorer_folder::resolve_explorer_folder_path(
            windows::Win32::Foundation::HWND(hwnd as *mut _),
        ),
        ShellSurface::Desktop => app
            .path()
            .desktop_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

#[cfg(not(windows))]
fn shell_surface_dest_dir(_app: &AppHandle, surface: ShellSurface) -> Option<String> {
    match surface {}
}

/// Has the shell's copy of `src` verifiably arrived in `dest_dir`?
/// existence + size + mtime (±2s) of `<dest_dir>/<basename>` vs the source.
fn shell_copy_verified(dest_dir: &str, src: &str) -> bool {
    let src_path = std::path::Path::new(src);
    let name = match src_path.file_name() {
        Some(n) => n,
        None => return false,
    };
    let dest = std::path::Path::new(dest_dir).join(name);
    let (Ok(sm), Ok(dm)) = (src_path.metadata(), dest.metadata()) else {
        return false;
    };
    if sm.len() != dm.len() {
        return false;
    }
    match (sm.modified(), dm.modified()) {
        (Ok(a), Ok(b)) => {
            let diff = if a > b {
                a.duration_since(b)
            } else {
                b.duration_since(a)
            };
            diff.map(|d| d.as_secs() <= 2).unwrap_or(false)
        }
        _ => false,
    }
}

/// Is a primary physical mouse button held right now? (Swap-agnostic; pen /
/// touch synthesize the left button.)
fn primary_pointer_down() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON,
        };
        ((GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16) & 0x8000 != 0)
            || ((GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16) & 0x8000 != 0)
    }
    #[cfg(not(windows))]
    {
        use device_query::DeviceQuery;
        let m = device_query::DeviceState::new().get_mouse();
        m.button_pressed.get(1).copied().unwrap_or(false)
            || m.button_pressed.get(2).copied().unwrap_or(false)
    }
}

// Generation-tagged single-flight gate (0 = idle, else the owning drag's id).
static OS_DRAG_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static OS_DRAG_NEXT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const OS_DRAG_WATCHDOG_UP_MS: u64 = 10_000;

fn os_drag_release_gate(gen: u64) {
    let _ = OS_DRAG_GEN.compare_exchange(
        gen,
        0,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::SeqCst,
    );
}

/// End-of-drag chip/overlay cleanup for a drag that never reached (or never
/// survived) DoDragDrop. Standalone Latch has no wd-os-drag-result consumers,
/// so only the overlay events are emitted.
fn emit_drag_cleanup(app: &AppHandle) {
    let _ = app.emit("wd-overlay-hide", serde_json::json!({}));
    let _ = app.emit("wd-drag-ended", serde_json::json!({}));
    if let Some(overlay) = app.get_webview_window("drag-overlay") {
        let _ = overlay.hide();
    }
    crate::drag_overlay::mark_drag_inactive();
}

/// `cleanup_temp_on_shell_drop`: the dragged paths are disposable temp
/// renders — if the drop landed on a shell surface AND the shell's copy
/// verifiably arrived, delete ours shortly after. Only chop-style
/// drag-outs set this.
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
    // Stale gate: the gesture must still be physically held — a DoDragDrop
    // entered after release has no button-up transition to end on.
    if !primary_pointer_down() {
        log::warn!("os drag aborted (stale): {} path(s)", paths.len());
        emit_drag_cleanup(&app);
        return Ok(());
    }
    // Single-flight gate.
    let gen = OS_DRAG_NEXT_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if OS_DRAG_GEN
        .compare_exchange(
            0,
            gen,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        log::warn!("os drag rejected: another OS drag is already in flight");
        return Ok(());
    }
    let overlay = match app.get_webview_window("drag-overlay") {
        Some(w) => w,
        None => {
            os_drag_release_gate(gen);
            return Err("drag-overlay window not found".to_string());
        }
    };
    let settled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Watchdog: force-release if DoDragDrop hasn't settled well after the
    // button went up (wedged modal loop). A late real completion no-ops via
    // the settle latch + generation compare.
    {
        let settled = settled.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let mut up_since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                if settled.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                if primary_pointer_down() {
                    up_since = None;
                    continue;
                }
                let since = *up_since.get_or_insert_with(std::time::Instant::now);
                if since.elapsed().as_millis() as u64 >= OS_DRAG_WATCHDOG_UP_MS {
                    if !settled.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        os_drag_release_gate(gen);
                        log::error!(
                            "os drag watchdog: DoDragDrop did not settle within 10s of button-up; force-releasing"
                        );
                        emit_drag_cleanup(&app);
                    }
                    return;
                }
            }
        });
    }

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
    // macOS: AppKit renders whatever Image the drag session is given as the
    // NSDraggingItem's drag image. When the frontend supplied a composed chip
    // PNG (`preview_png`), hand THAT to the session so Latch's own custom chip
    // (the waveform strip / pill) renders natively (an empty/transparent image
    // makes AppKit fall back to the OS default file icon). Windows keeps the
    // transparent placeholder — its native layered chip window draws the visual
    // there and `preview_png` is not sent, so this path is byte-identical.
    #[cfg(target_os = "macos")]
    let image_bytes: Vec<u8> = match preview_png {
        Some(ref p) if !p.is_empty() => p.clone(),
        _ => TRANSPARENT_PNG.to_vec(),
    };
    #[cfg(not(target_os = "macos"))]
    let image_bytes: Vec<u8> = TRANSPARENT_PNG.to_vec();
    let app_for_cleanup: AppHandle = app.clone();
    let cleanup_temp = cleanup_temp_on_shell_drop.unwrap_or(false);
    let shell_op = std::sync::Arc::new(drag::ShellOpState::default());
    let settled_for_closure = settled.clone();
    let res = overlay
        .run_on_main_thread(move || {
            let app = app_for_cleanup;
            let settled = settled_for_closure;
            // Execution-time stale re-check (the queued closure can run late).
            if !primary_pointer_down() {
                if !settled.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    os_drag_release_gate(gen);
                    log::warn!("os drag aborted (stale at execution)");
                    emit_drag_cleanup(&app);
                }
                return;
            }
            let app_for_err = app.clone();
            let settled_for_err = settled.clone();
            let shell_op_for_cb = shell_op.clone();
            let res = drag::start_drag(
                &source,
                drag::DragItem::Files(files),
                drag::Image::Raw(image_bytes),
                move |result, _pos| {
                    let first_settle =
                        !settled.swap(true, std::sync::atomic::Ordering::SeqCst);
                    os_drag_release_gate(gen);
                    let shell_op = shell_op_for_cb.clone();
                    let performed = match result {
                        drag::DragResult::Dropped(op) => Some(op),
                        drag::DragResult::Cancel => None,
                    };
                    // Disposable temp render dropped onto a shell surface →
                    // fate-based reclaim (see module header): observe the
                    // filesystem instead of trusting the (intent-only, async)
                    // drop effect. Never deletes on a declined drop.
                    let surface = if performed.is_some() {
                        shell_surface_under_cursor()
                    } else {
                        None
                    };
                    if cleanup_temp && surface.is_some() {
                        let dest_dir = surface
                            .and_then(|s| shell_surface_dest_dir(&app, s));
                        let to_watch = dragged_paths.clone();
                        let copy_like = matches!(
                            performed,
                            Some(drag::DragOperation::Copy) | Some(drag::DragOperation::Move)
                        );
                        std::thread::spawn(move || {
                            let started = std::time::Instant::now();
                            let mut delays_ms: Vec<u64> = vec![1500, 2500, 6000]; // 1.5/4/10s
                            let mut removed = 0usize;
                            loop {
                                let delay = if !delays_ms.is_empty() {
                                    delays_ms.remove(0)
                                } else if shell_op
                                    .started
                                    .load(std::sync::atomic::Ordering::SeqCst)
                                    && started.elapsed().as_secs() < 120
                                {
                                    5000 // conflict prompt may hold the paste open
                                } else {
                                    log::info!(
                                        "latch clip shell-drop fate: source kept ({} removed of {}, copy_like={copy_like})",
                                        removed,
                                        to_watch.len(),
                                    );
                                    return;
                                };
                                std::thread::sleep(std::time::Duration::from_millis(delay));
                                let all_gone = to_watch
                                    .iter()
                                    .all(|p| !std::path::Path::new(p).exists());
                                if all_gone {
                                    log::info!("latch clip shell-drop fate: shell took the source");
                                    return;
                                }
                                if copy_like {
                                    if let Some(dir) = dest_dir.as_deref() {
                                        let mut pending = false;
                                        for p in &to_watch {
                                            let path = std::path::Path::new(p);
                                            if !path.exists() {
                                                continue;
                                            }
                                            if shell_copy_verified(dir, p) {
                                                match std::fs::remove_file(path) {
                                                    Ok(()) => removed += 1,
                                                    Err(_) => pending = true, // share-lock; retry
                                                }
                                            } else {
                                                pending = true;
                                            }
                                        }
                                        if !pending {
                                            log::info!(
                                                "latch clip shell-drop fate: copy verified, {} source(s) reclaimed",
                                                removed
                                            );
                                            return;
                                        }
                                    }
                                }
                            }
                        });
                    }
                    // Always clean up the floating chip when the OS drag
                    // finishes — dropped or cancelled (skipped if the
                    // watchdog already ran the identical cleanup).
                    if first_settle {
                        emit_drag_cleanup(&app);
                    }
                },
                drag::Options {
                    shell_op: Some(shell_op),
                    ..Default::default()
                },
            );
            // start_drag failing (e.g. the button already released by the
            // time a slow clip render finished) never invokes the drop
            // callback — clean the chip up here or it sticks to the cursor
            // forever.
            if let Err(e) = res {
                log::error!("drag::start_drag failed: {e}");
                if !settled_for_err.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    os_drag_release_gate(gen);
                    emit_drag_cleanup(&app_for_err);
                }
            }
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"));
    if res.is_err() && !settled.swap(true, std::sync::atomic::Ordering::SeqCst) {
        os_drag_release_gate(gen);
    }
    res
}
