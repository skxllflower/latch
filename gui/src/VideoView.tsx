import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import {
  Play, Pause, Volume2, VolumeX, Maximize, PanelTopOpen, Repeat, SkipBack, SkipForward, BarChart3, Paintbrush,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCanvasViewport } from './useCanvasViewport';
import { ReverseDecoder } from './videoReverse';
import { VideoAudio } from './videoAudio';
import { NativeVideoEngine, type NativeStreamConfig } from './nativeVideoStream';
import { registerVideoTransport } from './videoTransport';
import { latheStatus } from './latheStatus';
import { WdSelect } from './WdSelect';
import {
  type ImageChannel, type Swatch, type Histogram, CHANNEL_OPTIONS, EYEDROPPER_CURSOR,
  buildHistogram, extractPalette, drawHistogram, swatchHex,
} from './imageAnalysis';
import { isMac } from './platform';

const HUD_BOTTOM = 72;
const HUD_TOP = 0;

// Volume fader, modeled on the control-room master fader but capped at 0 dB
// (unity = max; no boost). Linear gain 0..1 ↔ dB; bottom of the track is -∞.
const VOL_MIN_DB = -48;
const volGainToDb = (g: number): number => (g <= 0.001 ? -Infinity : 20 * Math.log10(g));
const volDbToGain = (db: number): number => (db <= VOL_MIN_DB || !isFinite(db) ? 0 : Math.min(1, Math.pow(10, db / 20)));
const volDbToPct = (db: number): number => (db >= 0 ? 0 : db <= VOL_MIN_DB ? 100 : (-db / -VOL_MIN_DB) * 100);
const volPctToDb = (pct: number): number => -(Math.max(0, Math.min(100, pct)) / 100) * -VOL_MIN_DB;
const VOL_LERP = 0.7;
const VOL_SNAP_DB = 0.02;
// dB scale ticks — same three tiers as the master fader (major labeled,
// minor mid-weight, subdivision faint+short). 0 dB at the top.
const VOL_TICKS: { db: number; major?: boolean; subdivision?: boolean }[] = [
  { db: 0, major: true },
  { db: -3, subdivision: true },
  { db: -6, major: true },
  { db: -9, subdivision: true },
  { db: -12, major: true },
  { db: -18 },
  { db: -24, major: true },
  { db: -36 },
  { db: -48, major: true },
];

// Canvas-based video viewer sharing the image viewer's gesture engine
// (zoom/pan/pinch) via useCanvasViewport. A hidden <video> decodes + plays
// audio; requestVideoFrameCallback blits each painted frame to the canvas, so
// zoom/pan apply to live video. Custom theme-aware transport — no browser
// chrome, no spinner — with a scrub timeline, loop in/out, frame stepping,
// volume/speed, and keyboard control.

// Size class lives on each control (matching ImageView) — buttons don't
// reliably inherit font-size, which left the transport huge. Fixed h-5 +
// centering so icon and text buttons line up at the same height.
const BTN = 'h-5 inline-flex items-center justify-center text-[0.5625rem] leading-none border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 hover:border-zinc-700 transition-colors';
const BTN_ON = 'h-5 inline-flex items-center justify-center text-[0.5625rem] leading-none border border-zinc-500 bg-zinc-700 text-zinc-100';
const ICON_BTN = 'w-5';       // square icon buttons
const TEXT_BTN = 'px-1.5';    // text buttons (IN/OUT/speed)
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

function fmtTime(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00';
  const s = Math.floor(t % 60), m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface VideoViewHandle {
  // `freeze` (native engine only): hold the last displayed frame through the
  // seek until the cue frame lands, instead of flashing the decoder's pre-cue
  // keyframe frames — used by the chop window's retrigger / stop / re-cue seeks.
  seek: (sec: number, freeze?: boolean) => void;
  togglePlay: () => void;
  shuttle: (dir: number) => void;
  stepFrame: (dir: number) => void;
  play: () => void;
  setLoop: (inSec: number, outSec: number) => void;
  // Live region-drag bounds: update the engine's loop bounds every frame
  // WITHOUT re-arming the decoder loop (setLoop's per-move re-arm was the drag
  // "freakout"). present() reads these live and bounces at the moving walls.
  setLoopBounds: (inSec: number, outSec: number) => void;
  clearLoop: () => void;
  pause: () => void;
  // Live media time, read per-frame for a seamless follower playhead.
  getCurrentTime: () => number;
  // Current preview playback-speed multiplier — the chop export applies it
  // to the rendered clip (video setpts + atempo / audio atempo).
  getSpeed: () => number;
  // Snapshot the currently-visible frame to a fresh offscreen canvas
  // (or null if nothing is painted yet). Used by the chop drag-out chip.
  captureFrame: () => HTMLCanvasElement | null;
}

export interface VideoViewProps {
  src: string;
  path?: string;
  label?: string;
  onPopOut?: () => void;
  // Fired whenever the IN/OUT loop points change — lets a host (the
  // Latch chop window) mirror them into its own region model.
  onLoopPointsChange?: (inSec: number | null, outSec: number | null) => void;
  // Suppress the first-load text while the parent pane's freeze overlay is up.
  suppressChip?: boolean;
  // Fired when the first frame is ready — clears the parent's transition freeze.
  onReady?: () => void;
  // Reports the current playback time (sec). Used by the Latch chop window
  // to drive a follower playhead on the waveform below.
  onTime?: (sec: number) => void;
  // Disable VideoView's own document-level shortcuts. The Latch chop window
  // handles keys at the window level (so space/J/K/L work even when the
  // waveform — not the video — is hovered) and drives the player through the
  // imperative handle instead.
  disableKeyboard?: boolean;
  // Fired whenever play/pause state changes, so an external transport (the
  // chop window's in-waveform play/pause) can mirror it.
  onPlayingChange?: (playing: boolean) => void;
  // Largest pixel dimension of the source (max of width/height), when known.
  // Consumed by the VideoPreview guard wrapper — NOT VideoView itself — to
  // decide whether a Chromium-safe container is also within WebView2's reliable
  // decode envelope. Undefined/0 means "unknown" and is treated as oversized
  // (transcoded down) so a 4K stream never reaches <video> and crashes the host.
  maxDim?: number;
  // Native frame engine: when set, frames are streamed from the localhost
  // ffmpeg-via-lathe server and drawn on the canvas, and the <video> element is
  // left unsourced (never decodes, so it can't crash the host). Replaces the
  // transcode-to-temp-MP4 path for big/exotic video. Transport is inert in this
  // mode for now (Phase 0: prove the picture path); play/pause/seek + audio
  // sync land next.
  nativeStream?: NativeStreamConfig | null;
  // Autoplay for the native-stream mount (default true). false = the engine
  // opens PAUSED at 0 with no audio session until the first play() — the chop
  // window's parked open. Consumed by VideoPreview when it builds the
  // nativeStream config; inert for the <video> fallback path.
  nativeAutoplay?: boolean;
  // When true, the preview plays at 1× regardless of the speed button. The
  // audio engine only does varispeed (pitch follows speed), so a pitch-locked
  // speed change can't be previewed honestly — the Latch chop window's "Locked
  // pitch" mode passes this to preview at true 1× pitch instead of faking it.
  // `getSpeed()` still returns the chosen speed, so export is unaffected.
  pitchPreviewLock?: boolean;
  /** Prefer compressed WebKit playback for a known-safe Mac preview file. */
  macDirectPlayback?: boolean;
}

export const VideoView = forwardRef<VideoViewHandle, VideoViewProps>(function VideoView(
  { src, path, onPopOut, suppressChip = false, onReady, onTime, disableKeyboard = false, onPlayingChange, nativeStream, onLoopPointsChange, pitchPreviewLock = false, macDirectPlayback = false }, ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const drawFnRef = useRef<() => void>(() => {});
  // Decoded audio: waveform peaks (scrubber) + reversed buffer (reverse audio).
  const audioRef = useRef<VideoAudio | null>(null);
  // Mirrors src so the idle-deferred audio decode can bail if the user has
  // navigated away before it ran (the video analog of fast-nav skipping work).
  const liveSrcRef = useRef(src); liveSrcRef.current = src;
  const audioIdleRef = useRef<number | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const [waveReady, setWaveReady] = useState(0);   // bump to redraw when peaks land

  const [size, setSize] = useState({ w: 0, h: 0 });          // intrinsic video px
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // Sticky after the first frame paints. The canvas already retains the last
  // frame across a src change (draw() bails before clearing), so this only
  // suppresses the Loading… overlay for every load after the first (no flash).
  const everLoadedRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Surface the time to the parent (chop window's follower playhead) from a
  // single place, so all the setCurrentTime sites are covered.
  const onTimeRef = useRef(onTime); onTimeRef.current = onTime;
  useEffect(() => { onTimeRef.current?.(currentTime); }, [currentTime]);
  // Mirrored so the native-stream effect can fire onReady without restarting the
  // stream when the parent passes a fresh onReady identity each render.
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [latheBinary, setLatheBinary] = useState(() => latheStatus.get().path ?? '');
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [loopRegion, setLoopRegion] = useState(false);
  const inPointRef = useRef(inPoint); inPointRef.current = inPoint;
  const outPointRef = useRef(outPoint); outPointRef.current = outPoint;
  const loopRegionRef = useRef(loopRegion); loopRegionRef.current = loopRegion;
  const macAv = isMac && macDirectPlayback && !!path;
  const macTimeRef = useRef(0);
  const macPlayingRef = useRef(false);
  const macRevealTimerRef = useRef<number | null>(null);
  const revealMacVideo = useCallback(() => {
    if (macRevealTimerRef.current != null) window.clearTimeout(macRevealTimerRef.current);
    macRevealTimerRef.current = window.setTimeout(() => {
      macRevealTimerRef.current = null;
      void invoke('mac_video_command', { label: getCurrentWindow().label, action: 'reveal', sec: 0, end: 0 });
    }, 120);
  }, []);

  useEffect(() => {
    if (!macAv || !path) return;
    const label = getCurrentWindow().label;
    const doc = document.documentElement;
    // The picture composites BELOW the webview (wavdesk's underlay system):
    // the DOM must stop painting over the video rect. wd-native-hole clears
    // the background chain and #wd-punch-backfill repaints the app background
    // around the hole via four strips (see styles.css; both backfill layers
    // ride z-index -1 — positioned boxes otherwise paint over static chrome).
    let backfill = document.getElementById('wd-punch-backfill');
    if (!backfill) {
      backfill = document.createElement('div');
      backfill.id = 'wd-punch-backfill';
      for (const side of ['t', 'b', 'l', 'r']) {
        const strip = document.createElement('div');
        strip.className = `wd-punch-${side}`;
        backfill.appendChild(strip);
      }
      document.body.prepend(backfill);
    }
    // Clamp the hole to overflow-hidden ancestors; the native frame keeps the
    // unclamped rect (offscreen native video is invisible below the webview).
    let clippers: HTMLElement[] = [];
    const collectClippers = () => {
      clippers = [];
      let el = containerRef.current?.parentElement ?? null;
      while (el) {
        const cs = getComputedStyle(el);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clippers.push(el);
        el = el.parentElement;
      }
    };
    collectClippers();
    let lastFrame = '';
    let lastHole = '';
    let frameRaf = 0;
    const syncFrame = () => {
      const r = containerRef.current?.getBoundingClientRect(); if (!r) return;
      let hx = r.left, hy = r.top, hr = r.right, hb = r.bottom;
      for (const c of clippers) {
        const cr = c.getBoundingClientRect();
        hx = Math.max(hx, cr.left); hy = Math.max(hy, cr.top);
        hr = Math.min(hr, cr.right); hb = Math.min(hb, cr.bottom);
      }
      const hw = Math.max(0, hr - hx), hh = Math.max(0, hb - hy);
      const holeKey = `${hx.toFixed(2)}:${hy.toFixed(2)}:${hw.toFixed(2)}:${hh.toFixed(2)}`;
      if (holeKey !== lastHole) {
        lastHole = holeKey;
        doc.style.setProperty('--wd-hole-x', `${hx}px`);
        doc.style.setProperty('--wd-hole-y', `${hy}px`);
        doc.style.setProperty('--wd-hole-w', `${hw}px`);
        doc.style.setProperty('--wd-hole-h', `${hh}px`);
        doc.classList.add('wd-native-hole');
      }
      const frameKey = `${r.left.toFixed(2)}:${r.top.toFixed(2)}:${r.width.toFixed(2)}:${r.height.toFixed(2)}:${window.innerHeight}`;
      if (frameKey === lastFrame) return;
      lastFrame = frameKey;
      void invoke('mac_video_frame', { label, x: r.left, y: r.top, width: r.width, height: r.height });
    };
    const scheduleFrame = () => {
      if (frameRaf) return;
      frameRaf = requestAnimationFrame(() => { frameRaf = 0; syncFrame(); });
    };
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    void invoke('mac_video_open', {
      label, path, x: r.left, y: r.top, width: r.width, height: r.height,
    }).then(() => { setStatus('ready'); onReadyRef.current?.(); syncFrame(); });
    const ro = new ResizeObserver(() => { collectClippers(); scheduleFrame(); });
    ro.observe(containerRef.current!);
    window.addEventListener('resize', scheduleFrame);
    const poll = window.setInterval(() => {
      scheduleFrame();
      void invoke<{ active: boolean; sec: number; duration: number; width: number; height: number; playing: boolean; recovered_loop: boolean }>('mac_video_state', { label }).then((s) => {
        if (!s.active) return;
        if (s.recovered_loop) {
          // AVPlayer escaped despite an armed looper. Re-cue the independent
          // audio/clock decoder in the same recovery cycle so picture and
          // sound cannot remain split (silent audio + free-running playhead).
          const lo = inPointRef.current;
          const hi = outPointRef.current;
          if (loopRegionRef.current && lo != null && hi != null && hi > lo) {
            nativeEngineRef.current?.setLoopRegion({ inSec: lo, outSec: hi });
            nativeEngineRef.current?.seek(lo);
          }
        }
        macTimeRef.current = s.sec;
        macPlayingRef.current = s.playing;
        setCurrentTime(s.sec);
        setPlaying(s.playing);
        if (s.duration > 0) setDuration((old) => old === s.duration ? old : s.duration);
        if (s.width > 0 && s.height > 0) setSize((old) => old.w === s.width && old.h === s.height ? old : { w: s.width, h: s.height });
      });
    }, 33);
    return () => {
      ro.disconnect(); window.removeEventListener('resize', scheduleFrame); window.clearInterval(poll);
      if (frameRaf) cancelAnimationFrame(frameRaf);
      if (macRevealTimerRef.current != null) window.clearTimeout(macRevealTimerRef.current);
      // Un-punch BEFORE stopping the session: the worst interleaving is one
      // frame of DOM background over live video, never a hole over nothing.
      doc.classList.remove('wd-native-hole');
      document.getElementById('wd-punch-backfill')?.remove();
      void invoke('mac_video_stop', { label });
    };
  }, [macAv, path]);
  const [volOpen, setVolOpen] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const [volWarping, setVolWarping] = useState(false);
  const volumeRef = useRef(volume); volumeRef.current = volume;
  const mutedRef = useRef(muted); mutedRef.current = muted;
  const speedRef = useRef(speed); speedRef.current = speed;
  const pitchPreviewLockRef = useRef(pitchPreviewLock); pitchPreviewLockRef.current = pitchPreviewLock;
  const volAnimRef = useRef<number | null>(null);
  const volTargetDbRef = useRef(0);
  const volDragRef = useRef<{ startDb: number; passed: boolean; preDy: number; accumPct: number } | null>(null);

  // Image-style analysis tools (parity with ImageView) on the live frame:
  // channel isolation (GPU SVG filter), histogram, palette, RGBA hover.
  const [channel, setChannel] = useState<ImageChannel>('rgb');
  const [showHist, setShowHist] = useState(false);
  // HDR source flag from the native stream's geometry; the decoder tone-maps
  // PQ/HLG to SDR by default and the HDR button toggles the raw view.
  const [hdrKind, setHdrKind] = useState<'' | 'pq' | 'hlg'>('');
  const [tonemapOn, setTonemapOn] = useState(true);
  const [showPalette, setShowPalette] = useState(false);
  const [palette, setPalette] = useState<Swatch[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; r: number; g: number; b: number; a: number } | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleRef = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);
  const histRef = useRef<Histogram | null>(null);
  const histCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastSampleRef = useRef(0);
  const lastPaletteRef = useRef(0);
  const sampleKeyRef = useRef('');                         // skip re-sampling an unchanged frame
  const fid = useId().replace(/:/g, '');                   // unique SVG-filter id base
  const sampleAtRef = useRef<(cx: number, cy: number) => void>(() => {});
  // Refs mirror state so the rAF sampling loop reads current values without
  // re-subscribing (and so sampleFrame's deps stay minimal).
  const channelRef = useRef(channel); channelRef.current = channel;
  const showHistRef = useRef(showHist); showHistRef.current = showHist;
  const showPaletteRef = useRef(showPalette); showPaletteRef.current = showPalette;

  // fps estimate from requestVideoFrameCallback mediaTime deltas (browser
  // doesn't expose fps); seeds frame stepping. Falls back to 30.
  const fpsRef = useRef(30);
  const lastMediaTimeRef = useRef(-1);
  const directPresentedTimeRef = useRef(-1);

  // JKL shuttle: an integer level (0 = stop, +N = forward N×, −N = reverse N×).
  // Forward uses native playbackRate; reverse seeks backward on a rAF loop
  // (HTML5 <video> has no negative playbackRate).
  const [shuttleLevel, setShuttleLevel] = useState(0);
  const shuttleRef = useRef(0);
  const shuttleRepeatRef = useRef(0);   // throttles auto-repeat ramp (held J/L)
  const reverseRafRef = useRef<number | null>(null);
  // Decoded-reverse (WebCodecs): decoder + the bitmap currently shown +
  // tracked reverse time. decodedFrameRef being set tells draw() to blit the
  // decoded frame instead of the <video>.
  const revDecoderRef = useRef<ReverseDecoder | null>(null);
  const decodedFrameRef = useRef<ImageBitmap | null>(null);
  // Native stream engine (when nativeStream is active). nativeFrameRef holds the
  // frame it currently wants shown (top-priority draw source — see draw()); the
  // ENGINE owns that bitmap's lifecycle, so we never close it here.
  const nativeFrameRef = useRef<ImageBitmap | null>(null);
  const nativeEngineRef = useRef<NativeVideoEngine | null>(null);
  // Whole-track audio peaks for the scrubber waveform in native mode (the
  // <video> audio-decode path is dead there). Fetched once via lathe audio-peaks.
  const nativePeaksRef = useRef<number[] | null>(null);
  const revTimeRef = useRef(0);
  const reverseStopRef = useRef<(() => void) | null>(null);
  const stopReverse = useCallback(() => {
    const wasReversing = reverseStopRef.current !== null;
    if (reverseRafRef.current !== null) { cancelAnimationFrame(reverseRafRef.current); reverseRafRef.current = null; }
    if (reverseStopRef.current) { reverseStopRef.current(); reverseStopRef.current = null; }
    audioRef.current?.stop();
    decodedFrameRef.current = null;
    if (wasReversing) {
      const v = videoRef.current;
      if (v) v.currentTime = revTimeRef.current;   // resume forward from where reverse left off
    }
  }, []);

  // Space + K: play/pause at the normal speed, clearing any shuttle. K while
  // shuttling → pause; when paused → restart at regular speed.
  const togglePlay = useCallback(() => {
    if (macAv) {
      const action = macPlayingRef.current ? 'pause' : 'play';
      void invoke('mac_video_command', { label: getCurrentWindow().label, action, sec: 0, end: 0 });
      return;
    }
    if (nativeEngineRef.current) {
      // K/Space while shuttling stops the shuttle (= pause); otherwise toggle.
      if (shuttleRef.current !== 0) {
        shuttleRef.current = 0; setShuttleLevel(0);
        nativeEngineRef.current.shuttle(0);
        return;
      }
      nativeEngineRef.current.toggle();
      return;
    }
    const v = videoRef.current; if (!v) return;
    stopReverse();
    const wasShuttling = shuttleRef.current !== 0;
    shuttleRef.current = 0; setShuttleLevel(0);
    v.playbackRate = speed;
    if (wasShuttling) { v.pause(); return; }
    if (v.paused) void v.play().catch(() => {}); else v.pause();
  }, [speed, stopReverse, macAv]);
  // Global Space (FileExplorer's video-row handler) drives this player without
  // hover/focus. Ref-bridged so the registration doesn't churn per render;
  // satellite windows (disableKeyboard) keep their own transport.
  const togglePlayRef = useRef(togglePlay); togglePlayRef.current = togglePlay;
  useEffect(() => {
    if (disableKeyboard || status !== 'ready') return;
    return registerVideoTransport({ toggle: () => togglePlayRef.current() });
  }, [status, disableKeyboard]);
  // Last-resort global Space: bubble phase on document, firing only when
  // NOTHING else claimed the key (FileExplorer's row handlers, this player's
  // own hover/focus handler, dialogs — they all preventDefault). So Space
  // toggles the previewed video from the InfoPanel, sidebar, anywhere — but
  // never steals it from typing or an audio-row audition.
  useEffect(() => {
    if (disableKeyboard || status !== 'ready') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.defaultPrevented) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'button' || el?.isContentEditable) return;
      e.preventDefault();
      togglePlayRef.current();
    };
    document.addEventListener('keydown', onKey); // bubble — runs after everyone
    return () => document.removeEventListener('keydown', onKey);
  }, [status, disableKeyboard]);

  const viewport = useCanvasViewport({
    containerRef, contentW: size.w, contentH: size.h, enabled: status === 'ready',
    spacebarFit: false,   // Space = play/pause for video
    onTap: togglePlay,
    onHover: (cx, cy) => sampleAtRef.current(cx, cy),
    onLeave: () => setHover(null),
    // Use the same accumulated-target + 0.18 lerp as WAVdesk's spectrogram.
    // It arbitrates smooth-wheel pan as one gesture instead of issuing a
    // separate native-layer jump for every Magic Mouse event.
    directGestures: false,
  });
  const { view, viewRef, containerSize } = viewport;

  // The AVPlayerLayer lives outside WebKit's canvas compositor, so mirror the
  // canvas viewport onto it. Underlay architecture: the picture fills the
  // FULL container (the DOM transport draws on top, same as wavdesk), so the
  // viewport maps 1:1 — no more HUD-band remap from the old above-webview
  // overlay days.
  useEffect(() => {
    if (!macAv || size.w <= 0 || size.h <= 0 || containerSize.w <= 0 || containerSize.h <= 0) return;
    void invoke('mac_video_transform', {
      label: getCurrentWindow().label, ox: view.ox, oy: view.oy,
      width: size.w * view.s, height: size.h * view.s, pictureHeight: containerSize.h,
    });
  }, [macAv, size, view, containerSize]);

  // ---- draw a frame at the current viewport ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current, video = videoRef.current;
    const { w: cw, h: ch } = containerSize;
    if (!canvas || cw === 0 || ch === 0) return;
    const vw = size.w, vh = size.h;
    // Source priority: native-engine frame (when streaming), else the decoded
    // reverse ImageBitmap, else the <video>. Bail (keep last frame) when none
    // has a frame yet.
    const nativeBmp = nativeFrameRef.current;
    const decoded = decodedFrameRef.current;
    const srcImg: CanvasImageSource | null = nativeBmp ?? decoded ?? video;
    if (!srcImg || vw <= 0 || vh <= 0) return;
    if (!nativeBmp && !decoded && (!video || video.readyState < 2)) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (canvas.width !== W) canvas.width = W;     // resizing clears — only when changed
    if (canvas.height !== H) canvas.height = H;
    canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const { s, ox, oy } = view;
    ctx.imageSmoothingEnabled = s < 1;
    ctx.imageSmoothingQuality = 'high';
    // Channel isolation via a GPU SVG color-matrix filter — cheap per-frame,
    // unlike ImageView's getImageData loop (too slow at video frame rates).
    ctx.filter = channel === 'rgb' ? 'none' : `url(#${fid}-${channel})`;
    try { ctx.drawImage(srcImg, ox, oy, vw * s, vh * s); } catch { /* not ready */ }
    ctx.filter = 'none';
  }, [view, containerSize, size, channel, fid]);
  useEffect(() => { draw(); }, [draw]);
  drawFnRef.current = draw;

  // Native frame engine. When nativeStream is set we stream decoded RGBA frames
  // from the localhost server (ffmpeg-via-lathe) and blit them on the canvas;
  // the <video> is left unsourced (so it can't crash the host). onLoadedMeta /
  // onLoadedData never fire in this mode, so size / status / onReady are driven
  // here from the stream's geometry + first frame. Keyed on the primitive
  // stream params so a fresh nativeStream object identity doesn't restart it.
  const nsPath = nativeStream?.path;
  const nsHeight = nativeStream?.height;
  const nsFps = nativeStream?.fps;
  // autoplay is read through a ref at mount time (NOT an effect key): it only
  // matters for how a FRESH engine opens, and keying on it would tear the
  // engine down if the host ever recomputed the config object.
  const nsAutoplayRef = useRef(nativeStream?.autoplay);
  nsAutoplayRef.current = nativeStream?.autoplay;
  useEffect(() => {
    if (!nsPath || nsHeight == null || nsFps == null) return;
    let firstFrame = true;
    setStatus('loading');
    setHdrKind('');
    setTonemapOn(true);
    const engine = new NativeVideoEngine(
      { path: nsPath, height: nsHeight, fps: nsFps, autoplay: nsAutoplayRef.current },
      {
        onGeom: (g) => {
          setSize({ w: g.w, h: g.h });
          // requestVideoFrameCallback never fires in native mode, so the fps
          // estimate that seeds frame-stepping comes from the geometry.
          if (g.fps > 0) fpsRef.current = g.fps;
          setHdrKind(g.hdr);
        },
        onDuration: (d) => setDuration(d),
        onTime: (t) => setCurrentTime(t),
        onState: (p) => setPlaying(p),
        // Reverse shuttle hit 0:00 — the engine stopped itself; clear the JKL
        // level indicator to match.
        onShuttleEnd: () => { shuttleRef.current = 0; setShuttleLevel(0); },
        onFrame: (bmp) => {
          nativeFrameRef.current = bmp; // engine owns the bitmap; don't close
          if (firstFrame) {
            firstFrame = false;
            everLoadedRef.current = true;
            setStatus('ready');
            onReadyRef.current?.();
          }
          drawFnRef.current();
        },
        onError: () => { setStatus('error'); onReadyRef.current?.(); },
      },
    );
    nativeEngineRef.current = engine;
    // Carry the session's fader/speed onto the fresh engine (the states
    // persist across file switches; in/out points are cleared per-src so the
    // loop region starts empty). Later changes flow via the mirror effects.
    engine.setVolume(mutedRef.current ? 0 : volumeRef.current);
    if (!pitchPreviewLockRef.current && speedRef.current !== 1) engine.setRate(speedRef.current);
    return () => {
      nativeEngineRef.current = null;
      engine.destroy();      // closes every buffered bitmap
      nativeFrameRef.current = null;
    };
  }, [nsPath, nsHeight, nsFps]);

  // Native mode: stream at the resolution the DISPLAY actually needs. The
  // pane's pixel height (CSS × devicePixelRatio) picks a tier; entering
  // fullscreen / resizing a popout re-streams at the current position (audio
  // is untouched, so the switch is just a brief picture refine). Debounced so
  // a live window-drag doesn't spawn decoders per tick; tier quantization
  // keeps small pane tweaks free.
  useEffect(() => {
    if (!nsPath) return;
    const cs = containerSize;
    if (cs.h <= 0) return;
    const want = cs.h * (window.devicePixelRatio || 1);
    const tier = [720, 1080, 1440, 2160].find((t) => t >= want) ?? 2160;
    const timer = window.setTimeout(() => {
      nativeEngineRef.current?.setHeight(tier);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [nsPath, containerSize]);

  // Native mode: fetch the whole-track waveform peaks once per file (lathe
  // decodes the audio to bins). Feeds drawWave via nativePeaksRef + waveReady.
  useEffect(() => {
    return latheStatus.subscribe((s) => setLatheBinary(s.path ?? ''));
  }, []);
  useEffect(() => {
    nativePeaksRef.current = null;
    const peaksPath = nsPath ?? (macAv ? path : undefined);
    if (!peaksPath || !latheBinary) return;
    let cancelled = false;
    void invoke<{ peaks?: number[] }>('video_audio_peaks', {
      binaryPath: latheBinary, path: peaksPath, bins: 2000,
    }).then((r) => {
      if (!cancelled && Array.isArray(r?.peaks) && r.peaks.length) {
        nativePeaksRef.current = r.peaks;
        setWaveReady((n) => n + 1);
      }
    }).catch((err) => console.warn('[VideoView] audio peaks unavailable', err));
    return () => { cancelled = true; };
  }, [nsPath, macAv, path, latheBinary]);

  // Waveform peaks → the scrubber canvas (drawn once peaks land + on resize).
  const drawWave = useCallback(() => {
    const c = waveCanvasRef.current; if (!c) return;
    const rect = c.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(rect.width * dpr)), H = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const mid = H / 2;
    const peaks = nativePeaksRef.current ?? audioRef.current?.peaks;
    if (!peaks || peaks.length === 0) {
      ctx.fillStyle = 'rgba(113,113,122,0.45)';
      ctx.fillRect(0, mid - dpr / 2, W, dpr);   // baseline when no audio
      return;
    }
    ctx.fillStyle = 'rgba(161,161,170,0.6)';
    for (let x = 0; x < W; x++) {
      const p = peaks[Math.min(peaks.length - 1, Math.floor((x / W) * peaks.length))];
      const h = Math.max(dpr, p * H * 0.92);
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [waveReady]);
  useEffect(() => { drawWave(); }, [drawWave, containerSize]);

  // ---- frame sampling for histogram / palette / hover RGBA ----
  // The display blits the full-res frame; this is a capped offscreen copy
  // (decoded ImageBitmap during reverse, else the <video>). getImageData
  // throws on a tainted canvas — tools degrade silently then. Throttled.
  // Shared scope-consumption tail: histogram straight to canvas, palette via
  // throttled React state. Both the canvas path and the macAv native-sample
  // path land here.
  const consumeSample = useCallback((data: Uint8ClampedArray, sw: number, sh: number, now: number) => {
    sampleRef.current = { data, w: sw, h: sh };
    if (showHistRef.current) {
      const hist = buildHistogram(data, sw, sh);
      histRef.current = hist;
      const c = histCanvasRef.current;
      if (c) drawHistogram(c, hist, channelRef.current);
    }
    if (showPaletteRef.current && now - lastPaletteRef.current > 90) {
      lastPaletteRef.current = now;
      setPalette(extractPalette(data));
    }
  }, []);

  const macSampleBusyRef = useRef(false);
  const sampleFrame = useCallback(() => {
    const now = performance.now();
    if (now - lastSampleRef.current < 33) return;          // ~30fps cap
    if (macAv) {
      // The picture composites below the webview — pixels come from the
      // native AVPlayerItemVideoOutput tap instead of a canvas blit.
      if (macSampleBusyRef.current) return;
      const key = `${macTimeRef.current.toFixed(3)}|mac`;
      if (key === sampleKeyRef.current) return;
      macSampleBusyRef.current = true;
      lastSampleRef.current = now;
      void invoke<ArrayBuffer>('mac_video_sample', { label: getCurrentWindow().label, maxDim: 480 })
        .then((buf) => {
          if (!buf || buf.byteLength < 8) {
            // No NEW pixel buffer (paused + already sampled). Lock the key so
            // a static frame doesn't re-poll every tick — but only once a
            // sample exists, else preroll would lock the scopes empty.
            if (sampleRef.current) sampleKeyRef.current = key;
            return;
          }
          sampleKeyRef.current = key;
          const head = new DataView(buf);
          const sw = head.getUint32(0, true), sh = head.getUint32(4, true);
          if (sw <= 0 || sh <= 0 || buf.byteLength < 8 + sw * sh * 4) return;
          consumeSample(new Uint8ClampedArray(buf, 8, sw * sh * 4), sw, sh, performance.now());
        })
        .catch(() => { /* transient (window teardown, timeout) — keep last */ })
        .finally(() => { macSampleBusyRef.current = false; });
      return;
    }
    const src = nativeFrameRef.current ?? decodedFrameRef.current ?? videoRef.current;
    const vw = size.w, vh = size.h;
    if (!src || vw <= 0 || vh <= 0) return;
    if (!nativeFrameRef.current && !decodedFrameRef.current &&
        (!videoRef.current || videoRef.current.readyState < 2)) return;
    // Skip an unchanged frame (paused + static) — don't bump lastSample so we
    // recheck promptly once it moves again. Native mode keys off the engine
    // clock (the unsourced <video>'s currentTime is stuck at 0).
    const ct = nativeEngineRef.current?.currentTime ?? videoRef.current?.currentTime ?? 0;
    const key = `${ct.toFixed(3)}|${nativeFrameRef.current ? 2 : decodedFrameRef.current ? 1 : 0}`;
    if (key === sampleKeyRef.current) return;
    sampleKeyRef.current = key;
    lastSampleRef.current = now;
    const CAP = 480;
    const scale = Math.min(1, CAP / Math.max(vw, vh));
    const sw = Math.max(1, Math.round(vw * scale)), sh = Math.max(1, Math.round(vh * scale));
    try {
      const off = sampleCanvasRef.current ?? (sampleCanvasRef.current = document.createElement('canvas'));
      if (off.width !== sw) off.width = sw;
      if (off.height !== sh) off.height = sh;
      const octx = off.getContext('2d', { willReadFrequently: true })!;
      octx.drawImage(src, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh).data;
      consumeSample(data, sw, sh, now);
    } catch {
      sampleRef.current = null; histRef.current = null;
    }
  }, [size, macAv, consumeSample]);

  // Hover RGBA — map the cursor to image px via the viewport transform, then
  // read the capped sample. Samples on demand so the readout works without a
  // panel open. (Mirrors ImageView.sampleAt.)
  const sampleAt = useCallback((clientX: number, clientY: number) => {
    if (!sampleRef.current || performance.now() - lastSampleRef.current > 400) sampleFrame();
    const rect = containerRef.current?.getBoundingClientRect();
    const samp = sampleRef.current;
    const iw = size.w, ih = size.h;
    if (!rect || !samp || iw <= 0) { setHover(null); return; }
    const v = viewRef.current;
    const cx = clientX - rect.left, cy = clientY - rect.top;
    const imgX = (cx - v.ox) / v.s, imgY = (cy - v.oy) / v.s;
    if (imgX < 0 || imgY < 0 || imgX >= iw || imgY >= ih) { setHover(null); return; }
    const sx = Math.min(samp.w - 1, Math.floor((imgX / iw) * samp.w));
    const sy = Math.min(samp.h - 1, Math.floor((imgY / ih) * samp.h));
    const idx = (sy * samp.w + sx) * 4;
    setHover({ x: Math.floor(imgX), y: Math.floor(imgY), r: samp.data[idx], g: samp.data[idx + 1], b: samp.data[idx + 2], a: samp.data[idx + 3] });
  }, [size, viewRef, sampleFrame]);
  sampleAtRef.current = sampleAt;

  // Realtime sampling — a single rAF loop runs whenever a panel is open and
  // covers every playback mode (forward / reverse / paused-scrub) since it
  // reads the live frame. sampleFrame self-throttles + skips static frames.
  useEffect(() => {
    if (!(showHist || showPalette)) { sampleKeyRef.current = ''; return; }
    // Force a fresh sample of the CURRENT frame when a tool turns on. The
    // dedup key is shared with the hover-RGBA path: moving the cursor onto the
    // palette/histogram toggle already sampled this frame (locking the key)
    // while the tool was off, so without this reset the loop would skip the
    // frame and the palette would stay empty until the playhead moved.
    sampleKeyRef.current = '';
    let raf = 0;
    const loop = () => { sampleFrame(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [showHist, showPalette, sampleFrame]);

  // Histogram redraw on channel switch / toggle (using the last sample) and
  // clear when hidden. Realtime updates come from sampleFrame's direct draw.
  useEffect(() => {
    const c = histCanvasRef.current; if (!c) return;
    if (!showHist || status !== 'ready') { c.getContext('2d')?.clearRect(0, 0, c.width, c.height); return; }
    if (histRef.current) drawHistogram(c, histRef.current, channel);
  }, [showHist, channel, status]);

  // Click a swatch → copy its hex (eyedropper).
  const copyHex = useCallback((hex: string) => {
    void navigator.clipboard?.writeText(hex).catch(() => { /* unavailable */ });
    setCopiedHex(hex);
    window.setTimeout(() => setCopiedHex((x) => (x === hex ? null : x)), 1200);
  }, []);

  // ---- requestVideoFrameCallback loop (blits every painted frame) ----
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    }) | null;
    if (!video) return;
    if (!video.requestVideoFrameCallback) {
      // Fallback: rAF while playing.
      let raf = 0;
      const loop = () => { drawFnRef.current(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    let handle = 0;
    const cb = (_now: number, md: { mediaTime: number }) => {
      const loopIn = inPointRef.current;
      const loopOut = outPointRef.current;
      if (loopRegionRef.current && loopIn != null && loopOut != null &&
          loopOut > loopIn && md.mediaTime >= loopOut) {
        video.currentTime = loopIn;
        setCurrentTime(loopIn);
        lastMediaTimeRef.current = -1;
        handle = video.requestVideoFrameCallback!(cb);
        return;
      }
      const last = lastMediaTimeRef.current;
      if (last >= 0) {
        const d = md.mediaTime - last;
        if (d > 0.0005 && d < 0.5) fpsRef.current = fpsRef.current * 0.8 + (1 / d) * 0.2;  // smoothed
      }
      lastMediaTimeRef.current = md.mediaTime;
      directPresentedTimeRef.current = md.mediaTime;
      drawFnRef.current();
      handle = video.requestVideoFrameCallback!(cb);
    };
    handle = video.requestVideoFrameCallback(cb);
    return () => video.cancelVideoFrameCallback?.(handle);
  }, []);

  // ---- video element events ----
  useEffect(() => {
    // In native mode the engine owns play/status/time/duration (and runs in a
    // separate effect that may fire before this one) — don't clobber its state
    // on the src change, or the UI shows "paused" while the engine is playing
    // and the transport inverts.
    if (!nativeStream) {
      setStatus('loading'); setPlaying(false); setCurrentTime(0); setDuration(0); setBuffered(0);
    }
    setInPoint(null); setOutPoint(null); lastMediaTimeRef.current = -1;
    directPresentedTimeRef.current = -1;
    // The component is reused across file switches (no key= at the call site),
    // so clear the frame-dedup key — the new video's frame 0 would otherwise
    // collide with the previous file's locked key and the palette/histogram
    // would show stale colors until the playhead moved.
    sampleKeyRef.current = '';
    // Dep is the stream PATH, not the config object: callers build the
    // config inline (fresh identity every render), and keying this reset
    // on the object nulled the loop points — a silent loop CLEAR — every
    // time the parent re-rendered. (The engine effect below already
    // extracts primitives for exactly this reason.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, nativeStream?.path]);

  // Idle-deferred audio decode (scrubber waveform + reverse-tape audio). It's a
  // full fetch + decodeAudioData + a main-thread peak scan + a reversed-copy
  // build — heavy enough that running it on load made nav STICKY. Deferring to
  // idle (guarded by liveSrcRef) keeps it off the nav path entirely: arrow onto
  // a video and it paints instantly; arrow PAST it before idle fires and the
  // work never starts.
  const scheduleAudioDecode = useCallback((forSrc: string, dur: number) => {
    if (audioIdleRef.current != null) return;
    const start = () => {
      audioIdleRef.current = null;
      if (liveSrcRef.current !== forSrc || audioRef.current) return;   // navigated away / already built
      const a = new VideoAudio(forSrc, dur);
      audioRef.current = a;
      a.ready.then((ok) => { if (ok && liveSrcRef.current === forSrc) setWaveReady((n) => n + 1); }).catch(() => {});
    };
    audioIdleRef.current = (typeof window.requestIdleCallback === 'function')
      ? window.requestIdleCallback(start, { timeout: 1200 })
      : (window.setTimeout(start, 250) as unknown as number);
  }, []);
  const cancelAudioDecode = useCallback(() => {
    if (audioIdleRef.current == null) return;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(audioIdleRef.current);
    else window.clearTimeout(audioIdleRef.current);
    audioIdleRef.current = null;
  }, []);

  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    setSize({ w: v.videoWidth, h: v.videoHeight });
    setDuration(v.duration || 0);
    setStatus('ready');
    everLoadedRef.current = true;
    // NOTE: onReady fires on onLoadedData (first frame painted), NOT here —
    // onLoadedMetadata only has dimensions, so clearing the parent freeze
    // now would blank the pane until the first frame decodes.
    // The audio decode (above) and the reverse-decoder warm-up are both heavy
    // fetch+decode/demux passes NOT needed to show or play the video — doing
    // them here made nav sticky. Defer the audio to idle, and create the
    // reverse decoder lazily on the first J (startReverse) instead of here.
    if ((v.duration || 0) > 0) scheduleAudioDecode(src, v.duration);
  }, [src, scheduleAudioDecode]);
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    setCurrentTime(v.currentTime);
    // Loop region: jump back to the in-point at/after the out-point.
    if (loopRegion && inPoint != null && outPoint != null && outPoint > inPoint && v.currentTime >= outPoint) {
      v.currentTime = inPoint;
    }
  }, [loopRegion, inPoint, outPoint]);
  const onProgress = useCallback(() => {
    const v = videoRef.current; if (!v || !v.duration) return;
    try { if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1) / v.duration); } catch { /* ignore */ }
  }, []);

  // ---- transport actions ----
  const seek = useCallback((t: number, freeze = false) => {
    if (macAv) {
      void invoke('mac_video_command', { label: getCurrentWindow().label, action: 'seek', sec: t, end: 0 });
      return;
    }
    if (nativeEngineRef.current) {
      nativeEngineRef.current.seek(t, freeze);
      setCurrentTime(nativeEngineRef.current.currentTime);
      return;
    }
    const v = videoRef.current; if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration, t));
    setCurrentTime(v.currentTime);
  }, [macAv]);
  const stepFrame = useCallback((dir: number) => {
    if (nativeEngineRef.current) {
      // Native: pause (parity with the <video> path) and step relative to the
      // engine clock — in-process seeks are frame-accurate now.
      nativeEngineRef.current.pause();
      seek(nativeEngineRef.current.currentTime + dir / Math.max(1, fpsRef.current));
      return;
    }
    const v = videoRef.current; if (!v) return;
    v.pause();
    seek(v.currentTime + dir / Math.max(1, fpsRef.current));
  }, [seek]);
  // These set React state FIRST and only touch the <video> element when
  // one exists — in native-engine mode there is no <video>, and the old
  // `if (!v) return` guard dead-ended the whole control (the speed
  // button silently did nothing; the engine mirror effects below never
  // saw a state change).
  const cycleSpeed = useCallback(() => {
    const i = SPEEDS.indexOf(speed);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    const v = videoRef.current;
    if (v) v.playbackRate = next;
    setSpeed(next);
  }, [speed]);
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const v = videoRef.current;
      if (v) v.muted = !m;
      return !m;
    });
  }, []);
  const onVolume = useCallback((val: number) => {
    const v = videoRef.current;
    if (v) { v.volume = val; v.muted = val === 0; }
    setVolume(val); setMuted(val === 0);
  }, []);
  // Mirror volume/mute onto the reverse-audio bus (WebAudio gain). waveReady
  // re-fires this once the decoder exists, so the initial level lands too.
  useEffect(() => {
    audioRef.current?.setVolume(muted ? 0 : volume);
  }, [volume, muted, waveReady]);
  // Mirror transport state onto the native engine (no-ops when not in native
  // mode). The fader/speed/loop handlers only write React state — these are
  // what actually lands them on the daemon/decoder.
  useEffect(() => {
    nativeEngineRef.current?.setVolume(muted ? 0 : volume);
    if (macAv) void invoke('mac_video_command', {
      label: getCurrentWindow().label, action: 'volume', sec: muted ? 0 : volume, end: 0,
    });
  }, [volume, muted, macAv]);
  useEffect(() => {
    nativeEngineRef.current?.setRate(pitchPreviewLock ? 1 : speed);
    if (macAv) void invoke('mac_video_command', {
      label: getCurrentWindow().label, action: 'rate', sec: pitchPreviewLock ? 1 : speed, end: 0,
    });
  }, [speed, pitchPreviewLock, macAv]);
  useEffect(() => {
    nativeEngineRef.current?.setLoopRegion(
      loopRegion && inPoint != null && outPoint != null && outPoint > inPoint
        ? { inSec: inPoint, outSec: outPoint }
        : null,
    );
  }, [loopRegion, inPoint, outPoint]);
  // Loop points surface to the host ONLY from explicit user actions (the
  // IN/OUT buttons + I/O keys, via the emit sites below) — an effect on
  // inPoint/outPoint also fired for the imperative setLoop() the chop
  // host calls when ACTIVATING a region, feeding the points straight
  // back as a new-region request (sliver regions, selection chaos).
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current; if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  }, []);

  // Reverse playback. Spins up the WebCodecs decoder lazily; the rAF loop
  // presents decoded frames backward once it's ready (buttery), and seeks the
  // <video> backward in the meantime / for non-MP4 / decode failures.
  const startReverse = useCallback((rate: number) => {
    stopReverse();
    const v = videoRef.current; if (!v) return;
    v.pause();
    if (!revDecoderRef.current) revDecoderRef.current = new ReverseDecoder(src);
    const dec = revDecoderRef.current;
    const fromT = v.currentTime;
    revTimeRef.current = fromT;
    // True reversed-tape audio when the decoded buffer is available; the
    // audio clock then drives the reverse position for tight A/V sync.
    const audio = audioRef.current;
    const useAudio = !!(audio && audio.isReady && audio.hasReverse);
    const audioStart = useAudio ? audio!.playReverse(fromT, rate) : 0;
    let last = performance.now();
    let lastSeek = 0;
    let lastUi = 0;
    let stopped = false;
    reverseStopRef.current = () => { stopped = true; };
    const tick = () => {
      if (stopped) return;
      if (useAudio) {
        revTimeRef.current = audio!.positionAt(audioStart, fromT, rate);
      } else {
        const now = performance.now(); const dt = Math.min(0.08, (now - last) / 1000); last = now;
        revTimeRef.current = Math.max(0, revTimeRef.current - rate * dt);
      }
      const t = revTimeRef.current;
      // Throttle the playhead state to ~15fps — 60fps setState here was the
      // 283ms render / forced-reflow storm. Decoded-frame draw is separate.
      const nowUi = performance.now();
      if (nowUi - lastUi > 66) { lastUi = nowUi; setCurrentTime(t); }
      if (dec.isReady) {
        // Buttery: read the cached frame for `t` (never blocks) and keep the
        // decoder filling well ahead of the playhead so boundaries don't
        // stall — current GOP + ~1–2 GOPs of lookahead, scaled by speed.
        const la = Math.max(1.2, rate);
        dec.prefetch(t);
        dec.prefetch(t - la);
        const bmp = dec.getCached(t);
        if (bmp) {
          decodedFrameRef.current = bmp;
          drawFnRef.current();
        } else {
          // Nothing close is cached yet (cold start / fast scrub past the
          // prefetch window) — seek the <video> so the picture keeps moving
          // until prefetch fills in. Rare in steady state with the widened
          // getCached window, so the brief seek-frame doesn't read as flicker.
          decodedFrameRef.current = null;
          const nowS = performance.now();
          if (nowS - lastSeek > 80) { lastSeek = nowS; const vid = videoRef.current; if (vid) vid.currentTime = t; }
        }
      } else {
        // Seek fallback while the decoder warms up (or non-MP4 / decode fail).
        // Throttled: 60fps currentTime sets never let a seek complete, so the
        // 'seeked' redraw never fires (frozen). ~12fps lets each one land.
        decodedFrameRef.current = null;
        const now = performance.now();
        if (now - lastSeek > 80) { lastSeek = now; const vid = videoRef.current; if (vid) vid.currentTime = t; }
      }
      if (t <= 0.001) { shuttleRef.current = 0; setShuttleLevel(0); stopReverse(); return; }
      reverseRafRef.current = requestAnimationFrame(tick);
    };
    reverseRafRef.current = requestAnimationFrame(tick);
  }, [src, stopReverse]);
  const applyShuttle = useCallback((level: number) => {
    // Native: the engine owns the whole shuttle (forward = audio-rate, reverse
    // = seek-stepping scrub). NEVER fall through to startReverse here — the
    // WebCodecs ReverseDecoder demuxes the source in the webview, which is
    // exactly the decoder class that hard-crashes the host (0xE0000008) on
    // the files native mode exists for.
    if (nativeEngineRef.current) { nativeEngineRef.current.shuttle(level); return; }
    const v = videoRef.current; if (!v) return;
    if (level === 0) { stopReverse(); v.playbackRate = speed; v.pause(); }
    else if (level > 0) { stopReverse(); v.playbackRate = level; void v.play().catch(() => {}); }
    else { v.playbackRate = 1; startReverse(-level); }
  }, [speed, stopReverse, startReverse]);
  // J / L: step the shuttle level down / up (J J L L → rev 2×, back to stop).
  const shuttle = useCallback((dir: number) => {
    const next = Math.max(-8, Math.min(8, shuttleRef.current + dir));
    shuttleRef.current = next; setShuttleLevel(next); applyShuttle(next);
  }, [applyShuttle]);

  // Imperative handle — the Latch chop window (video-as-master) drives the
  // player from the waveform click + window-level transport keys.
  useImperativeHandle(ref, () => ({
    seek, togglePlay, shuttle, stepFrame,
    play: () => {
      if (macAv) {
        void invoke('mac_video_command', { label: getCurrentWindow().label, action: 'play', sec: 0, end: 0 });
        return;
      }
      const eng = nativeEngineRef.current;
      if (eng) {
        if (shuttleRef.current !== 0) eng.shuttle(0);
        shuttleRef.current = 0; setShuttleLevel(0);
        eng.play();
        return;
      }
      const v = videoRef.current; if (!v) return;
      stopReverse(); shuttleRef.current = 0; setShuttleLevel(0);
      v.playbackRate = speed;
      if (v.paused) void v.play().catch(() => {});
    },
    setLoop: (inSec: number, outSec: number) => {
      setInPoint(inSec); setOutPoint(outSec); setLoopRegion(true);
      // The native stream remains the audio + transport clock even when
      // AVPlayer paints the Mac picture. Arm it in this same call so a click
      // followed immediately by Space cannot outrun React's mirror effect.
      if (outSec > inSec) nativeEngineRef.current?.setLoopRegion({ inSec, outSec });
      if (macAv) {
        void invoke('mac_video_command', { label: getCurrentWindow().label, action: 'loop', sec: inSec, end: outSec });
        revealMacVideo();
        return;
      }
      // Push the new bounds to the native engine SYNCHRONOUSLY — not only via
      // the deferred inPoint/outPoint mirror effect. A live region-resize that
      // strands the playhead needs the engine to re-arm + force-wrap in the
      // SAME tick, before the chop host's follow-up seek runs; otherwise that
      // seek re-cues the decoder while the OLD loop is still armed and the old
      // span replays for a cycle or two. Idempotent with the mirror effect.
      // Already armed synchronously above; the state mirror is idempotent.
    },
    setLoopBounds: (inSec: number, outSec: number) => {
      // Live drag: poke ONLY the engine's live loop bounds (present() reads
      // them each frame). Deliberately NOT touching inPoint/outPoint state so
      // the mirror effect never re-fires and re-arms the decoder per move.
      nativeEngineRef.current?.setLoopBounds(inSec, outSec);
    },
    clearLoop: () => {
      setLoopRegion(false);
      // Mac AVPlayer is only the picture surface; clear the native
      // audio/clock loop as well, synchronously with the host gesture.
      nativeEngineRef.current?.setLoopRegion(null);
      if (macAv) {
        void invoke('mac_video_command', { label: getCurrentWindow().label, action: 'loop', sec: 0, end: 0 });
        revealMacVideo();
        return;
      }
      // Sync engine clear too: with loopRegion state ALREADY false (a gesture
      // cage armed via setLoopBounds only — nothing ever set the React loop),
      // the mirror effect won't re-fire, and the engine's live-drag loop
      // would dangle at the last drag bounds, caging whole-file playback.
      // Already cleared synchronously above; the state mirror is idempotent.
    },
    pause: () => {
      if (macAv) {
        void invoke('mac_video_command', { label: getCurrentWindow().label, action: 'pause', sec: 0, end: 0 });
        return;
      }
      const eng = nativeEngineRef.current;
      if (eng) {
        if (shuttleRef.current !== 0) eng.shuttle(0);
        shuttleRef.current = 0; setShuttleLevel(0);
        eng.pause();
        return;
      }
      const v = videoRef.current; if (!v) return;
      stopReverse(); shuttleRef.current = 0; setShuttleLevel(0);
      if (!v.paused) v.pause();
    },
    getCurrentTime: () => macAv ? macTimeRef.current : nativeEngineRef.current?.currentTime ??
      (directPresentedTimeRef.current >= 0 ? directPresentedTimeRef.current : videoRef.current?.currentTime ?? 0),
    getSpeed: () => speedRef.current,
    captureFrame: () => {
      // Prefer the painted canvas (what's actually on screen, incl. a
      // reverse-decoded frame); fall back to the raw <video> element.
      const c = canvasRef.current;
      if (c && c.width > 0 && c.height > 0) {
        try {
          const off = document.createElement('canvas');
          off.width = c.width; off.height = c.height;
          const cx = off.getContext('2d');
          if (cx) { cx.drawImage(c, 0, 0); return off; }
        } catch { /* fall through */ }
      }
      const v = videoRef.current;
      if (v && v.videoWidth > 0) {
        try {
          const off = document.createElement('canvas');
          off.width = v.videoWidth; off.height = v.videoHeight;
          const cx = off.getContext('2d');
          if (cx) { cx.drawImage(v, 0, 0, off.width, off.height); return off; }
        } catch { /* ignore */ }
      }
      return null;
    },
  }), [seek, togglePlay, shuttle, stepFrame, speed, stopReverse]);

  // ---- scrub timeline ----
  const trackRef = useRef<HTMLDivElement>(null);
  const seekFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current; if (!el || !duration) return;
    const rect = el.getBoundingClientRect();
    seek(((clientX - rect.left) / rect.width) * duration);
  }, [seek, duration]);
  const onTrackDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    seekFromClientX(e.clientX);
  }, [seekFromClientX]);
  const onTrackMove = useCallback((e: React.PointerEvent) => {
    if (e.buttons & 1) seekFromClientX(e.clientX);
  }, [seekFromClientX]);

  // ---- vertical volume fader (control-room style: relative drag, LERP,
  //      hidden cursor while dragging, cursor warp to the cap on release) ----
  const volRef = useRef<HTMLDivElement>(null);
  const volPopRef = useRef<HTMLDivElement>(null);
  const volTrackRef = useRef<HTMLDivElement>(null);
  // LERP tick — eases the gain toward the drag target (reads volumeRef so it
  // isn't stale), committing the exact value on snap. Mirrors the master fader.
  const volTick = useCallback(() => {
    const cur = volGainToDb(volumeRef.current);
    const target = volTargetDbRef.current;
    const curM = isFinite(cur) ? cur : VOL_MIN_DB;
    const diff = target - curM;
    if (Math.abs(diff) < VOL_SNAP_DB) {
      onVolume(volDbToGain(target));
      volAnimRef.current = null;
      return;
    }
    onVolume(volDbToGain(curM + diff * VOL_LERP));
    volAnimRef.current = requestAnimationFrame(volTick);
  }, [onVolume]);
  const onVolDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (volAnimRef.current != null) { cancelAnimationFrame(volAnimRef.current); volAnimRef.current = null; }
    const cur = volGainToDb(volumeRef.current);
    volDragRef.current = { startDb: isFinite(cur) ? cur : VOL_MIN_DB, passed: false, preDy: 0, accumPct: 0 };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);
  const onVolMove = useCallback((e: React.PointerEvent) => {
    const s = volDragRef.current; if (!s) return;
    if (!s.passed) {
      s.preDy += e.movementY;
      if (Math.abs(s.preDy) < 3) return;
      s.passed = true; setVolDragging(true);
    }
    const sens = (e.ctrlKey || e.metaKey || (isMac && e.altKey)) ? 0.25 : 0.5;   // Ctrl / Cmd / Option (mac) = precision
    const track = volTrackRef.current; if (!track) return;
    const rect = track.getBoundingClientRect();
    s.accumPct += (e.movementY / rect.height) * 100 * sens;
    const nextPct = Math.max(0, Math.min(100, volDbToPct(s.startDb) + s.accumPct));
    volTargetDbRef.current = nextPct >= 97 ? VOL_MIN_DB : volPctToDb(nextPct);
    if (volAnimRef.current == null) volAnimRef.current = requestAnimationFrame(volTick);
  }, [volTick]);
  const onVolUp = useCallback((e: React.PointerEvent) => {
    const s = volDragRef.current; if (!s) return;
    const wasDragging = s.passed;
    volDragRef.current = null; setVolDragging(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!wasDragging) return;
    // Warp the OS cursor to the cap's final position (cursor stayed hidden
    // through the drag; volWarping keeps it hidden across the async IPC).
    const track = volTrackRef.current; if (!track) return;
    const rect = track.getBoundingClientRect();
    const finalPct = volDbToPct(Math.max(VOL_MIN_DB, Math.min(0, volTargetDbRef.current)));
    const capX = rect.left + rect.width / 2;
    const capY = rect.top + (rect.height * finalPct) / 100;
    setVolWarping(true);
    void (async () => {
      try {
        const win = getCurrentWindow();
        const [innerPos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
        await invoke('set_native_cursor_position', { x: Math.round(innerPos.x + capX * scale), y: Math.round(innerPos.y + capY * scale) });
      } catch { /* cursor stays put */ }
      finally { setVolWarping(false); }
    })();
  }, []);
  // Hide the OS cursor while dragging or warping (matches the master fader).
  useEffect(() => {
    if (!volDragging && !volWarping) return;
    const el = document.createElement('style');
    el.textContent = '*, *::before, *::after { cursor: none !important; }';
    document.head.appendChild(el);
    return () => el.remove();
  }, [volDragging, volWarping]);
  useEffect(() => () => { if (volAnimRef.current != null) cancelAnimationFrame(volAnimRef.current); }, []);
  // Auto-close when the cursor leaves the button + slider region (15px buffer
  // bridges the gap). Suspended while dragging/warping so a relative drag that
  // strays outside doesn't snap it shut.
  useEffect(() => {
    if (!volOpen || volDragging || volWarping) return;
    const PAD = 15;
    const near = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD;
    };
    const onMove = (e: PointerEvent) => {
      if (!near(volRef.current, e.clientX, e.clientY) && !near(volPopRef.current, e.clientX, e.clientY)) setVolOpen(false);
    };
    document.addEventListener('pointermove', onMove);
    return () => document.removeEventListener('pointermove', onMove);
  }, [volOpen, volDragging, volWarping]);

  // ---- keyboard (while hovering the player) ----
  // Capture phase + stopImmediatePropagation so shortcuts don't leak to global
  // handlers (e.g. type-to-search) while the player is focused/hovered.
  const hoveredRef = useRef(false);
  useEffect(() => {
    if (disableKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const el = containerRef.current;
      const focusWithin = !!el && el.contains(document.activeElement);
      if ((!hoveredRef.current && !focusWithin) || status !== 'ready') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const v = videoRef.current; if (!v) return;
      let handled = true;
      switch (e.code) {
        case 'Space': case 'KeyK': togglePlay(); break;
        // Plain arrows frame-step, Shift jogs 1s — identical in native mode
        // now that in-process seeks are frame-accurate and fast.
        case 'ArrowLeft':
          if (e.shiftKey) seek((nativeEngineRef.current?.currentTime ?? v.currentTime) - 1);
          else stepFrame(-1);
          break;
        case 'ArrowRight':
          if (e.shiftKey) seek((nativeEngineRef.current?.currentTime ?? v.currentTime) + 1);
          else stepFrame(1);
          break;
        // JKL shuttle. A distinct press always steps. Held-key auto-repeat
        // ramps the speed too, but throttled to ~3/s so it doesn't slam to
        // max instantly (OS already delays the first repeat).
        case 'KeyJ': case 'KeyL': {
          const dir = e.code === 'KeyJ' ? -1 : 1;
          if (e.repeat) {
            const now = performance.now();
            if (now - shuttleRepeatRef.current < 300) break;
            shuttleRepeatRef.current = now;
          } else {
            shuttleRepeatRef.current = performance.now();
          }
          shuttle(dir);
          break;
        }
        // Native: the unsourced <video>'s currentTime is stuck at 0 — the
        // engine clock is the playhead.
        case 'KeyI': {
          const t = nativeEngineRef.current?.currentTime ?? v.currentTime;
          setInPoint(t);
          onLoopPointsChange?.(t, outPointRef.current);
          break;
        }
        case 'KeyO': {
          const t = nativeEngineRef.current?.currentTime ?? v.currentTime;
          setOutPoint(t);
          onLoopPointsChange?.(inPointRef.current, t);
          break;
        }
        case 'KeyX':        if (e.altKey) { setInPoint(null); setOutPoint(null); } else handled = false; break;
        case 'KeyM':        toggleMute(); break;
        case 'KeyF':        toggleFullscreen(); break;
        default:            handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    document.addEventListener('keydown', onKey, true);  // capture — beats global handlers
    return () => document.removeEventListener('keydown', onKey, true);
  }, [status, togglePlay, seek, stepFrame, shuttle, toggleMute, toggleFullscreen, disableKeyboard]);

  // Clear shuttle + reverse loop + dispose the decoder on source change / unmount.
  // Also cancel any pending idle audio decode so a fast nav past this video
  // never spins it up after we've moved on.
  useEffect(() => {
    stopReverse(); shuttleRef.current = 0; setShuttleLevel(0);
    cancelAudioDecode();
    revDecoderRef.current?.close(); revDecoderRef.current = null;
    audioRef.current?.close(); audioRef.current = null;
    decodedFrameRef.current = null; setWaveReady(0);
  }, [src, stopReverse, cancelAudioDecode]);
  useEffect(() => () => { stopReverse(); cancelAudioDecode(); revDecoderRef.current?.close(); audioRef.current?.close(); }, [stopReverse, cancelAudioDecode]);

  useEffect(() => { onPlayingChange?.(playing); }, [playing, onPlayingChange]);

  if (status === 'error') {
    return <div className="w-full h-full flex items-center justify-center text-zinc-500 text-xs select-none">Couldn't load this video.</div>;
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const inPct = inPoint != null && duration > 0 ? (inPoint / duration) * 100 : null;
  const outPct = outPoint != null && duration > 0 ? (outPoint / duration) * 100 : null;
  // Drop in/out + frame-step at narrow widths (InfoPanel min width).
  const compact = containerSize.w > 0 && containerSize.w < 380;
  const active = playing || shuttleLevel !== 0;   // play icon reflects shuttle too
  const volNow = muted ? 0 : volume;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`w-full h-full relative overflow-hidden select-none group outline-none ${macAv ? '' : 'bg-black/40'}`}
      style={{ touchAction: 'none', cursor: viewport.panning ? 'grabbing' : ((macAv || viewport.isZoomed) ? 'grab' : 'default') }}
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseLeave={() => { hoveredRef.current = false; }}
      // Clicking anywhere in the player (incl. the video itself) takes keyboard
      // focus off the search box etc., so JKL/space work without hovering.
      onPointerDownCapture={() => { try { containerRef.current?.focus({ preventScroll: true }); } catch { /* ok */ } }}
      {...viewport.handlers}
      onDoubleClick={viewport.fit}
    >
      <video
        ref={videoRef}
        // Native mode: no src, so the <video> never decodes (and never crashes
        // the host). Frames come from the stream engine onto the canvas instead.
        src={nativeStream || macAv ? undefined : src}
        crossOrigin="anonymous"
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMeta}
        onLoadedData={() => { drawFnRef.current(); onReady?.(); }}
        onSeeked={() => drawFnRef.current()}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
        onProgress={onProgress}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => { setStatus('error'); onReady?.(); }}
        className="absolute inset-0 w-full h-full pointer-events-none opacity-0"
      />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />

      {/* Channel-isolation color matrices (R/G/B isolated to grey, Luma,
          Alpha-as-grey). Referenced by ctx.filter in draw(). */}
      <svg width="0" height="0" aria-hidden className="absolute pointer-events-none">
        <defs>
          <filter id={`${fid}-r`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" /></filter>
          <filter id={`${fid}-g`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 0 1" /></filter>
          <filter id={`${fid}-b`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 0 1" /></filter>
          <filter id={`${fid}-luma`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 0 1" /></filter>
          <filter id={`${fid}-a`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1" /></filter>
        </defs>
      </svg>

      {/* Control cluster — top-right, fades in on hover. Image-style tools
          (channel / palette / histogram) plus pop-out. */}
      <div
        className="absolute top-1.5 right-1.5 z-[2147483647] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        style={{ transform: 'translateZ(0)' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <WdSelect<ImageChannel>
          value={channel}
          onChange={setChannel}
          options={CHANNEL_OPTIONS}
          ariaLabel="Channel"
          className={`h-5 px-1.5 leading-none text-[0.5625rem] font-bold tracking-wide border transition-colors ${channel === 'rgb' ? 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-200 hover:border-zinc-700' : 'bg-zinc-700 text-zinc-100 border-zinc-500'}`}
        />
        {hdrKind !== '' && (
          <button
            type="button"
            onClick={() => {
              setTonemapOn((v) => {
                nativeEngineRef.current?.setTonemap(!v);
                return !v;
              });
            }}
            title={tonemapOn ? `Tone-mapping ${hdrKind.toUpperCase()} to SDR (click for raw)` : `Raw ${hdrKind.toUpperCase()} transfer (click to tone-map)`}
            className={`${TEXT_BTN} font-bold tracking-wide ${tonemapOn ? BTN_ON : BTN}`}
          >HDR</button>
        )}
        <button type="button" onClick={() => setShowPalette((v) => !v)} title="Toggle color palette" className={`${ICON_BTN} ${showPalette ? BTN_ON : BTN}`}><Paintbrush size={11} /></button>
        <button type="button" onClick={() => setShowHist((v) => !v)} title="Toggle histogram" className={`${ICON_BTN} ${showHist ? BTN_ON : BTN}`}><BarChart3 size={11} /></button>
        {onPopOut && <button type="button" onClick={onPopOut} title="Pop out to window" className={`${ICON_BTN} ${BTN}`}><PanelTopOpen size={11} /></button>}
      </div>

      {/* Histogram overlay — bottom-right, above the transport. */}
      <canvas
        ref={histCanvasRef}
        width={200}
        height={96}
        className="absolute right-1 pointer-events-none border border-zinc-800 bg-zinc-900"
        style={{ width: 200, height: 96, bottom: HUD_BOTTOM, display: showHist ? 'block' : 'none' }}
      />

      {/* Color palette — Coolors-style contiguous strip; eyedropper cursor,
          click a block to copy its hex. Rides above the RGBA readout while
          hovering and slides down to fill the gap when it hides. */}
      {showPalette && palette.length > 0 && (
        <div
          className="absolute left-1 flex flex-col items-start gap-1"
          style={{ bottom: hover ? HUD_BOTTOM + 26 : HUD_BOTTOM, transition: 'bottom 160ms ease-out' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {copiedHex && (
            <span className="font-mono text-[0.5rem] uppercase tracking-wide text-zinc-300 bg-zinc-900 border border-zinc-800 px-1 py-px">Copied {copiedHex}</span>
          )}
          <div className="flex">
            {palette.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => copyHex(swatchHex(s))}
                title={swatchHex(s)}
                className="w-5 h-5 block"
                style={{ background: swatchHex(s), cursor: EYEDROPPER_CURSOR }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Pixel / RGBA readout — bottom-left HUD, above the transport. */}
      {hover && (
        <div
          className="absolute left-1 pointer-events-none select-none flex items-center gap-1.5 px-1.5 h-5 bg-zinc-900 border border-zinc-800 font-mono text-[0.5625rem] tabular-nums text-zinc-300"
          style={{ bottom: HUD_BOTTOM }}
        >
          <span className="text-zinc-500">{hover.x},{hover.y}</span>
          <span className="inline-block w-2.5 h-2.5 border border-zinc-700" style={{ background: `rgb(${hover.r},${hover.g},${hover.b})` }} />
          <span>{hover.r} {hover.g} {hover.b}{hover.a !== 255 ? ` / ${hover.a}` : ''}</span>
        </div>
      )}

      {status === 'loading' && !everLoadedRef.current && !suppressChip && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-xs select-none pointer-events-none">Loading…</div>
      )}

      {/* Transport — theme-aware, fades in on hover (always visible while paused). */}
      <div
        className={`absolute bottom-0 inset-x-0 z-[2147483647] px-2 pt-1 pb-1.5 flex flex-col gap-1 bg-gradient-to-t from-black/80 to-transparent
                    transition-opacity duration-150 ${playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
        style={{ transform: 'translateZ(0)' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Scrub timeline — waveform-backed (scrub by sound). */}
        <div
          ref={trackRef}
          className="relative h-8 cursor-pointer overflow-hidden"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
        >
          <canvas ref={waveCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
          {/* buffered (thin, top edge) */}
          <div className="absolute top-0 left-0 h-px bg-zinc-600" style={{ width: `${buffered * 100}%` }} />
          {/* in→out loop region */}
          {inPct != null && outPct != null && outPct > inPct && (
            <div className="absolute top-0 bottom-0 bg-zinc-400/15" style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }} />
          )}
          {/* played tint */}
          <div className="absolute top-0 bottom-0 left-0 bg-zinc-100/10" style={{ width: `${pct}%` }} />
          {inPct != null && <div className="absolute top-0 bottom-0 w-px bg-emerald-400" style={{ left: `${inPct}%` }} />}
          {outPct != null && <div className="absolute top-0 bottom-0 w-px bg-rose-400" style={{ left: `${outPct}%` }} />}
          {/* playhead */}
          <div className="absolute top-0 bottom-0 w-px bg-zinc-100" style={{ left: `${pct}%` }} />
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-1.5 text-[0.5625rem] font-mono text-zinc-300">
          <button type="button" onClick={togglePlay} title={active ? 'Pause (K)' : 'Play (Space/K)'} className={`${ICON_BTN} ${BTN}`}>
            {active ? <Pause size={11} /> : <Play size={11} />}
          </button>
          {!compact && <button type="button" onClick={() => stepFrame(-1)} title="Previous frame (←)" className={`${ICON_BTN} ${BTN}`}><SkipBack size={11} /></button>}
          {!compact && <button type="button" onClick={() => stepFrame(1)} title="Next frame (→)" className={`${ICON_BTN} ${BTN}`}><SkipForward size={11} /></button>}
          <span className="tabular-nums text-zinc-400 whitespace-nowrap">{fmtTime(currentTime)} / {fmtTime(duration)}</span>
          {shuttleLevel !== 0 && (
            <span className="tabular-nums text-zinc-200 whitespace-nowrap">{shuttleLevel < 0 ? '◀◀' : '▶▶'} {Math.abs(shuttleLevel)}×</span>
          )}

          <div className="flex-1" />

          {!compact && <button type="button" onClick={() => { setInPoint(currentTime); onLoopPointsChange?.(currentTime, outPointRef.current); }} title="Set loop in (I)" className={`${TEXT_BTN} ${inPoint != null ? BTN_ON : BTN}`}>IN</button>}
          {!compact && <button type="button" onClick={() => { setOutPoint(currentTime); onLoopPointsChange?.(inPointRef.current, currentTime); }} title="Set loop out (O)" className={`${TEXT_BTN} ${outPoint != null ? BTN_ON : BTN}`}>OUT</button>}
          <button type="button" onClick={() => setLoopRegion((l) => !l)} title="Loop in→out section" className={`${ICON_BTN} ${loopRegion ? BTN_ON : BTN}`}><Repeat size={11} /></button>

          <button type="button" onClick={cycleSpeed} title="Playback speed" className={`${TEXT_BTN} tabular-nums ${BTN}`}>{speed}×</button>

          {/* Volume — vertical fader that reveals on hover; clicking the
              button toggles mute. Relative drag with eased LERP, hidden
              cursor while dragging, cursor warp to the cap on release, and
              decorative dB ticks (top = 0 dB) — matches the master fader. */}
          <div ref={volRef} className="relative flex items-center" onMouseEnter={() => setVolOpen(true)}>
            <button type="button" onClick={toggleMute} title={muted ? 'Unmute (M)' : 'Mute (M)'} className={`${ICON_BTN} ${muted ? BTN_ON : BTN}`}>
              {volNow === 0 ? <VolumeX size={11} /> : <Volume2 size={11} />}
            </button>
            {/* Always mounted so it can fade/slide in and out. translateX
                (-14px = padding 6 + left col 6 + half slot 2) puts the slot —
                not the asymmetric box — centered over the button. */}
            <div
              ref={volPopRef}
              className="absolute bottom-full left-1/2 mb-1 px-1.5 py-2.5 bg-zinc-900 border border-zinc-800 shadow-lg"
              style={{
                cursor: 'default',                              // don't inherit the video's grab cursor
                transformOrigin: 'bottom center',
                transform: `translateX(-14px) translateY(${volOpen ? 0 : 6}px)`,
                opacity: volOpen ? 1 : 0,
                pointerEvents: volOpen ? 'auto' : 'none',
                transition: 'opacity 140ms ease, transform 140ms ease',
              }}
              onPointerDown={(e) => e.stopPropagation()}        // don't pan the video through the popout
            >
                <div className="relative flex items-stretch gap-0" style={{ height: 96 }}>
                  {/* Left hash column — tight (w-1.5, hashes flush against the
                      slot). The translateX above keeps the slot centered. */}
                  <div className="relative w-1.5 h-full pointer-events-none">
                    {VOL_TICKS.map(({ db, major, subdivision }) => (
                      <div
                        key={db}
                        className={`absolute right-0 h-px ${db === 0 ? 'w-1.5 bg-zinc-300' : major ? 'w-1.5 bg-zinc-500' : subdivision ? 'w-0.5 bg-zinc-800' : 'w-1 bg-zinc-700'}`}
                        style={{ top: `${volDbToPct(db)}%`, transform: 'translateY(-50%)' }}
                      />
                    ))}
                  </div>
                  {/* Track — the cutout slot. The cap is the grab target. */}
                  <div
                    ref={volTrackRef}
                    className="relative w-1 h-full touch-none"
                    style={{ cursor: volDragging ? 'none' : 'ns-resize' }}
                    onPointerDown={onVolDown}
                    onPointerMove={onVolMove}
                    onPointerUp={onVolUp}
                    onPointerCancel={onVolUp}
                    onDoubleClick={() => { volTargetDbRef.current = 0; if (volAnimRef.current == null) volAnimRef.current = requestAnimationFrame(volTick); }}
                  >
                    <div
                      className="absolute inset-0 bg-black pointer-events-none"
                      style={{ boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.8), 0 0 0 1px #3f3f46' }}
                    />
                    {/* Chunky metallic cap — the full cap is the hit target so
                        it's easy to grab; events bubble to the track handlers. */}
                    <div
                      className={`absolute left-1/2 w-3.5 h-3 shadow-md border ${volDragging ? 'bg-zinc-200 border-zinc-50' : 'bg-zinc-500 border-zinc-300'}`}
                      style={{ top: `${volDbToPct(volGainToDb(volNow))}%`, transform: 'translate(-50%, -50%)', cursor: volDragging ? 'none' : 'ns-resize' }}
                    >
                      <div className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-px pointer-events-none ${volDragging ? 'bg-zinc-600' : 'bg-zinc-100'}`} />
                    </div>
                  </div>
                  {/* Right hash column + dB labels — matches the master fader. */}
                  <div className="relative w-5 h-full pointer-events-none">
                    {VOL_TICKS.map(({ db, major, subdivision }) => (
                      <React.Fragment key={db}>
                        <div
                          className={`absolute left-0 h-px ${db === 0 ? 'w-1.5 bg-zinc-300' : major ? 'w-1.5 bg-zinc-500' : subdivision ? 'w-0.5 bg-zinc-800' : 'w-1 bg-zinc-700'}`}
                          style={{ top: `${volDbToPct(db)}%`, transform: 'translateY(-50%)' }}
                        />
                        {major && (
                          <span
                            className="absolute text-[0.4375rem] font-mono tabular-nums text-zinc-500 leading-none"
                            style={{ left: 8, top: `${volDbToPct(db)}%`, transform: 'translateY(-50%)' }}
                          >
                            {db === 0 ? '0' : db}
                          </span>
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
            </div>
          </div>

          <button type="button" onClick={toggleFullscreen} title="Fullscreen (F)" className={`${ICON_BTN} ${BTN}`}><Maximize size={11} /></button>
        </div>
      </div>
    </div>
  );
});
