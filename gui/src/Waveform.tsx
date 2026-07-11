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
import { isMac } from './platform';
import { logToFile } from './frontendLog';

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
  overlay?: (vp: { tStart: number; tEnd: number; durationSec: number; panViewport: (deltaSec: number) => void; setViewportSec: (startSec: number, endSec: number) => void }) => React.ReactNode;
  // Vertical tick marks (e.g. chapter starts, the armed I point) drawn
  // behind the peaks. Default tint is the chapter amber; pass `color`
  // for distinct marks.
  markers?: { sec: number; label?: string; color?: string }[];
  // Channel Split: draw each channel as its own half-height lane (L top,
  // R bottom) when the file is multi-channel. Mono files ignore it (single
  // lane). Triggers a per-channel data fetch; the combined path is untouched
  // when false, and the renderer falls back to a single lane if the data
  // returns < 2 channels. The region overlay + playhead stay full-height.
  channelSplit?: boolean;
}

interface WaveData {
  success: boolean;
  duration_sec: number;
  channels?: number;
  // [min, max, rms] per bin (signed) — matches WAVdesk's peak-bin shape.
  points: [number, number, number][];
  // Per-channel bins (outer index = channel). Present only when the fetch
  // asked for perChannel; backs the two-lane channel-split render.
  channel_points?: [number, number, number][][];
}

const MIN_SPAN_SEC = 0.02;
// A healthy full-file peaks tier is one bin per requested slot (the fetch asks
// for >= 4000 — see the load-once effect). A DEGENERATE tier (a short/truncated
// array of a few to a few hundred bins, e.g. an upstream decode that failed and
// returned a stub) must never reach the renderer: foldColumns would interpolate
// it across the whole width and the quad-smoothed envelope would balloon into a
// giant triangular ramp wedge that SWALLOWS the real peaks (the owner's
// mirrored-triangle corruption). Any tier below this floor is rejected as
// no-data so the lane draws clean instead of garbage. Well under the 4000-bin
// minimum a real tier always carries, so it never rejects a healthy fetch.
const MIN_TIER_BINS = 512;
// Exponential lerp factor per frame for the zoom/pan tween (WAVdesk's value).
// 0.18 lands between snappy and floaty — notches read direct, but pan/zoom
// pick up the "drag through molasses" glide that feels buttery.
const ZOOM_LERP_K = 0.18;

// Waveform paint, ported from WAVdesk's WaveformView so the two render
// identically: a filled min/max envelope (the asymmetric DAW look), quad-
// smoothed, fattened by a round-cap stroke (1.55px) so it reads as a clean
// line where top≈bottom (low frequencies) and a solid body where it's busy.
// The standalone defines no --theme-waveform CSS vars, so these match
// WAVdesk's exact fallbacks.
const WAVE_COLOR = '#a1a1aa';
const WAVE_STROKE_PX = 1.55;

// Quad-smoothed edge (matches WAVdesk's appendCurveSegment 'quad'): the curve
// passes through the midpoints between consecutive bins, each bin a control.
function appendQuadEdge(
  ctx: CanvasRenderingContext2D, n: number,
  xs: Float32Array, ys: Float32Array, reverse: boolean,
): void {
  if (n < 2) return;
  const start = reverse ? n - 1 : 0;
  const dir = reverse ? -1 : 1;
  const last = reverse ? 0 : n - 1;
  for (let j = start; j !== last; j += dir) {
    const next = j + dir;
    ctx.quadraticCurveTo(xs[j], ys[j], (xs[j] + xs[next]) / 2, (ys[j] + ys[next]) / 2);
  }
  ctx.lineTo(xs[last], ys[last]);
}

// Closed envelope polygon: top edge L→R, step down the right, bottom edge
// R→L, closePath links back. Mirrors WAVdesk's drawWaveformPolygon.
function drawWaveEnvelope(
  ctx: CanvasRenderingContext2D, n: number,
  xs: Float32Array, tops: Float32Array, bots: Float32Array,
): void {
  if (n < 2) return;
  ctx.moveTo(xs[0], tops[0]);
  appendQuadEdge(ctx, n, xs, tops, false);
  ctx.lineTo(xs[n - 1], bots[n - 1]);
  appendQuadEdge(ctx, n, xs, bots, true);
  ctx.closePath();
}

// Fold a bin array down to ~one column per device pixel over the visible
// grid, returning per-column signed min/max (amplitude, -1..1) + x position.
// Extracted so the single-lane and channel-split paths decimate identically
// — the split view just runs it once per channel into its own lane.
interface FoldOut { xs: Float32Array; mns: Float32Array; mxs: Float32Array; visN: number; }
function foldColumns(
  pts: [number, number, number][],
  gFirst: number, iEnd: number, step: number, n: number,
  pkTStart: number, pkSpan: number, curTStart: number, span: number, w: number,
): FoldOut {
  const outLen = Math.max(2, Math.floor((iEnd - gFirst) / step) + 1);
  const xs = new Float32Array(outLen);
  const mns = new Float32Array(outLen);
  const mxs = new Float32Array(outLen);
  let visN = 0;
  for (let g0 = gFirst; g0 <= iEnd; g0 += step) {
    const lo = Math.max(0, g0);
    const g1 = Math.min(g0 + step, n);
    let mn = Infinity, mx = -Infinity;
    for (let i = lo; i < g1; i++) {
      if (pts[i][0] < mn) mn = pts[i][0];
      if (pts[i][1] > mx) mx = pts[i][1];
    }
    if (!isFinite(mn)) { mn = 0; mx = 0; }
    const bc = (lo + g1 - 1) / 2;                      // group center bin
    const tBin = pkTStart + ((bc + 0.5) / n) * pkSpan;
    xs[visN] = ((tBin - curTStart) / span) * w;
    mns[visN] = mn; mxs[visN] = mx;
    visN++;
  }
  return { xs, mns, mxs, visN };
}

export const WaveformView: React.FC<WaveformViewProps> = ({
  audioFile, filePath, playheadGetter, overlay, markers, channelSplit = false,
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

  // Eased viewport tween — WAVdesk's gesture model, which is what makes its
  // pan/zoom feel buttery instead of stepped. Gestures push a TARGET viewport;
  // a rAF loop LERPs the DISPLAYED viewport toward it at ZOOM_LERP_K/frame.
  //   vpRef        = displayed (eased) viewport — draw + playhead + overlay read it
  //   vpTargetRef  = where gestures push (null when settled)
  // Each gesture reads `vpTargetRef ?? vpRef` as its base so a fast burst
  // compounds on the in-flight target and stays continuous, rather than
  // fighting the lagging displayed value. The tween also coalesces the 125Hz
  // HID stream into one setVp (= one render/redraw) per frame.
  const vpTargetRef = useRef<{ tStart: number; tEnd: number } | null>(null);
  const tweenRafRef = useRef(0);
  const baseVp = useCallback(() => vpTargetRef.current ?? vpRef.current, []);
  const tweenTick = useCallback(() => {
    const target = vpTargetRef.current;
    if (!target) { tweenRafRef.current = 0; return; }
    const cur = vpRef.current;
    const next = {
      tStart: cur.tStart + (target.tStart - cur.tStart) * ZOOM_LERP_K,
      tEnd:   cur.tEnd   + (target.tEnd   - cur.tEnd)   * ZOOM_LERP_K,
    };
    const dur = Math.max(1e-9, duration);
    const gap = Math.abs(next.tStart - target.tStart) + Math.abs(next.tEnd - target.tEnd);
    if (gap / dur < 0.0005) {        // close enough — land on the target and stop
      vpRef.current = target;
      setVp(target);
      vpTargetRef.current = null;
      tweenRafRef.current = 0;
      return;
    }
    vpRef.current = next;
    setVp(next);
    tweenRafRef.current = requestAnimationFrame(tweenTick);
  }, [duration]);
  // Gesture commit: push a target and ensure the tween is running.
  const commitTarget = useCallback((next: { tStart: number; tEnd: number }) => {
    vpTargetRef.current = next;
    if (!tweenRafRef.current) tweenRafRef.current = requestAnimationFrame(tweenTick);
  }, [tweenTick]);
  // Pan the viewport by a signed second delta (clamped to [0, duration],
  // width-preserving) — backs the region overlay's ctrl+drag pan and its
  // near-edge auto-scroll. Compounds on the in-flight target like the wheel
  // pan (:306-310) so a burst stays continuous.
  const panBySec = useCallback((deltaSec: number) => {
    if (duration <= 0 || !deltaSec) return;
    const cur = vpTargetRef.current ?? vpRef.current;
    let s = cur.tStart + deltaSec;
    let t = cur.tEnd + deltaSec;
    if (s < 0) { t -= s; s = 0; }
    if (t > duration) { s -= t - duration; t = duration; }
    commitTarget({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
  }, [duration, commitTarget]);
  // Absolute viewport set (width preserved, clamped to [0, duration]) — backs
  // the chop window's Shift+arrow region switching (viewport-follow). Tweens
  // like a pan so the follow reads buttery, not teleported.
  const setViewportSec = useCallback((startSec: number, endSec: number) => {
    if (duration <= 0) return;
    const w = Math.max(1e-6, endSec - startSec);
    let s = startSec;
    let t = endSec;
    if (s < 0) { s = 0; t = Math.min(duration, w); }
    if (t > duration) { t = duration; s = Math.max(0, duration - w); }
    commitTarget({ tStart: s, tEnd: t });
  }, [duration, commitTarget]);
  // Immediate commit (file reset) — snap with no tween.
  const commitVp = useCallback((next: { tStart: number; tEnd: number }) => {
    if (tweenRafRef.current) { cancelAnimationFrame(tweenRafRef.current); tweenRafRef.current = 0; }
    vpTargetRef.current = null;
    vpRef.current = next;
    setVp(next);
  }, []);
  useEffect(() => () => { if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current); }, []);

  // Reset the viewport to full when the file/duration changes.
  useEffect(() => {
    if (duration > 0) commitVp({ tStart: 0, tEnd: duration });
  }, [filePath, duration, commitVp]);

  const peaksRef = useRef<{
    points: [number, number, number][];
    channelPoints: [number, number, number][][] | null;
    tStart: number; tEnd: number;
  } | null>(null);
  // Live-read in draw() so toggling split repaints without a redraw dep churn.
  const channelSplitRef = useRef(channelSplit);
  channelSplitRef.current = channelSplit;

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

    // Channel Split is live only when the toggle asked for it AND per-channel
    // data actually came back with >= 2 channels (mono falls through to the
    // single centered lane).
    const chans = pk?.channelPoints;
    const splitActive = channelSplitRef.current && !!chans && chans.length >= 2;

    // Two stacked lanes (channel 0 top, channel 1 bottom) separated by a gap +
    // 1px divider. Without the gap the lanes abut exactly at the mid-line and,
    // on loud/limited audio (both channels near +/-1), L's bottom envelope
    // meets R's top there and the two fuse into a single solid full-height mass
    // — visually identical to the combined view. The gap keeps the seam visible
    // so the lanes stay plainly separate. amp +/-1 maps to +/-(laneScale) so a
    // full-scale sample just reaches its lane's inner edge (0.95 headroom, same
    // as the single lane). (WAVdesk drawSplit geometry.)
    const laneGap = Math.max(4, Math.round(h * 0.03));
    const laneH = Math.max(1, (h - laneGap) / 2);
    const laneScale = (laneH / 2) * 0.95;
    const laneCx = [laneH / 2, laneH + laneGap + laneH / 2];
    const dividerY = laneH + laneGap / 2;

    // Center line (single lane) OR the lane divider seam (split).
    ctx.fillStyle = 'rgba(161,161,170,0.25)';
    if (splitActive) {
      ctx.fillRect(0, dividerY - 0.5, w, 1);
      ctx.fillStyle = 'rgba(161,161,170,0.14)';
      ctx.fillRect(0, laneCx[0] - 0.5, w, 1);
      ctx.fillRect(0, laneCx[1] - 0.5, w, 1);
    } else {
      ctx.fillRect(0, h / 2 - 0.5, w, 1);
    }
    // Chapter/marker ticks behind the peaks (always full-height).
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

    const n = pk.points.length;
    const pkSpan = Math.max(1e-9, pk.tEnd - pk.tStart);

    // Bins covering the visible viewport (+/-1 so the quad curve endpoints
    // fall outside the visible area and don't snap at the edges).
    const iStart = Math.max(0, Math.floor(((cur.tStart - pk.tStart) / pkSpan) * n) - 1);
    const iEnd = Math.min(n - 1, Math.ceil(((cur.tEnd - pk.tStart) / pkSpan) * n) + 1);
    if (iStart >= iEnd) return;

    // Decimate with a stride PINNED to the bin grid, not the viewport. WAVdesk
    // gets stable columns for free from its fixed tier grid; here the whole
    // file is one dense array, so we emulate it: derive the fold stride from
    // the ZOOM (visible seconds only, via span) so it stays constant while
    // panning, and snap group boundaries to multiples of that stride. The old
    // code distributed `vis` bins across the columns by viewport fraction, so
    // as iStart slid a fraction of a bin every frame the min/max landing in
    // each column reshuffled — that reshuffle IS the "sparkle"/shimmer the
    // standalone had and WAVdesk doesn't. Target ~1 column per DEVICE pixel
    // (crispest, matches the WebGL renderer's density); step 1 = one bin per
    // column when zoomed in (no fold).
    const binsPerSec = n / pkSpan;
    const targetCols = Math.max(2, Math.ceil(w * dpr));
    const step = Math.max(1, Math.round((span * binsPerSec) / targetCols));
    const gFirst = Math.floor(iStart / step) * step;    // grid-aligned start

    ctx.fillStyle = WAVE_COLOR;
    ctx.strokeStyle = WAVE_COLOR;
    ctx.lineWidth = WAVE_STROKE_PX;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Fold one bin array into a lane centered at `cx`, amp scaled by `scl`,
    // and paint the filled quad-smoothed min/max envelope.
    const paintLane = (pts: [number, number, number][], cx: number, scl: number) => {
      const { xs, mns, mxs, visN } = foldColumns(pts, gFirst, iEnd, step, n, pk.tStart, pkSpan, cur.tStart, span, w);
      const tops = new Float32Array(visN);
      const bots = new Float32Array(visN);
      for (let j = 0; j < visN; j++) {
        tops[j] = cx - mxs[j] * scl; // max (positive) → above center
        bots[j] = cx - mns[j] * scl; // min (negative) → below center
      }
      ctx.beginPath();
      drawWaveEnvelope(ctx, visN, xs, tops, bots);
      ctx.fill();
      ctx.stroke();
    };

    if (splitActive && chans) {
      paintLane(chans[0], laneCx[0], laneScale);
      paintLane(chans[1], laneCx[1], laneScale);
    } else {
      paintLane(pk.points, h / 2, (h / 2) * 0.95);
    }
  }, []);

  // Whole-file peaks, fetched ONCE per file at high density. Drawing any
  // zoom/pan is then a bounded subset-walk over this cached set (see draw's
  // fold) — NO per-zoom refetch, which is what caused the standalone's
  // zoom-out gaps (old peaks didn't cover the wider range) and resolution
  // pops. This is WAVdesk's load-once model. ~1000 bins/sec (capped 200k)
  // keeps deep zoom sharp; the cost is a single IPC on file load.
  useEffect(() => {
    if (!filePath || duration <= 0) return;
    let stale = false;
    peaksRef.current = null; // drop the previous file's peaks (no stale flash)
    const bins = Math.min(200_000, Math.max(4000, Math.round(duration * 1000)));
    // Ask for per-channel bins only while split is on (additive on the backend;
    // combined `points` still comes back either way). Toggling split re-fetches.
    void invoke<WaveData>('generate_waveform', {
      path: filePath, points: bins, startSec: 0, endSec: duration, perChannel: channelSplit,
    }).then((data) => {
      if (stale || !data?.success) return;
      const pts = data.points ?? [];
      // Reject a degenerate tier at the DATA layer (never paint garbage): a
      // short array folds into the triangular ramp wedge that swallows the real
      // peaks. Below MIN_TIER_BINS (and well below what was requested) = a
      // broken/truncated tier — leave peaks null so the lane stays clean, with a
      // receipt in latch.log so a field recurrence is diagnosable, not silent.
      if (pts.length > 0 && pts.length < Math.min(bins, MIN_TIER_BINS)) {
        logToFile('warn', 'Waveform',
          `${filePath}: degenerate peaks tier (${pts.length} bins for a ${duration.toFixed(2)}s file, requested ${bins}) - skipping render to avoid triangle corruption`);
        return;
      }
      // Only adopt per-channel bins whose lengths MATCH the combined tier — the
      // split renderer folds each channel with n = combined length, so a
      // mismatched-length channel array would drift the time axis and wedge into
      // the same triangle. A mismatch falls back to the single combined lane.
      const cp = data.channel_points && data.channel_points.length >= 2 &&
                 data.channel_points.every((c) => c.length === pts.length)
        ? data.channel_points : null;
      peaksRef.current = { points: pts, channelPoints: cp, tStart: 0, tEnd: duration };
      draw();
    }).catch(() => { /* peaks are cosmetic; the overlay still works */ });
    return () => { stale = true; };
  }, [filePath, duration, channelSplit, draw]);

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
    // A live trackpad gesture is already handled via raw HID — these
    // wheel events are DirectManipulation echoing the same motion.
    if (performance.now() < trackpadActiveUntilRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const cur = baseVp();
    const span = Math.max(1e-6, cur.tEnd - cur.tStart);
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Vertical-dominant scroll already zooms and horizontal-dominant pans (the
    // waveform has no Y axis) — that IS the mac trackpad convention, since the
    // Windows raw-HID path never fires on macOS. Cmd+wheel is the mac
    // accelerator equivalent of a pinch: force the zoom path regardless of the
    // dominant axis (Cmd has no OS wheel meaning on mac, so it's collision-free).
    const pan = !(isMac && e.metaKey) && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY));
    if (pan) {
      const delta = (pan && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)
        / rect.width * span;
      let s = cur.tStart + delta;
      let t = cur.tEnd + delta;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; }
      commitTarget({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
      return;
    }
    const factor = Math.pow(1.0015, e.deltaY);
    const newSpan = Math.max(MIN_SPAN_SEC, Math.min(duration, span * factor));
    const anchor = cur.tStart + frac * span;
    let s = anchor - frac * newSpan;
    let t = s + newSpan;
    if (s < 0) { t -= s; s = 0; }
    if (t > duration) { s -= t - duration; t = duration; s = Math.max(0, s); }
    commitTarget({ tStart: s, tEnd: t });
  }, [duration]);

  // Precision-touchpad pinch/pan via the raw-HID subsystem
  // (touchpad_raw_input.rs broadcasts wd-pinch-zoom / wd-trackpad-pan;
  // WebView2 eats the native gestures before any DOM event fires).
  // Hover-gated so gestures over other surfaces don't zoom the wave.
  // While a trackpad gesture is live, DirectManipulation STILL forwards
  // the same motion as wheel events — onWheel suppresses itself for the
  // gesture + a 250ms grace, or the two handlers fight (the
  // barely-moves/glitchy wave).
  const hoverRef = useRef(false);
  const lastXRef = useRef<number | null>(null);
  const trackpadActiveUntilRef = useRef(0);
  useEffect(() => {
    let unZoom: (() => void) | null = null;
    let unPan: (() => void) | null = null;
    let unActive: (() => void) | null = null;
    let disposed = false;
    listen<boolean>('wd-trackpad-active', (e) => {
      if (e.payload) trackpadActiveUntilRef.current = Number.MAX_SAFE_INTEGER;
      else trackpadActiveUntilRef.current = performance.now() + 250;
    }).then((fn) => { if (disposed) fn(); else unActive = fn; });
    listen<number>('wd-pinch-zoom', (e) => {
      if (!hoverRef.current || duration <= 0) return;
      const factor = e.payload;
      if (typeof factor !== 'number' || !isFinite(factor) || factor <= 0) return;
      const rect = containerRef.current?.getBoundingClientRect();
      const frac = lastXRef.current != null && rect && rect.width > 0
        ? Math.max(0, Math.min(1, (lastXRef.current - rect.left) / rect.width))
        : 0.5;
      // factor > 1 = fingers apart = zoom IN = the visible span shrinks.
      const cur = baseVp();
      const span = Math.max(1e-6, cur.tEnd - cur.tStart);
      const newSpan = Math.max(MIN_SPAN_SEC, Math.min(duration, span / factor));
      const anchor = cur.tStart + frac * span;
      let s = anchor - frac * newSpan;
      let t = s + newSpan;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; s = Math.max(0, s); }
      commitTarget({ tStart: s, tEnd: t });
    }).then((fn) => { if (disposed) fn(); else unZoom = fn; });
    listen<[number, number]>('wd-trackpad-pan', (e) => {
      if (!hoverRef.current || duration <= 0) return;
      trackpadActiveUntilRef.current = Math.max(trackpadActiveUntilRef.current, performance.now() + 150);
      const [dx, dy] = e.payload ?? [0, 0];
      const cur = baseVp();
      let span = Math.max(1e-6, cur.tEnd - cur.tStart);
      let s = cur.tStart;
      let t = cur.tEnd;
      // Horizontal two-finger drag = pan. HID units → span fraction
      // (touchpads span a few thousand units). Positive = the natural
      // content-follows-fingers direction (matches WAVdesk's trackpad feel;
      // the mouse-only inversion lives in the middle-drag handler, never here).
      if (isFinite(dx) && dx !== 0) {
        const delta = (dx / 1500) * span;
        s += delta; t += delta;
      }
      // Vertical two-finger drag = zoom around the cursor. Mirrors WAVdesk's
      // raw-HID handler exactly: newSpan = span * exp(dy * 0.003), so the
      // zoom direction matches it (one drives the visible span larger, the
      // other smaller). Without this, vertical swipe was dropped and did
      // nothing — the reported bug.
      if (isFinite(dy) && dy !== 0) {
        const rect = containerRef.current?.getBoundingClientRect();
        const frac = lastXRef.current != null && rect && rect.width > 0
          ? Math.max(0, Math.min(1, (lastXRef.current - rect.left) / rect.width))
          : 0.5;
        const newSpan = Math.max(MIN_SPAN_SEC, Math.min(duration, span * Math.exp(dy * 0.003)));
        const anchor = s + frac * span;   // anchor in the (possibly panned) view
        s = anchor - frac * newSpan;
        t = s + newSpan;
        span = newSpan;
      }
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; s = Math.max(0, s); }
      commitTarget({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
    }).then((fn) => { if (disposed) fn(); else unPan = fn; });
    return () => { disposed = true; unZoom?.(); unPan?.(); unActive?.(); };
  }, [duration]);

  // Middle-drag pan.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 1 || duration <= 0) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const startX = e.clientX;
    const orig = { ...baseVp() };
    const span = Math.max(1e-6, orig.tEnd - orig.tStart);
    const onMove = (ev: PointerEvent) => {
      const delta = ((startX - ev.clientX) / rect.width) * span;
      let s = orig.tStart + delta;
      let t = orig.tEnd + delta;
      if (s < 0) { t -= s; s = 0; }
      if (t > duration) { s -= t - duration; t = duration; }
      commitTarget({ tStart: Math.max(0, s), tEnd: Math.min(duration, t) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [duration]);

  // Playhead — ref mutation per frame, no React state churn. Primary tick is
  // rAF, but macOS WKWebView PARKS rAF for this satellite window (same reason
  // ChopApp's reveal needs a timer fallback), which froze the playhead solid
  // even while audio/video played. A setTimeout fallback keeps it moving there;
  // whichever fires first paints and cancels the other. Windows/WebView2 rAF is
  // reliable, so the timer is mac-only and leaves that path untouched.
  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const paint = () => {
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
    const tick = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (timer) { window.clearTimeout(timer); timer = 0; }
      paint();
      raf = requestAnimationFrame(tick);
      if (isMac) timer = window.setTimeout(tick, 24);
    };
    tick();
    return () => { if (raf) cancelAnimationFrame(raf); if (timer) window.clearTimeout(timer); };
  }, [filePath, playheadGetter]);

  const vpForOverlay = useMemo(
    () => ({ tStart: vp.tStart, tEnd: vp.tEnd, durationSec: duration, panViewport: panBySec, setViewportSec }),
    [vp, duration, panBySec, setViewportSec],
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
