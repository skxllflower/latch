// Multi-region selection overlay for the Latch chop window. Generalizes
// the single-region TrimOverlay to N non-overlapping, individually-
// coloured regions, and implements the audition + edit model:
//
//   • drag empty space           → draw a new region (auto-loops on release)
//   • double-click empty space    → add a default-width region (auto-loops)
//   • click INSIDE a region        → make it the active loop (swap)
//   • click OUTSIDE any region     → play the whole file from there, no loop
//   • drag a region EDGE           → resize that edge
//   • drag a region's bottom STRIP → drag the clip OUT as a file (export);
//                                     the WHOLE bottom band (full width) is
//                                     the grip, so narrow / zoomed-out regions
//                                     are still grabbable. Video links split
//                                     the strip left(audio)|right(video) —
//                                     never an Alt modifier: Windows refuses
//                                     drops while Alt is held (link drop-effect)
//   • drag the region BODY         → move the whole region (above the strip)
//   • scroll / middle-drag / trackpad → WaveformView's built-in zoom/pan
//
// On hover, a region shows affordances: a resize chevron at each edge and
// a grip strip across the bottom (the drag-out zone). The cursor tracks the
// zone under the pointer (ew-resize / grab / move / crosshair).
//
// The active selection is highlighted and everything outside it is dimmed.
//
// It does NOT touch wheel/middle/trackpad: the root is a plain
// pointer-events:auto <div> (WebView2 won't bubble wheel out of a
// pointer-events:none SVG), the inner SVG + affordance layer are purely
// visual, and hit-testing is done in JS. Non-left buttons return before
// any preventDefault so middle-drag pan still reaches the container.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Music, Film, GripVertical } from 'lucide-react';
import {
  ChopRegion, createDragRegion, setRegionBounds, resizeEdge, moveRegion,
} from './chopRegions';

interface ChopRegionOverlayProps {
  regions: ChopRegion[];
  selectedId: string | null;
  viewportStartSec: number;
  viewportEndSec: number;
  durationSec: number;
  onChange: (regions: ChopRegion[]) => void;
  onSelect: (id: string | null) => void;
  onSeek: (sec: number) => void;          // click outside → play whole, no loop
  onActivate: (id: string) => void;        // click inside / new region → loop it
  onCreateDefault: (atSec: number) => void; // double-click → add a region
  onDragOut: (id: string, opts: { video: boolean }) => void; // centre grip → export out
  canExportVideo?: boolean; // a video file exists → show the second (video) grip
  // Gesture boundaries for the host's undo snapshots + snap-on-release.
  // Start fires before the first mutation of any mutating gesture; end
  // fires on release ONLY when the gesture actually changed a region.
  onGestureStart?: () => void;
  onGestureEnd?: (info: { id: string; kind: 'create' | 'resize' | 'move'; edge?: 'start' | 'end' }) => void;
  // Pan the waveform viewport by a signed second delta. Backs both the
  // ctrl/cmd+drag pan and the near-edge auto-scroll during a gesture.
  panViewport?: (deltaSec: number) => void;
  // Imperative live-bounds channel: fired every gesture tick (create/resize/
  // move) so the host can re-arm the audition loop DIRECTLY, ungated by React
  // state — see ChopApp's rAF-coalesced re-arm.
  onLiveBounds?: (id: string, startSec: number, endSec: number) => void;
  // Cursor shown over empty space (the region-DRAW zone). The chop window
  // keeps the crosshair default; the in-browser visualizer passes 'text'
  // so an armed chop mode reads as an I-beam over the waveform.
  createCursor?: string;
}

const DRAG_THRESH_PX = 4;
const EDGE_HIT_PX = 6;
// Auto-scroll when a gesture drags the pointer within this many px of the
// container edge. The pan speed scales with proximity (0 at the boundary of
// the zone, max right at the edge).
const EDGE_SCROLL_PX = 24;
const EDGE_SCROLL_MAX_FRAC = 0.05; // up to 5% of the visible span per frame
// The drag-out grip is the ENTIRE BOTTOM STRIP of a region (full width, a
// band across the bottom), not a small centre handle — a narrow / zoomed-out
// region's tiny pill was near-impossible to grab, so users kept landing on
// move / resize instead. Resize edges (EDGE_HIT_PX) still win in their own
// bands; the region body ABOVE the strip stays the move zone. A video link
// splits the strip into two halves (left = audio, right = video) — never an
// Alt modifier (Windows forces the link drop-effect while Alt is held and most
// targets then refuse the drop).
const DRAGOUT_STRIP_FRAC   = 0.2;  // bottom 20% of the region height…
const DRAGOUT_STRIP_MIN_PX = 14;   // …but always at least this tall (short panes)
const DRAGOUT_STRIP_MAX_PX = 26;   // …and never a giant band on a tall pane
// Split the strip into audio | video halves only when the region is at least
// this wide on screen; below it the whole strip exports audio.
const DUAL_STRIP_MIN_PX    = 48;
const DARKEN = 'rgba(0,0,0,0.55)';

// Bottom-strip band height for the current container height.
const dragoutBandPx = (h: number) =>
  Math.min(DRAGOUT_STRIP_MAX_PX, Math.max(DRAGOUT_STRIP_MIN_PX, h * DRAGOUT_STRIP_FRAC));

type Zone =
  | { kind: 'create'; anchorSec: number; startX: number; createdId: string | null }
  | { kind: 'resize'; id: string; edge: 'start' | 'end' }
  | { kind: 'move'; id: string; grabSec: number; origStart: number; startX: number; moved: boolean }
  | { kind: 'dragout'; id: string; video: boolean; startX: number; startY: number; armed: boolean };

export const ChopRegionOverlay: React.FC<ChopRegionOverlayProps> = ({
  regions, selectedId, viewportStartSec, viewportEndSec, durationSec,
  onChange, onSelect, onSeek, onActivate, onCreateDefault, onDragOut, canExportVideo = false,
  onGestureStart, onGestureEnd, panViewport, onLiveBounds, createCursor = 'crosshair',
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Zone | null>(null);
  const workingRef = useRef<ChopRegion[]>(regions);
  // Live viewport mirrors so an in-flight gesture (and the edge auto-scroll
  // rAF) reads the CURRENT pan/zoom every tick, not the value captured when
  // the gesture began. Without this the region bound stops tracking the
  // waveform the instant the viewport pans underneath it.
  const vpStartRef = useRef(viewportStartSec); vpStartRef.current = viewportStartSec;
  const vpEndRef = useRef(viewportEndSec); vpEndRef.current = viewportEndSec;
  // Near-edge auto-scroll loop + last pointer position it re-applies at.
  const edgeRafRef = useRef(0);
  const lastPtrRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panViewportRef = useRef(panViewport); panViewportRef.current = panViewport;
  const onLiveBoundsRef = useRef(onLiveBounds); onLiveBoundsRef.current = onLiveBounds;
  // True while a ctrl/cmd+drag pan is in flight — suppresses the hover cursor
  // handler so the grabbing cursor doesn't flicker back to the zone cursor.
  const panningRef = useRef(false);
  useEffect(() => () => { if (edgeRafRef.current) cancelAnimationFrame(edgeRafRef.current); }, []);
  // Timestamp until which a double-click is ignored — a drag-create's
  // release can fire a spurious dblclick at the end point, which would
  // otherwise spawn a stray default region in the gap right after.
  const suppressDblRef = useRef(0);
  // The region whose hover affordances are shown (and a ref mirror so the
  // pointer-move handler can skip redundant setState churn).
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  // Whether the cursor is over the export handle specifically (vs elsewhere
  // in the region). Drives the handle's dim → bright nudge.
  // Which export grip is hovered: false | 'audio' | 'video'. Two DISTINCT
  // grips replace the old Alt+drag modifier — Windows treats Alt held
  // during DoDragDrop as a drop-effect override (link) and most targets
  // refuse the drop with the forbidden cursor, so a modifier key can
  // never gate the video drag.
  const [hoverHandle, setHoverHandle] = useState<false | 'audio' | 'video'>(false);
  const hoverHandleRef = useRef<false | 'audio' | 'video'>(false);
  // Alt held while on the handle → the drag exports video; the handle icon
  // flips to a film glyph to telegraph that. Synced from BOTH the pointer
  // move's modifier state (so Alt already held on arrival registers) and
  // key events (so a press/release while stationary registers); the ref
  // mirror dedupes the two and prevents missed/flip-flopped updates.

  const vpSpan = Math.max(1e-6, viewportEndSec - viewportStartSec);
  const secToPct = (sec: number) => ((sec - viewportStartSec) / vpSpan) * 100;

  const secAtClientX = useCallback((clientX: number): number => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return viewportStartSec;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.max(0, Math.min(durationSec, viewportStartSec + frac * vpSpan));
  }, [viewportStartSec, vpSpan, durationSec]);

  // Like secAtClientX but reads the LIVE viewport refs, so it stays correct
  // while the viewport pans mid-gesture (edge auto-scroll / ctrl+drag pan).
  const secAtClientXLive = useCallback((clientX: number): number => {
    const rect = rootRef.current?.getBoundingClientRect();
    const vs = vpStartRef.current;
    const span = Math.max(1e-6, vpEndRef.current - vs);
    if (!rect || rect.width <= 0) return vs;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.max(0, Math.min(durationSec, vs + frac * span));
  }, [durationSec]);

  // Classify the pointer position into a gesture zone. Edges win over the
  // bottom-centre Export handle, which wins over the body, which wins over
  // empty space.
  const hitTest = useCallback((clientX: number, clientY: number): Zone => {
    const rect = rootRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 1;
    const h = rect?.height ?? 1;
    const xpx = rect ? clientX - rect.left : 0;
    const ypx = rect ? clientY - rect.top : 0;
    const span = Math.max(1e-6, viewportEndSec - viewportStartSec);
    const xOf = (sec: number) => ((sec - viewportStartSec) / span) * w;
    for (const r of regions) {
      if (r.startSec > viewportStartSec && r.startSec < viewportEndSec && Math.abs(xpx - xOf(r.startSec)) <= EDGE_HIT_PX) {
        return { kind: 'resize', id: r.id, edge: 'start' };
      }
      if (r.endSec > viewportStartSec && r.endSec < viewportEndSec && Math.abs(xpx - xOf(r.endSec)) <= EDGE_HIT_PX) {
        return { kind: 'resize', id: r.id, edge: 'end' };
      }
    }
    const sec = secAtClientX(clientX);
    for (const r of regions) {
      if (sec > r.startSec && sec < r.endSec) {
        const xs = xOf(r.startSec), xe = xOf(r.endSec);
        // Drag-out grip = the whole bottom strip (full region width). Resize
        // edges already returned above, so they still win in their bands; the
        // body above the strip is the move zone.
        if (ypx >= h - dragoutBandPx(h)) {
          // Video links split the strip: left half audio, right half video —
          // only when the region is wide enough to land each half reliably.
          if (canExportVideo && (xe - xs) >= DUAL_STRIP_MIN_PX) {
            const video = xpx >= (xs + xe) / 2;
            return { kind: 'dragout', id: r.id, video, startX: clientX, startY: clientY, armed: false };
          }
          return { kind: 'dragout', id: r.id, video: false, startX: clientX, startY: clientY, armed: false };
        }
        return { kind: 'move', id: r.id, grabSec: sec, origStart: r.startSec, startX: clientX, moved: false };
      }
    }
    return { kind: 'create', anchorSec: sec, startX: clientX, createdId: null };
  }, [regions, viewportStartSec, viewportEndSec, secAtClientX]);

  const beginGesture = useCallback((e: React.PointerEvent, g: Zone) => {
    e.preventDefault();
    const captureEl = e.currentTarget as Element;
    const pid = e.pointerId;
    captureEl.setPointerCapture?.(pid);
    gestureRef.current = g;
    workingRef.current = regions;
    if (g.kind === 'create' || g.kind === 'resize' || g.kind === 'move') onGestureStart?.();
    if (g.kind === 'resize' || g.kind === 'move' || g.kind === 'dragout') onSelect(g.id);

    // Fire the imperative live-bounds channel for the gesture's active
    // region — the host re-arms the audition loop off this, ungated by React.
    const emitLive = () => {
      const cur = gestureRef.current;
      if (!cur) return;
      const id = cur.kind === 'create' ? cur.createdId
        : (cur.kind === 'resize' || cur.kind === 'move') ? cur.id : null;
      if (!id) return;
      const r = workingRef.current.find((x) => x.id === id);
      if (r) onLiveBoundsRef.current?.(id, r.startSec, r.endSec);
    };

    // Apply the active mutation for a pointer at clientX, reading the LIVE
    // viewport so the bound keeps tracking while the view auto-scrolls.
    const applyAt = (clientX: number) => {
      const cur = gestureRef.current;
      if (!cur) return;
      const sec = secAtClientXLive(clientX);
      if (cur.kind === 'create') {
        if (cur.createdId == null) {
          if (Math.abs(clientX - cur.startX) < DRAG_THRESH_PX) return;
          const { regions: next, id } = createDragRegion(workingRef.current, cur.anchorSec, sec, durationSec);
          if (id) { cur.createdId = id; workingRef.current = next; onChange(next); onSelect(id); }
        } else {
          workingRef.current = setRegionBounds(workingRef.current, cur.createdId, cur.anchorSec, sec, durationSec);
          onChange(workingRef.current);
        }
      } else if (cur.kind === 'resize') {
        workingRef.current = resizeEdge(workingRef.current, cur.id, cur.edge, sec, durationSec);
        onChange(workingRef.current);
      } else if (cur.kind === 'move') {
        if (!cur.moved && Math.abs(clientX - cur.startX) < DRAG_THRESH_PX) return;
        cur.moved = true;
        workingRef.current = moveRegion(workingRef.current, cur.id, cur.origStart + (sec - cur.grabSec), durationSec);
        onChange(workingRef.current);
      }
      emitLive();
    };

    const stopEdgeScroll = () => {
      if (edgeRafRef.current) { cancelAnimationFrame(edgeRafRef.current); edgeRafRef.current = 0; }
    };
    // Self-scheduling rAF: while a mutating gesture holds the pointer near an
    // edge, pan the viewport (proximity-scaled) and re-apply the bound at the
    // stationary pointer each frame. Stops when the pointer leaves the zone.
    const edgeTick = () => {
      edgeRafRef.current = 0;
      const cur = gestureRef.current;
      if (!cur || cur.kind === 'dragout') return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const x = lastPtrRef.current.x;
      const leftDist = x - rect.left;
      const rightDist = rect.right - x;
      let dir = 0, prox = 0;
      if (leftDist < EDGE_SCROLL_PX) { dir = -1; prox = (EDGE_SCROLL_PX - Math.max(0, leftDist)) / EDGE_SCROLL_PX; }
      else if (rightDist < EDGE_SCROLL_PX) { dir = 1; prox = (EDGE_SCROLL_PX - Math.max(0, rightDist)) / EDGE_SCROLL_PX; }
      if (dir === 0) return;
      const span = Math.max(1e-6, vpEndRef.current - vpStartRef.current);
      panViewportRef.current?.(dir * prox * span * EDGE_SCROLL_MAX_FRAC);
      applyAt(x);
      edgeRafRef.current = requestAnimationFrame(edgeTick);
    };
    const maybeEdgeScroll = () => {
      if (edgeRafRef.current || !panViewportRef.current) return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const x = lastPtrRef.current.x;
      if (x - rect.left < EDGE_SCROLL_PX || rect.right - x < EDGE_SCROLL_PX) {
        edgeRafRef.current = requestAnimationFrame(edgeTick);
      }
    };

    const onMove = (ev: PointerEvent) => {
      const cur = gestureRef.current;
      if (!cur) return;
      lastPtrRef.current = { x: ev.clientX, y: ev.clientY };
      if (cur.kind === 'dragout') {
        // Past the threshold, hand off to the OS file drag and end the
        // pointer gesture (release capture so DoDragDrop's modal loop gets
        // the button). The grabbed GRIP decides audio vs video — never a
        // modifier (Alt poisons DoDragDrop with the link drop-effect). A
        // press that never crosses the threshold stays a click.
        if (Math.abs(ev.clientX - cur.startX) < DRAG_THRESH_PX &&
            Math.abs(ev.clientY - cur.startY) < DRAG_THRESH_PX) return;
        cur.armed = true;
        gestureRef.current = null;
        stopEdgeScroll();
        captureEl.releasePointerCapture?.(pid);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        onDragOut(cur.id, { video: cur.video });
        return;
      }
      applyAt(ev.clientX);
      maybeEdgeScroll();
    };
    const onUp = (ev: PointerEvent) => {
      const cur = gestureRef.current;
      gestureRef.current = null;
      stopEdgeScroll();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!cur) return;
      if (cur.kind === 'create') {
        if (cur.createdId != null) {
          // Drew a region → arm it, and suppress the spurious dblclick the
          // release can fire at the end point (which would spawn a phantom).
          suppressDblRef.current = performance.now() + 400;
          onActivate(cur.createdId);
          onGestureEnd?.({ id: cur.createdId, kind: 'create' });
        } else {
          onSelect(null);
          onSeek(secAtClientX(ev.clientX));     // empty click → park + (Space plays whole)
        }
      } else if ((cur.kind === 'move' && !cur.moved) || (cur.kind === 'dragout' && !cur.armed)) {
        onActivate(cur.id);                     // click inside a region → swap loop
      } else if (cur.kind === 'resize') {
        onGestureEnd?.({ id: cur.id, kind: 'resize', edge: cur.edge });
      } else if (cur.kind === 'move' && cur.moved) {
        onGestureEnd?.({ id: cur.id, kind: 'move' });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [regions, durationSec, secAtClientX, secAtClientXLive, onChange, onSelect, onSeek, onActivate, onDragOut,
      onGestureStart, onGestureEnd]);

  // ctrl/cmd + left-drag pans the viewport (mirrors WaveformView's middle-drag
  // pan) instead of starting a region gesture. No undo snapshot; a press that
  // never moves is a no-op (no seek, no activate).
  const beginPan = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const captureEl = e.currentTarget as Element;
    const pid = e.pointerId;
    captureEl.setPointerCapture?.(pid);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    let lastX = e.clientX;
    const prevCursor = rootRef.current?.style.cursor ?? '';
    panningRef.current = true;
    if (rootRef.current) rootRef.current.style.cursor = 'grabbing';
    const onMove = (ev: PointerEvent) => {
      const span = Math.max(1e-6, vpEndRef.current - vpStartRef.current);
      const delta = ((lastX - ev.clientX) / rect.width) * span;
      lastX = ev.clientX;
      panViewportRef.current?.(delta);
    };
    const onUp = () => {
      panningRef.current = false;
      captureEl.releasePointerCapture?.(pid);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (rootRef.current) rootRef.current.style.cursor = prevCursor || createCursor;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [createCursor]);

  const cursorFor = (kind: Zone['kind']): string =>
    kind === 'resize' ? 'ew-resize' : kind === 'dragout' ? 'grab' : kind === 'move' ? 'move' : createCursor;

  const onRootPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return; // middle/right bubble → WaveformView built-in pan
    // Left gestures are OURS alone. Without this, the event bubbles into the
    // host WaveformView container whose Alt+drag tape-scrub handler would
    // start a scrub UNDER an in-flight region gesture (both fired — the
    // latent chop-window collision, and the visualizer's scrub/chop clash).
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) { beginPan(e); return; } // ctrl/cmd+drag = pan
    beginGesture(e, hitTest(e.clientX, e.clientY));
  }, [beginGesture, beginPan, hitTest]);

  // Hover: track which region (and zone) the pointer is over so we can show
  // the edit affordances and set a zone-appropriate cursor. Skipped while a
  // gesture is active (the pressed-zone cursor persists through the drag).
  const onRootPointerMove = useCallback((e: React.PointerEvent) => {
    if (gestureRef.current || panningRef.current) return;
    const z = hitTest(e.clientX, e.clientY);
    if (rootRef.current) rootRef.current.style.cursor = cursorFor(z.kind);
    const hid = z.kind === 'create' ? null : z.id;
    const onHandle: false | 'audio' | 'video' =
      z.kind === 'dragout' ? (z.video ? 'video' : 'audio') : false;
    if (hid !== hoverIdRef.current) { hoverIdRef.current = hid; setHoverId(hid); }
    if (onHandle !== hoverHandleRef.current) { hoverHandleRef.current = onHandle; setHoverHandle(onHandle); }
  }, [hitTest]);

  const onRootPointerLeave = useCallback(() => {
    if (hoverIdRef.current !== null) { hoverIdRef.current = null; setHoverId(null); }
    if (hoverHandleRef.current) { hoverHandleRef.current = false; setHoverHandle(false); }
  }, []);

  const onRootDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (performance.now() < suppressDblRef.current) return; // a drag-create just happened
    onCreateDefault(secAtClientX(e.clientX));
  }, [onCreateDefault, secAtClientX]);

  const sel = selectedId ? regions.find((r) => r.id === selectedId) ?? null : null;
  const hover = hoverId ? regions.find((r) => r.id === hoverId) ?? null : null;

  return (
    <div
      ref={rootRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: createCursor, zIndex: 2 }}
      onPointerDown={onRootPointerDown}
      onPointerMove={onRootPointerMove}
      onPointerLeave={onRootPointerLeave}
      onDoubleClick={onRootDoubleClick}
    >
      {durationSec > 0 && (
        <svg
          aria-hidden
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {/* Dim everything outside the active selection. */}
          {sel && (() => {
            const sx = Math.max(0, Math.min(100, secToPct(sel.startSec)));
            const ex = Math.max(0, Math.min(100, secToPct(sel.endSec)));
            return (
              <>
                {sx > 0 && <rect x={0} y={0} width={sx} height={100} style={{ fill: DARKEN }} />}
                {ex < 100 && <rect x={ex} y={0} width={100 - ex} height={100} style={{ fill: DARKEN }} />}
              </>
            );
          })()}

          {regions.map((r) => {
            const x0 = Math.max(0, Math.min(100, secToPct(r.startSec)));
            const x1 = Math.max(0, Math.min(100, secToPct(r.endSec)));
            const w = Math.max(0, x1 - x0);
            if (w <= 0 && (r.endSec < viewportStartSec || r.startSec > viewportEndSec)) return null;
            const isSel = r.id === selectedId;
            const isHover = r.id === hoverId;
            const showStart = r.startSec > viewportStartSec && r.startSec < viewportEndSec;
            const showEnd = r.endSec > viewportStartSec && r.endSec < viewportEndSec;
            return (
              <g key={r.id}>
                <rect x={x0} y={0} width={w} height={100} style={{ fill: r.color + (isSel ? '4a' : isHover ? '34' : '24') }} />
                {showStart && <line x1={x0} y1={0} x2={x0} y2={100} style={{ stroke: r.color }} strokeWidth={isSel ? 1.3 : 0.8} vectorEffect="non-scaling-stroke" />}
                {showEnd && <line x1={x1} y1={0} x2={x1} y2={100} style={{ stroke: r.color }} strokeWidth={isSel ? 1.3 : 0.8} vectorEffect="non-scaling-stroke" />}
              </g>
            );
          })}
        </svg>
      )}

      {/* Hover affordances: resize chevrons at the edges + a drag-out GRIP
          STRIP across the region's bottom (the export zone). Pixel-sized,
          %-positioned so they track zoom/pan; pointer-events:none so
          hit-testing stays in JS. */}
      {hover && (() => {
        const sPct = secToPct(hover.startSec);
        const ePct = secToPct(hover.endSec);
        const cPct = (sPct + ePct) / 2;
        // Clamp for the strip so a region running past the viewport edge still
        // paints a sane band instead of spilling off-canvas.
        const sClamp = Math.max(0, Math.min(100, sPct));
        const eClamp = Math.max(0, Math.min(100, ePct));
        const showStart = hover.startSec > viewportStartSec && hover.startSec < viewportEndSec;
        const showEnd = hover.endSec > viewportStartSec && hover.endSec < viewportEndSec;
        const showHandle = eClamp - sClamp > 1.5;
        const chevron: React.CSSProperties = {
          position: 'absolute', top: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.5)', borderRadius: 3, color: hover.color,
          height: 18, width: 13,
        };
        return (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
            {showStart && (
              <div style={{ ...chevron, left: `${sPct}%`, transform: 'translate(1px,-50%)' }}>
                <ChevronLeft size={12} />
              </div>
            )}
            {showEnd && (
              <div style={{ ...chevron, left: `${ePct}%`, transform: 'translate(calc(-100% - 1px),-50%)' }}>
                <ChevronRight size={12} />
              </div>
            )}
            {showHandle && (() => {
              const rect = rootRef.current?.getBoundingClientRect();
              const wpx = rect?.width ?? 0;
              const hpx = rect?.height ?? 0;
              const bandH = dragoutBandPx(hpx);
              const regionPx = (eClamp - sClamp) / 100 * wpx;
              // Split point, clamped into the visible band so a region running
              // past a viewport edge never yields a negative-width half.
              const cClamp = Math.max(sClamp, Math.min(eClamp, cPct));
              // Video links split the strip (audio | video) — never an Alt
              // modifier (Windows forces the link drop-effect under Alt).
              const dual = canExportVideo && regionPx >= DUAL_STRIP_MIN_PX;
              const stripBase: React.CSSProperties = {
                position: 'absolute', bottom: 0, height: bandH,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                background: hover.color, color: '#0a0a0a',
                boxShadow: '0 -1px 4px rgba(0,0,0,0.35)',
                transition: 'opacity 120ms ease',
              };
              return (
                <>
                  {hoverHandle && (
                    <div style={{
                      position: 'absolute', left: `${Math.max(sClamp, Math.min(eClamp, cPct))}%`,
                      bottom: bandH + 4,
                      transform: 'translateX(-50%)', padding: '1px 5px', borderRadius: 3,
                      background: 'rgba(0,0,0,0.8)', color: '#e5e7eb',
                      fontSize: 8, lineHeight: 1.5, whiteSpace: 'nowrap', letterSpacing: '0.02em',
                    }}>
                      {hoverHandle === 'video' ? 'Drag out the video clip' : 'Drag out the audio clip'}
                    </div>
                  )}
                  {dual ? (
                    <>
                      <div style={{
                        ...stripBase, left: `${sClamp}%`, width: `${cClamp - sClamp}%`,
                        borderTopLeftRadius: 3,
                        opacity: hoverHandle === 'audio' ? 0.92 : 0.5,
                      }}>
                        <Music size={10} strokeWidth={2.5} />
                        <GripVertical size={11} strokeWidth={2.5} />
                      </div>
                      <div style={{
                        ...stripBase, left: `${cClamp}%`, width: `${eClamp - cClamp}%`,
                        borderTopRightRadius: 3,
                        opacity: hoverHandle === 'video' ? 0.92 : 0.5,
                      }}>
                        <Film size={10} strokeWidth={2.5} />
                        <GripVertical size={11} strokeWidth={2.5} />
                      </div>
                    </>
                  ) : (
                    <div style={{
                      ...stripBase, left: `${sClamp}%`, width: `${eClamp - sClamp}%`,
                      borderTopLeftRadius: 3, borderTopRightRadius: 3,
                      opacity: hoverHandle ? 0.92 : 0.5,
                    }}>
                      <Music size={10} strokeWidth={2.5} />
                      <GripVertical size={11} strokeWidth={2.5} />
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        );
      })()}
    </div>
  );
};
