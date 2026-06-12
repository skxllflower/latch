// Multi-region selection overlay for the Latch chop window. Generalizes
// the single-region TrimOverlay to N non-overlapping, individually-
// coloured regions, and implements the audition + edit model:
//
//   • drag empty space           → draw a new region (auto-loops on release)
//   • double-click empty space    → add a default-width region (auto-loops)
//   • click INSIDE a region        → make it the active loop (swap)
//   • click OUTSIDE any region     → play the whole file from there, no loop
//   • drag a region EDGE           → resize that edge
//   • drag a region's bottom GRIP  → drag the clip OUT as a file (export);
//                                     video links show TWO grips (audio +
//                                     video — never an Alt modifier:
//                                     Windows refuses drops while Alt is
//                                     held, it forces the link drop-effect)
//   • drag the region BODY         → move the whole region
//   • scroll / middle-drag / trackpad → WaveformView's built-in zoom/pan
//
// On hover, a region shows affordances: a resize chevron at each edge and
// a grip handle in the centre (the drag-out zone). The cursor tracks the
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
}

const DRAG_THRESH_PX = 4;
const EDGE_HIT_PX = 6;
// The drag-out "Export" handle: a pill anchored at the BOTTOM-centre of a
// region. Its hit zone is just the handle box itself (so the rest of the
// body drags-to-move); the visual + hitbox use the same dimensions.
const HANDLE_W = 34;
const HANDLE_W2 = 26;     // each pill when the audio+video pair renders
const HANDLE_GAP = 4;
const HANDLE_H = 16;
const HANDLE_BOTTOM = 5;       // gap from the region's bottom edge
const HANDLE_HIT_PAD = 3;      // small forgiveness around the box
const DARKEN = 'rgba(0,0,0,0.55)';

type Zone =
  | { kind: 'create'; anchorSec: number; startX: number; createdId: string | null }
  | { kind: 'resize'; id: string; edge: 'start' | 'end' }
  | { kind: 'move'; id: string; grabSec: number; origStart: number; startX: number; moved: boolean }
  | { kind: 'dragout'; id: string; video: boolean; startX: number; startY: number; armed: boolean };

export const ChopRegionOverlay: React.FC<ChopRegionOverlayProps> = ({
  regions, selectedId, viewportStartSec, viewportEndSec, durationSec,
  onChange, onSelect, onSeek, onActivate, onCreateDefault, onDragOut, canExportVideo = false,
  onGestureStart, onGestureEnd,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Zone | null>(null);
  const workingRef = useRef<ChopRegion[]>(regions);
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
        const center = (xs + xe) / 2;
        // Export handle hitboxes at the bottom centre, only when the
        // region is wide enough to host them clear of the edges. Video
        // links get a PAIR of grips (audio + video) — never a modifier.
        const inY = ypx >= h - HANDLE_BOTTOM - HANDLE_H - HANDLE_HIT_PAD && ypx <= h - HANDLE_BOTTOM + HANDLE_HIT_PAD;
        if (canExportVideo && (xe - xs) >= 2 * HANDLE_W2 + HANDLE_GAP + 2 * EDGE_HIT_PX) {
          const off = (HANDLE_W2 + HANDLE_GAP) / 2;
          if (inY && Math.abs(xpx - (center - off)) <= HANDLE_W2 / 2 + HANDLE_HIT_PAD) {
            return { kind: 'dragout', id: r.id, video: false, startX: clientX, startY: clientY, armed: false };
          }
          if (inY && Math.abs(xpx - (center + off)) <= HANDLE_W2 / 2 + HANDLE_HIT_PAD) {
            return { kind: 'dragout', id: r.id, video: true, startX: clientX, startY: clientY, armed: false };
          }
        } else if ((xe - xs) >= HANDLE_W + 2 * EDGE_HIT_PX
            && inY && Math.abs(xpx - center) <= HANDLE_W / 2 + HANDLE_HIT_PAD) {
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

    const onMove = (ev: PointerEvent) => {
      const cur = gestureRef.current;
      if (!cur) return;
      const sec = secAtClientX(ev.clientX);
      if (cur.kind === 'create') {
        if (cur.createdId == null) {
          if (Math.abs(ev.clientX - cur.startX) < DRAG_THRESH_PX) return;
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
        if (!cur.moved && Math.abs(ev.clientX - cur.startX) < DRAG_THRESH_PX) return;
        cur.moved = true;
        workingRef.current = moveRegion(workingRef.current, cur.id, cur.origStart + (sec - cur.grabSec), durationSec);
        onChange(workingRef.current);
      } else if (cur.kind === 'dragout') {
        // Past the threshold, hand off to the OS file drag and end the
        // pointer gesture (release capture so DoDragDrop's modal loop gets
        // the button). The grabbed GRIP decides audio vs video — never a
        // modifier (Alt poisons DoDragDrop with the link drop-effect). A
        // press that never crosses the threshold stays a click.
        if (Math.abs(ev.clientX - cur.startX) < DRAG_THRESH_PX &&
            Math.abs(ev.clientY - cur.startY) < DRAG_THRESH_PX) return;
        cur.armed = true;
        gestureRef.current = null;
        captureEl.releasePointerCapture?.(pid);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        onDragOut(cur.id, { video: cur.video });
      }
    };
    const onUp = (ev: PointerEvent) => {
      const cur = gestureRef.current;
      gestureRef.current = null;
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
  }, [regions, durationSec, secAtClientX, onChange, onSelect, onSeek, onActivate, onDragOut,
      onGestureStart, onGestureEnd]);

  const cursorFor = (kind: Zone['kind']): string =>
    kind === 'resize' ? 'ew-resize' : kind === 'dragout' ? 'grab' : kind === 'move' ? 'move' : 'crosshair';

  const onRootPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return; // middle/right bubble → WaveformView built-in pan
    beginGesture(e, hitTest(e.clientX, e.clientY));
  }, [beginGesture, hitTest]);

  // Hover: track which region (and zone) the pointer is over so we can show
  // the edit affordances and set a zone-appropriate cursor. Skipped while a
  // gesture is active (the pressed-zone cursor persists through the drag).
  const onRootPointerMove = useCallback((e: React.PointerEvent) => {
    if (gestureRef.current) return;
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
      style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'crosshair', zIndex: 2 }}
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

      {/* Hover affordances: resize chevrons at the edges + an Export pill at
          the bottom centre (the drag-out zone). Pixel-sized, %-positioned so
          they track zoom/pan; pointer-events:none so hit-testing stays in JS. */}
      {hover && (() => {
        const sPct = secToPct(hover.startSec);
        const ePct = secToPct(hover.endSec);
        const cPct = (sPct + ePct) / 2;
        const showStart = hover.startSec > viewportStartSec && hover.startSec < viewportEndSec;
        const showEnd = hover.endSec > viewportStartSec && hover.endSec < viewportEndSec;
        const showHandle = cPct > 1 && cPct < 99 && (ePct - sPct) > 7;
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
              // Video links render a PAIR of grips (audio + video) instead
              // of an Alt modifier — Windows refuses drops while Alt is
              // held (link drop-effect), so the modifier could never work.
              const rectW = rootRef.current?.getBoundingClientRect().width ?? 0;
              const regionPx = (ePct - sPct) / 100 * rectW;
              const dual = canExportVideo && regionPx >= 2 * HANDLE_W2 + HANDLE_GAP + 2 * EDGE_HIT_PX;
              const pill = (video: boolean, leftCalc: string) => (
                <div key={video ? 'v' : 'a'} style={{
                  position: 'absolute', left: leftCalc, bottom: HANDLE_BOTTOM,
                  transform: 'translateX(-50%)', width: dual ? HANDLE_W2 : HANDLE_W, height: HANDLE_H,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1,
                  background: hover.color, color: '#0a0a0a', borderRadius: 4,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  opacity: hoverHandle === (video ? 'video' : 'audio') ? 1 : 0.55,
                  transition: 'opacity 120ms ease',
                }}>
                  {video ? <Film size={9} strokeWidth={2.5} /> : <Music size={9} strokeWidth={2.5} />}
                  <GripVertical size={10} strokeWidth={2.5} />
                </div>
              );
              const off = (HANDLE_W2 + HANDLE_GAP) / 2;
              return (
                <>
                  {hoverHandle && (
                    <div style={{
                      position: 'absolute', left: `${cPct}%`, bottom: HANDLE_BOTTOM + HANDLE_H + 5,
                      transform: 'translateX(-50%)', padding: '1px 5px', borderRadius: 3,
                      background: 'rgba(0,0,0,0.8)', color: '#e5e7eb',
                      fontSize: 8, lineHeight: 1.5, whiteSpace: 'nowrap', letterSpacing: '0.02em',
                    }}>
                      {hoverHandle === 'video' ? 'Drag out the video clip' : 'Drag out the audio clip'}
                    </div>
                  )}
                  {dual ? (
                    <>
                      {pill(false, `calc(${cPct}% - ${off}px)`)}
                      {pill(true, `calc(${cPct}% + ${off}px)`)}
                    </>
                  ) : (
                    pill(false, `${cPct}%`)
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
