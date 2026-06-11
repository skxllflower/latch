import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

// Shared zoom/pan/pinch engine for canvas content viewers (ImageView,
// VideoView). Extracted from the image viewer so both get the exact same
// feel: cursor-anchored wheel zoom with an eased tween, drag-pan with release
// momentum, Windows HID pinch/pan (the global wd-pinch-zoom / wd-trackpad-*
// events), Mac gesturechange, multi-touch pinch, and fit/zoom controls.
//
// The view is a {scale, offsetX, offsetY} transform over content of size
// (contentW × contentH), drawn into a container of `containerSize`. The hook
// owns the gesture state + a ResizeObserver and returns the live view plus
// the pointer handlers to spread on the container.

export type View = { s: number; ox: number; oy: number };

const WHEEL_K        = 0.0019;  // mouse wheel
const PINCH_WHEEL_K  = 0.01;    // mac trackpad pinch fallback (non-HID)
const TWEEN_K        = 0.18;    // eased-tween catch-up per frame
const HID_TO_PX      = 0.6;     // HID trackpad-pan units → px
const MAX_PIXEL_ZOOM = 64;      // up to 64 canvas px per content px
const TAP_SLOP       = 5;       // px of movement under which a press counts as a tap

export function fitScale(cw: number, ch: number, iw: number, ih: number): number {
  if (iw <= 0 || ih <= 0) return 1;
  return Math.min(cw / iw, ch / ih);
}
export function fitView(cw: number, ch: number, iw: number, ih: number): View {
  const s = fitScale(cw, ch, iw, ih);
  return { s, ox: (cw - iw * s) / 2, oy: (ch - ih * s) / 2 };
}

interface Options {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentW: number;
  contentH: number;
  enabled?: boolean;                                  // gate gestures (e.g. until loaded)
  spacebarFit?: boolean;                              // bind Space → fit toggle (off for video, where Space = play/pause)
  onHover?: (clientX: number, clientY: number) => void;  // non-drag pointer move
  onLeave?: () => void;
  onTap?: (clientX: number, clientY: number) => void;    // click with no drag
}

export function useCanvasViewport({ containerRef, contentW, contentH, enabled = true, spacebarFit = true, onHover, onLeave, onTap }: Options) {
  const [view, setView] = useState<View>({ s: 1, ox: 0, oy: 0 });
  const viewRef = useRef(view); viewRef.current = view;
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(containerSize); sizeRef.current = containerSize;
  const contentRef = useRef({ w: contentW, h: contentH }); contentRef.current = { w: contentW, h: contentH };
  const [panning, setPanning] = useState(false);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;

  const targetRef = useRef<View | null>(null);
  const tweenRafRef = useRef<number | null>(null);
  const momentumRafRef = useRef<number | null>(null);
  const panStateRef = useRef<{ active: boolean; lastX: number; lastY: number; startX: number; startY: number; moved: number } | null>(null);
  const panSamplesRef = useRef<{ t: number; x: number; y: number }[]>([]);
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureStateRef = useRef<{ pair: [number, number]; lastDist: number; lastCx: number; lastCy: number } | null>(null);
  const isHoveredRef = useRef(false);
  const trackpadActiveUntilRef = useRef(0);
  const lastZoomRef = useRef<View | null>(null);
  const hoverClientRef = useRef<{ x: number; y: number } | null>(null);
  const onHoverRef = useRef(onHover); onHoverRef.current = onHover;
  const onTapRef = useRef(onTap); onTapRef.current = onTap;

  const clampView = useCallback((v: View): View => {
    const { w: cw, h: ch } = sizeRef.current;
    const { w: iw, h: ih } = contentRef.current;
    if (cw <= 0 || ch <= 0 || iw <= 0 || ih <= 0) return v;
    const sFit = fitScale(cw, ch, iw, ih);
    const sMax = Math.max(sFit, MAX_PIXEL_ZOOM);
    const s = Math.max(sFit, Math.min(sMax, v.s));
    const dw = iw * s, dh = ih * s;
    const ox = dw <= cw ? (cw - dw) / 2 : Math.max(cw - dw, Math.min(0, v.ox));
    const oy = dh <= ch ? (ch - dh) / 2 : Math.max(ch - dh, Math.min(0, v.oy));
    return { s, ox, oy };
  }, []);

  const zoomAround = useCallback((base: View, newS: number, cx: number, cy: number): View => {
    const ratio = newS / base.s;
    return clampView({ s: newS, ox: cx - (cx - base.ox) * ratio, oy: cy - (cy - base.oy) * ratio });
  }, [clampView]);

  const cancelTween = useCallback(() => {
    if (tweenRafRef.current !== null) { cancelAnimationFrame(tweenRafRef.current); tweenRafRef.current = null; }
    targetRef.current = null;
  }, []);
  const cancelMomentum = useCallback(() => {
    if (momentumRafRef.current !== null) { cancelAnimationFrame(momentumRafRef.current); momentumRafRef.current = null; }
  }, []);

  const tick = useCallback(() => {
    const target = targetRef.current;
    if (!target) { tweenRafRef.current = null; return; }
    const cur = viewRef.current;
    const next: View = {
      s:  cur.s  + (target.s  - cur.s)  * TWEEN_K,
      ox: cur.ox + (target.ox - cur.ox) * TWEEN_K,
      oy: cur.oy + (target.oy - cur.oy) * TWEEN_K,
    };
    const done = Math.abs(next.s - target.s) / Math.max(1e-6, target.s) < 0.001
      && Math.abs(next.ox - target.ox) < 0.3 && Math.abs(next.oy - target.oy) < 0.3;
    if (done) { setView(target); tweenRafRef.current = null; targetRef.current = null; return; }
    setView(next);
    tweenRafRef.current = requestAnimationFrame(tick);
  }, []);
  const easeTo = useCallback((v: View) => {
    targetRef.current = v;
    if (tweenRafRef.current === null) tweenRafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const applyPinchZoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    if (!isFinite(factor) || factor <= 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    let cx: number, cy: number;
    if (clientX !== undefined && clientY !== undefined) {
      cx = clientX - rect.left; cy = clientY - rect.top;
      if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) return;
    } else {
      const h = hoverClientRef.current;
      if (!h) return;
      cx = h.x - rect.left; cy = h.y - rect.top;
    }
    const base = targetRef.current ?? viewRef.current;
    cancelMomentum();
    easeTo(zoomAround(base, base.s * factor, cx, cy));
  }, [containerRef, cancelMomentum, easeTo, zoomAround]);

  const panSmoothBy = useCallback((dx: number, dy: number) => {
    const base = targetRef.current ?? viewRef.current;
    easeTo(clampView({ s: base.s, ox: base.ox + dx, oy: base.oy + dy }));
  }, [clampView, easeTo]);
  const panBy = useCallback((dx: number, dy: number) => {
    const v = viewRef.current;
    setView(clampView({ s: v.s, ox: v.ox + dx, oy: v.oy + dy }));
  }, [clampView]);

  // ---- momentum ----
  const releaseVelocity = useCallback(() => {
    const s = panSamplesRef.current;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const last = s[s.length - 1];
    const cutoff = last.t - 30;
    let i = s.length - 1;
    while (i > 0 && s[i - 1].t >= cutoff) i--;
    if (i >= s.length - 1) return { vx: 0, vy: 0 };
    const dt = last.t - s[i].t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (last.x - s[i].x) / dt, vy: (last.y - s[i].y) / dt };
  }, []);
  const startMomentum = useCallback(() => {
    cancelMomentum();
    const { vx, vy } = releaseVelocity();
    if (Math.hypot(vx, vy) < 0.5) return;
    let lastT = performance.now(), curVx = vx, curVy = vy;
    const step = () => {
      const now = performance.now();
      const dt = Math.min(40, now - lastT); lastT = now;
      panBy(curVx * dt, curVy * dt);
      const decay = Math.pow(0.85, dt / 16);
      curVx *= decay; curVy *= decay;
      if (Math.hypot(curVx, curVy) < 0.05) { momentumRafRef.current = null; return; }
      momentumRafRef.current = requestAnimationFrame(step);
    };
    momentumRafRef.current = requestAnimationFrame(step);
  }, [cancelMomentum, releaseVelocity, panBy]);

  // Cancel any in-flight tween / momentum rAF when the consumer (ImageView /
  // VideoView) unmounts so the loop doesn't keep calling setView on a dead
  // component until the tween/decay happens to settle.
  useEffect(() => () => {
    if (tweenRafRef.current !== null) { cancelAnimationFrame(tweenRafRef.current); tweenRafRef.current = null; }
    if (momentumRafRef.current !== null) { cancelAnimationFrame(momentumRafRef.current); momentumRafRef.current = null; }
  }, []);

  // ---- multi-touch ----
  const pickPair = useCallback((): [number, number] | null => {
    if (touchesRef.current.size < 2) return null;
    const ids = Array.from(touchesRef.current.keys()).sort((a, b) => a - b);
    return [ids[0], ids[1]];
  }, []);
  const pairMetrics = useCallback((pair: [number, number]) => {
    const a = touchesRef.current.get(pair[0]); const b = touchesRef.current.get(pair[1]);
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }, []);
  const reseatGesture = useCallback(() => {
    const pair = pickPair();
    const m = pair && pairMetrics(pair);
    gestureStateRef.current = pair && m ? { pair, lastDist: m.dist, lastCx: m.cx, lastCy: m.cy } : null;
  }, [pickPair, pairMetrics]);

  // ---- pointer handlers ----
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabledRef.current) return;
    cancelMomentum(); cancelTween();
    if (e.pointerType === 'touch') {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (touchesRef.current.size >= 2) reseatGesture();
      e.preventDefault();
      return;
    }
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      panStateRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: 0 };
      panSamplesRef.current = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      setPanning(true);
    }
  }, [cancelMomentum, cancelTween, reseatGesture]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    hoverClientRef.current = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch' && touchesRef.current.has(e.pointerId)) {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const gs = gestureStateRef.current;
      if (gs) {
        if (!touchesRef.current.has(gs.pair[0]) || !touchesRef.current.has(gs.pair[1])) { reseatGesture(); e.preventDefault(); return; }
        const m = pairMetrics(gs.pair);
        if (m) {
          if (gs.lastDist > 4 && m.dist > 4) applyPinchZoom(m.dist / gs.lastDist, m.cx, m.cy);
          const dx = m.cx - gs.lastCx, dy = m.cy - gs.lastCy;
          if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) panSmoothBy(dx, dy);
          gs.lastDist = m.dist; gs.lastCx = m.cx; gs.lastCy = m.cy;
        }
        e.preventDefault();
        return;
      }
      if (touchesRef.current.size === 1) {
        const prev = touchesRef.current.get(e.pointerId)!;
        panSmoothBy(e.clientX - prev.x, e.clientY - prev.y);
      }
      e.preventDefault();
      return;
    }
    if (panStateRef.current?.active) {
      const ps = panStateRef.current;
      const dx = e.clientX - ps.lastX, dy = e.clientY - ps.lastY;
      ps.lastX = e.clientX; ps.lastY = e.clientY;
      ps.moved += Math.abs(dx) + Math.abs(dy);
      const now = performance.now();
      const s = panSamplesRef.current;
      s.push({ t: now, x: e.clientX, y: e.clientY });
      while (s.length && now - s[0].t > 80) s.shift();
      panSmoothBy(dx, dy);
      return;
    }
    onHoverRef.current?.(e.clientX, e.clientY);
  }, [reseatGesture, pairMetrics, applyPinchZoom, panSmoothBy]);

  const endPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      touchesRef.current.delete(e.pointerId);
      if (gestureStateRef.current) { if (touchesRef.current.size >= 2) reseatGesture(); else gestureStateRef.current = null; }
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    const ps = panStateRef.current;
    if (ps?.active) {
      const wasTap = ps.moved < TAP_SLOP;
      panStateRef.current = null;
      setPanning(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wasTap) onTapRef.current?.(e.clientX, e.clientY);
      else startMomentum();
    }
  }, [reseatGesture, startMomentum]);

  const onPointerLeave = useCallback(() => { onLeave?.(); }, [onLeave]);

  // ---- wheel (native, non-passive) ----
  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPad|iPhone/.test(navigator.platform || navigator.userAgent || '');
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!enabledRef.current) return;
      if (performance.now() < trackpadActiveUntilRef.current) return;
      cancelMomentum();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const isMouseWheel = !isMac || e.deltaMode === 1
        || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 30);
      if (!isMouseWheel && !e.ctrlKey) { panSmoothBy(-e.deltaX, -e.deltaY); return; }
      const base = isMouseWheel ? viewRef.current : (targetRef.current ?? viewRef.current);
      const k = isMouseWheel ? WHEEL_K : PINCH_WHEEL_K;
      easeTo(zoomAround(base, base.s * Math.exp(-e.deltaY * k), cx, cy));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [containerRef, cancelMomentum, panSmoothBy, easeTo, zoomAround]);

  // ---- hover gate + Tauri HID gesture events ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const on = () => { isHoveredRef.current = true; };
    const off = () => { isHoveredRef.current = false; };
    el.addEventListener('mouseenter', on); el.addEventListener('mouseleave', off);
    el.addEventListener('mousemove', on); window.addEventListener('blur', off);
    return () => {
      el.removeEventListener('mouseenter', on); el.removeEventListener('mouseleave', off);
      el.removeEventListener('mousemove', on); window.removeEventListener('blur', off);
    };
  }, [containerRef]);

  useEffect(() => {
    let un: (() => void) | null = null; let disposed = false;
    listen<boolean>('wd-trackpad-active', (e) => {
      if (!isHoveredRef.current) return;
      trackpadActiveUntilRef.current = e.payload ? Number.MAX_SAFE_INTEGER : performance.now() + 250;
    }).then((fn) => { if (disposed) fn(); else un = fn; });
    return () => { disposed = true; if (un) un(); };
  }, []);
  useEffect(() => {
    let un: (() => void) | null = null; let disposed = false;
    listen<number>('wd-pinch-zoom', (e) => {
      if (!isHoveredRef.current) return;
      trackpadActiveUntilRef.current = Math.max(trackpadActiveUntilRef.current, performance.now() + 150);
      applyPinchZoom(e.payload);
    }).then((fn) => { if (disposed) fn(); else un = fn; });
    return () => { disposed = true; if (un) un(); };
  }, [applyPinchZoom]);
  useEffect(() => {
    let un: (() => void) | null = null; let disposed = false;
    listen<[number, number]>('wd-trackpad-pan', (e) => {
      if (!isHoveredRef.current) return;
      trackpadActiveUntilRef.current = Math.max(trackpadActiveUntilRef.current, performance.now() + 150);
      panSmoothBy(-e.payload[0] * HID_TO_PX, -e.payload[1] * HID_TO_PX);
    }).then((fn) => { if (disposed) fn(); else un = fn; });
    return () => { disposed = true; if (un) un(); };
  }, [panSmoothBy]);

  // Mac trackpad pinch.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastScale = 1.0;
    const onStart = (e: Event) => { e.preventDefault(); lastScale = 1.0; };
    const onChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      if (lastScale > 0 && isFinite(ge.scale) && ge.scale > 0) applyPinchZoom(ge.scale / lastScale, ge.clientX, ge.clientY);
      lastScale = ge.scale;
    };
    const onEnd = (e: Event) => { e.preventDefault(); lastScale = 1.0; };
    el.addEventListener('gesturestart', onStart as EventListener);
    el.addEventListener('gesturechange', onChange as EventListener);
    el.addEventListener('gestureend', onEnd as EventListener);
    return () => {
      el.removeEventListener('gesturestart', onStart as EventListener);
      el.removeEventListener('gesturechange', onChange as EventListener);
      el.removeEventListener('gestureend', onEnd as EventListener);
    };
  }, [containerRef, applyPinchZoom]);

  // ---- resize ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const w = Math.round(cr.width), h = Math.round(cr.height);
        const prev = sizeRef.current;
        if (w === prev.w && h === prev.h) return;
        const { w: iw, h: ih } = contentRef.current;
        setContainerSize({ w, h }); sizeRef.current = { w, h };
        if (iw <= 0 || ih <= 0) return;
        cancelTween(); cancelMomentum();
        if (prev.w === 0 || prev.h === 0) { setView(fitView(w, h, iw, ih)); return; }
        const v = viewRef.current;
        const wasFit = Math.abs(v.s - fitScale(prev.w, prev.h, iw, ih)) < 1e-3;
        setView(wasFit ? fitView(w, h, iw, ih) : clampView(v));
      });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [containerRef, clampView, cancelTween, cancelMomentum]);

  const fit = useCallback(() => {
    let { w: cw, h: ch } = sizeRef.current;
    // sizeRef can still be 0 here when a fast/cache-hit load fires the
    // content-size effect before the ResizeObserver's rAF has measured the
    // container. Falling back to the content's own dims (cw || iw) fits at
    // scale 1 / top-left — the "starts small and off to the side, then grows
    // into place" pop. Measure the real container directly instead so the
    // very first fit is already correct and there's nothing to grow from.
    if (cw === 0 || ch === 0) {
      const r = containerRef.current?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) { cw = Math.round(r.width); ch = Math.round(r.height); }
    }
    const { w: iw, h: ih } = contentRef.current;
    if (iw <= 0) return;
    cancelMomentum(); cancelTween();
    setView(fitView(cw || iw, ch || ih, iw, ih));
    lastZoomRef.current = null;
  }, [cancelMomentum, cancelTween, containerRef]);

  // Fit whenever the content dimensions become known / change.
  useEffect(() => {
    if (contentW > 0 && contentH > 0) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentW, contentH]);

  const cycleZoom = useCallback(() => {
    const { w: cw, h: ch } = sizeRef.current;
    const { w: iw, h: ih } = contentRef.current;
    if (iw <= 0) return;
    const f = fitScale(cw, ch, iw, ih);
    const ratio = viewRef.current.s / f;
    cancelMomentum();
    if (ratio < 1.5) easeTo(zoomAround(viewRef.current, f * 2, cw / 2, ch / 2));
    else if (ratio < 3) easeTo(zoomAround(viewRef.current, f * 4, cw / 2, ch / 2));
    else { cancelTween(); setView(fitView(cw, ch, iw, ih)); }
  }, [cancelMomentum, cancelTween, easeTo, zoomAround]);

  // Spacebar toggles fit ↔ last zoom while hovering (opt-out for video).
  useEffect(() => {
    if (!spacebarFit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !isHoveredRef.current || !enabledRef.current) return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cancelTween();
      const { w: cw, h: ch } = sizeRef.current;
      const { w: iw, h: ih } = contentRef.current;
      const sFit = fitScale(cw, ch, iw, ih);
      if (Math.abs(viewRef.current.s - sFit) < 1e-4) {
        if (lastZoomRef.current) setView(clampView(lastZoomRef.current));
      } else {
        lastZoomRef.current = viewRef.current;
        setView(fitView(cw, ch, iw, ih));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cancelTween, clampView, spacebarFit]);

  const sFit = useMemo(() => fitScale(containerSize.w, containerSize.h, contentW, contentH), [containerSize, contentW, contentH]);

  return {
    view, viewRef, setView, containerSize, sFit, panning,
    isZoomed: view.s > sFit + 1e-4,
    fit, cycleZoom,
    handlers: { onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer, onPointerLeave },
  };
}
