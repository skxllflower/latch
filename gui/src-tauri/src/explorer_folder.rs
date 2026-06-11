// Resolve the folder path currently displayed in a Windows Explorer
// window. Used by the drag chip to label drops over Explorer with
// the actual destination folder name ("Copy Kick.wav to My Kick
// Folder") instead of just "File Explorer".
//
// How this works
// ──────────────
// IShellWindows is a COM service Explorer registers itself with —
// every open Explorer window (CabinetWClass / ExploreWClass) shows
// up as an entry. Each entry exposes IServiceProvider, from which
// we can pull SID_STopLevelBrowser → IShellBrowser, then walk the
// chain:
//   IShellBrowser → IShellView → IFolderView2 → IPersistFolder2
// IPersistFolder2::GetCurFolder gives back a PIDL (shell-namespace
// item identifier list); SHGetPathFromIDListEx flattens that to a
// regular filesystem path.
//
// We could also enumerate IShellWindows::Item by index, query each
// for its top-level HWND via IWebBrowser2::HWND, and match — but
// FindWindowSW does that lookup natively in one call. Slightly
// less Rust noise.
//
// Threading
// ─────────
// COM has to be initialized per-thread before any COM calls land.
// CoInitializeEx returns S_FALSE if the thread already initialized
// COM (e.g. Tauri did so during webview construction); both S_OK
// and S_FALSE are safe to proceed past, only the explicit error
// HRESULTs (RPC_E_CHANGED_MODE, etc.) bail. We don't CoUninitialize
// since the chip thread runs for the app's lifetime.
//
// Performance
// ───────────
// Caller (native_drag_chip) already caches "last seen HWND" so this
// is only invoked on transitions — typically once per drag. Each
// resolution does ~5 COM calls; a CoCreateInstance for IShellWindows
// is the heaviest single op (a few ms). Acceptable on a transition.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;

// CoInitializeEx-on-this-thread guard. Set true after the first
// successful (or no-op-already-init) call so subsequent resolutions
// skip the syscall.
static COM_INITIALIZED: AtomicBool = AtomicBool::new(false);

fn ensure_com_initialized() {
    if COM_INITIALIZED.load(Ordering::Relaxed) { return; }
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // S_OK = first init on this thread; S_FALSE = already
        // initialized (compatible mode). Both are fine. RPC_E_
        // CHANGED_MODE means the thread previously initialized in
        // a different apartment model — we'd live with that and
        // skip the resolution rather than crash.
        if hr.is_ok() || hr.0 == 1 /* S_FALSE */ {
            COM_INITIALIZED.store(true, Ordering::Relaxed);
        }
    }
}

/// Resolve `hwnd` (a top-level Explorer window) to the filesystem
/// path of the folder it's currently displaying. Returns None when:
///   • COM init fails (rare; usually a different apartment in the
///     thread, in which case caller's previous result still stands)
///   • the HWND isn't a registered Explorer window (e.g. the user's
///     dragging over a Cabinet view we don't recognize)
///   • the displayed location isn't a real path (Quick Access, This
///     PC, network virtual folders)
///   • any of the COM calls along the way fails
pub fn resolve_explorer_folder_path(hwnd: HWND) -> Option<String> {
    ensure_com_initialized();
    unsafe {
        // The IShellWindows COM object — the index of every open
        // Explorer / IE window on the system.
        let shell_windows: IShellWindows = CoCreateInstance(
            &ShellWindows,
            None,
            CLSCTX_LOCAL_SERVER,
        ).ok()?;

        // FindWindowSW: filter the registered windows to ones in
        // SWC_BROWSER class (Explorer / IE), match by HWND, and
        // request an IDispatch back so we can QueryInterface from
        // there. lhwnd is in/out — we don't care about its return
        // value but the call requires the param.
        let v_wnd = VARIANT::from(hwnd.0 as i32);
        let v_class = VARIANT::default(); // VT_EMPTY = "any class"
        let mut lhwnd: i32 = 0;
        let dispatch: IDispatch = shell_windows.FindWindowSW(
            &v_wnd,
            &v_class,
            SWC_BROWSER,
            &mut lhwnd,
            SWFO_NEEDDISPATCH,
        ).ok()?;

        // IServiceProvider opens the door to interface chasing on
        // the IDispatch; SID_STopLevelBrowser gets us IShellBrowser
        // for the active view.
        let svc: IServiceProvider = dispatch.cast().ok()?;
        let shell_browser: IShellBrowser = svc.QueryService(&SID_STopLevelBrowser).ok()?;
        let shell_view: IShellView = shell_browser.QueryActiveShellView().ok()?;

        // IFolderView2 → IPersistFolder2 chain. IFolderView (no 2)
        // also works for GetFolder; using the 2 variant for futureproofing.
        let folder_view: IFolderView2 = shell_view.cast().ok()?;
        let persist_folder: IPersistFolder2 = folder_view.GetFolder().ok()?;

        // PIDL = shell namespace item identifier list. Allocated by
        // the COM call; SHGetPathFromIDListEx flattens it. We free
        // via CoTaskMemFree once the path string is extracted.
        let pidl: *mut ITEMIDLIST = persist_folder.GetCurFolder().ok()?;
        if pidl.is_null() { return None; }

        let mut buf = [0u16; 1024];
        let ok = SHGetPathFromIDListEx(
            pidl,
            &mut buf,
            GPFIDL_DEFAULT,
        ).as_bool();
        CoTaskMemFree(Some(pidl as *const _));

        if !ok { return None; }

        // Convert the wchar buffer to a Rust String, trimming the
        // trailing NUL chunk.
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if len == 0 { return None; }
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

// Note: basename-from-path formatting lives on the JS side
// (dropTargetResolver.ts) so the chip can show either the full
// path or just the leaf based on user preference / chip width
// without round-tripping through Rust.
