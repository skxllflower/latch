// Cross-platform drag-overlay window machinery — pure cursor
// positioning. Drag lifecycle is owned by the OS-level drag (DoDragDrop
// on Windows, NSDragging on macOS, XDND on Linux) initiated through
// ipc::start_os_file_drag. This module just keeps the floating chip
// glued to the cursor for the duration.
//
// Why an overlay window: the chip used to render inline with
// position:fixed inside the originating webview. That clipped to the
// WebView's bounds and vanished the moment the cursor crossed past
// them — and JS-driven mouse routing across overlapping webviews in
// the same process is unreliable enough that we couldn't keep the
// chip glued via DOM events alone. A separate borderless transparent
// always-on-top webview, repositioned every frame from a Rust
// background thread reading the global cursor via Tauri's
// cross-platform API, gives us a chip that follows the cursor
// anywhere on screen — over our own windows, over external apps,
// over the desktop — without any of those routing concerns.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use device_query::{DeviceQuery, DeviceState, Keycode};
use tauri::{AppHandle, Manager, PhysicalPosition};

const OVERLAY_LABEL: &str = "drag-overlay";

// Note: the SWP_ASYNCWINDOWPOS-based fast_move_window helper that
// used to live here was a partial-fix for the modal-pump stall —
// it's been superseded on Windows by native_drag_chip, which puts
// the chip in its own thread + window so the stall is structurally
// avoided. Non-Windows platforms still call overlay.set_position
// directly because they don't have the equivalent issue.

// Lerp factor applied to the overlay-position update each tick. 0.30
// gives ~1.5 frames of trail at 60Hz — perceptible-but-snappy. Lower
// (0.15) reads as too sluggish; higher (0.5+) becomes a sterile snap.
const LERP_FACTOR: f32 = 0.30;

// Cursor → chip offset (down + right of the cursor tip). Mirrors the
// OS drag-cursor convention so the chip never covers the click point
// the user is aiming with.
const CHIP_OFFSET_X: f32 = 14.0;
const CHIP_OFFSET_Y: f32 = 10.0;

// While true, the poll thread is running and the overlay is being
// repositioned every frame. Flipped on by drag_overlay_start, off by
// drag_overlay_stop OR by ipc::start_os_file_drag's drop callback
// (via mark_drag_inactive) when DoDragDrop completes.
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

// Most-recent polled cursor position (screen coords, pixel-snapped
// to integers). Kept around for any caller that wants the chip's
// last-rendered position without re-reading the OS cursor.
static LAST_CURSOR_X: AtomicI32 = AtomicI32::new(0);
static LAST_CURSOR_Y: AtomicI32 = AtomicI32::new(0);

// Most-recent polled keyboard modifier state. The poll thread
// updates this each tick from the OS-level keyboard state via
// device_query — that's the only reliable read of Ctrl/Cmd while
// DoDragDrop's modal pump on Windows captures keyboard input for
// its own copy/move/link handling, blocking JS-level keydown
// events from firing until after the drag releases. handleOsDrop
// reads this via the drag_overlay_modifier_state command at drop
// time so a Ctrl-held drop actually fires fs_copy instead of
// fs_move.
static MOD_CTRL: AtomicBool = AtomicBool::new(false);
static MOD_SHIFT: AtomicBool = AtomicBool::new(false);

// Cached AppHandle, set on first start. The poll thread can't be
// passed an &AppHandle directly (it outlives a single command call),
// and AppHandle is Clone + Send so cloning into the static is fine.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Begin a drag. Snaps the overlay to the current cursor, shows it,
/// and spawns the cursor-poll thread. Idempotent — calling while a
/// drag is already active is a no-op (lets a stray double-fire from
/// React strict mode or a missed stop pass through harmlessly).
///
/// Re-pins the overlay to the top of the always-on-top tier on every
/// start so other AOT windows in the app (Lathe, find-similar,
/// sticky notes) that the OS may have promoted above us during their
/// last activation don't end up covering the chip.
#[tauri::command]
pub fn drag_overlay_start(app: AppHandle) -> Result<(), String> {
    let _ = APP_HANDLE.set(app.clone());
    if DRAG_ACTIVE.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // Windows-only: spawn (or reuse) the native chip thread. This
    // is the structural fix for the "drag stutters over Chrome /
    // Discord / FL Studio" bug — the native chip lives in its own
    // Win32 layered window owned by a dedicated thread, so DoDrag
    // Drop's modal pump on the Tauri main thread can't stall its
    // SetWindowPos calls. Tauri overlay stays the path on macOS /
    // Linux, where the same modal-pump issue doesn't exist.
    #[cfg(target_os = "windows")]
    crate::native_drag_chip::ensure_thread_spawned();

    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        if let Ok(cursor) = overlay.cursor_position() {
            let x = cursor.x.round() as i32;
            let y = cursor.y.round() as i32;
            LAST_CURSOR_X.store(x, Ordering::SeqCst);
            LAST_CURSOR_Y.store(y, Ordering::SeqCst);
            // Non-Windows: the Tauri overlay IS the visible chip,
            // so we position it at the cursor for show().
            #[cfg(not(target_os = "windows"))]
            let _ = overlay.set_position(PhysicalPosition::new(
                x + CHIP_OFFSET_X as i32,
                y + CHIP_OFFSET_Y as i32,
            ));
            let _ = x; let _ = y;
        }
        // Windows: park the Tauri overlay OFFSCREEN and show it.
        // It needs to be technically "visible" to the OS so WebView2
        // keeps running layout + paint inside it — that's what
        // html2canvas relies on to read the chip's computed sizes.
        // If we leave it hidden, WebView2 can short-circuit layout
        // and html2canvas captures a 0×0 chip. Parked at -32000 so
        // it can't ever be seen by the user even on a multi-monitor
        // setup that extends into negative coordinates. The native
        // chip is what's visible at the cursor.
        #[cfg(target_os = "windows")]
        {
            let _ = overlay.set_position(PhysicalPosition::new(-32000, -32000));
            let _ = overlay.show();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = overlay.show();
            let _ = overlay.set_always_on_top(false);
            let _ = overlay.set_always_on_top(true);
        }
    }
    #[cfg(target_os = "windows")]
    crate::native_drag_chip::show();

    spawn_poll_thread(app);
    Ok(())
}

/// End a drag. Hides the overlay, clears DRAG_ACTIVE so the poll
/// thread exits on its next tick. Safe to call when no drag is
/// active — the overlay's already-hidden case is a cheap no-op.
#[tauri::command]
pub fn drag_overlay_stop(app: AppHandle) -> Result<(), String> {
    DRAG_ACTIVE.store(false, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    crate::native_drag_chip::hide();
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
    }
    Ok(())
}

/// Convenience for callers that want the most-recently-polled cursor
/// position without re-reading the OS cursor. The poll thread updates
/// this every ~16ms while a drag is active.
#[tauri::command]
pub fn drag_overlay_last_cursor() -> Result<(i32, i32), String> {
    Ok((
        LAST_CURSOR_X.load(Ordering::SeqCst),
        LAST_CURSOR_Y.load(Ordering::SeqCst),
    ))
}

/// Read the most-recently polled Ctrl + Shift state. handleOsDrop in
/// JS calls this at drop time so a Ctrl-held drop fires fs_copy
/// instead of fs_move — DoDragDrop's modal pump captures keyboard
/// input for its own modifier handling, so JS document.keydown
/// events queue and only fire AFTER the drag releases, leaving JS
/// state stale at drop time. The poll thread reads keyboard state
/// every ~16ms regardless of DoDragDrop, so this read is fresh.
#[tauri::command]
pub fn drag_overlay_modifier_state() -> Result<(bool, bool), String> {
    Ok((
        MOD_CTRL.load(Ordering::SeqCst),
        MOD_SHIFT.load(Ordering::SeqCst),
    ))
}

/// Internal accessors for the live modifier state — same atomics
/// the IPC command above reads. Lets other modules (e.g.
/// chip_bitmap_server's /target endpoint) include modifier flags in
/// their own responses without going through Tauri IPC, which is
/// blocked by DoDragDrop's modal pump on Windows during a drag.
pub fn is_ctrl_held()  -> bool { MOD_CTRL.load(Ordering::SeqCst) }
pub fn is_shift_held() -> bool { MOD_SHIFT.load(Ordering::SeqCst) }

/// Internal helper for ipc::start_os_file_drag's completion callback
/// to flip DRAG_ACTIVE off without going through the IPC layer.
pub fn mark_drag_inactive() {
    DRAG_ACTIVE.store(false, Ordering::SeqCst);
}

/// Push a fresh bitmap (RGBA from the React DragChip's html2canvas
/// capture) to the native chip's layered window. Called from JS
/// whenever a state-relevant chip change happens (modifier flip,
/// target label update, theme/language). Windows-only effect; on
/// other platforms the JS side falls through to the existing Tauri
/// overlay rendering, so this is a no-op there.
#[tauri::command]
pub fn drag_chip_set_bitmap(
    rgba: Vec<u8>, width: u32, height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    crate::native_drag_chip::update_bitmap(rgba, width, height);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (rgba, width, height);
    }
    Ok(())
}

/// Returns the localhost URL the drag-overlay's JS should POST chip
/// bitmaps to. Called ONCE by the JS at app startup (cached for the
/// session) so the per-frame capture path doesn't depend on Tauri
/// IPC during a drag — fetch() to localhost bypasses main's modal
/// pump, which is what kept blocking the bitmap delivery before.
///
/// Empty string when:
///   • non-Windows (no native chip; existing Tauri overlay path
///     handles rendering normally)
///   • the server hasn't bound yet (chip_bitmap_server::start was
///     never called, or it failed) — JS falls back to the IPC path
#[tauri::command]
pub fn get_chip_bitmap_endpoint() -> String {
    #[cfg(target_os = "windows")]
    {
        let port = crate::chip_bitmap_server::current_port();
        if port == 0 {
            return String::new();
        }
        return format!("http://127.0.0.1:{port}/bitmap");
    }
    #[allow(unreachable_code)]
    String::new()
}

fn spawn_poll_thread(app: AppHandle) {
    std::thread::spawn(move || {
        let mut cur_x = LAST_CURSOR_X.load(Ordering::SeqCst) as f32;
        let mut cur_y = LAST_CURSOR_Y.load(Ordering::SeqCst) as f32;
        // device_query is allocated once outside the loop — its
        // platform backends (raw input on Windows, X11 connection
        // on Linux, CGEvent on macOS) cache initialization here so
        // get_keys() doesn't re-open per tick.
        let device_state = DeviceState::new();
        // ~60Hz. 120Hz showed no perceptible difference in chip
        // latency on test hardware and just burns CPU.
        let interval = Duration::from_millis(16);

        loop {
            if !DRAG_ACTIVE.load(Ordering::SeqCst) {
                break;
            }

            // Cursor positioning.
            let cursor_pos = app
                .get_webview_window(OVERLAY_LABEL)
                .and_then(|w| w.cursor_position().ok());

            if let Some(pos) = cursor_pos {
                let target_x = pos.x as f32;
                let target_y = pos.y as f32;
                cur_x += (target_x - cur_x) * LERP_FACTOR;
                cur_y += (target_y - cur_y) * LERP_FACTOR;

                LAST_CURSOR_X.store(target_x.round() as i32, Ordering::SeqCst);
                LAST_CURSOR_Y.store(target_y.round() as i32, Ordering::SeqCst);

                let next_x = cur_x.round() as i32 + CHIP_OFFSET_X as i32;
                let next_y = cur_y.round() as i32 + CHIP_OFFSET_Y as i32;

                // Windows: native chip reads cursor itself on its
                // own thread (see native_drag_chip's WM_TIMER), so
                // we don't need to feed position from here. This
                // poll thread still runs to keep modifier polling
                // alive (drag_overlay_modifier_state IPC) + to
                // update LAST_CURSOR_X/Y for any caller that wants
                // the last cursor sample.
                //
                // Non-Windows: fall back to set_position on the
                // Tauri overlay. macOS NSDraggingSession + Linux
                // XDND don't have the same modal-pump issue, so
                // the Tauri overlay still works smoothly there.
                #[cfg(not(target_os = "windows"))]
                {
                    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
                        let _ = overlay.set_position(PhysicalPosition::new(next_x, next_y));
                    }
                }
                let _ = next_x;
                let _ = next_y;
            }

            // Keyboard modifier polling. device_query.get_keys()
            // returns currently-pressed Keycodes from OS-level
            // keyboard state — bypasses DoDragDrop's modal pump on
            // Windows that captures keyboard for its own modifier
            // handling. Both LCtrl/RCtrl + LShift/RShift +
            // (LMeta/RMeta on macOS via the Command alias) are
            // mapped to the platform-conventional "copy modifier"
            // since user expectation is "Ctrl on Windows, Cmd on
            // Mac" — both surface as a Copy via copyModeRef on the
            // JS side.
            let keys = device_state.get_keys();
            let ctrl_now = keys.iter().any(|k| matches!(
                k,
                Keycode::LControl | Keycode::RControl |
                Keycode::Command  |
                Keycode::LMeta    | Keycode::RMeta
            ));
            let shift_now = keys.iter().any(|k| matches!(
                k,
                Keycode::LShift | Keycode::RShift
            ));
            MOD_CTRL.store(ctrl_now, Ordering::SeqCst);
            MOD_SHIFT.store(shift_now, Ordering::SeqCst);

            std::thread::sleep(interval);
        }

        if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = overlay.hide();
        }
        // Windows: also hide the native chip when the poll thread
        // exits (drag ended via mark_drag_inactive from
        // start_os_file_drag's drop callback, which flips DRAG_ACTIVE
        // false but doesn't go through drag_overlay_stop). Without
        // this the chip stays visible glued to the cursor after
        // drop.
        #[cfg(target_os = "windows")]
        crate::native_drag_chip::hide();
    });
}
