// Standalone waveform for the Chop window. WAVdesk's WaveformView is a
// 1700-line subsystem entangled with the host app (transport, tool
// previews, settings, peak cache) — the slice Chop actually uses is
// peaks + zoom/pan + playhead + the overlay slot, and that's what this
// implements, honoring the exact same overlay viewport contract
// ({tStart, tEnd, durationSec}) so ChopRegionOverlay ports verbatim.
//
// Sharp at any zoom: peaks re-fetch for the visible window (debounced)
// at ~2x pixel density via generate_waveform's startSec/endSec range,
// instead of decimating one whole-file array.
//
// Interactions (matching the chop hint text): scroll = zoom around the
// cursor, Shift+scroll or middle-drag = pan. Click/drag is owned by the
// region overlay sitting on top.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { playbackEngine } from './playbackEngine';

export interface WaveAudioFile {
  path: string;
  durationSec: number;
}

interface WaveformViewProps {
  audioFile: WaveAudioFile | null;
  filePath: string;
  clickMode?: 'seek';
  hideTransport?: boolean;
  // When provided, the playhead renders at this position; when absent it
  // follows the engine while OUR file is playing.
  playheadGetter?: () => number;
  overlay?: (vp: { tStart: number; tEnd: number; durationSec: number }) => React.ReactNode;
  // Vertical tick marks (e.g. chapter starts, the armed I point) drawn
  // behind the peaks. Default tint is the chapter amber; pass `color`
  // for distinct marks.
  markers?: { sec: number; label?: string; color?: string }[];
}

interface WaveData {
  success: boolean;
  duration_sec: number;
  points: number[];
}

const MIN_SPAN_SEC = 0.02;

export const WaveformView: React.FC<WaveformViewProps> = ({
  audioFile, filePath, playheadGetter, overlay, markers,
}) => {
  const duration = audioFile?.durationSec ?? 0;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);

  const [vp, setVp] = useState<{ tStart: number; tEnd: number }>({ tStart: 0, tEnd: 0 });
  const vpRef = useRef(vp);
  vpRef.current = vp;

  // Reset the viewport to full when the file/duration changes.
  useEffect(() => {
    if (duration > 0) setVp({ tStart: 0, tEnd: duration });
  }, [filePath, duration]);

  const peaksRef = useRef<{ points: number[]; tStart: number; tEnd: number } | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pk = peaksRef.current;
    const cur = vpRef.current;
    const span = Math.max(1e-6, cur.tEnd - cur.tStart);
    // Center line.
    ctx.fillStyle = 'rgba(161,161,170,0.25)';
    ctx.fillRect(0, h / 2 - 0.5, w, 1);
    // Chapter/marker ticks behind the peaks.
    const mks = markersRef.current;
    if (mks?.length) {
      for (const m of mks) {
        if (m.sec < cur.tStart || m.sec > cur.tEnd) continue;
        ctx.fillStyle = m.color ?? 'rgba(251,191,36,0.35)';
        const wPx = m.color ? 2 : 1;
        ctx.fillRect(((m.sec - cur.tStart) / span) * w, 0, wPx, h);
      }
    }
    if (!pk || pk.points.length === 0) return;

    const pkSpan = Math.max(1e-6, pk.tEnd - pk.tStart);
    ctx.fillStyle = '#a1a1aa';
    const mid = h / 2;
    const usable = (h / 2) * 0.92;
    for (let x = 0; x < w; x++) {
      const t = cur.tStart + (x / w) * span;
      const fi = ((t - pk.tStart) / pkSpan) * pk.points.length;
      const i = Math.floor(fi);
      if (i < 0 || i >= pk.points.length) continue;
      const amp = Math.min(1, pk.points[i]);
      const half = Math.max(0.5, amp * usable);
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }, []);

  // Debounced range-fetch of peaks for the visible window.
  useEffect(() => {
    if (!filePath || duration <= 0 || vp.tEnd <= vp.tStart) return;
    let stale = false;
    const id = window.setTimeout(() => {
      const w = containerRef.current?.clientWidth ?? 800;
      void invoke<WaveData>('generate_waveform', {
        path: filePath,
        points: Math.min(8000, Math.max(256, Math.round(w * 2))),
        startSec: vp.tStart,
        endSec: vp.tEnd,
      }).then((data) => {
        if (stale || !data?.success) return;
        peaksRef.current = { points: data.points ?? [], tStart: vp.tStart, tEnd: vp.tEnd };
        draw();
      }).catch(() => { /* peaks are cosmetic; the overlay still works */ });
    }, 80);
    return () => { stale = true; window.clearTimeout(id); };
  }, [filePath, duration, vp.tStart, vp.tEnd, draw]);

  // Redraw on resize (peaks refetch piggybacks on the next zoom/pan).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { draw(); }, [vp, markers, draw]);

  // Wheel: zoom around the cursor; Shift (or a sideways wheel) pans.
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (duration <= 0) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const cur = vpRef.current;
    const span = Math.max(1e-6, cur.tEnd - cur.tStart);
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (pan) {
      const delta = (pan && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)
        / rect.width * span;
      let s = cur.tStart + delta;
      let t = cur.tEnd + delta;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; }
      setVp({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
      return;
    }
    const factor = Math.pow(1.0015, e.deltaY);
    const newSpan = Math.max(MIN_SPAN_SEC, Math.min(duration, span * factor));
    const anchor = cur.tStart + frac * span;
    let s = anchor - frac * newSpan;
    let t = s + newSpan;
    if (s < 0) { t -= s; s = 0; }
    if (t > duration) { s -= t - duration; t = duration; s = Math.max(0, s); }
    setVp({ tStart: s, tEnd: t });
  }, [duration]);

  // Precision-touchpad pinch/pan via the raw-HID subsystem
  // (touchpad_raw_input.rs broadcasts wd-pinch-zoom / wd-trackpad-pan;
  // WebView2 eats the native gestures before any DOM event fires).
  // Hover-gated so gestures over other surfaces don't zoom the wave.
  const hoverRef = useRef(false);
  const lastXRef = useRef<number | null>(null);
  useEffect(() => {
    let unZoom: (() => void) | null = null;
    let unPan: (() => void) | null = null;
    let disposed = false;
    listen<number>('wd-pinch-zoom', (e) => {
      if (!hoverRef.current || duration <= 0) return;
      const factor = e.payload;
      if (typeof factor !== 'number' || !isFinite(factor) || factor <= 0) return;
      const rect = containerRef.current?.getBoundingClientRect();
      const frac = lastXRef.current != null && rect && rect.width > 0
        ? Math.max(0, Math.min(1, (lastXRef.current - rect.left) / rect.width))
        : 0.5;
      // factor > 1 = fingers apart = zoom IN = the visible span shrinks.
      const cur = vpRef.current;
      const span = Math.max(1e-6, cur.tEnd - cur.tStart);
      const newSpan = Math.max(MIN_SPAN_SEC, Math.min(duration, span / factor));
      const anchor = cur.tStart + frac * span;
      let s = anchor - frac * newSpan;
      let t = s + newSpan;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; s = Math.max(0, s); }
      setVp({ tStart: s, tEnd: t });
    }).then((fn) => { if (disposed) fn(); else unZoom = fn; });
    listen<[number, number]>('wd-trackpad-pan', (e) => {
      if (!hoverRef.current || duration <= 0) return;
      const [dx] = e.payload ?? [0, 0];
      if (!isFinite(dx) || dx === 0) return;
      const cur = vpRef.current;
      const span = Math.max(1e-6, cur.tEnd - cur.tStart);
      // HID units → span fraction (touchpads span a few thousand units).
      // Negative: content follows the fingers (natural touch scrolling).
      const delta = -(dx / 1500) * span;
      let s = cur.tStart + delta;
      let t = cur.tEnd + delta;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; }
      setVp({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
    }).then((fn) => { if (disposed) fn(); else unPan = fn; });
    return () => { disposed = true; unZoom?.(); unPan?.(); };
  }, [duration]);

  // Middle-drag pan.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 1 || duration <= 0) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const startX = e.clientX;
    const orig = { ...vpRef.current };
    const span = Math.max(1e-6, orig.tEnd - orig.tStart);
    const onMove = (ev: PointerEvent) => {
      const delta = ((startX - ev.clientX) / rect.width) * span;
      let s = orig.tStart + delta;
      let t = orig.tEnd + delta;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; }
      setVp({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [duration]);

  // Playhead — rAF-driven ref mutation, no React state churn.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = playheadRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!el || !rect || rect.width <= 0) return;
      let pos: number | null = null;
      if (playheadGetter) {
        pos = playheadGetter();
      } else if (playbackEngine.getCurrentPath() === filePath &&
                 playbackEngine.getState() !== 'stopped') {
        pos = playbackEngine.getPosition();
      }
      const cur = vpRef.current;
      const span = Math.max(1e-6, cur.tEnd - cur.tStart);
      if (pos == null || pos < cur.tStart || pos > cur.tEnd) {
        el.style.opacity = '0';
        return;
      }
      el.style.opacity = '1';
      el.style.transform = `translateX(${((pos - cur.tStart) / span) * rect.width}px)`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [filePath, playheadGetter]);

  const vpForOverlay = useMemo(
    () => ({ tStart: vp.tStart, tEnd: vp.tEnd, durationSec: duration }),
    [vp, duration],
  );

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerMove={(e) => { hoverRef.current = true; lastXRef.current = e.clientX; }}
      onPointerLeave={() => { hoverRef.current = false; }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <div
        ref={playheadRef}
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: 1,
          background: '#fafafa', opacity: 0, pointerEvents: 'none', zIndex: 4,
        }}
      />
      {duration > 0 && overlay?.(vpForOverlay)}
    </div>
  );
};
