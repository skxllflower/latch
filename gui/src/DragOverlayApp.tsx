// Drag-overlay window's React root. Renders the floating drag chip
// while a drag is in flight; otherwise renders nothing.
//
// Lifecycle:
//   • Origin window emits `wd-overlay-show` with the chip metadata
//     (filename, count, isDirectory) at drag-start; we set local
//     state and the chip appears.
//   • After each render with chip data, the component measures its
//     own footprint and asks the OS to resize this window down to
//     the chip's exact bounds — keeps the visible surface the chip
//     and only the chip, no halo of empty transparent canvas around
//     it.
//   • While the drag is active, Rust's drag_overlay poll thread
//     repositions THIS WINDOW each frame to follow the cursor. The
//     chip element is anchored at (0,0) of the window — the window
//     position IS the chip position.
//   • Origin (or DoDragDrop's completion callback) emits
//     `wd-overlay-hide`; we clear state, the chip disappears, and
//     drag_overlay_stop hides the window itself.
//
// Mouse events: this window has set_ignore_cursor_events(true)
// applied at startup, so it never intercepts clicks even though it
// sits at the very top of the z-order. The chip is purely visual.

import React, { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toCanvas } from 'html-to-image';
import { DragChip, type DragChipVerb } from './DragChip';
import { resolveExternalLabel, resolveExternalVerb } from './dropTargetResolver';

interface OverlayChipState {
  fileName:    string;
  isDirectory: boolean;
  count:       number;
  // Optional verb-aware fields. When `verb` is set, the chip
  // renders the "<verb> filename to <label>" form instead of the
  // plain filename. Re-emitting the show event with new verb/label
  // values is how target-aware updates propagate during a drag.
  verb?:        DragChipVerb;
  targetLabel?: string | null;
  // Optional waveform image variant. When `waveformDataUrl` is set,
  // DragChip renders a thumbnail-with-label-strip card instead of
  // the plain pill. Carries the sampled bg color too so the strip
  // reads continuous with the waveform.
  waveformDataUrl?: string | null;
  bgColor?:         string | null;
}

// Localhost URL for chip-bitmap delivery. Resolved ONCE at module
// load (well before any drag starts) so the per-frame capture path
// doesn't depend on Tauri IPC — fetch() to localhost bypasses
// main's modal pump during a Windows file drag, which is what was
// keeping bitmaps from arriving at the native chip during the drag.
//
// Empty string on non-Windows or if the server failed to start —
// JS falls back to the IPC path (works for non-drag scenarios; on
// macOS/Linux the existing Tauri overlay handles rendering anyway).
let chipBitmapUrl = '';
// Sibling endpoint on the same localhost server for cross-process
// drop-target detection (GET /target returns the exe basename of
// whatever top-level window the cursor is currently over). Derived
// from chipBitmapUrl by swapping the trailing path segment so we
// don't need a second IPC round-trip to discover it.
let chipTargetUrl = '';
invoke<string>('get_chip_bitmap_endpoint')
  .then(url => {
    chipBitmapUrl = url || '';
    chipTargetUrl = url ? url.replace(/\/bitmap$/, '/target') : '';
  })
  .catch(() => {});

export default function DragOverlayApp() {
  const [chip, setChip] = useState<OverlayChipState | null>(null);
  // Cross-process drop target snapshot — fetched from the native
  // chip thread's localhost /target endpoint while a drag is in
  // flight. Fields:
  //   exe        — basename of the top-level window's process
  //                ("Discord.exe", "explorer.exe", …).
  //   folderPath — Explorer's currently-displayed folder, when the
  //                cursor is over an Explorer window AND the
  //                IShellWindows COM walk returned a real path.
  //                Empty for everything else (DAWs, virtual folders,
  //                Quick Access view, etc.).
  //   ctrl/shift — live modifier state, for Ctrl-aware Move/Copy on
  //                Explorer destinations.
  // All four empty/false when the cursor is over WAVdesk's own
  // process so internal drag context (sidebar pin name, collection
  // label) takes over.
  interface ExternalTarget {
    exe:        string;
    folderPath: string;
    ctrl:       boolean;
    shift:      boolean;
  }
  const [externalTarget, setExternalTarget] = useState<ExternalTarget>(
    { exe: '', folderPath: '', ctrl: false, shift: false }
  );
  const chipWrapperRef = useRef<HTMLDivElement | null>(null);
  const prewarmRef     = useRef<HTMLDivElement | null>(null);

  // Pre-warm html-to-image at mount. Its first toCanvas() call has to
  // walk every stylesheet, inline them into an SVG foreignObject,
  // and round-trip through an Image() decode — ~hundreds of ms of
  // cold work the user otherwise eats on the first real drag (the
  // placeholder pill stays up while it churns). Subsequent calls
  // reuse the warm CSS-parse/Image-decode caches, so this pays off
  // exactly once per app launch. We capture a hidden dummy chip
  // node and discard the result; nothing is POSTed to the native
  // chip thread.
  useEffect(() => {
    const el = prewarmRef.current;
    if (!el) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        await toCanvas(el, {
          backgroundColor: undefined,
          cacheBust:       true,
          pixelRatio:      window.devicePixelRatio || 1,
        });
      } catch {}
    }, 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, []);

  // Force the host document to render fully transparent so only the
  // chip pixels show through the overlay's window surface. The
  // shared theme.css rule `body { @apply bg-background ... }`
  // sets background-color on body via a Tailwind utility — that
  // beats inline element-level styles in CSS specificity, so a
  // simple `body.style.background = 'transparent'` doesn't
  // override it. Inject an actual <style> tag with !important
  // rules instead. This is fine because the overlay window is a
  // dedicated webview that only ever renders DragOverlayApp; the
  // global !important transparent applies only here.
  //
  // Margin/padding zeroing too — Tailwind preflight covers most
  // browser defaults but explicit zeros guarantee no leftover
  // gutter ever shows up as visible black (the overlay window is
  // pre-sized 1000×60 so any non-chip area MUST be transparent
  // for the user to never see it).
  useEffect(() => {
    // Two paths to override the Tailwind body bg:
    //
    //  1) Injected <style> tag in <head> with !important rules.
    //  2) Inline style on html + body via setProperty(..., 'important').
    //     Inline !important is the absolute top of CSS specificity —
    //     only another inline !important can override it. This is the
    //     belt that catches the case where the <style> injection
    //     loses to Tailwind's @layer base !important reversal rules.
    const style = document.createElement('style');
    // CRITICAL: index.html has an inline <style> that paints html,
    // body, AND #root with `var(--theme-bg-app, #000)`. The #root
    // bg was the missing piece — even with html+body transparent,
    // #root painted dark over them. Cover all three here.
    style.textContent = `
      html, body, #root {
        background: transparent !important;
        background-color: transparent !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      body { overflow: hidden !important; }
    `;
    document.head.appendChild(style);

    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    html.style.setProperty('background',       'transparent', 'important');
    html.style.setProperty('background-color', 'transparent', 'important');
    body.style.setProperty('background',       'transparent', 'important');
    body.style.setProperty('background-color', 'transparent', 'important');
    body.style.setProperty('margin',  '0',      'important');
    body.style.setProperty('padding', '0',      'important');
    body.style.setProperty('overflow','hidden', 'important');
    if (root) {
      root.style.setProperty('background',       'transparent', 'important');
      root.style.setProperty('background-color', 'transparent', 'important');
    }

    return () => {
      try { document.head.removeChild(style); } catch {}
    };
  }, []);

  // No runtime resize. The window is created at a fixed 1000×60 in
  // lib.rs (large enough to fit any chip text) and the chip
  // renders in its top-left corner with the rest transparent.
  // setSize via JS IPC is blocked by DoDragDrop's modal pump on
  // Windows — same root cause as the wd-overlay-show event
  // queueing we already work around with localStorage. Pre-sizing
  // dodges the issue entirely.

  useEffect(() => {
    let unShow: UnlistenFn | null = null;
    let unHide: UnlistenFn | null = null;

    // PRIMARY DELIVERY PATH: cross-window localStorage + storage
    // events. This bypasses Tauri's IPC entirely, which is critical
    // because Tauri events are queued during DoDragDrop's modal pump
    // on the host UI thread — they only fire AFTER drag release,
    // which is too late for live chip updates. localStorage is
    // shared across same-origin WebView2 windows; the `storage`
    // event fires cross-window in the receiving webview's process,
    // independent of the host UI thread.
    const applyFromStorage = (raw: string | null) => {
      if (!raw) {
        setChip(null);
        return;
      }
      try {
        const p = JSON.parse(raw) as OverlayChipState;
        if (!p?.fileName) {
          setChip(null);
          return;
        }
        setChip({
          fileName:        p.fileName,
          isDirectory:     !!p.isDirectory,
          count:           Math.max(1, (p.count ?? 1) | 0),
          verb:            (p.verb ?? null) as DragChipVerb,
          targetLabel:     p.targetLabel ?? null,
          waveformDataUrl: p.waveformDataUrl ?? null,
          bgColor:         p.bgColor ?? null,
        });
      } catch { /* malformed payload — ignore */ }
    };
    // Pick up any chip state that was set BEFORE this listener was
    // attached (e.g. main wrote during overlay window startup).
    try { applyFromStorage(localStorage.getItem('wd-overlay-chip')); } catch {}
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'wd-overlay-chip') return;
      applyFromStorage(e.newValue);
    };
    window.addEventListener('storage', onStorage);

    // FALLBACK PATH: Tauri events. Same shape, but only fires after
    // DoDragDrop returns. Useful if localStorage cross-window
    // sharing is ever broken (different WebView2 user-data dirs,
    // for example). Both paths feed the same setChip; identical
    // payloads no-op via React's reconciliation.
    void (async () => {
      unShow = await listen<OverlayChipState>('wd-overlay-show', (e) => {
        const p = e.payload;
        if (!p?.fileName) return;
        setChip({
          fileName:        p.fileName,
          isDirectory:     !!p.isDirectory,
          count:           Math.max(1, p.count | 0),
          verb:            (p.verb ?? null) as DragChipVerb,
          targetLabel:     p.targetLabel ?? null,
          waveformDataUrl: p.waveformDataUrl ?? null,
          bgColor:         p.bgColor ?? null,
        });
      });
      unHide = await listen('wd-overlay-hide', () => setChip(null));
    })();
    return () => {
      window.removeEventListener('storage', onStorage);
      if (unShow) unShow();
      if (unHide) unHide();
    };
  }, []);

  // Cross-process drop-target poll. While a drag is in flight, fetch
  // /target every 100 ms to learn what app the cursor is currently
  // over. The native chip thread does the heavy lifting (cursor →
  // top-level HWND → exe path) on its own thread at 60Hz; we just
  // sample the result.
  //
  // Why fetch and not Tauri IPC: same reason chip-bitmap delivery
  // bypasses IPC — DoDragDrop's modal pump on main blocks Tauri
  // commands until release. fetch() to localhost is on Chromium's
  // network stack, untouched by the modal pump.
  //
  // 100 ms cadence is a deliberate compromise: smooth label transitions
  // when sweeping across taskbar buttons or window edges, but ten
  // round-trips per second is well below anything that'd compete with
  // the chip-bitmap channel for bandwidth. Stops cleanly when the
  // chip clears (drag end / hide).
  useEffect(() => {
    if (!chip || !chipTargetUrl) {
      // No drag in flight — make sure stale state from a previous
      // drag doesn't bleed into the next one.
      setExternalTarget({ exe: '', folderPath: '', ctrl: false, shift: false });
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const resp = await fetch(chipTargetUrl);
        if (cancelled || !resp.ok) return;
        const data = await resp.json();
        const exe        = typeof data?.exe        === 'string'  ? data.exe.trim()        : '';
        const folderPath = typeof data?.folder     === 'string'  ? data.folder.trim()     : '';
        const ctrl       = data?.ctrl  === true;
        const shift      = data?.shift === true;
        // Field-by-field equality compare — re-rendering only when
        // SOMETHING changed avoids unnecessary chip re-captures while
        // the cursor sits over the same window with no modifier flips.
        setExternalTarget(prev =>
          prev.exe === exe && prev.folderPath === folderPath
            && prev.ctrl === ctrl && prev.shift === shift
            ? prev
            : { exe, folderPath, ctrl, shift }
        );
      } catch { /* network/parse failure — try again next tick */ }
    };
    void tick();
    const id = window.setInterval(tick, 100);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [chip]);

  // Capture the rendered chip → push the bitmap to the native chip
  // window on every state change. Fires whenever `chip` changes
  // (any prop the chip displays — verb, targetLabel, count, etc.) —
  // those are the only "state-relevant" updates the chip cares
  // about, so this is the on-demand version of the capture-and-push
  // pipeline (vs capturing every render).
  //
  // Why setTimeout(0) and not requestAnimationFrame: this overlay
  // window is HIDDEN on Windows during a drag (the native chip is
  // the visible chip), and WebView2 / Chromium throttles rAF on
  // hidden / backgrounded contexts to ~1 Hz. A 2-rAF wait that's
  // ~32 ms when visible can take 1–2 seconds when hidden — most
  // drags would end before the capture even starts, leaving the
  // user staring at the placeholder. setTimeout(0) is a regular
  // task and fires within ~4 ms regardless of window visibility.
  //
  // The single-task delay is enough for layout: React commits
  // synchronously + html2canvas internally calls getComputedStyle
  // which forces any pending layout. We don't need a dedicated
  // rAF tick to "let the browser lay out."
  //
  // RGBA pulled via getImageData (canvas already has the pixels —
  // no PNG encode step). Sent as Vec<u8> to Rust which converts to
  // premultiplied BGRA for UpdateLayeredWindow. Cancelled flag
  // covers the unmount/state-change-before-capture-completes case.
  useEffect(() => {
    if (!chip) return;
    const el = chipWrapperRef.current;
    if (!el) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        // html-to-image instead of html2canvas: it serializes the
        // node into an SVG foreignObject and lets the browser
        // render it, so modern CSS (oklch / lab / color-mix /
        // backdrop-filter / etc.) Just Works. html2canvas has its
        // own CSS parser and chokes on oklch — and Tailwind v4
        // emits oklch everywhere, so html2canvas never returned a
        // usable canvas for our chip.
        //
        // pixelRatio = devicePixelRatio so the captured bitmap is
        // sized in PHYSICAL pixels (matching what the native chip's
        // UpdateLayeredWindow paints in). Capturing at 1x on a
        // 150% display would render the chip at 138×19 physical
        // (= 92×13 logical = tiny). Capturing at 1.5x gives 207×29
        // physical = 138×19 logical = correct on-screen size.
        const dpr = window.devicePixelRatio || 1;
        const canvas = await toCanvas(el, {
          backgroundColor: undefined, // keep transparency
          cacheBust:       true,
          pixelRatio:      dpr,
        });
        if (cancelled) return;
        if (canvas.width === 0 || canvas.height === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Localhost HTTP path bypasses Tauri IPC. fetch() goes
        // through Chromium's network stack which is not blocked by
        // DoDragDrop's modal pump on main, so bitmap updates land
        // at the native chip thread DURING the drag instead of
        // queueing until drag-end. Falls back to the IPC path when
        // the server isn't available (non-Windows / startup race).
        if (chipBitmapUrl) {
          // NO keepalive: it caps the request body at 64 KB by spec
          // (Fetch standard §4.5.4); our chip bitmaps regularly
          // exceed that — a 604×40 capture is 96,640 bytes — so
          // keepalive would silently reject the request. Plain
          // fetch has no body-size limit.
          //
          // imageData.data is a Uint8ClampedArray — its underlying
          // ArrayBuffer is the contiguous RGBA bytes the server
          // expects. .slice(0) makes a detached copy so any future
          // GC / reuse of the canvas's backing buffer can't race
          // with the in-flight POST.
          try {
            await fetch(`${chipBitmapUrl}?w=${canvas.width}&h=${canvas.height}`, {
              method:  'POST',
              body:    imageData.data.buffer.slice(0),
              headers: { 'Content-Type': 'application/octet-stream' },
            });
          } catch {}
        } else {
          await invoke('drag_chip_set_bitmap', {
            rgba:   Array.from(imageData.data),
            width:  canvas.width,
            height: canvas.height,
          });
        }
      } catch {}
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // externalTarget is in the dep list so when the cursor enters a
    // new app (or a modifier flips on an Explorer drop), the merge
    // in render swaps the verb/targetLabel and we re-capture the
    // chip bitmap with the new label baked in.
  }, [chip, externalTarget]);

  return (
    <div
      ref={chipWrapperRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        background: 'transparent',
        // inline-block + lineHeight:0 collapses the inline baseline
        // metrics that would otherwise add a few pixels of empty
        // space above the chip — a visible black halo when the
        // body bg manages to paint through the transparent window.
        // The DragChip itself sets lineHeight:1 on its own
        // children so this doesn't crush the chip's text.
        display: 'inline-block',
        lineHeight: 0,
        verticalAlign: 'top',
        margin: 0,
        padding: 0,
      }}
    >
      {chip && (() => {
        // Merge cross-process target detection with the chip's
        // internal-context verb/targetLabel. External wins when a
        // non-WAVdesk window is under the cursor — the resolver
        // returns empty strings when both exe and folderPath are
        // empty (cursor over our own process), so internal context
        // (sidebar pin, collection name) shows through naturally.
        const { exe, folderPath, ctrl, shift } = externalTarget;
        const extLabel = resolveExternalLabel(exe, folderPath);
        const extVerb  = resolveExternalVerb(exe, folderPath, ctrl, shift);
        const verb        = extVerb  ?? chip.verb       ?? null;
        const targetLabel = extLabel || (chip.targetLabel ?? null);
        return (
          <DragChip
            fileName={chip.fileName}
            isDirectory={chip.isDirectory}
            count={chip.count}
            verb={verb}
            targetLabel={targetLabel}
            waveformDataUrl={chip.waveformDataUrl ?? null}
            bgColor={chip.bgColor ?? null}
          />
        );
      })()}
      {/* Hidden dummy chip the prewarm useEffect captures once at
          mount to prime html-to-image's cold caches. Positioned
          off-screen and visibility:hidden so it never shows up
          even while the overlay window itself is briefly visible
          during startup. Layout still runs (visibility:hidden
          preserves box generation), so toCanvas() has a real DOM
          subtree to walk. */}
      <div
        ref={prewarmRef}
        style={{
          position: 'absolute',
          top: -10000,
          left: -10000,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
        aria-hidden
      >
        <DragChip
          fileName="prewarm.wav"
          isDirectory={false}
          count={1}
          verb={null}
          targetLabel={null}
          waveformDataUrl={null}
          bgColor={null}
        />
      </div>
    </div>
  );
}
