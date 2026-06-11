// Native Win32 drag chip — replaces the Tauri webview-based drag
// overlay on Windows during a file-drag (DoDragDrop), where the
// modal pump on Tauri's main UI thread can stall window-position
// updates whenever a slow IDropTarget consumer in another process
// (Chrome / Discord / FL Studio) takes a long time on its DragOver
// callback. The Tauri overlay shares the main UI thread, so its
// SetWindowPos messages queue behind the modal pump's stalls and
// the chip visibly lags the cursor.
//
// This module solves that structurally: the chip lives in a real
// native Win32 layered window owned by a dedicated thread with its
// own message pump. SetWindowPos calls happen on the SAME thread
// as the window — no cross-thread message routing, no queueing
// behind anything. DoDragDrop on main can hold its modal pump for
// as long as it wants; the native chip's thread is unaffected.
//
// Cross-platform: this module is Windows-only. macOS's
// NSDraggingSession and Linux's XDND don't have the same modal-
// pump-stall issue (events route through per-runloop dispatch
// rather than blocking COM callbacks), so the existing Tauri
// webview chip stays in use on those platforms.
//
// Phase 1 (this file): infrastructure only — creates the layered
// window, sets up its message pump, supports show/hide/move from
// other threads. Renders a placeholder bitmap so we can verify the
// drag-over-Chrome stutter is structurally fixed before wiring up
// the real React→bitmap pipeline. Phase 2 will wire UpdateLayered
// Window with bitmaps captured from the React DragChip via
// html2canvas.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::WindowsAndMessaging::*;

// Custom thread-message tags used by the chip's owner (other Rust
// threads) to drive the chip without sharing pointers. PostThread
// Message wakes the chip's pump and the message-handling switch
// dispatches to the right action.
const WM_CHIP_SHOW:    u32 = WM_USER + 1;
const WM_CHIP_HIDE:    u32 = WM_USER + 2;
const WM_CHIP_QUIT:    u32 = WM_USER + 3;
const WM_CHIP_BITMAP:  u32 = WM_USER + 4;
// Tag for the WM_TIMER we use to read the position atomics each
// frame. Wired in StartThread.
const TIMER_ID_POSITION: usize = 1;
// Window's logical size — fixed for now (matches the Tauri
// drag-overlay's pre-spawn 1000×200 so we have room to display any
// chip variant without resizing). Phase 2 may refine this once we
// know the actual chip bitmap dimensions.
const CHIP_WINDOW_W: i32 = 1000;
const CHIP_WINDOW_H: i32 = 200;

// Active flag — true between drag_overlay_start and the matching
// stop. Used by the chip's WM_TIMER handler to gate cursor reads
// (we only follow the cursor while a drag is in flight).
static CHIP_VISIBLE: AtomicBool = AtomicBool::new(false);

// Cursor → chip offset in PHYSICAL pixels (down + right of the
// cursor tip). Mirrors drag_overlay's CHIP_OFFSET_X/Y so the
// native chip lands at the same spot the Tauri overlay would have.
const CHIP_OFFSET_X: i32 = 14;
const CHIP_OFFSET_Y: i32 = 10;

// Smoothed window position — read + written exclusively by the
// chip thread (WM_TIMER), with an i32::MIN sentinel to mark "first
// frame after show, snap to cursor instead of lerping". show()
// resets these so a fresh drag doesn't inherit the trail from the
// previous drop position.
//
// Lerp factor LERP_NUM/LERP_DEN per 16 ms tick. Lower numerator =
// longer/lazier trail. With (1 - 0.18)^N = remaining gap: after
// 250 ms (~15 ticks) ~6% gap remains, so the chip catches up
// fluidly without ever feeling sticky. Bump LERP_NUM up if it
// drags too much, down if it feels too tight.
static CUR_X: AtomicI32 = AtomicI32::new(i32::MIN);
static CUR_Y: AtomicI32 = AtomicI32::new(i32::MIN);
const LERP_NUM: i32 = 18;
const LERP_DEN: i32 = 100;

// ─────────────────────────────────────────────────────────────────
// Cross-process drop-target detection
// ─────────────────────────────────────────────────────────────────
//
// Each WM_TIMER tick we look at what TOP-LEVEL window the cursor is
// over and resolve it to a process exe filename (Discord.exe,
// Ableton Live 12 Suite.exe, explorer.exe, …). The JS side reads
// this via the localhost server's GET /target endpoint and renders
// a friendly label ("Send Kick.wav to Ableton Live") on the chip.
//
// Caching: WindowFromPoint + GetAncestor are fast (kernel calls),
// but OpenProcess + QueryFullProcessImageNameW are heavier. We
// cache the last seen top-level HWND and only re-resolve when it
// changes — typical drag spends seconds over the same target window
// so this knocks per-frame cost down to two cheap syscalls when
// idle and the full pipeline only on transitions.
//
// Self-suppression: when the cursor is over our own process, we
// clear EXTERNAL_EXE so the JS side falls back to the internal
// drag context (sidebar pin / collection / tag highlight). Without
// this, dragging within the app would label "Send Kick.wav to
// wavdesk".
static LAST_TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
static EXTERNAL_EXE: Mutex<String> = Mutex::new(String::new());
// When the cursor is over an Explorer window, the resolved folder
// path (e.g. "C:\Users\me\Music\Kicks"). Empty otherwise. Lets the
// JS side render "Copy Kick.wav to Kicks" rather than the generic
// "Copy Kick.wav to File Explorer". Resolved on HWND transitions
// only — same caching as EXTERNAL_EXE.
static EXTERNAL_FOLDER: Mutex<String> = Mutex::new(String::new());
static OWN_PID: OnceLock<u32> = OnceLock::new();

/// Snapshot of the exe filename of the top-level window currently
/// under the cursor (basename only, e.g. "discord.exe"). Empty when
/// the cursor is over our own process or no resolvable window.
/// Read by chip_bitmap_server's GET /target endpoint each poll.
pub fn current_external_exe() -> String {
    EXTERNAL_EXE.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Snapshot of the resolved Explorer folder path under the cursor.
/// Empty when the cursor isn't over an Explorer window or when COM
/// resolution failed (virtual folders, "This PC", etc.). The JS
/// side basename's this for display.
pub fn current_external_folder() -> String {
    EXTERNAL_FOLDER.lock().map(|s| s.clone()).unwrap_or_default()
}

// The chip thread's TID so other threads can PostThreadMessage to
// it without holding a reference. Set once when the thread is
// spawned; never cleared (the thread runs for app lifetime).
static CHIP_TID: AtomicU32 = AtomicU32::new(0);

// One-time initialization guard — spawn the thread on first call,
// no-op subsequent calls. The chip thread is meant to live for the
// app's lifetime; spawning multiple would create overlapping windows.
static SPAWN_GUARD: OnceLock<()> = OnceLock::new();

// Pending bitmap from JS — populated by update_bitmap (called from
// the drag_chip_set_bitmap Tauri command), drained by the chip
// thread's WM_CHIP_BITMAP handler. RGBA in CSS-pixel order; the
// chip thread converts to premultiplied BGRA and hands to
// UpdateLayeredWindow. Mutex<Option<...>> so a stale frame is
// dropped if a fresher one arrives before the chip thread woke up.
struct PendingBitmap {
    rgba:   Vec<u8>,
    width:  u32,
    height: u32,
}
static PENDING_BITMAP: Mutex<Option<PendingBitmap>> = Mutex::new(None);

// Current chip dimensions — read by the WM_TIMER handler so it
// knows the rendered chip's size (used by SetWindowPos's no-op
// SWP_NOSIZE flag, which doesn't actually resize, but kept here
// in case future code wants to reposition based on chip extents).
// Initial value is the placeholder size; updated each time a fresh
// bitmap arrives.
static CHIP_W: AtomicI32 = AtomicI32::new(320);
static CHIP_H: AtomicI32 = AtomicI32::new(32);

/// Spawn the chip thread on first call, no-op afterwards. Safe to
/// call from any thread. The thread creates the layered window and
/// runs its message pump for the rest of the app's life.
pub fn ensure_thread_spawned() {
    SPAWN_GUARD.get_or_init(|| {
        std::thread::spawn(chip_thread_main);
    });
}

/// Make the chip visible and start it tracking the cursor. Resets
/// the smoothed-position sentinel so the next WM_TIMER snaps to
/// the cursor (no inherited trail from where the chip was dropped
/// last time).
pub fn show() {
    CHIP_VISIBLE.store(true, Ordering::SeqCst);
    CUR_X.store(i32::MIN, Ordering::SeqCst);
    CUR_Y.store(i32::MIN, Ordering::SeqCst);
    let tid = CHIP_TID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_CHIP_SHOW, WPARAM(0), LPARAM(0));
        }
    }
}

/// Hide the chip. Idempotent.
pub fn hide() {
    CHIP_VISIBLE.store(false, Ordering::SeqCst);
    // Reset cross-process state too — without this, the next drag
    // would briefly carry over the previous drop's target exe until
    // the JS poll catches up + the chip thread re-resolves.
    LAST_TARGET_HWND.store(0, Ordering::SeqCst);
    if let Ok(mut e) = EXTERNAL_EXE.lock() { e.clear(); }
    if let Ok(mut f) = EXTERNAL_FOLDER.lock() { f.clear(); }
    let tid = CHIP_TID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_CHIP_HIDE, WPARAM(0), LPARAM(0));
        }
    }
}

// Note: there is no set_position helper on this module any more.
// The chip reads the OS cursor itself via GetCursorPos in its
// WM_TIMER handler — no cross-thread coordination, no risk that
// any other thread's stall could starve our position updates.
// Same thread reads cursor and calls SetWindowPos = bulletproof.

/// Push a fresh bitmap from the React DragChip's html2canvas
/// capture. Called from the drag_chip_set_bitmap Tauri command on
/// any state-relevant chip change (modifier flip, target label
/// update, theme/language). The chip thread picks up the buffer
/// on its next WM_CHIP_BITMAP wake and calls UpdateLayeredWindow
/// — no per-frame paint, just a single update when the bitmap
/// actually changes. Position tracking continues independently
/// via WM_TIMER.
pub fn update_bitmap(rgba: Vec<u8>, width: u32, height: u32) {
    if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
        return; // malformed — silently drop
    }
    {
        let mut pending = PENDING_BITMAP.lock().unwrap();
        *pending = Some(PendingBitmap { rgba, width, height });
    }
    let tid = CHIP_TID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_CHIP_BITMAP, WPARAM(0), LPARAM(0));
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────

fn chip_thread_main() {
    unsafe {
        // Record this thread's TID so PostThreadMessage targeting
        // works. Win32's GetCurrentThreadId is a thin syscall.
        use windows::Win32::System::Threading::GetCurrentThreadId;
        CHIP_TID.store(GetCurrentThreadId(), Ordering::SeqCst);

        let hwnd = match create_chip_window() {
            Ok(h) => h,
            Err(e) => {
                log::error!("native_drag_chip: window creation failed: {e:?}");
                return;
            }
        };

        // Render a placeholder bitmap so we can verify the chip
        // shows + tracks the cursor before the real bitmap pipeline
        // is wired in Phase 2. Solid translucent rectangle in the
        // accent color — instantly recognizable as "the chip" but
        // distinct from the Tauri-based one for side-by-side test.
        if let Err(e) = paint_placeholder(hwnd) {
            log::warn!("native_drag_chip: placeholder paint failed: {e:?}");
        }

        // 60 Hz position poll. WM_TIMER handler in our wndproc
        // reads CHIP_X/Y and calls SetWindowPos. SetWindowPos here
        // executes on this thread (same thread as the window) so
        // it's effectively synchronous — no cross-thread queueing.
        let _ = SetTimer(Some(hwnd), TIMER_ID_POSITION, 16, None);

        // Standard Win32 message pump. PostThreadMessage delivers
        // WM_CHIP_SHOW/HIDE/QUIT here; WM_TIMER fires from the
        // SetTimer above. Anything else falls through to
        // DefWindowProc.
        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                break;
            }
            match msg.message {
                WM_CHIP_SHOW => {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    // Re-pin to the top of the always-on-top tier.
                    // Other AOT windows in the app (Lathe, find-similar,
                    // sticky notes) get bumped above the chip when the
                    // OS promotes them on activation — without this
                    // re-assert, the chip is invisibly stuck below them
                    // as soon as the user clicks on those windows. The
                    // WM_TIMER position update uses SWP_NOZORDER so it
                    // can't fix this on its own.
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                WM_CHIP_HIDE => {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
                WM_CHIP_QUIT => {
                    PostQuitMessage(0);
                }
                WM_CHIP_BITMAP => {
                    // Drain the latest pending bitmap. .take() leaves
                    // None behind so a follow-up WM_CHIP_BITMAP that
                    // arrives before the next state change is a
                    // cheap no-op. RGBA → premultiplied BGRA →
                    // CreateDIBSection → UpdateLayeredWindow.
                    let pending = PENDING_BITMAP.lock().unwrap().take();
                    if let Some(bmp) = pending {
                        if let Err(e) = apply_chip_bitmap(hwnd, &bmp.rgba, bmp.width, bmp.height) {
                            log::warn!("native_drag_chip: bitmap apply failed: {e:?}");
                        }
                    }
                }
                _ => {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }

        let _ = KillTimer(Some(hwnd), TIMER_ID_POSITION);
        let _ = DestroyWindow(hwnd);
    }
}

unsafe fn create_chip_window() -> Result<HWND> {
    let class_name = w!("WAVdeskNativeChip");
    let hinstance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)?;

    let wc = WNDCLASSW {
        lpfnWndProc:   Some(wndproc),
        hInstance:     hinstance.into(),
        lpszClassName: class_name,
        // No background brush — UpdateLayeredWindow handles all the
        // pixels. A non-null hbrBackground would briefly paint the
        // window with that color before the layered update lands.
        hbrBackground: HBRUSH(std::ptr::null_mut()),
        ..Default::default()
    };
    // Best-effort registration: ignore "class already exists" on
    // re-init paths (shouldn't happen since SPAWN_GUARD is OnceLock,
    // but defensive).
    RegisterClassW(&wc);

    // WS_EX_LAYERED       — required for UpdateLayeredWindow alpha
    // WS_EX_TRANSPARENT   — clicks pass through (chip never owns
    //                       the click target during a drag)
    // WS_EX_TOPMOST       — over every other window
    // WS_EX_NOACTIVATE    — doesn't steal focus from main on show
    // WS_EX_TOOLWINDOW    — no entry in the alt-tab list
    let ex_style = WS_EX_LAYERED
        | WS_EX_TRANSPARENT
        | WS_EX_TOPMOST
        | WS_EX_NOACTIVATE
        | WS_EX_TOOLWINDOW;

    let hwnd = CreateWindowExW(
        ex_style,
        class_name,
        w!("WAVdesk Drag Chip"),
        WS_POPUP,
        0, 0,
        CHIP_WINDOW_W,
        CHIP_WINDOW_H,
        None,
        None,
        Some(hinstance.into()),
        None,
    )?;
    Ok(hwnd)
}

// Resolve the top-level HWND under `cursor` to a process exe
// basename, with HWND-based caching so we only pay the heavier
// OpenProcess / QueryFullProcessImageNameW costs on transitions.
// Updates EXTERNAL_EXE in-place; returns nothing (caller doesn't
// need the value, it'll be served via current_external_exe()).
//
// Returns silently on any failure — partial detection is fine, we
// just leave the previous EXTERNAL_EXE in place. The next valid
// transition overwrites it.
unsafe fn refresh_external_target(cursor: POINT) {
    let hwnd = WindowFromPoint(cursor);
    if hwnd.0.is_null() { return; }
    let top = GetAncestor(hwnd, GA_ROOT);
    if top.0.is_null() { return; }

    // HWND cache — if the top-level window hasn't changed since the
    // last tick, don't re-resolve (typical drag spends seconds over
    // the same target). Stored as isize since AtomicHwnd doesn't
    // exist; HWND is an opaque pointer so the bit pattern compare
    // is fine.
    let top_as_isize = top.0 as isize;
    if LAST_TARGET_HWND.load(Ordering::SeqCst) == top_as_isize {
        return;
    }
    LAST_TARGET_HWND.store(top_as_isize, Ordering::SeqCst);

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(top, Some(&mut pid));
    if pid == 0 { return; }

    // Self-process suppression — when cursor is over our own window,
    // clear EXTERNAL_EXE so the JS side falls back to internal drag
    // context (sidebar pin label, collection name, etc.).
    let own_pid = *OWN_PID.get_or_init(|| GetCurrentProcessId());
    if pid == own_pid {
        if let Ok(mut e) = EXTERNAL_EXE.lock()    { e.clear(); }
        if let Ok(mut f) = EXTERNAL_FOLDER.lock() { f.clear(); }
        return;
    }

    let proc_handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(h) => h,
        Err(_) => return,
    };

    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let result = QueryFullProcessImageNameW(
        proc_handle,
        PROCESS_NAME_WIN32,
        PWSTR(buf.as_mut_ptr()),
        &mut len,
    );
    let _ = CloseHandle(proc_handle);
    if result.is_err() || len == 0 { return; }

    let path = String::from_utf16_lossy(&buf[..len as usize]);
    // Basename — last \ or / split.
    let name = path.rsplit(|c| c == '\\' || c == '/').next().unwrap_or(&path);
    let name_owned = name.to_string();
    if let Ok(mut e) = EXTERNAL_EXE.lock() { *e = name_owned.clone(); }

    // Explorer enrichment — if this is an Explorer window, walk the
    // shell COM chain to resolve the displayed folder path. Skipped
    // for every other exe. Resolution failure (virtual folders,
    // network locations, etc.) is fine — JS falls back to the bare
    // "File Explorer" label.
    if name_owned.eq_ignore_ascii_case("explorer.exe") {
        let folder = crate::explorer_folder::resolve_explorer_folder_path(top)
            .unwrap_or_default();
        if let Ok(mut f) = EXTERNAL_FOLDER.lock() { *f = folder; }
    } else {
        if let Ok(mut f) = EXTERNAL_FOLDER.lock() { f.clear(); }
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER => {
            // Read OS cursor + apply lerp toward it, then SetWindow
            // Pos same-thread. All native syscalls; no Tauri
            // runtime, no cross-thread atomic dance with a writer
            // that could be stuck behind DoDragDrop's modal pump.
            //
            // Lerp = inertial trail behind the cursor. cur_x lerps
            // toward target_x by LERP_NUM/LERP_DEN (30%) per tick
            // — same factor the existing drag-overlay poll thread
            // uses for the Tauri-overlay path, so the file-drag
            // chip's feel is consistent across both rendering
            // backends. i32::MIN sentinel means "first frame, snap
            // instead of lerp" (set by show() to prevent the chip
            // from sliding in from the last drop position).
            if CHIP_VISIBLE.load(Ordering::SeqCst) {
                let mut p = POINT::default();
                if GetCursorPos(&mut p).is_ok() {
                    // Cross-process target detection — cheap on
                    // steady-state (just WindowFromPoint + a HWND
                    // compare); only resolves the exe path when the
                    // top-level window changes.
                    refresh_external_target(p);
                    let target_x = p.x + CHIP_OFFSET_X;
                    let target_y = p.y + CHIP_OFFSET_Y;
                    let prev_x = CUR_X.load(Ordering::SeqCst);
                    let prev_y = CUR_Y.load(Ordering::SeqCst);
                    let (new_x, new_y) = if prev_x == i32::MIN || prev_y == i32::MIN {
                        (target_x, target_y)
                    } else {
                        (
                            prev_x + (target_x - prev_x) * LERP_NUM / LERP_DEN,
                            prev_y + (target_y - prev_y) * LERP_NUM / LERP_DEN,
                        )
                    };
                    CUR_X.store(new_x, Ordering::SeqCst);
                    CUR_Y.store(new_y, Ordering::SeqCst);
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        new_x, new_y,
                        0, 0,
                        SWP_ASYNCWINDOWPOS | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOREDRAW,
                    );
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// Apply an RGBA bitmap (as produced by html2canvas + getImageData
// in the React drag overlay) to the chip's layered window. Walks
// the buffer once converting RGBA → premultiplied BGRA (the format
// UpdateLayeredWindow's per-pixel-alpha mode wants), allocates a
// DIB section of that exact size, and hands it to the OS via
// UpdateLayeredWindow. CHIP_W/CHIP_H atomics record the new
// dimensions for any future code that wants them.
unsafe fn apply_chip_bitmap(hwnd: HWND, rgba: &[u8], width: u32, height: u32) -> Result<()> {
    let w = width as i32;
    let h = height as i32;
    if w <= 0 || h <= 0 {
        return Ok(());
    }

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize:        std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth:       w,
            biHeight:      -h, // negative = top-down DIB
            biPlanes:      1,
            biBitCount:    32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(Some(screen_dc));
    let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let dib = CreateDIBSection(
        Some(screen_dc),
        &bmi,
        DIB_RGB_COLORS,
        &mut bits_ptr,
        None,
        0,
    )?;

    // RGBA (canvas order, straight alpha) → BGRA (Win32 DIB order,
    // premultiplied alpha). Per-pixel: dst_b = src_b * a / 255, etc.
    let pixels = bits_ptr as *mut u8;
    let n = (w * h) as usize;
    for i in 0..n {
        let src = i * 4;
        let r = rgba[src]     as u32;
        let g = rgba[src + 1] as u32;
        let b = rgba[src + 2] as u32;
        let a = rgba[src + 3] as u32;
        let dst = (i * 4) as isize;
        *pixels.offset(dst)     = ((b * a) / 255) as u8;
        *pixels.offset(dst + 1) = ((g * a) / 255) as u8;
        *pixels.offset(dst + 2) = ((r * a) / 255) as u8;
        *pixels.offset(dst + 3) = a as u8;
    }

    let old_obj = SelectObject(mem_dc, dib.into());

    let blend = BLENDFUNCTION {
        BlendOp:             AC_SRC_OVER as u8,
        BlendFlags:          0,
        SourceConstantAlpha: 255,
        AlphaFormat:         AC_SRC_ALPHA as u8,
    };
    let size  = SIZE { cx: w, cy: h };
    let psrc  = POINT { x: 0, y: 0 };
    UpdateLayeredWindow(
        hwnd,
        Some(screen_dc),
        None,
        Some(&size),
        Some(mem_dc),
        Some(&psrc),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    )?;

    SelectObject(mem_dc, old_obj);
    let _ = DeleteObject(dib.into());
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);

    CHIP_W.store(w, Ordering::SeqCst);
    CHIP_H.store(h, Ordering::SeqCst);
    Ok(())
}

// Bootstrap placeholder shown until the first React-captured bitmap
// arrives. Translucent zinc-700 pillbox so the user sees something
// chip-shaped while the html2canvas pipeline warms up. Identical
// path to apply_chip_bitmap (RGBA → premultiplied BGRA →
// UpdateLayeredWindow), just with synthetic pixels instead of
// React-captured ones.
unsafe fn paint_placeholder(hwnd: HWND) -> Result<()> {
    const W: u32 = 320;
    const H: u32 = 32;
    let alpha: u8 = 220;
    let mut rgba = vec![0u8; (W * H * 4) as usize];
    for i in 0..(W * H) as usize {
        let o = i * 4;
        rgba[o]     = 70;     // R
        rgba[o + 1] = 63;     // G
        rgba[o + 2] = 63;     // B
        rgba[o + 3] = alpha;
    }
    apply_chip_bitmap(hwnd, &rgba, W, H)
}
