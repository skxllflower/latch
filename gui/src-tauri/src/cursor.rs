//! Native cursor positioning.
//!
//! Tauri's built-in `Window::set_cursor_position` goes through tao which
//! calls `SetCursorPos` on Windows. On the user's per-monitor v2 DPI-aware
//! 2x display, that path was depositing the cursor consistently offset
//! from the requested physical screen coords (cause was not pinned down —
//! suspected DPI awareness quirk in tao's conversion or some interaction
//! with the layered window flags Tauri uses).
//!
//! This command bypasses tao entirely and calls `SetPhysicalCursorPos`
//! directly. `SetPhysicalCursorPos` is documented to take RAW PHYSICAL
//! screen coordinates with no DPI conversion under any process awareness
//! mode — strictly the pixel address on the virtual desktop. Should
//! eliminate whatever was mangling the coordinates en route.
//!
//! macOS / Linux paths are stubbed for now; the call returns a soft
//! error message and the frontend swallows it (cursor stays where it
//! was at drag end).

#[tauri::command]
pub fn set_native_cursor_position(x: i32, y: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // SetPhysicalCursorPos takes virtual-desktop physical pixel coords.
        // Returns BOOL; nonzero on success.
        let ok = unsafe {
            windows::Win32::UI::WindowsAndMessaging::SetPhysicalCursorPos(x, y)
        };
        if ok.is_err() {
            return Err(format!("SetPhysicalCursorPos failed: {:?}", ok));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
        Err("set_native_cursor_position: not implemented on this platform".to_string())
    }
}
