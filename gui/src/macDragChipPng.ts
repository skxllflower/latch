// macOS custom drag-chip composition.
//
// On Windows the drag chip is composed by the drag-overlay webview
// (DragOverlayApp) and painted by a native layered chip window that follows the
// cursor; the OS drag image handed to DoDragDrop is a 1x1 transparent
// placeholder. macOS has no such follow-window — instead AppKit renders
// whatever image the NSDraggingSession is handed as the drag image (see
// os_drag::start_os_file_drag + vendor/drag macos platform_impl). So on macOS
// the chip PNG must be composed HERE, in the window that arms the drag, and
// passed to start_os_file_drag as `preview_png`.
//
// This reuses Latch's EXACT existing chip compositors (dragChipPng.ts, same
// constants): buildWaveformDragChipPng for the chop drag-out (a waveform/video
// thumbnail over a filename strip) and buildDragChipPng for the plain pill
// (filename + icon + count badge) used by the Extract output rows. Returns a
// plain number[] so Tauri serializes it to the Rust command's Vec<u8>.
// Non-macOS callers get null (Windows byte-identical: `preview_png` stays
// unsent / ignored, still the transparent placeholder).

import { isMac } from './platform';
import type { DragMetadata } from './internalDragHandoff';
import { buildDragChipPng, buildWaveformDragChipPng } from './dragChipPng';

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

// The chop drag-out carries a baked waveform/video-frame data URL on the meta.
// Draw it into a canvas so we can reuse buildWaveformDragChipPng VERBATIM (same
// layout, scale, sampled-bg behavior as the Windows/overlay chip) — the canvas
// is same-origin (produced by our own toDataURL), so sampleCanvasBg reads it
// fine (untainted).
async function buildStripChipFromMeta(meta: DragMetadata): Promise<Uint8Array | null> {
  const url = meta.waveformDataUrl;
  if (!url) return null;
  const img = await loadImage(url);
  if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return buildWaveformDragChipPng({ name: meta.fileName, waveformCanvas: canvas });
}

/// Compose the drag chip PNG for the CURRENT drag's metadata on macOS, matching
/// whichever chip the Windows overlay would show for the same meta:
///   • waveform data URL present → the waveform strip (chop drag-out)
///   • otherwise → the pill (filename + icon + count badge; Extract rows)
/// Returns null on non-macOS (so the Windows path stays byte-identical) or when
/// composition fails (the drag still runs, just with the OS default image).
export async function composeMacDragChipPng(meta: DragMetadata): Promise<number[] | null> {
  if (!isMac) return null;
  try {
    let bytes: Uint8Array | null = null;
    if (meta.waveformDataUrl) {
      bytes = await buildStripChipFromMeta(meta);
    }
    if (!bytes) {
      bytes = buildDragChipPng({
        name: meta.fileName,
        isDirectory: meta.isDirectory,
        count: meta.count,
      });
    }
    return bytes ? Array.from(bytes) : null;
  } catch {
    return null;
  }
}
