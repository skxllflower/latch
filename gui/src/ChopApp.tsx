// Standalone Latch Chop window (route ?wd=chop). Fork of WAVdesk's
// LatchChopApp; the two stay behaviorally aligned. Pulls the audio for
// a single link to a temp working dir, shows its waveform, and lets the
// user draw multiple non-overlapping selection regions, audition them
// (looped), then stage + export to a folder.
//
// Standalone deltas: audition runs on the in-app rodio engine (the
// playbackEngine shim) instead of the wavdesk audio-daemon, with the
// region loop checked Rust-side; the waveform is the standalone
// Waveform (same overlay viewport contract); the export-pill drag
// renders straight into the clips folder (no OS drag chip yet); video
// preview is stubbed out until the video-engine port — every link opens
// audio-only (bestaudio WAV), which still covers sampling sound from
// video links. The video code paths are kept compilable so the fork
// stays diff-able against WAVdesk's.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  Scissors, X, Play, Pause, Square, Loader2,
  Trash2, Film, Music, FolderOpen, Folder, ListMusic, Magnet, Rows2,
} from 'lucide-react';
import { useTheme, THEME_BG } from './theme';
import {
  usePlaybackState, usePlaybackCurrentPath,
} from './PlaybackContext';
import { playbackEngine } from './playbackEngine';
import { WaveformView, type WaveAudioFile } from './Waveform';
import { ChopRegionOverlay } from './ChopRegionOverlay';
import { type VideoViewHandle } from './VideoView';
import { VideoPreview } from './VideoPreview';
import { latheStatus } from './latheStatus';
import { confirmInWindow } from './dialogs';
import { RegionLoopWatcher } from './chopAudition';
import { useChopRegions } from './useChopRegions';
import {
  ChopRegion, regionFileStem, resizeEdge, moveRegion,
  nextRegionId, nextRegionColor, MIN_REGION_SEC,
  createDragRegion, setRegionBounds, edgeSnapExempt,
  stampedClipName,
} from './chopRegions';
import { startOverlayDrag, endOverlayDrag } from './internalDragHandoff';
import { cropCanvasFractionToDataUrl, videoFrameToChipDataUrl, peaksToChipDataUrl } from './dragChipPng';
import type { ChopSeed } from './chopWindow';

interface IpcWaveformData {
  success: boolean;
  duration_sec: number;
  points: [number, number, number][]; // [min, max, rms] per bin (signed)
}

let _seq = 0;
const uid = () => `chop${++_seq}_${Math.random().toString(36).slice(2)}`;

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${m}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

// Collapse ONLY the binary-resolution failures from the Rust resolver to
// the plain copy. find_tool_binary emits "latch.exe not found …" / "latch:
// configured path does not exist …" — both name the binary. Everything else
// (yt-dlp / ffmpeg runtime errors, which can themselves contain "no such
// file", "not found", etc.) is shown verbatim, so a real download/extract
// failure is never mislabeled as a missing binary.
const cleanError = (m: string): string =>
  /\blatch(\.exe)?\b[\s\S]*?(not found|does not exist)/i.test(m) ? 'latch.exe not found' : m;

// Height cap for the preview download. Audio is still bestaudio, so audio
// quality is unaffected — only the picture res is capped. This file is what the
// chop window previews/plays, and it STAYS the preview source (we no longer swap
// to the full-res HD file — that stuttered, since real-time full-res decode
// can't sustain 1x). 720p is crisp enough for the pane and still cheap to
// decode; the full-res HD download is used only for video clip export.
const PREVIEW_MAX_HEIGHT = 720;

type Phase = 'idle' | 'downloading' | 'extracting-audio' | 'ready' | 'error';

interface LatchEvent { type: string; [k: string]: any }

interface ChopChapter { title: string; startSec: number; endSec: number }

// Region nudge steps (arrow keys). Plain = fine, Shift = coarse.
const NUDGE_FINE_SEC   = 0.01;
const NUDGE_COARSE_SEC = 0.1;

export default function ChopApp() {
  const { theme } = useTheme();
  const bg = THEME_BG[theme];
  const playState = usePlaybackState();
  const playingPath = usePlaybackCurrentPath();

  const [seed, setSeed] = useState<ChopSeed | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [audioPath, setAudioPath] = useState<string | null>(null); // drives waveform/audition + audio clips
  const [videoPath, setVideoPath] = useState<string | null>(null); // low-res preview (null until fetched)
  const [videoFetching, setVideoFetching] = useState(false);       // initial preview fetch in flight
  const [hdVideoPath, setHdVideoPath] = useState<string | null>(null); // full-res, for video clip export
  const [hdLoading, setHdLoading] = useState(false);               // background HD download in flight
  const [durationSec, setDurationSec] = useState(0);
  // Zero-cross snap toggle (magnet). Default ON; persisted per app. A ref mirror
  // keeps the release snap reading the live value.
  const [zeroCrossSnap, setZeroCrossSnapState] = useState<boolean>(() => {
    try { return window.localStorage.getItem('latch-chop-zero-cross-snap') !== '0'; } catch { return true; }
  });
  const zeroCrossSnapRef = useRef(zeroCrossSnap); zeroCrossSnapRef.current = zeroCrossSnap;
  const setZeroCrossSnap = useCallback((on: boolean) => {
    setZeroCrossSnapState(on);
    try { window.localStorage.setItem('latch-chop-zero-cross-snap', on ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  // Channel Split: draw stereo files as two half-height lanes (L top / R
  // bottom). Persisted; default off. Mono files ignore it (single lane).
  const [channelSplit, setChannelSplitState] = useState<boolean>(() => {
    try { return window.localStorage.getItem('latch-chop-channel-split') === '1'; } catch { return false; }
  });
  const setChannelSplit = useCallback((on: boolean) => {
    setChannelSplitState(on);
    try { window.localStorage.setItem('latch-chop-channel-split', on ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [videoPlaying, setVideoPlaying] = useState(false); // mirrors VideoView play state
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(true);
  const [videoAspect] = useState(16 / 9);
  const [videoPaneH, setVideoPaneH] = useState(0);
  // Manual splitter override for the video/waveform split (null = auto-fit).
  // Set by dragging the row-resize handle; reset to null on any structural
  // change (video shown/hidden, aspect) by the fit effect.
  const [userVideoPaneH, setUserVideoPaneH] = useState<number | null>(null);
  const [cursorSec, setCursorSec] = useState(0);       // click position → playhead when audio isn't playing
  // Speed→pitch mode for exports, PER chop session (reset when a new video
  // loads). 'tape' lets pitch follow speed (asetrate varispeed, like a tape
  // machine); 'preserve' keeps the original pitch (atempo). Defaults to
  // 'tape' — when sampling, people expect the pitch to move with speed. The
  // first speed!=1 export still confirms once via a windowed dialog; the
  // in-window chip flips it thereafter (and pre-empts the dialog). No
  // cross-session persistence.
  const [pitchMode, setPitchMode] = useState<'tape' | 'preserve'>('tape');
  const pitchModeRef = useRef<'tape' | 'preserve'>('tape'); pitchModeRef.current = pitchMode;
  const pitchAskedRef = useRef(false);
  const [videoSpeed, setVideoSpeed] = useState(1); // mirrors VideoView speed → gates the pitch chip
  const videoRef = useRef<VideoViewHandle>(null);
  // Carried across the low-res → HD preview swap so the reload keeps the
  // playhead (and resumes if it was playing) instead of jumping to 0.
  const pendingSeekRef = useRef<number | null>(null);
  const pendingPlayRef = useRef(false);
  // The waveform's wrapper (to snapshot its canvas for the drag chip) and
  // the live viewport from the overlay render-prop (to crop the chip to
  // just the dragged region's slice).
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<{ tStart: number; tEnd: number } | null>(null);

  const {
    regions, selectedId, setRegions, select, createDefault, remove,
    setLabel, setStaged, setExportVideo, setClip,
  } = useChopRegions();
  // Fresh-regions ref so handlers fired from a gesture's pointerup (stale
  // closure) still see a just-drawn region.
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Chapter list from the source (yt-dlp via latch probe) — offered as a
  // one-click region seed when the user hasn't drawn anything yet.
  const [chapters, setChapters] = useState<ChopChapter[]>([]);
  const [showChapters, setShowChapters] = useState(false);
  // Keyboard I/O region authoring: I arms, O completes (via onLoopPoints).
  // The armed in-point mirrors into state so the waveform draws a marker
  // (visual feedback that a region is half-formed).
  const ioKeyInRef = useRef<number | null>(null);
  const [ioKeyIn, setIoKeyIn] = useState<number | null>(null);
  const onLoopPointsRef = useRef<((i: number | null, o: number | null) => void) | null>(null);

  // ---- Undo / redo ---------------------------------------------------------
  // Snapshots of (regions, selection) taken BEFORE each discrete mutation:
  // gesture starts, dbl-click creates, deletes, nudge bursts, label-edit
  // focus, chapter seeding. Staged/export-video toggles are export prefs,
  // not edits, and stay out of the stack on purpose.
  const historyRef  = useRef<{ regions: ChopRegion[]; selectedId: string | null }[]>([]);
  const redoRef     = useRef<{ regions: ChopRegion[]; selectedId: string | null }[]>([]);
  const lastPushRef = useRef<{ tag: string; at: number }>({ tag: '', at: 0 });
  const pushHistory = useCallback((tag = '', coalesceMs = 0) => {
    const now = performance.now();
    if (coalesceMs > 0 && tag && lastPushRef.current.tag === tag &&
        now - lastPushRef.current.at < coalesceMs) {
      lastPushRef.current.at = now;
      return;
    }
    lastPushRef.current = { tag, at: now };
    historyRef.current.push({ regions: regionsRef.current, selectedId: selectedIdRef.current });
    if (historyRef.current.length > 100) historyRef.current.shift();
    redoRef.current = [];
  }, []);
  const applySnapshot = useCallback((snap: { regions: ChopRegion[]; selectedId: string | null }) => {
    setRegions(snap.regions);
    const selOk = snap.selectedId && snap.regions.some((r) => r.id === snap.selectedId);
    select(selOk ? snap.selectedId : null);
    setAuditionId(null);
    lastPushRef.current = { tag: '', at: 0 };
  }, [setRegions, select]);
  const undo = useCallback(() => {
    const snap = historyRef.current.pop();
    if (!snap) return;
    redoRef.current.push({ regions: regionsRef.current, selectedId: selectedIdRef.current });
    applySnapshot(snap);
  }, [applySnapshot]);
  const redo = useCallback(() => {
    const snap = redoRef.current.pop();
    if (!snap) return;
    historyRef.current.push({ regions: regionsRef.current, selectedId: selectedIdRef.current });
    applySnapshot(snap);
  }, [applySnapshot]);

  const tempDirRef = useRef<string | null>(null);
  // Duration captured from the download's own `info` event — covers the case
  // where the Chop button was clicked before the Latch probe resolved (so the
  // seed had no duration). Used as the companion-WAV endSec fallback.
  const infoDurationRef = useRef(0);
  // Persistent default render folder (Documents/WAVdesk/Latch Clips),
  // resolved once. Drag-out clips land here so DAW references survive.
  const clipsDirRef = useRef<string | null>(null);
  // Resolved once per pipeline run (seed value, else settings) so the
  // download never fires with an empty path due to a stale seed.
  const binaryPathRef = useRef('');
  const hasVideo = videoPath !== null;                 // preview exists (low-res ok)
  const hasVideoRef = useRef(hasVideo); hasVideoRef.current = hasVideo;
  const canExportVideo = hdVideoPath !== null;          // full-res ready → video export allowed
  const windowLabel = useMemo(() => getCurrentWindow().label, []);
  // Base name for exported clips — the media title from the seed.
  const sourceStem = useMemo(() => (seed?.title || '').trim(), [seed]);

  // The waveform derives its time axis from audioFile.durationSec — feed
  // it the duration we already resolved.
  const waveAudioFile = useMemo<WaveAudioFile | null>(
    () => (audioPath ? { path: audioPath, durationSec } : null),
    [audioPath, durationSec],
  );

  // ---- Latch job plumbing -------------------------------------------------
  // One latch-event listener routes by jobId to the registered handler, so
  // the download, companion-WAV extraction, and per-region clip renders can
  // all be in flight at once.
  const jobHandlers = useRef<Map<string, (ev: LatchEvent) => void>>(new Map());
  const activeJobs = useRef<Set<string>>(new Set());

  useEffect(() => {
    const un = listen<{ jobId: string; event: LatchEvent }>('latch-event', (e) => {
      const { jobId, event } = e.payload;
      jobHandlers.current.get(jobId)?.(event);
    });
    return () => { void un.then((u) => u()).catch(() => {}); };
  }, []);

  // Run `latch_extract` to a temp dir; resolves with the landed file path.
  // `videoMaxHeight` caps the video resolution (0 = best) for a fast low-res
  // grab — audio is bestaudio regardless.
  const runExtract = useCallback((url: string, outputDir: string, video: boolean, videoMaxHeight = 0): Promise<string> => {
    return new Promise((resolve, reject) => {
      const jobId = uid();
      activeJobs.current.add(jobId);
      const done = (fn: () => void) => { jobHandlers.current.delete(jobId); activeJobs.current.delete(jobId); fn(); };
      jobHandlers.current.set(jobId, (ev) => {
        if (ev.type === 'progress') setProgress(Math.round(ev.percent ?? 0));
        else if (ev.type === 'info') {
          // Title/duration straight from the download — gives parity even
          // when Chop was clicked before the Latch probe resolved (seed had
          // no title/duration). Title feeds clip naming + the header.
          const t = typeof ev.title === 'string' ? ev.title.trim() : '';
          const d = Number(ev.duration_s) || 0;
          if (d > 0) { infoDurationRef.current = d; setDurationSec((cur) => (cur > 0 ? cur : d)); }
          if (t) setSeed((prev) => (prev ? { ...prev, title: t } : prev));
        }
        else if (ev.type === 'done') done(() => resolve(String(ev.output)));
        else if (ev.type === 'error') done(() => reject(new Error(ev.message || 'download failed')));
        else if (ev.type === 'cancelled') done(() => reject(new Error('cancelled')));
        else if (ev.type === 'exit' && jobHandlers.current.has(jobId)) {
          done(() => reject(new Error(`download exited (code ${ev.code})`)));
        }
      });
      invoke('latch_extract', {
        windowLabel, jobId, binaryPath: binaryPathRef.current, url, outputDir,
        options: {
          audioFormat: video ? '' : 'wav',
          noPlaylist: true,
          audioQuality: '',
          embedMetadata: false,
          embedThumbnail: false,
          writeThumbnail: false,
          cropThumbnail: false,
          cookiesFromBrowser: seed?.cookiesFromBrowser ?? '',
          section: '',
          video,
          videoFormat: video ? 'mp4' : '',
          videoMaxHeight: video ? videoMaxHeight : 0,
          // Temp downloads are internal; ASCII names keep the reported path
          // matching disk so it reopens for the companion WAV / clips.
          restrictFilenames: true,
        },
      }).catch((err) => done(() => reject(err)));
    });
  }, [windowLabel, seed]);

  // Run `latch_clip`; resolves with the (possibly de-duped) output path.
  // `onProgress` is optional — the companion-WAV extraction passes it so the
  // (often long) full-audio decode drives the loading bar; clip exports omit
  // it so they don't disturb it.
  const runClip = useCallback((args: {
    input: string; output: string; startSec: number; endSec: number;
    video: boolean; overwrite: boolean; preview?: boolean; speed?: number; pitchMode?: string; onProgress?: (pct: number) => void;
  }): Promise<string> => {
    return new Promise((resolve, reject) => {
      const jobId = uid();
      activeJobs.current.add(jobId);
      const done = (fn: () => void) => { jobHandlers.current.delete(jobId); activeJobs.current.delete(jobId); fn(); };
      jobHandlers.current.set(jobId, (ev) => {
        if (ev.type === 'progress') args.onProgress?.(Math.round(ev.percent ?? 0));
        else if (ev.type === 'done') done(() => resolve(String(ev.output)));
        else if (ev.type === 'error') done(() => reject(new Error(ev.message || 'clip failed')));
        else if (ev.type === 'cancelled') done(() => reject(new Error('cancelled')));
        else if (ev.type === 'exit' && jobHandlers.current.has(jobId)) {
          done(() => reject(new Error(`clip exited (code ${ev.code})`)));
        }
      });
      invoke('latch_clip', {
        windowLabel, jobId, binaryPath: binaryPathRef.current,
        input: args.input, output: args.output,
        startSec: args.startSec, endSec: args.endSec,
        video: args.video, audioFormat: 'wav', overwrite: args.overwrite, preview: args.preview ?? false,
        speed: args.speed ?? 1, pitchMode: args.pitchMode ?? 'preserve',
      }).catch((err) => done(() => reject(err)));
    });
  }, [windowLabel]);

  // Standalone: empty means "let the Rust resolver walk env → dev →
  // installed locations" — the seed value is only an explicit override.
  const resolveLatchPath = useCallback(async (s: ChopSeed): Promise<string> => {
    return s.latchPath?.trim() ?? '';
  }, []);

  const extractCompanionWav = useCallback(async (video: string, dir: string, dur?: number): Promise<string> => {
    setProgress(0);
    const end = (dur && dur > 0) ? dur : (infoDurationRef.current || 24 * 3600);
    const wavOut = `${dir}${dir.includes('\\') ? '\\' : '/'}__chop_audio.wav`;
    // Display-only: a tiny mono low-rate WAV just to draw the waveform. Clips
    // are cut from the video file (full quality), never from this.
    // Retry with backoff: a just-downloaded file can be momentarily
    // unreadable on Windows (AV scan / flush), which ffmpeg reports as
    // "No such file or directory". Idempotent (overwrite), so retrying is safe.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
      try {
        return await runClip({ input: video, output: wavOut, startSec: 0, endSec: end, video: false, overwrite: true, preview: true, onProgress: (p) => setProgress(p) });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }, [runClip]);

  // Pull the full-res video in the background (after the low-res preview is
  // already up). Sets hdVideoPath, which gates video clip export — so users
  // can chop audio immediately and only export video once HD has landed.
  const loadHd = useCallback(async (url: string, dir: string) => {
    setHdLoading(true);
    try {
      // Separate subdir so the HD file doesn't collide with the low-res one
      // (same title → yt-dlp would skip or clobber in a shared dir).
      const hdDir = `${dir}${dir.includes('\\') ? '\\' : '/'}hd`;
      const hd = await runExtract(url, hdDir, true, 0); // best video, no cap
      setHdVideoPath(hd);
      // Deliberately do NOT swap the preview to the full-res file. Decoding a
      // full-res (often 4K VP9/AV1) source in real time just to downscale it
      // into the small preview pane can't sustain 1x and stutters, for ~no
      // visible gain at this size. The preview stays the cheap 720p low-res
      // file; the HD file is used only for full-quality video clip export.
    } catch { /* leave video export gated; audio is unaffected */ }
    finally { setHdLoading(false); }
  }, [runExtract]);

  // ---- Download pipeline --------------------------------------------------
  const startPipeline = useCallback(async (s: ChopSeed) => {
    setPhase('downloading'); setProgress(0); setErrorMsg('');
    setAudioPath(null); setVideoPath(null); setVideoFetching(false);
    setHdVideoPath(null); setHdLoading(false); infoDurationRef.current = 0;
    setDurationSec(0); setRegions([]); select(null); setAuditionId(null); setExportMsg('');
    setChapters([]); historyRef.current = []; redoRef.current = [];
    lastPushRef.current = { tag: '', at: 0 };
    // Fresh pitch-mode session for the new clip — back to the 'tape'
    // default, ask again on its first speed-changed export.
    setPitchMode('tape'); pitchModeRef.current = 'tape'; pitchAskedRef.current = false;
    setVideoSpeed(1);
    try { playbackEngine.stop(); } catch { /* ignore */ }

    // Wipe the PREVIOUS session's temp downloads before allocating a fresh
    // dir. Re-seeding this window (loading a different clip) or a Retry would
    // otherwise orphan the old preview/HD downloads in %TEMP% until the window
    // finally closes — they pile up across a long chopping session.
    if (tempDirRef.current) {
      const stale = tempDirRef.current;
      tempDirRef.current = null;
      void invoke('latch_chop_cleanup_dir', { dir: stale }).catch(() => {});
    }

    let dir: string;
    try {
      dir = await invoke<string>('latch_chop_alloc_dir', { windowLabel });
      tempDirRef.current = dir;
    } catch (e) {
      setPhase('error'); setErrorMsg(`Could not allocate a temp dir: ${String(e)}`);
      return;
    }

    binaryPathRef.current = await resolveLatchPath(s);

    // Chapter probe in parallel with the download — feeds the one-click
    // "seed regions from chapters" affordance. Best-effort: failures and
    // old wrappers just leave the list empty.
    void (async () => {
      try {
        const res = await invoke<{ chapters?: { title?: string; start_time?: number; end_time?: number }[] }>(
          'latch_probe', {
            binaryPath: binaryPathRef.current,
            url: s.url,
            cookiesFromBrowser: s.cookiesFromBrowser ?? '',
          });
        const list = (res?.chapters ?? [])
          .map((c) => ({
            // yt-dlp synthesizes "<Untitled Chapter N>" gap fillers — blank
            // those labels so the rail falls back to its clip-NN placeholder.
            title: /^<untitled chapter \d+>$/i.test(c.title ?? '') ? '' : (c.title ?? ''),
            startSec: Number(c.start_time),
            endSec: Number(c.end_time),
          }))
          .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) &&
                         c.endSec - c.startSec >= MIN_REGION_SEC);
        setChapters(list);
      } catch { /* no chapters */ }
    })();

    try {
      let audio: string;
      if (s.includeVideo) {
        // Low-res video first: fast to download, gets the preview + waveform
        // up quickly. Its bestaudio is full quality, so audio clips are too.
        const video = await runExtract(s.url, dir, true, PREVIEW_MAX_HEIGHT);
        setVideoPath(video);
        setPhase('extracting-audio');
        audio = await extractCompanionWav(video, dir, s.durationSec);
      } else {
        audio = await runExtract(s.url, dir, false);
      }
      setAudioPath(audio);

      // Authoritative duration from the actual file (peaks are cached).
      try {
        const meta = await invoke<IpcWaveformData>('generate_waveform', { path: audio, points: 32 });
        if (meta?.success && meta.duration_sec > 0) setDurationSec(meta.duration_sec);
        else if (s.durationSec) setDurationSec(s.durationSec);
      } catch { if (s.durationSec) setDurationSec(s.durationSec); }

      setPhase('ready');
      // Now fetch the full-res video in the background for video export.
      if (s.includeVideo) void loadHd(s.url, dir);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setPhase('error');
      setErrorMsg(msg === 'cancelled' ? 'Cancelled.' : cleanError(msg));
    }
  }, [windowLabel, runExtract, extractCompanionWav, resolveLatchPath, setRegions, select, loadHd]);

  // Fetch video on demand (in-window toggle, audio→video first flip). The
  // audio WAV already drives the waveform; we just add the video file for
  // preview + video-clip export.
  const fetchVideo = useCallback(async () => {
    if (!seed || videoFetching || videoPath || !tempDirRef.current) return;
    if (!binaryPathRef.current) { setExportMsg('latch.exe not found'); return; }
    setVideoFetching(true); setExportMsg('Fetching video…');
    const dir = tempDirRef.current;
    try {
      // Low-res preview first (fast); HD follows in the background for export.
      const low = await runExtract(seed.url, dir, true, PREVIEW_MAX_HEIGHT);
      // VideoView becomes the player for video links — silence the WAV audition.
      try { playbackEngine.stop(); } catch { /* ignore */ }
      setAuditionId(null);
      setVideoPath(low);
      setShowVideo(true);
      setExportMsg('');
      void loadHd(seed.url, dir);
    } catch (e: any) {
      setExportMsg(`Video fetch failed: ${cleanError(String(e?.message ?? e))}`);
    } finally {
      setVideoFetching(false);
    }
  }, [seed, videoFetching, videoPath, runExtract, loadHd]);

  const onToggleVideo = useCallback(() => {
    if (videoFetching) return;
    if (videoPath) setShowVideo((v) => !v);
    else void fetchVideo();
  }, [videoFetching, videoPath, fetchVideo]);

  // ---- Seed handshake -----------------------------------------------------
  // Run ONCE. startPipeline's identity changes whenever `seed` changes (via
  // runExtract); if this effect depended on it, setSeed would tear down and
  // re-emit the ready handshake mid-download. A ref keeps the listener stable
  // while still calling the latest startPipeline.
  const startPipelineRef = useRef(startPipeline);
  startPipelineRef.current = startPipeline;
  useEffect(() => {
    const un = listen<ChopSeed>('wd-latch-chop-seed', (e) => {
      const s = e.payload;
      for (const id of activeJobs.current) void invoke('latch_cancel', { jobId: id }).catch(() => {});
      activeJobs.current.clear();
      jobHandlers.current.clear();
      setSeed(s);
      void startPipelineRef.current(s);
    });
    void emit('wd-latch-chop-ready', {});
    return () => { void un.then((u) => u()).catch(() => {}); };
  }, []);

  // Resolve lathe once at boot — the video preview (frame server + the
  // peaks scrubber) reads latheStatus synchronously. Missing lathe
  // degrades gracefully (VideoPreview shows its notice; audio chop is
  // unaffected).
  useEffect(() => {
    void latheStatus.refresh('');
  }, []);

  // Reveal after first paint (created hidden → no white flash). Also pin a
  // usable minimum size so the dynamic fit + user resize can't shrink the UI
  // into uselessness.
  useEffect(() => {
    void getCurrentWindow().setMinSize(new LogicalSize(560, 440)).catch(() => {});
    const id = requestAnimationFrame(() => {
      void (async () => {
        try { await getCurrentWindow().show(); } catch { /* ignore */ }
        // Register the chop window as a real taskbar + alt-tab window (it's a
        // full editor, not a transient popup). See register_taskbar_window.
        try { await invoke('register_taskbar_window', { label: getCurrentWindow().label }); } catch { /* ignore */ }
      })();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Title sync.
  useEffect(() => {
    const t = seed?.title ? baseName(seed.title) : (seed?.url ?? '');
    getCurrentWindow().setTitle(`LATCH: CHOP${t ? ` · ${t}` : ''}`).catch(() => {});
  }, [seed]);

  // Fit the window height dynamically: with the video preview shown, size
  // its pane to the video's aspect ratio (no letterbox deadspace) and give
  // the waveform a shorter slot; audio-only collapses to a compact height.
  // Width is preserved (read from the content), and the effect only fires
  // on show/hide/aspect — never on a width resize — so there's no loop.
  useEffect(() => {
    if (phase !== 'ready') return;
    // A structural change (video shown/hidden, aspect) returns the split to
    // auto — the user's manual splitter height only holds until the next one.
    // userVideoPaneH is deliberately NOT a dep, so a splitter drag doesn't
    // re-run this and snap the window back.
    setUserVideoPaneH(null);
    const W = Math.max(360, Math.round(window.innerWidth));
    const showV = hasVideo && showVideo;
    const paneH = showV ? Math.round(W / Math.max(0.1, videoAspect)) : 0;
    setVideoPaneH(paneH);
    const TITLE = 26, BOTTOM = 31, RAIL = 92, HINT = 14;
    const waveH = showV ? 150 : 300;
    const total = TITLE + paneH + waveH + RAIL + HINT + BOTTOM;
    void getCurrentWindow().setSize(new LogicalSize(W, total)).catch(() => {});
  }, [hasVideo, showVideo, videoAspect, phase]);

  // Cancel jobs + wipe temp on close (Rust destroy listener is the backstop).
  useEffect(() => {
    const w = getCurrentWindow();
    const unP = w.onCloseRequested(() => {
      for (const id of activeJobs.current) void invoke('latch_cancel', { jobId: id }).catch(() => {});
      if (tempDirRef.current) void invoke('latch_chop_cleanup_dir', { dir: tempDirRef.current }).catch(() => {});
    });
    return () => { void unP.then((u) => u()).catch(() => {}); };
  }, []);

  // Pause on defocus: stepping out to a DAW / another window shouldn't leave
  // this window playing under it. onFocusChanged (the OS-level window focus)
  // is used deliberately, NOT DOM blur — blur fires spuriously when a child
  // window or an in-window input takes focus.
  useEffect(() => {
    const w = getCurrentWindow();
    const unF = w.onFocusChanged(({ payload: focused }) => {
      if (focused) return;
      if (hasVideoRef.current) videoRef.current?.pause();
      else playbackEngine.pause();
    });
    return () => { void unF.then((u) => u()).catch(() => {}); };
  }, []);

  // ---- Transport / audition ----------------------------------------------
  const isPlaying = playState === 'playing';
  const onOurFile = playingPath === audioPath;
  // Ref mirrors so stable callbacks (onActivate) can branch on live
  // playback state without being re-created on every play/pause.
  const isPlayingRef = useRef(false); isPlayingRef.current = isPlaying;
  const onOurFileRef = useRef(false); onOurFileRef.current = onOurFile;
  const playStateRef = useRef(playState); playStateRef.current = playState;
  const videoPlayingRef = useRef(false); videoPlayingRef.current = videoPlaying;
  const auditionIdRef = useRef(auditionId); auditionIdRef.current = auditionId;

  const playWhole = useCallback(() => {
    if (!audioPath) return;
    setAuditionId(null);
    void playbackEngine.play(audioPath, 'full', { startSec: cursorSec });
  }, [audioPath, cursorSec]);

  const playRegion = useCallback((r: ChopRegion) => {
    if (!audioPath) return;
    setAuditionId(r.id);
    void playbackEngine.play(audioPath, 'full', { startSec: r.startSec });
    // Cmd::Play resets the Rust loop; re-arm explicitly (channel order
    // guarantees play-then-arm). The watcher's arm effect only fires on a
    // BOUNDS change, so a same-region retrigger (Space stop → Space, which
    // now keeps the region armed) would otherwise play through the out.
    playbackEngine.setLoop(r.startSec, r.endSec);
  }, [audioPath]);

  // Folded play: an ARMED selected region auditions THAT region (looped);
  // otherwise the whole file. Pause/resume when our file is already going.
  // Video links route to VideoView unconditionally — the WAV engine must
  // never start under a video session (that pairing was the "two audio
  // sources with no way to kill them" field bug: retrigger's no-region
  // fallback landed here with hasVideo true and played the companion WAV
  // alongside the video audio).
  const playPause = useCallback(() => {
    if (!audioPath) return;
    if (hasVideoRef.current) { videoRef.current?.togglePlay(); return; }
    if (isPlaying && onOurFile) { playbackEngine.pause(); return; }
    if (playState === 'paused' && onOurFile) { void playbackEngine.resume(); return; }
    const sel = selectedId && auditionId === selectedId
      ? regions.find((r) => r.id === selectedId) ?? null : null;
    if (sel) playRegion(sel); else playWhole();
  }, [audioPath, isPlaying, onOurFile, playState, selectedId, auditionId, regions, playRegion, playWhole]);

  const stopAll = useCallback(() => {
    setAuditionId(null);
    playbackEngine.stop({ fadeMs: 20 });
    if (hasVideo) { videoRef.current?.pause(); videoRef.current?.clearLoop(); }
  }, [hasVideo]);

  // Stop: pause and jump the playhead back to the start of the looping (or
  // selected) region — file start if none. Keeps the region armed so the
  // next Space replays it from the top.
  const stopToLoopStart = useCallback(() => {
    if (!audioPath) return;
    const aid = auditionId ?? selectedId;
    const r = aid ? regionsRef.current.find((x) => x.id === aid) ?? null : null;
    const target = r ? r.startSec : 0;
    setCursorSec(target);
    if (hasVideo) {
      videoRef.current?.pause();
      videoRef.current?.seek(target, true); // freeze the last frame across the park seek (no flash)
      playbackEngine.stop({ fadeMs: 20 }); // Stop kills EVERY source — no WAV may survive it
    } else if (onOurFileRef.current) {
      playbackEngine.pause();
      playbackEngine.seek(target);
    }
  }, [audioPath, auditionId, selectedId, hasVideo]);

  // Unified play/pause for the in-waveform transport overlay: video links
  // drive VideoView, audio links drive playbackEngine.
  const transportPlaying = hasVideo ? videoPlaying : (isPlaying && onOurFile);
  const toggleTransport = useCallback(() => {
    if (hasVideo) {
      // Belt-and-braces single-source rule: a WAV audition must never
      // underlap the video session.
      if (playStateRef.current === 'playing') playbackEngine.stop({ fadeMs: 20 });
      videoRef.current?.togglePlay();
    } else playPause();
  }, [hasVideo, playPause]);

  // Click OUTSIDE any selection: park the playhead there, un-looped, and
  // deselect — but do NOT auto-play. Space then plays the whole file from
  // here so the user can scout the next cut.
  const onSeek = useCallback((sec: number) => {
    setAuditionId(null);
    select(null);
    setCursorSec(sec);
    if (hasVideo) { videoRef.current?.clearLoop(); videoRef.current?.seek(sec); }
  }, [hasVideo, select]);

  // Click INSIDE a selection (or just drew one): arm it as the active loop
  // and move the playhead to its start. No autoplay — Space starts it.
  const onActivate = useCallback((id: string) => {
    const r = regionsRef.current.find((x) => x.id === id);
    if (!r) return;
    select(id);
    setAuditionId(id);
    setCursorSec(r.startSec);
    if (hasVideo) {
      videoRef.current?.seek(r.startSec, true); // freeze across the arm seek (no wrong-frame flash)
      videoRef.current?.setLoop(r.startSec, r.endSec);
    } else if (onOurFileRef.current && (playStateRef.current === 'playing' || playStateRef.current === 'paused')) {
      // Already auditioning (playing or paused) another region → move the
      // play position to this one now, instead of playing on until the old
      // loop end (which would audition outside the newly-selected region).
      playbackEngine.seek(r.startSec);
    }
  }, [hasVideo, select]);

  // Explicit "play this region looped" — the per-row ▶ button.
  const playRegionLooped = useCallback((r: ChopRegion) => {
    select(r.id);
    setAuditionId(r.id);
    setCursorSec(r.startSec);
    if (hasVideo) {
      // Single-source rule: kill any WAV audition before the video session
      // becomes the transport (a leaked engine play would otherwise run
      // UNDER the video audio with no UI showing it).
      playbackEngine.stop({ fadeMs: 20 });
      videoRef.current?.seek(r.startSec, true); // freeze across the retrigger seek (no flash)
      videoRef.current?.setLoop(r.startSec, r.endSec);
      videoRef.current?.play();
    } else {
      playRegion(r);
    }
  }, [hasVideo, select, playRegion]);

  // Space ALTERNATES retrigger <-> STOP, but ONLY on a region that is both
  // SELECTED and ACTIVE (armed as the audition loop): retrigger from the top
  // if stopped, STOP (not pause) parking the playhead at its start if playing.
  // The region stays selected AND armed through the stop so Space keeps
  // alternating retrigger, stop, retrigger… Anything else — no selection, or
  // a region merely selected in the rail — falls back to the ORIGINAL
  // whole-file play/pause transport (kind-routed: video links drive
  // VideoView, audio links the engine). K stays the plain pause/resume.
  const retriggerSelected = useCallback(() => {
    const selId = selectedIdRef.current;
    const armed = selId != null && auditionIdRef.current === selId;
    const r = armed ? regionsRef.current.find((x) => x.id === selId) ?? null : null;
    if (!r) { playPause(); return; }
    const playing = hasVideoRef.current
      ? videoPlayingRef.current
      : (isPlayingRef.current && onOurFileRef.current);
    if (playing) {
      // STOP: halt EVERY live source (video session AND the WAV engine — the
      // pair must never survive a stop), keep the region selected + armed +
      // loop-cued, and park the playhead at its start so the next Space
      // retriggers cleanly.
      setCursorSec(r.startSec);
      if (hasVideoRef.current) {
        videoRef.current?.pause();
        videoRef.current?.seek(r.startSec, true); // freeze the last frame across the stop-park seek
      }
      playbackEngine.stop({ fadeMs: 20 });
    } else {
      playRegionLooped(r);
    }
  }, [playRegionLooped, playPause]);

  // Delete a region and keep the audition sane. If the deleted region is the
  // one being auditioned, release its loop and SWAP to the next region in
  // order (the previous if it was last) — keeping playback going there if it
  // was playing; arming it (paused) otherwise. If it was the only region,
  // fall back to the no-region state. Deleting any other region leaves the
  // current audition untouched (selection follows along if it was selected).
  const removeAndAdvance = useCallback((id: string) => {
    pushHistory();
    const sorted = [...regionsRef.current].sort((a, b) => a.startSec - b.startSec);
    const i = sorted.findIndex((r) => r.id === id);
    const nextId = i >= 0 ? (sorted[i + 1]?.id ?? sorted[i - 1]?.id ?? null) : null;
    const wasAudition = auditionId === id;
    const wasSelected = selectedId === id;
    remove(id);
    if (wasAudition) {
      if (nextId) onActivate(nextId); // swaps the loop to next (releases the old)
      else stopAll();                 // last region gone → no-region state
    } else if (wasSelected) {
      select(nextId);
    }
  }, [auditionId, selectedId, remove, onActivate, stopAll, select, pushHistory]);

  // ---- Zero-crossing snap ---------------------------------------------------
  // On gesture release, pull each touched region edge to the nearest zero
  // crossing of the audition WAV (±15ms) so exported clips don't click at
  // the cut points. For video links the WAV is the low-rate companion, so
  // the crossing is approximate against the full-rate stream — still the
  // low-frequency crossing, which is what kills the click. No crossing in
  // the window = keep the raw position. Nudges stay raw on purpose
  // (precision work shouldn't fight the snap).
  const zeroCross = useCallback(async (sec: number, duration: number): Promise<number | null> => {
    if (!zeroCrossSnapRef.current) return null;   // snap off → keep the exact drag position
    // File edges stay exactly selectable even with snap on (owner invariant):
    // a bound at / within the window of 0 / EOF resolves to the exact edge.
    const edge = edgeSnapExempt(sec, duration);
    if (edge != null) return edge;
    if (!audioPath) return null;
    try {
      const t = await invoke<number>('wav_nearest_zero_cross', {
        path: audioPath, timeSec: sec, windowMs: 15,
      });
      return Number.isFinite(t) && t >= 0 ? t : null;
    } catch { return null; }
  }, [audioPath]);

  const onGestureEnd = useCallback(async (info: { id: string; kind: 'create' | 'resize' | 'move'; edge?: 'start' | 'end' }) => {
    const r = regionsRef.current.find((x) => x.id === info.id);
    if (!r) return;
    const dur = durationSec;
    if (info.kind === 'resize' && info.edge) {
      const t = await zeroCross(info.edge === 'start' ? r.startSec : r.endSec, dur);
      if (t != null) setRegions(resizeEdge(regionsRef.current, r.id, info.edge, t, dur));
    } else if (info.kind === 'create') {
      const s = await zeroCross(r.startSec, dur);
      if (s != null) setRegions(resizeEdge(regionsRef.current, r.id, 'start', s, dur));
      const cur = regionsRef.current.find((x) => x.id === info.id);
      if (!cur) return;
      const e = await zeroCross(cur.endSec, dur);
      if (e != null) setRegions(resizeEdge(regionsRef.current, r.id, 'end', e, dur));
    } else if (info.kind === 'move') {
      // Shift the whole region so its START lands on a crossing — width
      // (and therefore the end's relation to the start) is preserved.
      const s = await zeroCross(r.startSec, dur);
      if (s != null) setRegions(moveRegion(regionsRef.current, r.id, s, dur));
      // Re-anchor the playhead to the moved region's new start. r is the
      // post-drag (pre-snap) region, so newStart = s ?? r.startSec and the
      // width is unchanged.
      const newStart = s != null ? s : r.startSec;
      const newEnd = newStart + (r.endSec - r.startSec);
      const armedMoved = auditionIdRef.current === info.id;
      const wasPlaying = hasVideo
        ? videoPlayingRef.current
        : (isPlayingRef.current && onOurFileRef.current);
      setCursorSec(newStart);
      if (hasVideo) {
        if (armedMoved) {
          // The looping region moved: pause → snap → re-arm the loop →
          // resume (if it was playing) so the next pass starts cleanly at
          // the new spot instead of finishing the stale loop.
          videoRef.current?.pause();
          videoRef.current?.seek(newStart, true); // freeze across the re-cue seek (no flash)
          videoRef.current?.setLoop(newStart, newEnd);
          if (wasPlaying) videoRef.current?.play();
        } else if (!wasPlaying) {
          videoRef.current?.seek(newStart, true); // not playing → park the frame + playhead
        }
        // playing + moved a different region → leave playback undisturbed
      } else if (onOurFileRef.current && (playStateRef.current === 'playing' || playStateRef.current === 'paused')) {
        if (armedMoved && wasPlaying) {
          playbackEngine.pause();
          playbackEngine.seek(newStart);
          void playbackEngine.resume();
        } else if (!wasPlaying) {
          playbackEngine.seek(newStart); // paused → move the play position + playhead
        }
        // playing + moved a different region → leave playback undisturbed
      }
    }
  }, [durationSec, setRegions, zeroCross, hasVideo]);

  // Chapters are a NAVIGATION index (list popover + waveform ticks), not
  // region authors — seeding 25 regions on click buried the user's own
  // cuts and blew the rail out of the window.

  // Arrow-key seek for audio links (no daemon reverse, so just nudge ±1s).
  const nudge = useCallback((delta: number) => {
    const cap = durationSec > 0 ? durationSec : cursorSec + delta;
    const t = Math.max(0, Math.min(cap, cursorSec + delta));
    setCursorSec(t);
    if (!hasVideo && audioPath && (isPlaying || playState === 'paused') && onOurFile) playbackEngine.seek(t);
  }, [cursorSec, durationSec, hasVideo, audioPath, isPlaying, playState, onOurFile]);

  // Delete the selected region on Backspace/Delete (when not typing a label).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // Undo / redo — region edits only (label inputs keep native text undo
      // via the INPUT early-return above).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault();
        redo();
        return;
      }
      // Delete / Backspace / Alt+X: clear the selected region and swap the
      // loop + playhead to the next region in order (no-region if it was the
      // last). removeAndAdvance owns the release-and-advance behaviour.
      if (((e.key === 'Delete' || e.key === 'Backspace') || (e.altKey && e.code === 'KeyX')) && selectedId) {
        e.preventDefault();
        removeAndAdvance(selectedId);
        return;
      }
      if (phase !== 'ready') return;
      // Region nudge: with a region selected, arrows move it (Shift =
      // coarse 100ms, plain = 10ms; Ctrl = start edge only, Alt = end edge
      // only). Playhead / frame-step arrows still apply with no selection.
      // Bursts coalesce into one undo step.
      if (selectedId && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && tag !== 'SELECT') {
        e.preventDefault();
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        const step = (e.shiftKey ? NUDGE_COARSE_SEC : NUDGE_FINE_SEC) * dir;
        const r = regionsRef.current.find((x) => x.id === selectedId);
        if (!r) return;
        pushHistory('nudge', 800);
        if (e.ctrlKey || e.metaKey) {
          setRegions(resizeEdge(regionsRef.current, r.id, 'start', r.startSec + step, durationSec));
        } else if (e.altKey) {
          setRegions(resizeEdge(regionsRef.current, r.id, 'end', r.endSec + step, durationSec));
        } else {
          setRegions(moveRegion(regionsRef.current, r.id, r.startSec + step, durationSec));
        }
        return;
      }
      // SELECT keeps its own space/arrow handling (opens/changes the dropdown).
      // BUTTON intentionally does NOT: in this window Space is always transport,
      // so a focused chrome button (e.g. the audio/video toggle) must not eat it
      // and re-activate itself. preventDefault below suppresses the button's own
      // Space-click; Enter isn't a transport key, so it still activates buttons.
      if (tag === 'SELECT') return;
      // I/O: mark in/out points that author a region — parity with the
      // video player's IN/OUT buttons (whose keys are disabled here via
      // disableKeyboard). I arms the in point; O completes through the
      // same adoption-aware path the buttons use.
      if (e.code === 'KeyI' || e.code === 'KeyO') {
        e.preventDefault();
        const t = hasVideo
          ? (videoRef.current?.getCurrentTime() ?? 0)
          : (onOurFileRef.current ? playbackEngine.getPosition() : cursorSec);
        if (e.code === 'KeyI') {
          ioKeyInRef.current = t;
          setIoKeyIn(t);
          setExportMsg(`In point set: ${fmtTime(t)} — press O to make the region`);
        } else if (ioKeyInRef.current != null) {
          onLoopPointsRef.current?.(ioKeyInRef.current, t);
          ioKeyInRef.current = null;
          setIoKeyIn(null);
          setExportMsg('');
        } else {
          setExportMsg('Press I first to set the in point');
        }
        return;
      }
      // Window-level transport so space/J/K/L work anywhere in the window,
      // not just over the video (no dead zones). Video links drive VideoView
      // (which has true J/K/L shuttle); audio links drive playbackEngine.
      if (hasVideo) {
        const v = videoRef.current;
        switch (e.code) {
          case 'Space': e.preventDefault(); retriggerSelected(); break;
          case 'KeyK': e.preventDefault(); v?.togglePlay(); break;
          case 'KeyJ': e.preventDefault(); v?.shuttle(-1); break;
          case 'KeyL': e.preventDefault(); v?.shuttle(1); break;
          case 'ArrowLeft': e.preventDefault(); v?.stepFrame(-1); break;
          case 'ArrowRight': e.preventDefault(); v?.stepFrame(1); break;
        }
      } else {
        switch (e.code) {
          case 'Space': e.preventDefault(); retriggerSelected(); break;
          case 'KeyK': e.preventDefault(); playPause(); break;
          case 'ArrowLeft': e.preventDefault(); nudge(-1); break;
          case 'ArrowRight': e.preventDefault(); nudge(1); break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, phase, hasVideo, playPause, retriggerSelected, nudge, removeAndAdvance,
      undo, redo, pushHistory, setRegions, durationSec, cursorSec]);

  const auditionRegion = auditionId ? regions.find((r) => r.id === auditionId) ?? null : null;

  // Single update path for a LIVE edit of the ARMED region (resize / move /
  // nudge while it's auditioning): keep the active stream's loop bounds in
  // sync AND clamp the playhead into the new span if the edit stranded it
  // outside. Without the clamp the OLD loop appears to keep playing — the
  // audio drifts past the new out-point, or the picture freezes on the stale
  // seam until the clock re-enters the region. Both streams update off the
  // ONE bounds-change here so audio and video never diverge. videoPath is a
  // dep too: the low-res → HD swap REMOUNTS VideoView (fresh engine, no loop
  // armed), so the bounds must re-fire after the swap.
  useEffect(() => {
    if (!auditionRegion) return;
    // During a live drag, onLiveBounds owns the bounds (video → setLoopBounds
    // + present() live wrap; audio → st.looping read live by the Rust tick);
    // re-arming/clamping here per bounds-change is the churn. The drop wrapper
    // re-arms the gapless video loop once when draggingRef clears — this stays
    // the settled-state path (activation, nudge, the HD-swap remount).
    if (draggingRef.current) return;
    const s = auditionRegion.startSec;
    const e = auditionRegion.endSec;
    const EPS = 0.01;
    if (hasVideo) {
      videoRef.current?.setLoop(s, e);
      const t = videoRef.current?.getCurrentTime() ?? s;
      if (t < s - EPS || t > e + EPS) { videoRef.current?.seek(s, true); setCursorSec(s); }
    } else if (onOurFileRef.current) {
      // The audio wrap itself stays owned by RegionLoopWatcher; here we only
      // rescue a playhead the edit pushed out of the (possibly shrunk) span.
      const t = playbackEngine.getPosition();
      if (t < s - EPS || t > e + EPS) { playbackEngine.seek(s); setCursorSec(s); }
    }
  }, [hasVideo, videoPath, auditionRegion?.startSec, auditionRegion?.endSec]);

  // Imperative live-loop channel (item 7): the overlay fires onLiveBounds on
  // every gesture tick. We re-arm the active stream's loop DIRECTLY — ungated
  // by auditionId (arm-on-grab: the region under the drag becomes the live
  // loop for the gesture's duration) and coalesced to ONE authoritative
  // re-arm per frame so a fast drag can't thrash the decoder. The React
  // settle effect above stays as the on-drop backstop.
  const liveLoopRaf = useRef(0);
  const liveLoopPending = useRef<{ s: number; e: number; armed: boolean } | null>(null);
  // True between a gesture's start and end. Gates the settle effect's re-arm
  // so it fires ONCE on drop, not per bounds-change mid-drag (that per-move
  // re-arm was the "freakout"). Live tracking is owned by onLiveBounds below.
  const draggingRef = useRef(false);
  const onLiveBounds = useCallback((_id: string, s: number, e: number) => {
    // VIDEO: arm-on-grab — dragging ANY region's walls makes it the ball's
    // cage for the gesture (round-6 contract; the ball adopts the new cage at
    // the next wall touch); the drop path restores the armed region's loop
    // when a non-armed region was dragged.
    // AUDIO: gated to the ARMED region — retargeting the Rust loop to a
    // different region's bounds mid-gesture would corrupt the loop currently
    // auditioning.
    const armed = auditionIdRef.current === _id;
    liveLoopPending.current = { s, e, armed };
    if (liveLoopRaf.current) return;
    liveLoopRaf.current = requestAnimationFrame(() => {
      liveLoopRaf.current = 0;
      const p = liveLoopPending.current;
      if (!p || !(p.e > p.s)) return;
      if (hasVideoRef.current) {
        // Video: refresh the engine's LIVE loop bounds — present() bounces the
        // clock at these moving walls. NO decoder re-arm (the freakout);
        // setLoop re-arms the gapless loop once on release.
        videoRef.current?.setLoopBounds(p.s, p.e);
      } else if (p.armed && onOurFileRef.current) {
        // Audio: the Rust loop check reads st.looping live every ~4ms and owns
        // the wrap + strand-clamp; just keep the target fresh (cheap — no seek,
        // no restart). No JS clamp seek fighting the Rust tick.
        playbackEngine.setLoop(p.s, p.e);
      }
    });
  }, []);
  useEffect(() => () => { if (liveLoopRaf.current) cancelAnimationFrame(liveLoopRaf.current); }, []);

  // Mirror the video preview's speed so the Pitch chip appears only when speed
  // != 1 (VideoView owns the speed button; there's no reactive callback, so a
  // light 300ms poll is enough for a chip's visibility).
  useEffect(() => {
    if (phase !== 'ready' || !hasVideo) { setVideoSpeed(1); return; }
    const id = window.setInterval(() => {
      const s = videoRef.current?.getSpeed() ?? 1;
      setVideoSpeed((cur) => (cur !== s ? s : cur));
    }, 300);
    return () => window.clearInterval(id);
  }, [phase, hasVideo]);

  // ---- Export / drag-out --------------------------------------------------
  // `forceVideo` overrides the per-region/default toggle: the drag-out path
  // passes it (false = audio, true = the video grip) so each overlay grip
  // exports its own variant; a rail drag uses the region's toggle.
  const clipInputFor = useCallback((r: ChopRegion, forceVideo?: boolean): { input: string; video: boolean; ext: string } => {
    const wantVideo = forceVideo ?? r.exportVideo ?? false;
    // Video clip only from the full-res copy — until it lands, fall back to
    // audio (gated) so nothing exports the low-res preview.
    if (wantVideo && hdVideoPath != null) {
      return { input: hdVideoPath, video: true, ext: 'mp4' };
    }
    // Audio clip: cut from the low-res preview's bestaudio (full quality) for
    // a video link, else the downloaded audio WAV. NEVER the companion preview
    // WAV (that's the downsampled display-only track = audioPath for video).
    const audioSrc = videoPath != null ? videoPath : (audioPath as string);
    return { input: audioSrc, video: false, ext: 'wav' };
  }, [videoPath, hdVideoPath, audioPath]);

  const stagedRegions = regions.filter((r) => r.staged);

  // Resolve the pitch mode for a speed-changed export. Asks ONCE per session
  // (the first speed!=1 export with no choice yet) via a windowed dialog, then
  // reuses the session choice; the in-window Pitch chip can also set it (which
  // pre-empts the dialog). speed==1 → pitch mode is irrelevant.
  const resolvePitchMode = useCallback(async (): Promise<'tape' | 'preserve'> => {
    const speed = videoRef.current?.getSpeed() ?? 1;
    if (Math.abs(speed - 1) <= 1e-6) return 'preserve';
    if (pitchAskedRef.current) return pitchModeRef.current;
    const tape = await confirmInWindow({
      title: 'Speed change: keep pitch?',
      message: 'This clip exports at a changed speed. Tape mode lets pitch follow speed (a slower clip sounds lower, like tape). Keep original pitch changes only the tempo.',
      confirmLabel: 'Tape mode',
      cancelLabel: 'Keep pitch',
    });
    const mode: 'tape' | 'preserve' = tape ? 'tape' : 'preserve';
    pitchAskedRef.current = true;
    pitchModeRef.current = mode;
    setPitchMode(mode);
    return mode;
  }, []);

  // Resolve (and cache) the persistent clips folder in Documents.
  const ensureClipsDir = useCallback(async (): Promise<string> => {
    if (clipsDirRef.current) return clipsDirRef.current;
    const d = await invoke<string>('latch_clips_dir');
    clipsDirRef.current = d;
    return d;
  }, []);

  const exportStaged = useCallback(async () => {
    if (!audioPath || !stagedRegions.length) return;
    let defaultPath: string | undefined;
    try { defaultPath = await ensureClipsDir(); } catch { /* no default */ }
    const dir = await openDialog({ directory: true, multiple: false, defaultPath });
    if (!dir || typeof dir !== 'string') return;
    setExporting(true); setExportMsg('');
    const pm = await resolvePitchMode();
    const dsep = dir.includes('\\') ? '\\' : '/';
    const sorted = [...stagedRegions].sort((a, b) => a.startSec - b.startSec);
    let ok = 0, fail = 0;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const { input, video, ext } = clipInputFor(r);
      const stem = regionFileStem(r, i, sourceStem);
      const out = `${dir}${dsep}${stem}.${ext}`;
      try {
        const written = await runClip({ input, output: out, startSec: r.startSec, endSec: r.endSec, video, overwrite: false, speed: videoRef.current?.getSpeed() ?? 1, pitchMode: pm });
        void emit('wd-latch-clip-exported', { path: written, title: stem });
        ok++;
      } catch { fail++; }
    }
    setExporting(false);
    setExportMsg(`Exported ${ok} clip${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed` : ''}`);
  }, [audioPath, stagedRegions, clipInputFor, runClip, sourceStem, ensureClipsDir, resolvePitchMode]);

  // Build the drag-out chip image: in video mode, a snapshot of the
  // currently-visible frame; otherwise a crisp mini-waveform rendered
  // from peaks fetched for JUST this region (sharp at any zoom). Falls
  // back to cropping the on-screen canvas.
  const buildDragChip = useCallback(async (r: ChopRegion, wantVideo: boolean): Promise<{ url: string; bg: string | null } | null> => {
    if (wantVideo && videoRef.current) {
      const frame = videoRef.current.captureFrame();
      if (frame) return videoFrameToChipDataUrl(frame);
      // No painted frame → fall through to the waveform chip.
    }
    if (audioPath) {
      try {
        const data = await invoke<IpcWaveformData>('generate_waveform', {
          path: audioPath, points: 240, startSec: r.startSec, endSec: r.endSec,
        });
        if (data?.success && data.points?.length) {
          // generate_waveform now returns [min, max, rms] triplets directly —
          // the exact shape peaksToChipDataUrl wants.
          return peaksToChipDataUrl(data.points, r.color);
        }
      } catch { /* fall back to a canvas crop */ }
    }
    const cv = waveContainerRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
    const vp = vpRef.current;
    if (cv && vp) {
      const span = Math.max(1e-6, vp.tEnd - vp.tStart);
      return cropCanvasFractionToDataUrl(cv, (r.startSec - vp.tStart) / span, (r.endSec - vp.tStart) / span);
    }
    return null;
  }, [audioPath]);

  // Render a region's clip to the persistent clips folder. Backs both
  // the background PRE-render (so a drag can start instantly inside the
  // gesture) and the drag path's render-on-miss. Stamps clipPath only
  // if the region's bounds didn't change mid-render.
  const renderRegionClip = useCallback(async (id: string, forceVideo?: boolean): Promise<string | null> => {
    const r = regionsRef.current.find((x) => x.id === id);
    if (!r || !audioPath || r.clipState === 'rendering') return null;
    // A video render before the full-res file lands would silently fall
    // back to an AUDIO cut (clipInputFor's gate) while the UI says
    // "video" — be honest instead.
    const wantsVideo = forceVideo ?? r.exportVideo ?? false;
    if (wantsVideo && !hdVideoPath) {
      setExportMsg('Full-res video still downloading… try the video export shortly');
      return null;
    }
    const { input, video, ext } = clipInputFor(r, forceVideo);
    const idx = regionsRef.current.findIndex((x) => x.id === id);
    const stem = regionFileStem(r, idx < 0 ? 0 : idx, sourceStem);
    let clipsDir = tempDirRef.current ?? '';
    try { clipsDir = await ensureClipsDir(); } catch { /* temp fallback */ }
    if (!clipsDir) return null;
    const dsep = clipsDir.includes('\\') ? '\\' : '/';
    setClip(id, 'rendering');
    try {
      // Stamped mint name — see beginRegionDragOut; keeps pre-renders
      // collision-proof at any later drop destination too.
      const path = await runClip({
        input, output: `${clipsDir}${dsep}${stampedClipName(stem, ext)}`,
        startSec: r.startSec, endSec: r.endSec, video, overwrite: false,
        speed: videoRef.current?.getSpeed() ?? 1, pitchMode: pitchModeRef.current,
      });
      const cur = regionsRef.current.find((x) => x.id === id);
      const variantIsDefault = (forceVideo ?? (r.exportVideo ?? false)) === (cur?.exportVideo ?? false);
      if (cur && cur.startSec === r.startSec && cur.endSec === r.endSec && variantIsDefault) {
        setClip(id, 'ready', path);
      } else if (cur) {
        setClip(id, 'none'); // bounds/variant moved on — the cache is stale
      }
      return path;
    } catch {
      setClip(id, 'error');
      return null;
    }
  }, [audioPath, hdVideoPath, clipInputFor, runClip, setClip, sourceStem, ensureClipsDir]);

  // Background pre-render, debounced — runs after a region settles so the
  // file EXISTS by drag time. DoDragDrop must start inside the pointer
  // gesture; a multi-second render outlives it (the no-op-drag /
  // stuck-chip failure this replaces).
  const renderTimersRef = useRef<Map<string, number>>(new Map());
  const scheduleClipRender = useCallback((id: string) => {
    const prev = renderTimersRef.current.get(id);
    if (prev) window.clearTimeout(prev);
    renderTimersRef.current.set(id, window.setTimeout(() => {
      renderTimersRef.current.delete(id);
      const r = regionsRef.current.find((x) => x.id === id);
      if (r && r.clipState !== 'ready' && r.clipState !== 'rendering') {
        void renderRegionClip(id);
      }
    }, 700));
  }, [renderRegionClip]);

  // EVERY region keeps a fresh render, one at a time (the completing
  // render flips its clipState, which re-runs this and picks the next
  // 'none'). Bound edits invalidate clipState, re-arming the queue.
  useEffect(() => {
    if (phase !== 'ready') return;
    if (regions.some((r) => r.clipState === 'rendering')) return;
    const next = regions.find((r) => r.clipState === 'none');
    if (next) scheduleClipRender(next.id);
  }, [phase, regions, scheduleClipRender]);

  // Drag a region out as a file: render the clip to temp (if not already)
  // and hand it to the OS drag. VERBATIM port of the working WAVdesk flow
  // (the standalone's cache-gated rework answered every video drag with
  // "drag again" and is gone).
  const beginRegionDragOut = useCallback(async (r: ChopRegion, forceVideo?: boolean) => {
    if (!audioPath || !tempDirRef.current) return;
    // Dragging a clip out shouldn't leave the source playing underneath it.
    if (hasVideoRef.current) videoRef.current?.pause(); else playbackEngine.pause();
    const { input, video, ext } = clipInputFor(r, forceVideo);
    const idx = regionsRef.current.findIndex((x) => x.id === r.id);
    const stem = regionFileStem(r, idx < 0 ? 0 : idx, sourceStem);
    // Mint-time stamp (collision-proof naming): each render gets a fresh
    // stamped name, so a name freed by an earlier shell reclaim can never be
    // re-minted and collide at the next drop's destination (the OS replace
    // prompt). unique_output stays as the same-second backstop.
    const fileName = stampedClipName(stem, ext);
    // Render to the persistent clips folder (not the temp dir, which is
    // wiped on close) so a clip dropped into a DAW keeps resolving.
    let clipsDir = tempDirRef.current;
    try { clipsDir = await ensureClipsDir(); } catch { /* fall back to temp */ }
    const dsep = clipsDir.includes('\\') ? '\\' : '/';
    const out = `${clipsDir}${dsep}${fileName}`;
    // Track the button through the render: starting DoDragDrop AFTER the
    // user already released zombie-drops the file at whatever sits under
    // the cursor (or decays into a stuck forbidden-cursor drag). If the
    // release beats the render, kill the chip immediately and just leave
    // the finished clip in Latch Clips.
    let released = false;
    let handedOff = false;
    const onUp = () => {
      released = true;
      // Kill the chip the INSTANT the button comes up — while still
      // rendering, behind a native confirm dialog, anything. The only
      // exception is once the OS drag has taken over (handedOff): there the
      // chip is that drag's own transparent visual and DoDragDrop owns its end.
      if (!handedOff) void endOverlayDrag();
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    const chip = await buildDragChip(r, video);
    try {
      await startOverlayDrag({
        paths: [out], fileName, isDirectory: false, count: 1,
        waveformDataUrl: chip?.url ?? null, bgColor: chip?.bg ?? null,
      });
      // Render fresh each drag: a prior render may have been cleaned up
      // after a folder drop, so a cached path can't be trusted. No-clobber
      // keeps any path an app has already linked byte-stable.
      setClip(r.id, 'rendering');
      // Drag-out renders under a held pointer gesture, so it can't stop to ask
      // — it uses the current session pitch mode (set by the Pitch chip or a
      // prior Export dialog; defaults to preserve). The Export button owns the
      // ask-once dialog.
      const path = await runClip({ input, output: out, startSec: r.startSec, endSec: r.endSec, video, overwrite: false, speed: videoRef.current?.getSpeed() ?? 1, pitchMode: pitchModeRef.current });
      setClip(r.id, 'ready', path);
      void emit('wd-latch-clip-exported', { path, title: fileName });
      if (released) {
        void endOverlayDrag();
        setExportMsg(`Saved to Latch Clips: ${path.split(/[\\/]/).pop()}`);
      } else {
        // The clip lives in the persistent clips folder; if this drop lands on
        // a folder/desktop the OS copies it there and the native side deletes
        // our now-redundant copy (app drops that reference the path keep it).
        handedOff = true;
        await invoke('start_os_file_drag', { paths: [path], previewPng: null, transparent: true, cleanupTempOnShellDrop: true });
        void endOverlayDrag(); // DoDragDrop finished — ensure the chip is gone
      }
    } catch (err) {
      setClip(r.id, 'error');
      setExportMsg(`Clip failed: ${String((err as Error)?.message ?? err)}`);
      void endOverlayDrag();
    } finally {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      // Re-arm this region as the audition. The drag PAUSED the transport up
      // front; on a FAILED or aborted drag nothing resumed it, and if the
      // gesture came from a rail row (select-only, never armed) Space would
      // then fall back to whole-file playback — the "chop audio died
      // permanently" field bug. Re-cueing the loop here leaves it paused but
      // instantly retriggerable, whether the drag succeeded or not.
      select(r.id);
      setAuditionId(r.id);
      setCursorSec(r.startSec);
      if (hasVideoRef.current) videoRef.current?.setLoop(r.startSec, r.endSec);
    }
  }, [audioPath, clipInputFor, runClip, setClip, buildDragChip, sourceStem, ensureClipsDir, select]);

  const handleRegionDragOut = useCallback((id: string, opts: { video: boolean }) => {
    const r = regionsRef.current.find((x) => x.id === id);
    if (r) void beginRegionDragOut(r, opts.video);
  }, [beginRegionDragOut]);

  // VideoView's IN/OUT loop points double as region authors: with both
  // set, a dedicated region tracks them (created once, then re-bounded).
  // Insertion respects the non-overlap invariant — an IN inside an
  // existing region is a no-op.
  const ioRegionRef = useRef<string | null>(null);
  const onLoopPoints = useCallback((inSec: number | null, outSec: number | null) => {
    if (inSec == null || outSec == null || outSec - inSec < MIN_REGION_SEC) return;
    const dur = durationSec;
    if (dur <= 0) return;
    // Edge case: the playhead sits inside an existing region when the
    // points land. Adopt THAT region instead of trying to create one on
    // top of it (which the non-overlap invariant would reject) — hitting
    // IN/OUT while inside a region reads as "re-bound this one".
    const host = regionsRef.current.find((x) => inSec >= x.startSec && inSec < x.endSec);
    const target = host
      ?? (ioRegionRef.current
        ? regionsRef.current.find((x) => x.id === ioRegionRef.current)
        : null);
    pushHistory('io-region', 1200);
    if (target) {
      ioRegionRef.current = target.id;
      setRegions(setRegionBounds(regionsRef.current, target.id, inSec, outSec, dur));
      select(target.id);
    } else {
      const { regions: next, id } = createDragRegion(regionsRef.current, inSec, outSec, dur);
      if (id) {
        ioRegionRef.current = id;
        setRegions(next);
        select(id);
      }
    }
  }, [durationSec, pushHistory, setRegions, select]);
  onLoopPointsRef.current = onLoopPoints;

  // ---- Video / waveform splitter ------------------------------------------
  // A thin row-resize handle between the video pane and the waveform lets the
  // user trade video height for waveform height. It only redistributes the
  // internal split (userVideoPaneH); the WINDOW size is left alone, so the
  // waveform (flex-1) simply absorbs whatever the video pane gives up.
  const splitDragRef = useRef<{ y: number; h: number } | null>(null);
  const onSplitPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    splitDragRef.current = { y: e.clientY, h: userVideoPaneH ?? videoPaneH };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [userVideoPaneH, videoPaneH]);
  const onSplitPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = splitDragRef.current;
    if (!d) return;
    const MIN_VIDEO = 80;
    const bodyH = Math.max(0, window.innerHeight - 26);
    const RESERVED = 90 /* waveform min */ + 92 /* rail */ + 14 /* hint */ + 31 /* bottom */;
    const maxVideo = Math.max(MIN_VIDEO, bodyH - RESERVED);
    const next = Math.round(Math.max(MIN_VIDEO, Math.min(maxVideo, d.h + (e.clientY - d.y))));
    setUserVideoPaneH(next);
  }, []);
  const onSplitPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    splitDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // ---- Render -------------------------------------------------------------
  const railBtn = (active: boolean) =>
    `h-6 px-2 border transition-none text-[0.5625rem] uppercase font-bold tracking-tight shrink-0 ${
      active ? 'bg-[var(--theme-bg-hover)] border-[color:var(--theme-border-strong)] text-[color:var(--theme-text-heading)]'
             : 'bg-[var(--theme-bg-surface)] border-[color:var(--theme-border)] hover:bg-[var(--theme-bg-elevated)] text-[color:var(--theme-text-secondary)] hover:text-[color:var(--theme-text-primary)]'}`;
  const iconBtn = 'h-6 w-7 flex items-center justify-center shrink-0 transition-none bg-[var(--theme-bg-surface)] border border-[color:var(--theme-border)] hover:bg-[var(--theme-bg-elevated)] text-[color:var(--theme-text-secondary)] hover:text-[color:var(--theme-text-heading)]';
  // Floating transport buttons overlaid on the waveform (opaque surface +
  // shadow so they read over any waveform bg). pointer-events set inline.
  const floatBtn = 'h-6 w-6 flex items-center justify-center transition-none bg-[var(--theme-bg-surface)] border border-[color:var(--theme-border-strong)] hover:bg-[var(--theme-bg-elevated)] text-[color:var(--theme-text-secondary)] hover:text-[color:var(--theme-text-heading)] shadow-md';
  const mutedLabel = 'text-[0.5625rem] uppercase tracking-tight text-[color:var(--theme-text-muted)]';

  return (
    <div className="font-mono text-[color:var(--theme-text-primary)] select-none"
      style={{ height: '100vh', width: '100vw', overflow: 'hidden', background: bg, userSelect: 'none' }}>
      {/* Titlebar */}
      <div data-tauri-drag-region
        className="flex items-center gap-1.5 px-2 border-b border-[color:var(--theme-border)]" style={{ height: '26px' }}>
        <Scissors size={11} className="shrink-0 text-[color:var(--theme-text-secondary)] pointer-events-none" />
        <span className="text-[0.625rem] font-bold uppercase tracking-tight shrink-0 pointer-events-none">LATCH: CHOP</span>
        <span className="flex-1 truncate text-[0.5625rem] tabular-nums text-[color:var(--theme-text-muted)] pointer-events-none">
          {seed?.title ? baseName(seed.title) : (seed?.url ?? 'no source')}
          {hasVideo ? ' · video' : ''}
        </span>
        {audioPath && (
          <button
            onClick={() => setZeroCrossSnap(!zeroCrossSnap)}
            title={zeroCrossSnap
              ? 'Zero-cross snap (on): region edges snap to the nearest zero crossing. Click for exact placement'
              : 'Zero-cross snap (off): region edges stay exactly where dropped. Click to snap'}
            className={`shrink-0 flex items-center justify-center w-[18px] h-[18px] border transition-none ${
              zeroCrossSnap
                ? 'bg-[var(--theme-bg-hover)] border-[color:var(--theme-border-strong)] text-[color:var(--theme-text-heading)]'
                : 'bg-[var(--theme-bg-surface)] border-[color:var(--theme-border)] hover:bg-[var(--theme-bg-elevated)] text-[color:var(--theme-text-secondary)]'
            }`}
          >
            <Magnet size={10} />
          </button>
        )}
        {audioPath && (
          <button
            onClick={() => setChannelSplit(!channelSplit)}
            title={channelSplit
              ? 'Channel split (on): stereo files show L / R as separate lanes. Click for a single combined lane'
              : 'Channel split (off): single combined waveform. Click to split stereo into L / R lanes'}
            className={`shrink-0 flex items-center justify-center w-[18px] h-[18px] border transition-none ${
              channelSplit
                ? 'bg-[var(--theme-bg-hover)] border-[color:var(--theme-border-strong)] text-[color:var(--theme-text-heading)]'
                : 'bg-[var(--theme-bg-surface)] border-[color:var(--theme-border)] hover:bg-[var(--theme-bg-elevated)] text-[color:var(--theme-text-secondary)]'
            }`}
          >
            <Rows2 size={10} />
          </button>
        )}
        <button onClick={() => {
            const w = getCurrentWindow();
            void w.close().catch(() => w.destroy().catch(() => {}));
          }}
          className="text-[color:var(--theme-text-muted)] hover:text-[color:var(--theme-text-heading)] hover:bg-[var(--theme-bg-elevated)] p-0.5 transition-none shrink-0" title="Close">
          <X size={11} />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-col" style={{ height: 'calc(100vh - 26px)' }}>
        {/* Video preview — muted follower of the audio clock. Pane height
            is sized to the video's aspect (see the fit effect) so a 16:9
            clip fills it with no letterbox deadspace. */}
        {hasVideo && showVideo && videoPath && phase === 'ready' && (
          <div className="w-full shrink-0 border-b border-[color:var(--theme-border)] bg-black" style={{ height: (userVideoPaneH ?? videoPaneH) || undefined }}>
            {/* The real visualizer video player: rich transport, J/K/L
                shuttle, zoom/pan, frame-step. It owns playback (audio) for
                video links, so the WAV transport below is hidden then. */}
            <VideoPreview ref={videoRef} src={convertFileSrc(videoPath)} path={videoPath} suppressChip disableKeyboard
              pitchPreviewLock={pitchMode === 'preserve'}
              onPlayingChange={setVideoPlaying}
              onLoopPointsChange={onLoopPoints}
              onReady={() => {
                // After the low-res → HD swap reload, restore the playhead —
                // and the PAUSE state: the engine autoplays on open, so a
                // paused session would otherwise burst into playback when
                // the HD file lands mid-thought.
                if (pendingSeekRef.current != null) {
                  const t = pendingSeekRef.current; pendingSeekRef.current = null;
                  videoRef.current?.seek(t);
                  if (pendingPlayRef.current) videoRef.current?.play();
                  else videoRef.current?.pause();
                  pendingPlayRef.current = false;
                }
              }} />
          </div>
        )}
        {/* Row-resize handle: drag up to give the waveform more room, down to
            grow the video. Only redistributes the internal split. */}
        {hasVideo && showVideo && videoPath && phase === 'ready' && (
          <div
            onPointerDown={onSplitPointerDown}
            onPointerMove={onSplitPointerMove}
            onPointerUp={onSplitPointerUp}
            onPointerCancel={onSplitPointerUp}
            className="w-full shrink-0 cursor-row-resize bg-[color:var(--theme-border)] hover:bg-[color:var(--theme-border-strong)]"
            style={{ height: '4px', touchAction: 'none' }}
            title="Drag to resize the video / waveform split"
          />
        )}
        {/* Waveform + region overlay */}
        <div ref={waveContainerRef} className="relative w-full flex-1 min-h-0 border-b border-[color:var(--theme-border)]">
          {phase === 'ready' && audioPath ? (
            <WaveformView
              markers={[
                ...chapters.map((c) => ({ sec: c.startSec, label: c.title })),
                ...(ioKeyIn != null ? [{ sec: ioKeyIn, label: 'In point', color: 'rgba(52,211,153,0.9)' }] : []),
              ]}
              audioFile={waveAudioFile}
              filePath={audioPath}
              clickMode="seek"
              channelSplit={channelSplit}
              hideTransport
              playheadGetter={hasVideo
                ? (() => videoRef.current?.getCurrentTime() ?? cursorSec)
                : (isPlaying && onOurFile ? undefined : () => cursorSec)}
              overlay={(vp) => {
                vpRef.current = { tStart: vp.tStart, tEnd: vp.tEnd };
                return (
                  <ChopRegionOverlay
                    regions={regions}
                    selectedId={selectedId}
                    viewportStartSec={vp.tStart}
                    viewportEndSec={vp.tEnd}
                    durationSec={vp.durationSec || durationSec}
                    onChange={setRegions}
                    onSelect={select}
                    onSeek={onSeek}
                    onActivate={onActivate}
                    onCreateDefault={(sec) => {
                      pushHistory();
                      createDefault(sec, vp.durationSec || durationSec,
                        Math.min(Math.max((vp.tEnd - vp.tStart) * 0.05, 0.1), 5));
                    }}
                    onDragOut={handleRegionDragOut}
                    canExportVideo={canExportVideo}
                    onGestureStart={() => { draggingRef.current = true; pushHistory(); }}
                    onGestureEnd={(info) => {
                      draggingRef.current = false;
                      // Kill the trailing onLiveBounds rAF BEFORE re-arming.
                      // Queued by the gesture's last pointermove, it would
                      // otherwise fire AFTER the drop's setLoop, flip the
                      // engine back into live-drag mode (liveLoopActive) and
                      // collapse the just-queued arm into a disarm — the
                      // settled loop then escapes at the out-point every
                      // cycle until the next activation (the post-release
                      // right-boundary disrespect).
                      if (liveLoopRaf.current) {
                        cancelAnimationFrame(liveLoopRaf.current);
                        liveLoopRaf.current = 0;
                      }
                      liveLoopPending.current = null;
                      // Re-arm the gapless video loop at the settled bounds
                      // (present() ran on the live-drag seek-wrap path during
                      // the gesture). One re-arm on drop, never per move. When
                      // a NON-armed region was dragged (video arm-on-grab moved
                      // the live walls there), restore the ARMED region's cage.
                      // A CREATE was armed by onActivate a beat ago (the
                      // auditionId ref is still stale here) — treat it as the
                      // armed target. NO armed region at all → release the
                      // gesture cage entirely, or liveLoopActive dangles at
                      // the drag bounds and cages whole-file playback.
                      if (hasVideoRef.current) {
                        const armedId = info.kind === 'create' ? info.id : auditionIdRef.current;
                        const target = regionsRef.current.find((x) =>
                          x.id === (armedId === info.id ? info.id : armedId));
                        if (target) videoRef.current?.setLoop(target.startSec, target.endSec);
                        else videoRef.current?.clearLoop();
                      }
                      void onGestureEnd(info);
                    }}
                    panViewport={vp.panViewport}
                    onLiveBounds={onLiveBounds}
                  />
                );
              }}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
              {phase === 'error' ? (
                <>
                  <span className="text-[0.6875rem] text-[color:var(--theme-text-heading)]">Couldn't load this link</span>
                  <span className="text-[0.5625rem] text-[color:var(--theme-text-muted)] break-all max-w-[80%]">{errorMsg}</span>
                  {seed && (
                    <button className={railBtn(false)} onClick={() => void startPipeline(seed)}>Retry</button>
                  )}
                </>
              ) : phase === 'ready' ? (
                // Media is up but the display-only companion WAV is still
                // deriving in the background — show a small hint instead of the
                // full loading UI, which reads as if the whole window is stuck.
                <div className="flex items-center gap-2 select-none">
                  <Loader2 size={11} className="animate-spin text-[color:var(--theme-text-muted)]" />
                  <span className="text-[0.5625rem] uppercase tracking-tight text-[color:var(--theme-text-muted)]">
                    Deriving waveform{progress > 0 ? ` · ${progress}%` : ''}
                  </span>
                </div>
              ) : (
                <div className="w-full max-w-[440px] flex flex-col items-center gap-2 px-6">
                  <div className="self-stretch flex items-center gap-2">
                    <Loader2 size={13} className="animate-spin text-[color:var(--theme-text-secondary)] shrink-0" />
                    <span className="text-[0.6875rem] font-bold uppercase tracking-tight text-[color:var(--theme-text-heading)]">
                      Loading
                    </span>
                    <span className="flex-1 text-right text-[0.625rem] tabular-nums text-[color:var(--theme-text-secondary)]">
                      {progress > 0 ? `${progress}%` : ''}
                    </span>
                  </div>
                  {(seed?.title || seed?.url) && (
                    <span className="self-stretch truncate text-[0.5625rem] text-[color:var(--theme-text-muted)]">
                      {seed?.title ? baseName(seed.title) : seed?.url}
                    </span>
                  )}
                  <div className="self-stretch h-2 bg-[var(--theme-bg-surface)] border border-[color:var(--theme-border)] overflow-hidden">
                    {progress > 0 ? (
                      <div className="h-full bg-[var(--theme-accent)] transition-[width] duration-200" style={{ width: `${progress}%` }} />
                    ) : (
                      <>
                        {/* No percent yet (download setup) → indeterminate slide,
                            not a misleading static fill. */}
                        <style>{`@keyframes wdChopIndet{from{transform:translateX(-100%)}to{transform:translateX(350%)}}`}</style>
                        <div className="h-full bg-[var(--theme-accent)]" style={{ width: '30%', animation: 'wdChopIndet 1.2s ease-in-out infinite' }} />
                      </>
                    )}
                  </div>
                  <span className="self-stretch text-[0.5rem] leading-snug text-[color:var(--theme-text-muted)]">
                    Longer clips may take a while.
                  </span>
                  <button className={`${railBtn(false)} mt-1`} onClick={() => { void getCurrentWindow().close(); }}>Cancel</button>
                </div>
              )}
            </div>
          )}

          {/* Floating transport: play/pause + stop, overlaid on the waveform
              (top-left) so the middle row is gone. Container is click-through;
              only the buttons take pointer events. */}
          {phase === 'ready' && audioPath && (
            <div className="absolute top-1.5 left-1.5 flex items-center gap-1" style={{ zIndex: 5, pointerEvents: 'none' }}>
              <button className={floatBtn} style={{ pointerEvents: 'auto' }} onClick={toggleTransport}
                title={selectedId ? 'Play / pause the selected region' : 'Play / pause'}>
                {transportPlaying ? <Pause size={11} /> : <Play size={11} />}
              </button>
              <button className={floatBtn} style={{ pointerEvents: 'auto' }} onClick={stopToLoopStart}
                title="Stop: back to the region start">
                <Square size={10} />
              </button>
            </div>
          )}
        </div>

        {/* Region rail */}
        <div className="overflow-y-auto shrink-0" style={{ maxHeight: '38%' }}>
          {regions.length === 0 ? (
            <div className={`px-2 py-3 ${mutedLabel}`}>No selections yet.</div>
          ) : (
            [...regions].sort((a, b) => a.startSec - b.startSec).map((r, i) => {
              const sel = r.id === selectedId;
              return (
                <div
                  key={r.id}
                  draggable
                  onDragStart={(e) => { e.preventDefault(); if (hasVideoRef.current) videoRef.current?.pause(); else playbackEngine.pause(); select(r.id); void beginRegionDragOut(r); }}
                  onMouseDown={() => select(r.id)}
                  className={`flex items-center gap-1.5 px-2 h-7 border-b border-[color:var(--theme-border)] cursor-grab ${
                    sel ? 'bg-[var(--theme-bg-hover)]' : 'hover:bg-[var(--theme-bg-elevated)]'}`}
                  title="Drag out to drop as a file"
                >
                  <span className="shrink-0 w-1.5 h-4 rounded-sm" style={{ background: r.color }} />
                  <input
                    type="checkbox"
                    checked={r.staged}
                    onChange={(e) => setStaged(r.id, e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    title="Stage for batch export"
                    className="shrink-0"
                  />
                  <input
                    value={r.label}
                    placeholder={`clip ${String(i + 1).padStart(2, '0')}`}
                    onChange={(e) => setLabel(r.id, e.target.value)}
                    onFocus={() => pushHistory(`label-${r.id}`, 1500)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    draggable={false}
                    className="h-5 w-28 px-1 bg-[var(--theme-bg-surface)] border border-[color:var(--theme-border)] text-[0.5625rem] focus:border-[color:var(--theme-accent)] focus:outline-none shrink-0"
                  />
                  <span className={`flex-1 min-w-0 truncate ${mutedLabel} tabular-nums`}>
                    {fmtTime(r.startSec)} – {fmtTime(r.endSec)} · {fmtTime(r.endSec - r.startSec)}
                  </span>
                  {r.clipState === 'rendering' && (
                    <span className="shrink-0 flex items-center" title="Pre-rendering this clip so it's ready to drag out instantly">
                      <Loader2 size={10} className="animate-spin text-[color:var(--theme-text-muted)]" />
                    </span>
                  )}
                  {canExportVideo && (
                    <button
                      className={railBtn(r.exportVideo ?? false)}
                      onClick={(e) => { e.stopPropagation(); setExportVideo(r.id, !(r.exportVideo ?? false)); }}
                      title={(r.exportVideo ?? false) ? 'Exports as video+audio (click for audio only)' : 'Exports as audio only (click for video+audio)'}
                    >
                      {(r.exportVideo ?? false) ? <Film size={10} /> : <Music size={10} />}
                    </button>
                  )}
                  <button className={iconBtn} onClick={(e) => { e.stopPropagation(); playRegionLooped(r); }} title="Audition this region (loops)">
                    <Play size={10} />
                  </button>
                  <button
                    className="h-6 w-7 flex items-center justify-center shrink-0 transition-none bg-[var(--theme-bg-surface)] border border-[color:var(--theme-border)] text-[color:var(--theme-text-muted)] hover:text-[color:#f87171] hover:bg-[var(--theme-bg-elevated)]"
                    onClick={(e) => { e.stopPropagation(); removeAndAdvance(r.id); }}
                    title="Delete this region"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Keyboard hint strip — terse cheat sheet for the otherwise
            invisible shortcuts; full text survives in the tooltip. */}
        <div
          className="flex items-center px-2 border-t border-[color:var(--theme-border)] shrink-0 overflow-hidden"
          style={{ height: '14px' }}
          title="space: retrigger / stop the selected region (whole file if none) · K: play / pause · J/L: shuttle (video) · double-click or drag: add region · I then O: mark a region · arrows: nudge selected region (Shift: coarse, Ctrl: start edge, Alt: end edge) · Delete: remove region · Ctrl+Z / Ctrl+Y: undo / redo · region grips: drag out the audio / video clip"
        >
          <span className="truncate text-[0.5rem] text-[color:var(--theme-text-muted)] select-none tabular-nums">
            space retrigger/stop · K play/pause{hasVideo ? ' · J/L shuttle' : ''} · dbl-click add · I/O mark region · arrows nudge (shift coarse · ctrl start · alt end) · del remove · ctrl+Z undo · grips drag out audio{hasVideo ? '/video' : ''}
          </span>
        </div>

        {/* Bottom bar: video/audio mode toggle · region count · export */}
        <div className="flex items-center gap-1.5 px-2 border-t border-[color:var(--theme-border)] shrink-0" style={{ height: '31px' }}>
          {phase === 'ready' && chapters.length > 1 && (
            <div className="relative">
              {showChapters && (
                <div className="absolute bottom-full left-0 mb-1 z-30 max-h-48 w-72 overflow-y-auto border border-[color:var(--theme-border-strong)] bg-[var(--theme-bg-panel)] shadow-lg">
                  {chapters.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => onSeek(c.startSec)}
                      className="w-full text-left px-2 py-1 text-[0.6rem] text-[color:var(--theme-text-secondary)] hover:bg-[var(--theme-bg-elevated)] hover:text-[color:var(--theme-text-heading)] flex items-center gap-2 transition-none"
                      title="Jump the playhead to this chapter"
                    >
                      <span className="text-[color:var(--theme-text-faint)] tabular-nums shrink-0">{fmtTime(c.startSec)}</span>
                      <span className="truncate">{c.title || `Chapter ${i + 1}`}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                className={railBtn(showChapters)}
                onClick={() => setShowChapters((v) => !v)}
                title={`${chapters.length} chapter markers: a navigation index (click a chapter to jump there). Markers show as ticks on the waveform.`}
              >
                <ListMusic size={10} className="inline -mt-px mr-1" />
                Chapters · {chapters.length}
              </button>
            </div>
          )}
          {phase === 'ready' && (
            <button className={railBtn(hasVideo ? showVideo : false)} onClick={onToggleVideo} disabled={videoFetching && !videoPath}
              title={(videoFetching && !videoPath) ? 'Fetching video…' : hasVideo ? (showVideo ? 'Hide the video preview' : 'Show the video preview') : 'Fetch this link as video and show the preview'}>
              {(videoFetching && !videoPath) ? <Loader2 size={10} className="inline -mt-px mr-1 animate-spin" /> : <Film size={10} className="inline -mt-px mr-1" />}
              Video
            </button>
          )}
          {phase === 'ready' && videoSpeed !== 1 && (
            <button
              className={railBtn(pitchMode === 'tape')}
              onClick={() => {
                const m = pitchMode === 'tape' ? 'preserve' : 'tape';
                setPitchMode(m); pitchModeRef.current = m; pitchAskedRef.current = true;
              }}
              title={pitchMode === 'tape'
                ? 'Tape mode: pitch follows speed, previewing live. Click to keep the original pitch.'
                : "Locked pitch: only tempo changes on export. A pitch-lock can't be previewed at a changed speed, so preview plays at 1×. Click for tape mode (previews live)."}
            >
              Pitch: {pitchMode === 'tape' ? 'Tape' : 'Locked'}
            </button>
          )}
          {phase === 'ready' && videoSpeed !== 1 && pitchMode === 'preserve' && (
            <span className="shrink-0 text-[0.5rem] uppercase tracking-tight text-[color:var(--theme-text-muted)]"
              title="Locked pitch can't be previewed at a changed speed. Preview plays at 1×; export keeps the original pitch.">
              preview 1×
            </span>
          )}
          <span className={`flex-1 min-w-0 truncate ${mutedLabel} tabular-nums`}>
            {exportMsg || (hdLoading
              ? 'Full-res video loading (video export soon)…'
              : regions.length === 0
                ? 'double-click or drag to add a selection · scroll to zoom'
                : `${regions.length} region${regions.length > 1 ? 's' : ''} · ${stagedRegions.length} staged`)}
          </span>
          <button
            className={iconBtn}
            onClick={async () => { try { await invoke('os_open_path', { path: await ensureClipsDir() }); } catch { /* ignore */ } }}
            title="Open the clips folder (Documents/Latch Clips) where rendered + exported clips are saved"
          >
            <Folder size={11} />
          </button>
          <button
            onClick={exportStaged}
            disabled={exporting || !stagedRegions.length}
            className="px-2.5 h-6 bg-[var(--theme-bg-elevated)] border border-[color:var(--theme-border-strong)] hover:bg-[var(--theme-bg-hover)] text-[0.5625rem] uppercase font-bold tracking-tight transition-none flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed text-[color:var(--theme-text-heading)] shrink-0"
            title="Export the staged regions to a folder"
          >
            {exporting ? <Loader2 size={11} className="animate-spin" /> : <FolderOpen size={11} />}
            Export{stagedRegions.length ? ` · ${stagedRegions.length}` : ''}
          </button>
        </div>
      </div>

      {/* Region-loop watcher (leaf — scopes the 60Hz position subscription).
          Audio links only; video links audition through VideoView. */}
      {!hasVideo && auditionRegion && audioPath && (
        <RegionLoopWatcher
          path={audioPath}
          startSec={auditionRegion.startSec}
          endSec={auditionRegion.endSec}
          looping={true}
          onEnded={() => setAuditionId(null)}
        />
      )}
    </div>
  );
}
