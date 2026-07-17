// Copyright 2023-2023 CrabNebula Ltd.
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//!Start a drag operation out of a window on macOS, Windows and Linux (via GTK).
//!
//! Tested for [tao](https://github.com/tauri-apps/tao) (latest),
//! [winit](https://github.com/rust-windowing/winit) (latest),
//! [wry](https://github.com/tauri-apps/wry) (v0.24) and
//! [tauri](https://github.com/tauri-apps/tauri) (v1) windows.
//!
//! Due to the GTK-based implementation, winit currently cannot leverage this crate on Linux yet.
//!
//! - Add the `drag` dependency:
//!
//! `$ cargo add drag`
//!
//! - Use the `drag::start_drag` function. It takes a `&T: raw_window_handle::HasWindowHandle` type on macOS and Windows, and a `&gtk::ApplicationWindow` on Linux:
//!
//! - tao:
//!   ```rust,no_run
//!   let event_loop = tao::event_loop::EventLoop::new();
//!   let window = tao::window::WindowBuilder::new().build(&event_loop).unwrap();
//!
//!   let item = drag::DragItem::Files(vec![std::fs::canonicalize("./examples/icon.png").unwrap()]);
//!   let preview_icon = drag::Image::File("./examples/icon.png".into());
//!
//!   drag::start_drag(
//!     #[cfg(target_os = "linux")]
//!     {
//!       use tao::platform::unix::WindowExtUnix;
//!       window.gtk_window()
//!     },
//!     #[cfg(not(target_os = "linux"))]
//!     &window,
//!     item,
//!     preview_icon,
//!     |result, cursor_position| {
//!       println!("drag result: {result:?}");
//!     },
//!     drag::Options::default(),
//!   );
//!   ```
//!
//!   - wry:
//!   ```rust,no_run
//!   let event_loop = tao::event_loop::EventLoop::new();
//!   let window = tao::window::WindowBuilder::new().build(&event_loop).unwrap();
//!   let webview = wry::WebViewBuilder::new().build(&window).unwrap();
//!
//!   let item = drag::DragItem::Files(vec![std::fs::canonicalize("./examples/icon.png").unwrap()]);
//!   let preview_icon = drag::Image::File("./examples/icon.png".into());
//!
//!   drag::start_drag(
//!     #[cfg(target_os = "linux")]
//!     {
//!       use tao::platform::unix::WindowExtUnix;
//!       window.gtk_window()
//!     },
//!     #[cfg(not(target_os = "linux"))]
//!     &window,
//!     item,
//!     preview_icon,
//!     |result, cursor_position| {
//!       println!("drag result: {result:?}");
//!     },
//!     drag::Options::default(),
//!   );
//!   ```
//!
//!   - winit:
//!   ```rust,ignore
//!   let window = ...winit window;
//!
//!   let item = drag::DragItem::Files(vec![std::fs::canonicalize("./examples/icon.png").unwrap()]);
//!   let preview_icon = drag::Image::File("./examples/icon.png".into());
//!
//!   # #[cfg(not(target_os = "linux"))]
//!   let _ = drag::start_drag(&window, item, preview_icon, |result, cursor_position| {
//!     println!("drag result: {result:?}");
//!   }, Default::default());
//!   ```

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

use std::path::PathBuf;

mod platform_impl;
pub use platform_impl::start_drag;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(windows)]
    #[error("{0}")]
    WindowsError(#[from] windows::core::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("unsupported window handle")]
    UnsupportedWindowHandle,
    #[error("failed to start drag")]
    FailedToStartDrag,
    #[error("drag image not found")]
    ImageNotFound,
    #[cfg(target_os = "linux")]
    #[error("empty drag target list")]
    EmptyTargetList,
    #[error("failed to drop items")]
    FailedToDrop,
    #[error("failed to get cursor position")]
    FailedToGetCursorPosition,
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize, serde::Serialize))]
pub enum DragResult {
    /// Dropped successfully. Carries the drop-effect the TARGET performed
    /// (Windows: from DoDragDrop's out-parameter). A source that offered
    /// `Move` uses this to know when it must delete the original.
    /// macOS/Linux report `DragOperation::Unknown`.
    Dropped(DragOperation),
    Cancel,
}

/// The drop-effect a target performed. Only `Move` obliges the source to
/// delete the original file (DoDragDrop's move protocol).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize, serde::Serialize))]
pub enum DragOperation {
    #[default]
    Unknown,
    None,
    Copy,
    Move,
    Link,
    /// macOS Dock-Trash drop (NSDragOperationDelete): the TARGET performed a
    /// delete, and the source is expected to dispose of the dragged items.
    /// Only ever reported on macOS.
    Delete,
}

pub type DataProvider = Box<dyn Fn(&str) -> Option<Vec<u8>>>;

/// Item to be dragged.
pub enum DragItem {
    /// A list of files to be dragged.
    ///
    /// The paths must be absolute.
    Files(Vec<PathBuf>),
    /// Data to share with another app.
    ///
    /// - **Windows**: Not supported. Will result in a dummy drag operation of current folder that will be cancelled upon dropping.
    /// - **Linux (gtk)**: Not supported. Will result in a dummy drag operation that contains nothing to drop.
    Data {
        provider: DataProvider,
        types: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy)]
#[repr(u64)]
pub enum DragMode {
    Copy = 1,  // NSDragOperationCopy
    Move = 16, // NSDragOperationMove
}

impl Default for DragMode {
    fn default() -> Self {
        DragMode::Copy
    }
}

#[cfg(target_os = "macos")]
unsafe impl objc::Encode for DragMode {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("Q") } // unsigned long long
    }
}

/// Windows only: live state of an ASYNC shell paste operation running against
/// the dragged data object (IDataObjectAsyncCapability protocol). The shell
/// calls StartOperation before IDropTarget::Drop returns and EndOperation when
/// the (possibly prompt-gated) copy/move finishes on its background thread —
/// which can be minutes later if a "Replace or Skip Files" conflict dialog is
/// waiting on the user. Callers hand an Arc into `Options::shell_op` and poll
/// it after the drop callback to know whether a shell operation is still
/// pending and when it completed.
#[derive(Default, Debug)]
pub struct ShellOpState {
    /// StartOperation was seen (a shell async paste began).
    pub started: std::sync::atomic::AtomicBool,
    /// EndOperation was seen (the shell async paste finished).
    pub ended: std::sync::atomic::AtomicBool,
    /// dwEffects from EndOperation (raw DROPEFFECT bits; valid once `ended`).
    pub end_effects: std::sync::atomic::AtomicU32,
}

#[derive(Default)]
pub struct Options {
    pub skip_animatation_on_cancel_or_failure: bool,
    pub mode: DragMode,
    /// Windows only: offer `DROPEFFECT_COPY | DROPEFFECT_MOVE` (instead of the
    /// single `mode` effect) so the target can choose move vs copy, and report
    /// whichever it performed back through `DragResult::Dropped`. Lets a
    /// drag-out of a disposable temp be cleaned up only on a real move.
    pub allow_move: bool,
    /// Windows only: receives the async shell-paste lifecycle (see
    /// `ShellOpState`). Ignored on other platforms.
    pub shell_op: Option<std::sync::Arc<ShellOpState>>,
}

/// An image definition.
#[derive(Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize, serde::Serialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum Image {
    /// A path to a image.
    File(PathBuf),
    /// Raw bytes of the image.
    Raw(Vec<u8>),
}

/// Logical position of the cursor.
///
/// - **Windows**: Currently the win32 API for logical position reports physical position as well, due to the complicated nature of potential multiple monitor with different scaling there's no trivial solution to be incorporated.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize, serde::Serialize))]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
}

// macOS live drag-chip update (visual parity with the Windows chip).
//
// On Windows the drag chip is a follow-window webview the app repaints live.
// On macOS the chip is the native NSDraggingSession image, baked ONCE at drag
// start (start_drag). To update the live verb ("Move X to 'Folder'" / "Copy
// ...") mid-drag, the app re-composes the chip PNG and calls
// `macos_set_pending_drag_image`, which stashes the bytes here. The drag
// source's `draggingSession:movedToPoint:` callback runs on the main thread
// INSIDE AppKit's modal drag tracking loop (where a dispatch_async does NOT
// drain until the drag ends), so it polls this static each move and, when a
// new PNG is pending, swaps the dragging item's contents in place. The static
// is cleared after applying and at session end so a stale image can't leak
// into the next drag.
#[cfg(target_os = "macos")]
pub(crate) struct PendingDragImage {
    pub png: Vec<u8>,
    /// Chip LOGICAL (point) dimensions. The frontend composes the PNG at
    /// devicePixelRatio (== backingScaleFactor), so these are the SAME logical
    /// space start_drag divides the initial image into — the movedToPoint
    /// handler sizes the new NSImage to them so a 2x bitmap draws logical size.
    pub logical_w: f64,
    pub logical_h: f64,
}

#[cfg(target_os = "macos")]
pub(crate) static PENDING_DRAG_IMAGE: std::sync::Mutex<Option<PendingDragImage>> =
    std::sync::Mutex::new(None);

/// macOS only: stash a freshly composed drag-chip PNG to be applied to the live
/// `NSDraggingSession` on the next `draggingSession:movedToPoint:` tick.
/// `logical_w`/`logical_h` are the chip's LOGICAL (point) dimensions. Overwrites
/// any not-yet-applied image — intermediate verb frames are droppable; only the
/// latest matters. Safe to call from any thread; the movedToPoint callback (main
/// thread) drains it. No effect if no drag is in flight.
#[cfg(target_os = "macos")]
pub fn macos_set_pending_drag_image(png: Vec<u8>, logical_w: f64, logical_h: f64) {
    if let Ok(mut slot) = PENDING_DRAG_IMAGE.lock() {
        *slot = Some(PendingDragImage {
            png,
            logical_w,
            logical_h,
        });
    }
}
