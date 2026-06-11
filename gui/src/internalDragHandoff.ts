// Overlay-driven drag coordination — visual layer only.
//
// The actual drop-source / drop-target wiring is now 100% OS-level
// via DoDragDrop / NSDragging / XDND through ipc::start_os_file_drag
// (which uses the drag-overlay window as the drag source — see that
// command's doc-comment for why source ≠ origin window). All drop
// commits land in the receiving window's `onDragDropEvent` handler:
//
//   • main: handleOsDrop in Home.tsx routes paths to collection /
//     folder / pinned via DOM hit-test on the drop position.
//   • Lathe / find-similar: their existing onDragDropEvent listeners
//     call addPaths.
//   • External apps: native delivery.
//
// This module's job is purely the floating chip visual:
//   1. broadcast `wd-drag-started` so any component that wants to
//      know "a drag is in flight" can react (e.g. clearing local
//      ptrDrag state on completion via wd-drag-ended).
//   2. push the chip metadata into the drag-overlay window via
//      `wd-overlay-show` so it renders the chip.
//   3. tell Rust to start the cursor-poll thread that repositions
//      the overlay every frame.
//
// `endOverlayDrag` is the cleanup pair. ipc::start_os_file_drag's
// completion callback also emits the same end events when DoDragDrop
// finishes (whether dropped externally or cancelled), so callers
// don't strictly need to call endOverlayDrag — but it's safe to,
// and useful for the rare "drag was armed but never reached
// DoDragDrop" path.

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';

export const DRAG_STARTED_EVENT = 'wd-drag-started';
export const DRAG_ENDED_EVENT   = 'wd-drag-ended';
export const OVERLAY_SHOW_EVENT = 'wd-overlay-show';
export const OVERLAY_HIDE_EVENT = 'wd-overlay-hide';

export interface DragMetadata {
  paths:       string[];
  fileName:    string;
  isDirectory: boolean;
  count:       number;
  /// Optional waveform-thumbnail data URL. When set, the overlay
  /// chip renders the waveform variant (image + label strip)
  /// instead of the standard pill. Used by VisualizerPane drag-out.
  waveformDataUrl?: string | null;
  /// Background color sampled from the waveform thumbnail's
  /// top-left pixel. Used by the chip's label strip so the chip
  /// reads as one continuous block. Optional.
  bgColor?:         string | null;
  /// True when Ctrl/Cmd was held at the moment the drag activated.
  /// The Home-side keyboard listener that flips copyMode mid-drag only
  /// fires on key transitions — if the modifier was already held when
  /// the gesture began, no transition would fire and the chip would
  /// initialize as 'Move' even though the user clearly intended 'Copy'.
  /// Carrying it on meta lets the drag-started handler seed copyModeRef
  /// correctly so the first target hover renders the right verb.
  initialCopyMode?: boolean;
}

/// Show the floating chip + start the cursor-poll thread. Idempotent.
/// Note: this does NOT initiate the OS drag — the caller invokes
/// start_os_file_drag separately so it can pass paths + transparency
/// preferences. Splitting the two lets external-only callers (e.g.
/// Lathe outputs row dragging out to Explorer) reuse the same chip
/// machinery without coupling.
export async function startOverlayDrag(meta: DragMetadata): Promise<void> {
  try { await emit(DRAG_STARTED_EVENT, meta); } catch (err) {
    console.warn('[overlay-drag] start broadcast failed:', err);
  }
  // Initial chip state — write via BOTH localStorage (immediate,
  // bypasses DoDragDrop-blocked IPC) AND emit (fallback path).
  // localStorage is shared across same-origin WebView2 windows and
  // its `storage` event fires cross-window without going through
  // Tauri's UI-thread-bound runtime — that's the only mechanism
  // that delivers updates LIVE while DoDragDrop's modal pump is
  // running on the host UI thread. See Home.tsx pushChipShow for
  // the same pattern on subsequent updates during the drag.
  const showPayload = {
    fileName:        meta.fileName,
    isDirectory:     meta.isDirectory,
    count:           meta.count,
    verb:            null,
    targetLabel:     null,
    waveformDataUrl: meta.waveformDataUrl ?? null,
    bgColor:         meta.bgColor ?? null,
  };
  try { localStorage.setItem('wd-overlay-chip', JSON.stringify(showPayload)); } catch {}
  try { await emit(OVERLAY_SHOW_EVENT, showPayload); } catch (err) {
    console.warn('[overlay-drag] overlay-show emit failed:', err);
  }
  try { await invoke('drag_overlay_start'); } catch (err) {
    console.warn('[overlay-drag] drag_overlay_start failed:', err);
  }
}

/// Hide the chip + stop the cursor-poll thread + broadcast
/// drag-ended. Always safe to call. ipc::start_os_file_drag's
/// completion callback emits the same events when DoDragDrop
/// finishes so windows don't have to know which path ended the drag.
export async function endOverlayDrag(): Promise<void> {
  // Mirror the IPC-bypass strategy from startOverlayDrag — clear
  // the localStorage chip key first so the overlay's storage-event
  // listener fires immediately (vs. waiting for the queued emit).
  try { localStorage.removeItem('wd-overlay-chip'); } catch {}
  try { await emit(OVERLAY_HIDE_EVENT, {}); } catch {}
  try { await invoke('drag_overlay_stop'); } catch {}
  try { await emit(DRAG_ENDED_EVENT, {}); } catch {}
}
