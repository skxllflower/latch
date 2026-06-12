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
  Trash2, Film, Music, FolderOpen, Folder, ListMusic,
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
import { RegionLoopWatcher } from './chopAudition';
import { useChopRegions } from './useChopRegions';
import {
  ChopRegion, regionFileStem, resizeEdge, moveRegion,
  nextRegionId, nextRegionColor, MIN_REGION_SEC,
  createDragRegion, setRegionBounds,
} from './chopRegions';
import { startOverlayDrag, endOverlayDrag } from './internalDragHandoff';
import { cropCanvasFractionToDataUrl, videoFrameToChipDataUrl, peaksToChipDataUrl } from './dragChipPng';
import type { ChopSeed } from './chopWindow';

interface IpcWaveformData {
  success: boolean;
  duration_sec: number;
  points: number[];
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

// Height cap for the fast low-res preview download. Audio is still
// bestaudio, so audio quality is unaffected — only the picture is smaller.
const PREVIEW_MAX_HEIGHT = 480;

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
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [videoPlaying, setVideoPlaying] = useState(false); // mirrors VideoView play state
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(true);
  const [videoAspect] = useState(16 / 9);
  const [videoPaneH, setVideoPaneH] = useState(0);
  const [cursorSec, setCursorSec] = useState(0);       // click position → playhead when audio isn't playing
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
    video: boolean; overwrite: boolean; preview?: boolean; onProgress?: (pct: number) => void;
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
      // Swap the preview to the full-res file. Carry the playhead + play
      // state so the reload resumes seamlessly (VideoView onReady re-seeks).
      pendingSeekRef.current = videoRef.current?.getCurrentTime() ?? null;
      pendingPlayRef.current = videoPlayingRef.current;
      setVideoPath(hd);
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
    try { playbackEngine.stop(); } catch { /* ignore */ }

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
    const id = requestAnimationFrame(() => { void getCurrentWindow().show().catch(() => {}); });
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

  // ---- Transport / audition ----------------------------------------------
  const isPlaying = playState === 'playing';
  const onOurFile = playingPath === audioPath;
  // Ref mirrors so stable callbacks (onActivate) can branch on live
  // playback state without being re-created on every play/pause.
  const isPlayingRef = useRef(false); isPlayingRef.current = isPlaying;
  const onOurFileRef = useRef(false); onOurFileRef.current = onOurFile;
  const playStateRef = useRef(playState); playStateRef.current = playState;
  const videoPlayingRef = useRef(false); videoPlayingRef.current = videoPlaying;

  const playWhole = useCallback(() => {
    if (!audioPath) return;
    setAuditionId(null);
    void playbackEngine.play(audioPath, 'full', { startSec: cursorSec });
  }, [audioPath, cursorSec]);

  const playRegion = useCallback((r: ChopRegion) => {
    if (!audioPath) return;
    setAuditionId(r.id);
    void playbackEngine.play(audioPath, 'full', { startSec: r.startSec });
  }, [audioPath]);

  // Folded play: a selected region auditions THAT region (looped per the
  // Loop toggle); otherwise the whole file. Pause/resume when our file is
  // already going.
  const playPause = useCallback(() => {
    if (!audioPath) return;
    if (isPlaying && onOurFile) { playbackEngine.pause(); return; }
    if (playState === 'paused' && onOurFile) { void playbackEngine.resume(); return; }
    const sel = selectedId ? regions.find((r) => r.id === selectedId) ?? null : null;
    if (sel) playRegion(sel); else playWhole();
  }, [audioPath, isPlaying, onOurFile, playState, selectedId, regions, playRegion, playWhole]);

  const stopAll = useCallback(() => {
    setAuditionId(null);
    playbackEngine.stop({ fadeMs: 20 });
    if (hasVideo) videoRef.current?.clearLoop();
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
      videoRef.current?.seek(target);
    } else if (onOurFileRef.current) {
      playbackEngine.pause();
      playbackEngine.seek(target);
    }
  }, [audioPath, auditionId, selectedId, hasVideo]);

  // Unified play/pause for the in-waveform transport overlay: video links
  // drive VideoView, audio links drive playbackEngine.
  const transportPlaying = hasVideo ? videoPlaying : (isPlaying && onOurFile);
  const toggleTransport = useCallback(() => {
    if (hasVideo) videoRef.current?.togglePlay();
    else playPause();
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
      videoRef.current?.seek(r.startSec);
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
      videoRef.current?.seek(r.startSec);
      videoRef.current?.setLoop(r.startSec, r.endSec);
      videoRef.current?.play();
    } else {
      playRegion(r);
    }
  }, [hasVideo, select, playRegion]);

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
  const zeroCross = useCallback(async (sec: number): Promise<number | null> => {
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
      const t = await zeroCross(info.edge === 'start' ? r.startSec : r.endSec);
      if (t != null) setRegions(resizeEdge(regionsRef.current, r.id, info.edge, t, dur));
    } else if (info.kind === 'create') {
      const s = await zeroCross(r.startSec);
      if (s != null) setRegions(resizeEdge(regionsRef.current, r.id, 'start', s, dur));
      const cur = regionsRef.current.find((x) => x.id === info.id);
      if (!cur) return;
      const e = await zeroCross(cur.endSec);
      if (e != null) setRegions(resizeEdge(regionsRef.current, r.id, 'end', e, dur));
    } else if (info.kind === 'move') {
      // Shift the whole region so its START lands on a crossing — width
      // (and therefore the end's relation to the start) is preserved.
      const s = await zeroCross(r.startSec);
      if (s != null) setRegions(moveRegion(regionsRef.current, r.id, s, dur));
    }
  }, [durationSec, setRegions, zeroCross]);

  // Seed one region per chapter (labels from chapter titles), clamped
  // sequentially so the non-overlap invariant holds even on sloppy
  // chapter data. One-click affordance in the bottom bar; undoable.
  const seedChapters = useCallback(() => {
    if (!chapters.length || durationSec <= 0) return;
    pushHistory();
    const out: ChopRegion[] = [];
    let prevEnd = 0;
    for (const c of chapters) {
      const start = Math.max(prevEnd, Math.max(0, c.startSec));
      const end = Math.min(durationSec, c.endSec);
      if (end - start < MIN_REGION_SEC) continue;
      out.push({
        id: nextRegionId(), startSec: start, endSec: end,
        label: c.title.slice(0, 60), color: nextRegionColor(),
        staged: true, clipState: 'none',
      });
      prevEnd = end;
    }
    if (out.length) setRegions(out);
  }, [chapters, durationSec, pushHistory, setRegions]);

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
      // Window-level transport so space/J/K/L work anywhere in the window,
      // not just over the video (no dead zones). Video links drive VideoView
      // (which has true J/K/L shuttle); audio links drive playbackEngine.
      if (hasVideo) {
        const v = videoRef.current;
        switch (e.code) {
          case 'Space': case 'KeyK': e.preventDefault(); v?.togglePlay(); break;
          case 'KeyJ': e.preventDefault(); v?.shuttle(-1); break;
          case 'KeyL': e.preventDefault(); v?.shuttle(1); break;
          case 'ArrowLeft': e.preventDefault(); v?.stepFrame(-1); break;
          case 'ArrowRight': e.preventDefault(); v?.stepFrame(1); break;
        }
      } else {
        switch (e.code) {
          case 'Space': case 'KeyK': e.preventDefault(); playPause(); break;
          case 'ArrowLeft': e.preventDefault(); nudge(-1); break;
          case 'ArrowRight': e.preventDefault(); nudge(1); break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, phase, hasVideo, playPause, nudge, removeAndAdvance,
      undo, redo, pushHistory, setRegions, durationSec]);

  const auditionRegion = auditionId ? regions.find((r) => r.id === auditionId) ?? null : null;

  // Re-apply the video loop whenever the auditioned region's bounds change
  // (e.g. you resize the region while it's looping) so the <video> never
  // keeps looping the stale, pre-resize in/out points.
  useEffect(() => {
    if (!hasVideo || !auditionRegion) return;
    videoRef.current?.setLoop(auditionRegion.startSec, auditionRegion.endSec);
  }, [hasVideo, auditionRegion?.startSec, auditionRegion?.endSec]);

  // The VideoView (and its play state) only exists while the preview is shown.
  useEffect(() => { if (!(hasVideo && showVideo)) setVideoPlaying(false); }, [hasVideo, showVideo]);

  // ---- Export / drag-out --------------------------------------------------
  // `forceVideo` overrides the per-region/default toggle: the drag-out path
  // passes it (false = audio, true = Alt-drag video) so a plain drag is
  // always the audio clip and Alt+drag is always the video clip.
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
    const dsep = dir.includes('\\') ? '\\' : '/';
    const sorted = [...stagedRegions].sort((a, b) => a.startSec - b.startSec);
    let ok = 0, fail = 0;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const { input, video, ext } = clipInputFor(r);
      const stem = regionFileStem(r, i, sourceStem);
      const out = `${dir}${dsep}${stem}.${ext}`;
      try {
        const written = await runClip({ input, output: out, startSec: r.startSec, endSec: r.endSec, video, overwrite: false });
        void emit('wd-latch-clip-exported', { path: written, title: stem });
        ok++;
      } catch { fail++; }
    }
    setExporting(false);
    setExportMsg(`Exported ${ok} clip${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed` : ''}`);
  }, [audioPath, stagedRegions, clipInputFor, runClip, sourceStem, ensureClipsDir]);

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
          // The standalone peaks IPC returns max-abs scalars; the chip
          // renderer (ported verbatim) wants [min, max, rms] triplets.
          const triplets = data.points.map((p) => [-p, p, p] as [number, number, number]);
          return peaksToChipDataUrl(triplets, r.color);
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
      const path = await runClip({
        input, output: `${clipsDir}${dsep}${stem}.${ext}`,
        startSec: r.startSec, endSec: r.endSec, video, overwrite: false,
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

  // Drag a region out as a file. With a fresh pre-render the OS drag
  // starts immediately (inside the gesture); without one, kick the
  // render and tell the user to drag again — starting DoDragDrop after
  // the button is already up is the no-op-drag failure mode.
  const beginRegionDragOut = useCallback(async (r: ChopRegion, forceVideo?: boolean) => {
    if (!audioPath) return;
    const wantVideo = forceVideo ?? r.exportVideo ?? false;
    const cachedVariantMatches = wantVideo === (r.exportVideo ?? false);
    if (r.clipPath && r.clipState === 'ready' && cachedVariantMatches) {
      const fileName = r.clipPath.split(/[\\/]/).pop() ?? 'clip';
      const chip = await buildDragChip(r, wantVideo).catch(() => null);
      try {
        await startOverlayDrag({
          paths: [r.clipPath], fileName, isDirectory: false, count: 1,
          waveformDataUrl: chip?.url ?? null, bgColor: chip?.bg ?? null,
        });
        // The clips folder is the persistence story (DAW references) —
        // never delete the cache after a shell drop.
        await invoke('start_os_file_drag', {
          paths: [r.clipPath], previewPng: null, transparent: true,
          cleanupTempOnShellDrop: false,
        });
      } catch (err) {
        // Surface it — a silent failure here reads as "drag is broken".
        setExportMsg(`Drag failed: ${String((err as Error)?.message ?? err)}`);
        void endOverlayDrag();
      }
      return;
    }
    if (wantVideo && !hdVideoPath) {
      setExportMsg('Full-res video still downloading… try the video drag shortly');
      return;
    }
    if (r.clipState === 'rendering') {
      setExportMsg('Clip still rendering… drag again in a second');
      return;
    }
    // No fresh cache: WAVdesk-verbatim flow — chip up, render DURING the
    // held gesture, then hand the file to the OS drag. If a slow render
    // outlives the gesture the OS drag no-ops and the chip clears (the
    // os_drag error path), and the render is stamped so the next drag is
    // instant either way.
    const { ext } = clipInputFor(r, forceVideo);
    const idx = regionsRef.current.findIndex((x) => x.id === r.id);
    const fileName = `${regionFileStem(r, idx < 0 ? 0 : idx, sourceStem)}.${ext}`;
    const chip = await buildDragChip(r, wantVideo).catch(() => null);
    try {
      await startOverlayDrag({
        paths: [], fileName, isDirectory: false, count: 1,
        waveformDataUrl: chip?.url ?? null, bgColor: chip?.bg ?? null,
      });
    } catch { /* chip is cosmetic — keep going */ }
    const path = await renderRegionClip(r.id, forceVideo);
    if (!path) {
      void endOverlayDrag();
      return;
    }
    void emit('wd-latch-clip-exported', { path, title: fileName });
    try {
      await invoke('start_os_file_drag', {
        paths: [path], previewPng: null, transparent: true,
        cleanupTempOnShellDrop: false,
      });
    } catch (err) {
      setExportMsg(`Drag failed: ${String((err as Error)?.message ?? err)}`);
      void endOverlayDrag();
    }
  }, [audioPath, hdVideoPath, buildDragChip, renderRegionClip, clipInputFor, sourceStem]);

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
          <div className="w-full shrink-0 border-b border-[color:var(--theme-border)] bg-black" style={{ height: videoPaneH || undefined }}>
            {/* The real visualizer video player: rich transport, J/K/L
                shuttle, zoom/pan, frame-step. It owns playback (audio) for
                video links, so the WAV transport below is hidden then. */}
            <VideoPreview ref={videoRef} src={convertFileSrc(videoPath)} path={videoPath} suppressChip disableKeyboard
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
        {/* Waveform + region overlay */}
        <div ref={waveContainerRef} className="relative w-full flex-1 min-h-0 border-b border-[color:var(--theme-border)]">
          {phase === 'ready' && audioPath ? (
            <WaveformView
              markers={chapters.map((c) => ({ sec: c.startSec, label: c.title }))}
              audioFile={waveAudioFile}
              filePath={audioPath}
              clickMode="seek"
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
                    onGestureStart={() => pushHistory()}
                    onGestureEnd={(info) => { void onGestureEnd(info); }}
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
                  onDragStart={(e) => { e.preventDefault(); select(r.id); void beginRegionDragOut(r, e.altKey ? true : undefined); }}
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
                  {r.clipState === 'rendering' && <Loader2 size={10} className="animate-spin shrink-0 text-[color:var(--theme-text-muted)]" />}
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
          title="space: play/pause · J/K/L: shuttle (video) · double-click or drag: add region · arrows: nudge selected region (Shift: coarse, Ctrl: start edge, Alt: end edge) · Delete: remove region · Ctrl+Z / Ctrl+Y: undo / redo · Alt-drag handle: export video"
        >
          <span className="truncate text-[0.5rem] text-[color:var(--theme-text-muted)] select-none tabular-nums">
            space play{hasVideo ? ' · J/K/L shuttle' : ''} · dbl-click add · arrows nudge region (shift coarse · ctrl start · alt end) · del remove · ctrl+Z undo · alt-drag handle: video
          </span>
        </div>

        {/* Bottom bar: video/audio mode toggle · region count · export */}
        <div className="flex items-center gap-1.5 px-2 border-t border-[color:var(--theme-border)] shrink-0" style={{ height: '31px' }}>
          {phase === 'ready' && chapters.length > 1 && (
            <button
              className={railBtn(false)}
              onClick={seedChapters}
              title={`This source has ${chapters.length} chapter markers. Create one region per chapter, labeled from the chapter titles.${regions.length ? ' Replaces the current regions (undoable).' : ''}`}
            >
              <ListMusic size={10} className="inline -mt-px mr-1" />
              Chapters · {chapters.length}
            </button>
          )}
          {phase === 'ready' && (
            <button className={railBtn(hasVideo ? showVideo : false)} onClick={onToggleVideo} disabled={videoFetching && !videoPath}
              title={(videoFetching && !videoPath) ? 'Fetching video…' : hasVideo ? (showVideo ? 'Hide the video preview' : 'Show the video preview') : 'Fetch this link as video and show the preview'}>
              {(videoFetching && !videoPath) ? <Loader2 size={10} className="inline -mt-px mr-1 animate-spin" /> : <Film size={10} className="inline -mt-px mr-1" />}
              Video
            </button>
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
