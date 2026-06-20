// Latch (Extract) — the standalone Latch app's main window. Fork of
// WAVdesk's LatchExtractApp (the in-WAVdesk tool window); the two stay
// behaviorally aligned, with the WAVdesk-host glue (overlay drag-out,
// windowed dialogs, the Chop satellite window) swapped or deferred.
// Chop returns once its own audio engine lands (next phase). Same
// column language as Lathe Convert: URL + options on the left, target
// format / advanced flags in the middle, landed downloads on the right.
//
// Bootstrap (yt-dlp + ffmpeg auto-download on first run) works the
// same way it does in Lathe.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { downloadDir } from '@tauri-apps/api/path';
import {
  X, Download, FolderOpen, FolderSearch, Trash2,
  CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown, CloudDownload,
  Link2, Link2Off, RefreshCw, Cookie, AlertTriangle, CheckSquare,
  Terminal, LayoutList, Image as ImageIcon, Film, Music, Check, Search, Minus,
  Scissors, Info, FileText, ShieldAlert,
} from 'lucide-react';
import { useTheme, THEME_BG } from './theme';
import { startOverlayDrag, endOverlayDrag } from './internalDragHandoff';
import { confirmInWindow, infoInWindow } from './dialogs';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { openChopWindow } from './chopWindow';
import { openAboutWindow } from './aboutWindow';
import { WdSelect, type WdSelectOption } from './WdSelect';

interface LatchOptionsPayload {
  // Empty = highest quality (no conversion, leave source codec).
  // When `video` is true this is ignored.
  audioFormat:     string;
  noPlaylist:      boolean;
  audioQuality:    string;
  embedMetadata:   boolean;
  embedThumbnail:  boolean;
  // Save the cover art as a sidecar .png next to the output.
  writeThumbnail:  boolean;
  // Centre-crop the cover art to a square before saving / embedding.
  cropThumbnail:   boolean;
  cookiesFromBrowser: string;
  // Optional cookies.txt (Netscape) path; passed to yt-dlp's --cookies.
  cookiesFile: string;
  section: string;
  // Video mode toggle — flips off yt-dlp's -x audio-extract and merges
  // bestvideo+bestaudio. Audio remains the default; video is opt-in.
  video:           boolean;
  // Video container preference: mp4 / webm / mkv / mov. Empty = let
  // yt-dlp pick. Only matters when video=true.
  videoFormat:     string;
}

interface ProbeResult {
  title: string;
  duration_s: number;
  uploader: string;
  error: string;
}

// At most 2 yt-dlp processes in flight at once. yt-dlp itself is fairly
// happy with parallelism but the bot-detection heuristics on YouTube
// notice — a low cap keeps a multi-URL paste from getting flagged.
const EXTRACT_CONCURRENCY = 2;

// HH:MM:SS-HH:MM:SS, MM:SS-MM:SS, or seconds-seconds. Permissive on
// purpose — the wrapper passes the string straight to yt-dlp which
// rejects obvious garbage with a clear error of its own.
const SECTION_RE = /^(\d{1,2}:)?\d{1,2}:\d{2}-(\d{1,2}:)?\d{1,2}:\d{2}$|^\d+(\.\d+)?-\d+(\.\d+)?$/;

const formatDuration = (sec: number) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

// Light URL sniff — accept anything starting with http(s) so we don't
// fire probes on partial input. The wrapper does the real validation.
const looksLikeUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

// Browsers yt-dlp supports for --cookies-from-browser. Empty value =
// don't pass the flag. Order roughly tracks Windows desktop popularity.
const BROWSERS: { value: string; label: string }[] = [
  { value: '',         label: '— none —' },
  { value: 'firefox',  label: 'Firefox' },
  { value: 'chrome',   label: 'Chrome' },
  { value: 'edge',     label: 'Edge' },
  { value: 'brave',    label: 'Brave' },
  { value: 'opera',    label: 'Opera' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'vivaldi',  label: 'Vivaldi' },
  { value: 'safari',   label: 'Safari' },
];

// yt-dlp errors that the GUI knows how to react to. Each pattern fires
// a different inline action — cookies prompt for the bot wall, update
// prompt for outdated extractors, browser-locked prompt for the Chrome
// cookie-DB lock case.
type ErrorKind = 'bot-wall' | 'cookie-locked' | 'extractor-outdated' | 'unknown';
const classifyError = (msg: string | undefined): ErrorKind => {
  if (!msg) return 'unknown';
  const m = msg.toLowerCase();
  if (m.includes('could not copy') && m.includes('cookie')) return 'cookie-locked';
  if (m.includes('sign in to confirm') || m.includes('not a bot') || m.includes('cookies')) return 'bot-wall';
  if (m.includes('unsupported url') || m.includes('extractor') || m.includes('unable to extract')) return 'extractor-outdated';
  return 'unknown';
};

interface ExtractItem {
  id:        string;
  url:       string;
  title?:    string;
  jobId:     string;
  status:    'queued' | 'extracting' | 'done' | 'failed' | 'cancelled';
  percent:   number;
  // Which enqueue run this item belongs to — drives the batch-aware
  // status bar (finished/total + summed percent). An enqueue while the
  // list is idle starts a new batch; clip-exported rows carry none.
  batchId?:  number;
  speed?:    string;
  eta?:      string;
  output?:   string;
  error?:    string;
  // Last cookies-from-browser used for this URL. Lets the smart-retry
  // suggestion know which browser to skip when proposing the next try.
  lastCookies?: string;
  // Row selection for bulk drag-out and bulk remove. Multi-select via
  // Ctrl/Shift mirrors the inputs panel in Lathe.
  selected:  boolean;
}

// Pending URL in the input panel — gets probed for title/duration so
// either view (terminal rows OR cards) can show metadata. Cleared when
// the user clicks Extract; not the same list as `items` (Downloads).
interface InputQueueItem {
  id:         string;
  url:        string;
  title?:     string;
  uploader?:  string;
  duration?:  number;
  // Per-track thumbnail URL from yt-dlp's --flat-playlist mode (the
  // best-resolution variant). Used by the card view's preview slot;
  // empty / undefined falls back to the placeholder icon.
  thumbnail?: string;
  probeState: 'pending' | 'probing' | 'ok' | 'error';
  probeError?: string;
  // Terminal-row multi-select. Cards mode ignores this — cards have
  // a per-card X button instead.
  selected:   boolean;
  // 'search' = a ytsearchN: query still resolving (excluded from Extract,
  // no Chop). Resolved hits carry candidateGroup instead.
  kind?:      'url' | 'search';
  // Set on every row a multi-hit search expands into. Candidates are
  // excluded from Extract until picked — picking one dissolves the rest.
  candidateGroup?: string;
}

type UrlViewMode = 'terminal' | 'cards';

type BootstrapStage = 'idle' | 'downloading' | 'extracting' | 'failed';

// Whether a link is natively a video or an audio source, by host. Used for
// the informative per-row glyph, the chop window's default mode, and the
// 'native' download mode. Unknown hosts default to video (it carries audio
// too; the Audio config mode can still force audio-only).
const AUDIO_HOSTS = [
  'soundcloud.com', 'bandcamp.com', 'mixcloud.com', 'audiomack.com',
  'deezer.com', 'spotify.com', 'music.apple.com', 'audius.co', 'datpiff.com',
];
const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv', 'tiktok.com',
  'instagram.com', 'twitter.com', 'x.com', 'facebook.com', 'fb.watch',
  'dailymotion.com', 'streamable.com', 'reddit.com',
];
function linkSourceKind(url: string): 'audio' | 'video' {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const match = (h: string) => host === h || host.endsWith(`.${h}`);
    if (AUDIO_HOSTS.some(match)) return 'audio';
    if (VIDEO_HOSTS.some(match)) return 'video';
  } catch { /* not a parseable URL */ }
  return 'video';
}

// Reduce a YouTube *watch* URL to just its video, dropping the playlist
// context (list / start_radio / index). YouTube auto-appends these when you
// copy a URL while a mix is playing — `&list=RD…&start_radio=1` is a generated
// radio with HUNDREDS of entries. Resolving that URL with `expand` enumerates
// the whole mix (635 tracks ≈ 13s for the preview), even when "Single video
// only" is on and we then slice to 1 — the toggle trimmed the result, not the
// work. With the toggle on we strip to the bare video so the resolve is a
// single fast metadata fetch. Only watch URLs that carry a video id reduce;
// a bare /playlist?list=… (no v) is left untouched. Non-YouTube / unparseable
// URLs pass through unchanged.
function youtubeVideoOnlyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const isYt = host === 'youtube.com' || host.endsWith('.youtube.com');
    const isShort = host === 'youtu.be';
    if (isShort) {
      // youtu.be/<id>?list=… — id is the path; keep only an optional timestamp.
      const keep = new URLSearchParams();
      const t = u.searchParams.get('t'); if (t) keep.set('t', t);
      u.search = keep.toString();
      return u.toString();
    }
    if (!isYt) return raw;
    const v = u.searchParams.get('v');
    if (!v) return raw; // bare playlist / channel / etc. — nothing to reduce to
    const keep = new URLSearchParams();
    keep.set('v', v);
    const t = u.searchParams.get('t'); if (t) keep.set('t', t);
    u.search = keep.toString();
    return u.toString();
  } catch { return raw; }
}

const formatBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024)            return `${n} B`;
  if (n < 1024 * 1024)     return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3)       return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 ** 3)).toFixed(2)} GB`;
};

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export default function ExtractApp() {
  const { theme } = useTheme();
  const close = () => { try { void getCurrentWindow().close(); } catch { window.close(); } };

  // Current text in the $ prompt / cards input. Distinct from
  // `inputQueue` so the user can be mid-typing a URL when they
  // commit an earlier one.
  const [inputBuffer, setInputBuffer] = useState('');
  // Parsed URLs awaiting extraction. Both views (terminal rows /
  // cards) read from this — only the rendering differs.
  const [inputQueue, setInputQueue]   = useState<InputQueueItem[]>([]);
  // Tab-style toggle between the two URL views. Persisted so the
  // user's preferred layout sticks across sessions.
  const [urlViewMode, setUrlViewMode] = useState<UrlViewMode>(() => {
    try {
      const v = localStorage.getItem('wd-latch-url-view') as UrlViewMode | null;
      return v === 'cards' || v === 'terminal' ? v : 'terminal';
    } catch { return 'terminal'; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-url-view', urlViewMode); } catch {}
  }, [urlViewMode]);
  const [inputFocused, setInputFocused] = useState(false);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  // Scroll container for the visible prompt text — auto-scrolls right
  // whenever the buffer grows so the caret stays in view. Without this,
  // pasted URLs overflow the panel and bleed into the next column.
  const promptScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = promptScrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [inputBuffer]);

  const [outputDir, setOutputDir]   = useState<string>(() => {
    try { return localStorage.getItem('wd-latch-output-dir') ?? ''; } catch { return ''; }
  });
  const [items, setItems]           = useState<ExtractItem[]>([]);

  // First-run defaulting: if the user has never picked an output dir,
  // seed it from the platform's user-Downloads folder. Tauri's
  // downloadDir() does the OS-specific lookup (USERPROFILE\Downloads,
  // ~/Downloads, XDG_DOWNLOAD_DIR). Saved choice always wins; this
  // only fires on a truly empty initial state. Async because the
  // path lookup goes through the IPC boundary.
  useEffect(() => {
    if (outputDir) return;
    void (async () => {
      try {
        const d = await downloadDir();
        if (d) setOutputDir(d);
      } catch { /* fall through — user will pick manually */ }
    })();
    // Intentionally only runs on mount; subsequent outputDir changes
    // shouldn't re-trigger the lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-launch rights acknowledgement (one-time, persisted). Latch can
  // download copyrighted material, so make the user own that responsibility
  // before using it. Declining closes the window — no access without it.
  useEffect(() => {
    let done = false;
    try { if (localStorage.getItem('wd-latch-rights-ack-v1') === '1') return; } catch { /* ignore */ }
    void (async () => {
      const agreed = await confirmInWindow({
        title:        'Make sure you have the rights',
        message:      "Only download material you own or have the rights to, and follow each source's terms of service. You're responsible for how you use Latch.",
        confirmLabel: 'I Agree',
        cancelLabel:  'Cancel',
      });
      if (done) return;
      if (agreed) { try { localStorage.setItem('wd-latch-rights-ack-v1', '1'); } catch { /* ignore */ } }
      else { try { void getCurrentWindow().close(); } catch { /* ignore */ } }
    })();
    return () => { done = true; };
  }, []);

  // Last-selected item id — anchor for Shift+click range selection
  // in the Downloads panel.
  const lastSelectedRef = useRef<string | null>(null);

  // Output audio format. Empty string = pass-through (source codec,
  // no re-encode). Non-empty values map to yt-dlp's --audio-format
  // flag (which internally runs ffmpeg). Ignored when mode='video'.
  const [audioFormat, setAudioFormat] = useState<string>(() => {
    try { return localStorage.getItem('wd-latch-audio-format') ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-audio-format', audioFormat); } catch {}
  }, [audioFormat]);

  // Audio / video mode toggle. Persisted so the user's choice survives
  // restarts; audio is the original (and default) Latch behavior, video
  // is opt-in and routes through yt-dlp's bestvideo+bestaudio path.
  const [mediaMode, setMediaMode] = useState<'audio' | 'video' | 'native'>(() => {
    try {
      const v = localStorage.getItem('wd-latch-media-mode');
      return v === 'video' ? 'video' : v === 'native' ? 'native' : 'audio';
    } catch { return 'audio'; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-media-mode', mediaMode); } catch {}
  }, [mediaMode]);

  // Video container preference (mp4 / webm / mkv / mov). Empty = let
  // yt-dlp pick the best for the source streams.
  const [videoFormat, setVideoFormat] = useState<string>(() => {
    try { return localStorage.getItem('wd-latch-video-format') ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-video-format', videoFormat); } catch {}
  }, [videoFormat]);

  // Advanced.
  const [showAdvanced, setShowAdvanced]      = useState(false);
  const [noPlaylist, setNoPlaylist]          = useState(true);   // default ON — pasting a video that's IN a playlist shouldn't pull the whole playlist by accident
  const [embedMetadata, setEmbedMetadata]    = useState(false);
  // Cover art. Save + Embed default ON — out of the box every download
  // both drops a .png sidecar and carries the art inside the file. Crop
  // defaults OFF. All three persist so the chosen workflow sticks.
  const [writeThumbnail, setWriteThumbnail]  = useState<boolean>(() => {
    try { const v = localStorage.getItem('wd-latch-write-thumbnail'); return v === null ? true : v === '1'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-write-thumbnail', writeThumbnail ? '1' : '0'); } catch {}
  }, [writeThumbnail]);
  const [cropThumbnail, setCropThumbnail]    = useState<boolean>(() => {
    try { return localStorage.getItem('wd-latch-crop-thumbnail') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-crop-thumbnail', cropThumbnail ? '1' : '0'); } catch {}
  }, [cropThumbnail]);
  const [embedThumbnail, setEmbedThumbnail]  = useState<boolean>(() => {
    try { const v = localStorage.getItem('wd-latch-embed-thumbnail'); return v === null ? true : v === '1'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-embed-thumbnail', embedThumbnail ? '1' : '0'); } catch {}
  }, [embedThumbnail]);
  // Cookie source — the browser whose login cookies yt-dlp borrows for gated
  // sites (YouTube etc.), plus an optional cookies.txt escape hatch. Stored in
  // a SHARED file (…\Vacant Systems\Shared\cookies.json) via cookie_prefs_*,
  // so setting it here also configures the in-WAVdesk Latch tool and vice
  // versa. On first read it migrates the old per-window localStorage value;
  // on a never-configured machine it silently defaults to Firefox when a
  // Firefox cookie store is present (the only reliably readable one on Win).
  const [cookiesFromBrowser, setCookiesFromBrowser] = useState<string>('');
  const [cookiesFile, setCookiesFile] = useState<string>('');
  const [firefoxAutoNotice, setFirefoxAutoNotice] = useState(false);
  const cookiePrefsLoaded = useRef(false);
  useEffect(() => {
    void (async () => {
      try {
        let prefs = await invoke<{ configured: boolean; cookiesFromBrowser: string; cookiesFile: string }>('cookie_prefs_get');
        if (!prefs.configured) {
          let seed = '';
          try { seed = localStorage.getItem('wd-latch-cookies-browser') ?? ''; } catch {}
          if (!seed) {
            try { seed = (await invoke<{ recommended: string }>('detect_cookie_browsers')).recommended; } catch {}
          }
          prefs = { configured: true, cookiesFromBrowser: seed, cookiesFile: prefs.cookiesFile || '' };
          try { await invoke('cookie_prefs_set', { prefs }); } catch {}
          if (seed === 'firefox') setFirefoxAutoNotice(true);
        }
        setCookiesFromBrowser(prefs.cookiesFromBrowser);
        setCookiesFile(prefs.cookiesFile);
      } catch { /* shared store unreachable — fall back to empty */ }
      cookiePrefsLoaded.current = true;
    })();
  }, []);
  // Persist changes back to the shared file (after the initial load, so the
  // load itself doesn't echo a write).
  useEffect(() => {
    if (!cookiePrefsLoaded.current) return;
    void invoke('cookie_prefs_set', {
      prefs: { configured: true, cookiesFromBrowser, cookiesFile },
    }).catch(() => {});
  }, [cookiesFromBrowser, cookiesFile]);

  // yt-dlp self-update state. Triggered via the title-bar refresh
  // button; the wrapper streams `update` events that flow through the
  // same latch-event listener.
  const [updateState, setUpdateState] = useState<{
    running: boolean;
    log:     string[];
    failed?: boolean;
  }>({ running: false, log: [] });

  // Time-range trim — "00:30-02:15" style. Persisted across restarts
  // since folks who clip from one source tend to come back to it.
  const [section, setSection] = useState<string>(() => {
    try { return localStorage.getItem('wd-latch-section') ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try { localStorage.setItem('wd-latch-section', section); } catch {}
  }, [section]);

  // Cookie-test state. Result lives next to the cookies dropdown.
  const [cookieTest, setCookieTest] = useState<{
    state: 'idle' | 'testing' | 'ok' | 'fail';
    message?: string;
  }>({ state: 'idle' });

  // Standalone: no configured path — the Rust resolver walks env →
  // dev checkout → installed locations.
  const [latchPath] = useState('');

  // Title-bar "binary connected" indicator. Probed on mount and whenever
  // the configured path changes — flips between green check / warn-tinted check
  // (env or dev fallback) / red X.
  const [binStatus, setBinStatus] = useState<{
    resolved: boolean;
    path:     string;
    source:   string;
    message:  string;
  } | null>(null);

  const [bootstrap, setBootstrap] = useState<{
    stage:   BootstrapStage;
    binary?: string;
    bytes?:  number;
    total?:  number;
    percent?: number;
    message?: string;
  }>({ stage: 'idle' });

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const isActive = (s: ExtractItem['status']) => s === 'queued' || s === 'extracting';

  // Concurrency tracker. Incremented when we hand a job to the wrapper,
  // decremented when a terminal event arrives. The pump uses this to
  // decide whether to start more queued items.
  const inFlightRef = useRef(0);

  // Batch counter for the status bar — enqueueing while the list is idle
  // starts a new batch; enqueueing mid-run (retry, second Ctrl+Enter)
  // joins the current one.
  const batchSeqRef = useRef(0);

  useEffect(() => {
    try { localStorage.setItem('wd-latch-output-dir', outputDir); } catch {}
  }, [outputDir]);

  // Created hidden (tauri.conf visible:false) — reveal after the first
  // paint so the user never sees the transparent shell fill in.
  useEffect(() => {
    requestAnimationFrame(() => { void getCurrentWindow().show(); });
  }, []);

  // Main-window close owns full app teardown: the satellite windows
  // (chop, the pre-spawned drag overlay) would otherwise keep a headless
  // app alive. Active downloads prompt first — closing cancels them and
  // the Rust side kills every child + sweeps the chop temp root.
  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested(async (e) => {
      e.preventDefault();
      const active = itemsRef.current.filter(it => isActive(it.status));
      if (active.length > 0) {
        const goAhead = await confirmInWindow({
          title:        `${active.length} download${active.length === 1 ? '' : 's'} in progress`,
          message:      'Closing cancels the active downloads. Partial files are cleaned up.',
          confirmLabel: 'Cancel & close',
          cancelLabel:  'Keep working',
        });
        if (!goAhead) return;
        for (const it of active) {
          if (it.jobId) void invoke('latch_cancel', { jobId: it.jobId });
        }
      }
      void invoke('app_exit');
    });
    return () => { void un.then(u => u()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clips rendered in the Chop window surface in the downloads column,
  // so they're revealable / removable like any other Latch output.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      unlisten = await listen<{ path?: string; title?: string }>('wd-latch-clip-exported', (e) => {
        const path = e.payload?.path;
        if (!path) return;
        const title = e.payload?.title || (path.split(/[\\/]/).pop() ?? path);
        setItems(prev => {
          if (prev.some(it => it.output === path)) return prev;
          return [...prev, {
            id: uid(), url: '', title, jobId: '',
            status: 'done' as const, percent: 100, output: path, selected: false,
          }];
        });
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const status = await invoke<typeof binStatus>('tool_binary_probe', {
          name: 'latch',
          configured: latchPath,
        });
        setBinStatus(status);
      } catch { setBinStatus(null); }
    })();
  }, [latchPath]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      unlisten = await listen<{
        tool: string;
        jobId: string;
        event: { type: string; [k: string]: any };
      }>('latch-event', (e) => {
        const { jobId, event } = e.payload;
        if (event.type === 'update') {
          if (event.stage === 'start') {
            setUpdateState({ running: true, log: [] });
          } else if (event.stage === 'log') {
            const line = String(event.line ?? '').trim();
            if (line) setUpdateState(s => ({ ...s, log: [...s.log, line].slice(-12) }));
          } else if (event.stage === 'done') {
            setUpdateState(s => ({ running: false, log: s.log, failed: false }));
          } else if (event.stage === 'failed') {
            setUpdateState(s => ({ running: false, log: s.log, failed: true }));
          }
          return;
        }
        if (event.type === 'bootstrap') {
          if (event.stage === 'download') {
            setBootstrap({
              stage:   'downloading',
              binary:  event.binary,
              bytes:   typeof event.bytes   === 'number' ? event.bytes   : undefined,
              total:   typeof event.total   === 'number' ? event.total   : undefined,
              percent: typeof event.percent === 'number' ? event.percent : undefined,
            });
          } else if (event.stage === 'extracting') setBootstrap({ stage: 'extracting', binary: event.binary });
          else if (event.stage === 'done')   setBootstrap({ stage: 'idle' });
          else if (event.stage === 'failed') setBootstrap({ stage: 'failed', binary: event.binary, message: event.message });
          return;
        }
        setItems(prev => prev.map(it => {
          if (it.jobId !== jobId) return it;
          if (event.type === 'info') {
            return { ...it, title: event.title };
          }
          if (event.type === 'progress') {
            return {
              ...it,
              status: 'extracting',
              percent: event.percent ?? it.percent,
              speed:   event.speed,
              eta:     event.eta,
            };
          }
          if (event.type === 'done') {
            return { ...it, status: 'done', percent: 100, output: event.output };
          }
          if (event.type === 'cancelled') {
            return { ...it, status: 'cancelled' };
          }
          if (event.type === 'error') {
            return { ...it, status: 'failed', error: event.message };
          }
          return it;
        }));
        // Terminal events free up a slot for the pump. The wrapper
        // emits exactly one of {done, cancelled, error, exit} per
        // invocation; we listen on the first three and let `exit`
        // (which always follows) be a no-op so we don't double-count.
        if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') {
          inFlightRef.current = Math.max(0, inFlightRef.current - 1);
          // Defer to next tick so React state has a chance to settle
          // before we read items again to schedule the next dispatch.
          queueMicrotask(() => pumpRef.current?.());
        }
      });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const onPickDir = useCallback(async () => {
    // Open the picker AT the currently-shown (last-used) folder, not the
    // binary/cwd. Fall back to the OS Downloads folder if it's somehow empty.
    let defaultPath = outputDir;
    if (!defaultPath) { try { defaultPath = await downloadDir(); } catch { /* ignore */ } }
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: defaultPath || undefined });
    if (typeof picked === 'string') setOutputDir(picked);
  }, [outputDir]);

  // Parse a chunk of text (paste payload or prompt buffer) into a
  // deduped list of URLs. Splits on newlines, commas, or surrounding
  // whitespace — covers paste-from-CSV, paste-from-doc, and a single
  // typed URL alike. Dedupe respects what's ALREADY queued so a paste
  // that overlaps with the existing queue doesn't double-add.
  const parseUrlChunk = useCallback((text: string): string[] => {
    const seen = new Set(inputQueue.map(q => q.url));
    const out: string[] = [];
    for (const raw of text.split(/[\r\n,]+/)) {
      const trimmed = raw.trim();
      if (!trimmed || !looksLikeUrl(trimmed)) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }, [inputQueue]);

  // Add fresh URLs to the input queue. Each starts in 'pending' so the
  // probe driver effect can pick them up sequentially.
  const enqueueInputUrls = useCallback((urls: string[]) => {
    if (urls.length === 0) return;
    setInputQueue(prev => {
      const existing = new Set(prev.map(q => q.url));
      const next = [...prev];
      for (const u of urls) {
        if (existing.has(u)) continue;
        next.push({
          id:         uid(),
          url:        u,
          probeState: 'pending',
          selected:   false,
        });
      }
      return next;
    });
  }, []);

  // Non-URL prompt input becomes a yt-dlp search (ytsearch5:). The expand
  // driver resolves the row into candidate hits the user picks from.
  const enqueueSearch = useCallback((query: string) => {
    const q = query.trim();
    if (!q) return;
    setInputQueue(prev => [...prev, {
      id:         uid(),
      url:        `ytsearch5:${q}`,
      title:      `search: ${q}`,
      kind:       'search' as const,
      probeState: 'pending' as const,
      selected:   false,
    }]);
  }, []);

  // Keep one search hit, dissolve its sibling candidates.
  const pickCandidate = useCallback((id: string) => {
    setInputQueue(prev => {
      const target = prev.find(q => q.id === id);
      if (!target?.candidateGroup) return prev;
      const g = target.candidateGroup;
      return prev
        .filter(q => q.id === id || q.candidateGroup !== g)
        .map(q => (q.id === id ? { ...q, candidateGroup: undefined } : q));
    });
  }, []);

  const removeQueuedUrl = useCallback((id: string) => {
    setInputQueue(prev => prev.filter(q => q.id !== id));
  }, []);

  const clearInputQueue = useCallback(() => {
    setInputQueue([]);
  }, []);

  // Multi-select on terminal rows. Single-click selects only, Ctrl
  // toggles, Shift extends from the last-clicked anchor.
  const lastQueueSelectedRef = useRef<string | null>(null);
  const selectQueuedUrl = useCallback((id: string, mode: 'single' | 'toggle' | 'range') => {
    setInputQueue(prev => {
      if (mode === 'single') {
        lastQueueSelectedRef.current = id;
        return prev.map(q => ({ ...q, selected: q.id === id }));
      }
      if (mode === 'toggle') {
        lastQueueSelectedRef.current = id;
        return prev.map(q => q.id === id ? { ...q, selected: !q.selected } : q);
      }
      const anchor    = lastQueueSelectedRef.current;
      const targetIdx = prev.findIndex(q => q.id === id);
      const anchorIdx = anchor ? prev.findIndex(q => q.id === anchor) : -1;
      if (targetIdx < 0 || anchorIdx < 0) {
        lastQueueSelectedRef.current = id;
        return prev.map(q => ({ ...q, selected: q.id === id }));
      }
      const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      return prev.map((q, i) => ({ ...q, selected: i >= lo && i <= hi }));
    });
  }, []);

  const clearQueuedSelection = useCallback(() => {
    setInputQueue(prev => prev.map(q => ({ ...q, selected: false })));
    lastQueueSelectedRef.current = null;
  }, []);

  // URLs flowing into the Extract button. Unresolved searches and unpicked
  // candidates stay out — a 5-hit search must never download all 5.
  const parsedUrls = useMemo(
    () => inputQueue.filter(q => q.kind !== 'search' && !q.candidateGroup).map(q => q.url),
    [inputQueue]);
  const candidateCount = useMemo(
    () => inputQueue.filter(q => !!q.candidateGroup).length,
    [inputQueue]);
  const canExtract = useMemo(
    () => parsedUrls.length > 0 && outputDir.length > 0,
    [parsedUrls, outputDir]
  );

  // Serial expand-or-probe driver. Picks the oldest 'pending' item,
  // flips it to 'probing', calls the wrapper's `expand` command which
  // returns 1 track (for a single-video URL) or N tracks (for a
  // playlist URL). Replaces the queue item with the resolved track(s).
  //
  // Single-call path covers both single-URL metadata AND playlist
  // expansion — yt-dlp's `--flat-playlist --print-json` returns the
  // same shape either way (1 entry for a video, N for a playlist).
  //
  // Backward compat: if the wrapper doesn't have `expand` yet (returns
  // empty tracks + no error), we fall back to the legacy `latch_probe`
  // single-URL path so old wrappers still get metadata for single
  // videos. Old wrappers + playlist URLs still hit the original
  // bug where --no-playlist on a playlist-only URL doesn't suppress
  // download — there's no JS workaround for that short of refusing
  // the extract, which would be annoying. Upgrade the wrapper to the
  // `expand` command and the bug goes away.
  //
  // Timeout: cap so a slow site (SoundCloud playlist with 200+ tracks)
  // doesn't hang the spinner forever. After timeout the item flips to
  // 'error' but stays extractable. 25s (was 12s): YouTube now requires a
  // JS-runtime challenge (nsig/PO token) during format selection, which
  // pushes the probe over 12s in the app's process context — and because
  // settle() is first-wins, the timeout was firing BEFORE the (successful)
  // probe returned, so its result got discarded and the title never showed.
  const PROBE_TIMEOUT_MS = 25000;
  // Serialize probing through a ref instead of an effect-cleanup cancel.
  // Setting an item to 'probing' mutates inputQueue, which re-runs this
  // effect — and a cleanup that flipped a `cancelled` flag there would
  // kill the probe it had just started, hanging the spinner forever
  // (the old bug). The ref gates "one probe at a time"; settle() makes
  // the timeout-vs-result race idempotent and frees the gate.
  const probeInFlightRef = useRef(false);
  useEffect(() => {
    if (probeInFlightRef.current) return;
    const next = inputQueue.find(q => q.probeState === 'pending');
    if (!next) return;
    const targetId = next.id;
    probeInFlightRef.current = true;
    setInputQueue(prev => prev.map(q =>
      q.id === targetId ? { ...q, probeState: 'probing' } : q
    ));

    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      probeInFlightRef.current = false;
      window.clearTimeout(timeoutId);
      return true;
    };
    const timeoutId = window.setTimeout(() => {
      if (!settle()) return;
      setInputQueue(prev => prev.map(q =>
        q.id === targetId
          ? { ...q, probeState: 'error', probeError: 'preview timed out: still extractable' }
          : q
      ));
    }, PROBE_TIMEOUT_MS);

    const finishWithSingleResult = (
      title: string,
      uploader: string,
      duration: number,
      errorMsg: string,
      thumbnail?: string,
    ) => {
      setInputQueue(prev => prev.map(q => {
        if (q.id !== targetId) return q;
        if (errorMsg) {
          return { ...q, probeState: 'error', probeError: errorMsg };
        }
        return {
          ...q,
          probeState: 'ok' as const,
          title:      title     || q.title,
          uploader:   uploader  || q.uploader,
          duration:   duration  || q.duration,
          thumbnail:  thumbnail || q.thumbnail,
        };
      }));
    };

    void (async () => {
      try {
        const isSearch = next.kind === 'search';
        // "Single video only" should skip the playlist enumeration ENTIRELY,
        // not just slice its result — otherwise pasting a watch URL with an
        // auto-appended radio mix (&list=RD…) enumerates hundreds of entries
        // (~13s) just to preview one video. Strip to the bare video up front.
        // (Searches keep their ytsearch URL; the download path still gets the
        // original url + noPlaylist flag, so extract-time behavior is unchanged.)
        const resolveUrl = (!isSearch && noPlaylist)
          ? youtubeVideoOnlyUrl(next.url)
          : next.url;
        const expandRes = await invoke<{
          tracks: { url: string; title: string; duration_s: number; uploader: string; thumbnail: string }[];
          error:  string;
        }>('latch_expand_url', {
          binaryPath: latchPath,
          url: resolveUrl,
          cookiesFromBrowser,
          cookiesFile,
        });

        if (expandRes.tracks.length === 0 && isSearch) {
          // A search that found nothing is just an empty result — the
          // legacy probe fallback would probe the ytsearch URL itself,
          // which downloads nothing useful.
          if (!settle()) return;
          setInputQueue(prev => prev.map(q =>
            q.id === targetId
              ? { ...q, probeState: 'error', probeError: expandRes.error || 'no results' }
              : q
          ));
          return;
        }

        if (expandRes.tracks.length === 0) {
          // No tracks — either the wrapper doesn't support `expand`
          // yet (old binary) or yt-dlp couldn't resolve the URL.
          // Fall back to the legacy single-URL probe.
          try {
            const probeRes = await invoke<ProbeResult>('latch_probe', {
              binaryPath: latchPath,
              url: next.url,
              cookiesFromBrowser,
              cookiesFile,
            });
            if (!settle()) return;
            finishWithSingleResult(
              probeRes.title,
              probeRes.uploader,
              probeRes.duration_s,
              probeRes.error || expandRes.error,
            );
          } catch (err: any) {
            if (!settle()) return;
            const msg = expandRes.error || String(err?.message ?? err);
            setInputQueue(prev => prev.map(q =>
              q.id === targetId
                ? { ...q, probeState: 'error', probeError: msg }
                : q
            ));
          }
          return;
        }

        if (!isSearch && expandRes.tracks.length === 1) {
          // Single track returned — same shape as a probe result.
          // Update metadata in place. (A search ALWAYS replaces the row
          // instead: its url is the ytsearch query, not the hit.)
          if (!settle()) return;
          const t = expandRes.tracks[0];
          finishWithSingleResult(t.title, t.uploader, t.duration_s, '', t.thumbnail);
          return;
        }

        // Playlist expansion OR search results. Replace this queue item
        // with N new items, each marked as 'ok' with pre-filled metadata.
        // A playlist honors the "Single video only" trim; a search keeps
        // every hit and marks the rows as candidates (pick one, the rest
        // dissolve) so a 5-hit search never downloads all 5.
        if (!settle()) return;
        const tracksToQueue = isSearch
          ? expandRes.tracks
          : noPlaylist ? expandRes.tracks.slice(0, 1) : expandRes.tracks;
        const groupId = isSearch && tracksToQueue.length > 1 ? targetId : undefined;
        setInputQueue(prev => {
          const idx = prev.findIndex(q => q.id === targetId);
          if (idx < 0) return prev;
          const otherUrls = new Set(
            prev.filter((_, i) => i !== idx).map(q => q.url)
          );
          const expanded: InputQueueItem[] = tracksToQueue
            .filter(t => t.url && !otherUrls.has(t.url))
            .map(t => ({
              id:         uid(),
              url:        t.url,
              title:      t.title,
              uploader:   t.uploader,
              duration:   t.duration_s,
              thumbnail:  t.thumbnail || undefined,
              probeState: 'ok' as const,
              selected:   false,
              candidateGroup: groupId,
            }));
          return [
            ...prev.slice(0, idx),
            ...expanded,
            ...prev.slice(idx + 1),
          ];
        });
      } catch (err: any) {
        if (!settle()) return;
        setInputQueue(prev => prev.map(q =>
          q.id === targetId
            ? { ...q, probeState: 'error', probeError: String(err?.message ?? err) }
            : q
        ));
      }
    })();
    // No cleanup-cancel: the in-flight ref serializes probes and settle()
    // owns the timeout. A cleanup flipping a `cancelled` flag here was the
    // infinite-spinner bug — it killed the probe it had just started.
  }, [inputQueue, latchPath, cookiesFromBrowser, noPlaylist]);

  // Pump — promotes queued items to extracting up to the concurrency
  // cap. Called from onExtract (after enqueueing) and from the event
  // listener (after a terminal event frees a slot). `pumpRef` is used
  // by the event listener to break the closure cycle.
  const pumpRef = useRef<(() => void) | null>(null);
  const pump = useCallback(() => {
    setItems(prev => {
      let started = 0;
      const next = prev.map(it => {
        if (it.status !== 'queued' || it.jobId) return it;
        if (inFlightRef.current + started >= EXTRACT_CONCURRENCY) return it;
        const newJobId = uid();
        started++;
        const cookiesUsed = it.lastCookies ?? cookiesFromBrowser;
        const options: LatchOptionsPayload = {
          // User-selected target format. Empty = no conversion
          // (source codec lands). Non-empty maps to yt-dlp's
          // --audio-format flag (mp3 / wav / flac / m4a / opus / etc).
          audioFormat:    audioFormat,
          noPlaylist,
          audioQuality:   '',
          embedMetadata,
          embedThumbnail,
          writeThumbnail,
          cropThumbnail,
          cookiesFromBrowser: cookiesUsed,
          cookiesFile,
          section,
          // Audio/Video force every link; Native downloads each link in its
          // own type (a video host as video, an audio host as audio).
          video:          mediaMode === 'video' || (mediaMode === 'native' && linkSourceKind(it.url) === 'video'),
          videoFormat:    videoFormat,
        };
        // Fire-and-forget the spawn; the wrapper emits all status via
        // `latch-event`. Errors here are spawn failures only (binary
        // missing, etc.); terminal job errors come through the listener.
        invoke('latch_extract', {
          windowLabel: 'main',
          jobId: newJobId,
          binaryPath: latchPath,
          url: it.url,
          outputDir,
          options,
        }).catch(err => {
          setItems(p => p.map(x =>
            x.id === it.id ? { ...x, status: 'failed', error: String(err?.message ?? err) } : x
          ));
          inFlightRef.current = Math.max(0, inFlightRef.current - 1);
          queueMicrotask(() => pumpRef.current?.());
        });
        return { ...it, jobId: newJobId };
      });
      inFlightRef.current += started;
      return next;
    });
  }, [latchPath, outputDir, audioFormat, mediaMode, videoFormat, noPlaylist, embedMetadata, embedThumbnail, writeThumbnail, cropThumbnail, cookiesFromBrowser, section]);
  pumpRef.current = pump;

  // Add new items to the queue with status 'queued'. Pump dispatches
  // them. Used by both onExtract and the per-row "Retry with cookies"
  // action (cookiesOverride lets the retry pin a specific browser
  // without mutating the user's saved default).
  const enqueueExtract = useCallback((
    urls: string[],
    cookiesOverride?: string,
  ) => {
    if (urls.length === 0 || !outputDir) return;
    if (!itemsRef.current.some(it => isActive(it.status))) batchSeqRef.current += 1;
    const batchId = batchSeqRef.current;
    setItems(prev => [
      ...urls.map<ExtractItem>(u => ({
        id: uid(),
        jobId: '',
        url: u,
        status: 'queued',
        percent: 0,
        batchId,
        lastCookies: cookiesOverride ?? undefined,
        selected: false,
      })),
      ...prev,
    ]);
    queueMicrotask(() => pumpRef.current?.());
  }, [outputDir]);

  const onExtract = useCallback(() => {
    if (!canExtract) return;
    enqueueExtract(parsedUrls);
    // Unresolved searches + unpicked candidates stay queued — only the
    // rows that actually went to extraction leave the input list.
    setInputQueue(prev => prev.filter(q => q.kind === 'search' || !!q.candidateGroup));
  }, [canExtract, parsedUrls, enqueueExtract]);

  // Prompt key handler — Enter commits the buffer to the queue (with
  // multi-URL splitting in case the user typed/pasted comma-separated
  // URLs into the input). Ctrl+Enter still fires the whole batch.
  const onPromptKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && canExtract) {
        onExtract();
        return;
      }
      const urls = parseUrlChunk(inputBuffer);
      if (urls.length > 0) {
        enqueueInputUrls(urls);
        setInputBuffer('');
      } else if (inputBuffer.trim()) {
        // Not a URL → treat the buffer as a yt-dlp search query.
        enqueueSearch(inputBuffer);
        setInputBuffer('');
      }
      return;
    }
    // Backspace on an empty buffer pops the most recently queued URL
    // — terminal-shell muscle memory ("delete the last entered line").
    if (e.key === 'Backspace' && inputBuffer === '' && inputQueue.length > 0) {
      e.preventDefault();
      const last = inputQueue[inputQueue.length - 1];
      removeQueuedUrl(last.id);
    }
  }, [canExtract, onExtract, inputBuffer, inputQueue, parseUrlChunk, enqueueInputUrls, enqueueSearch, removeQueuedUrl]);

  // Paste handler — if the clipboard payload yields more than one URL
  // (newlines or commas), enqueue them all and prevent the default
  // paste so they don't pile up as text in the input. A single-URL
  // paste falls through to the native input behavior so the user can
  // still edit it before committing.
  const onPromptPaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    const urls = parseUrlChunk(text);
    if (urls.length > 1) {
      e.preventDefault();
      enqueueInputUrls(urls);
      setInputBuffer('');
    }
  }, [parseUrlChunk, enqueueInputUrls]);

  // Window-level paste — URLs land in the queue no matter what has focus.
  // The prompt's own input keeps its richer paste handling above, and
  // other text fields keep their native paste (the tag check).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const text = e.clipboardData?.getData('text') ?? '';
      const urls = parseUrlChunk(text);
      if (urls.length > 0) {
        e.preventDefault();
        enqueueInputUrls(urls);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [parseUrlChunk, enqueueInputUrls]);

  // "Test cookies" — probes the current URL (or a known YouTube ref
  // if blank) with the active cookies setting. The probe can fail for
  // reasons that have nothing to do with cookies (format selector,
  // 404, JS runtime missing); we re-classify here so the cookie test
  // only reports cookie verdicts. If the probe fails on a non-cookie
  // axis but the cookie copy itself succeeded, we surface that as
  // "cookies usable, but URL has issues" rather than a flat fail.
  const onTestCookies = useCallback(async () => {
    if (!cookiesFromBrowser && !cookiesFile) {
      setCookieTest({ state: 'fail', message: 'pick a browser or load a cookies.txt first' });
      return;
    }
    // Fallback target for the cookie probe (no download): Blender's
    // Big Buck Bunny, a Creative Commons short — a deliberately non-
    // copyrighted reference just to exercise the cookie gate.
    const target = parsedUrls[0] ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    setCookieTest({ state: 'testing' });
    try {
      const res = await invoke<ProbeResult>('latch_probe', {
        binaryPath: latchPath,
        url: target,
        cookiesFromBrowser,
        cookiesFile,
      });
      if (!res.error) {
        setCookieTest({ state: 'ok', message: `cookies ok · ${res.title || 'reachable'}` });
        return;
      }
      // Cookie-axis failures: the browser DB couldn't be read at all,
      // or the host explicitly rejected our session.
      const lower = res.error.toLowerCase();
      const cookieAxisFail = (
        lower.includes('could not copy') && lower.includes('cookie')
      ) || lower.includes('dpapi') || lower.includes('decrypt')
        || lower.includes('sign in to confirm') || lower.includes('not a bot')
        || (lower.includes('cookies') && !lower.includes('format'));
      if (cookieAxisFail) {
        setCookieTest({ state: 'fail', message: res.error });
      } else {
        // Cookies got through; the URL has a different issue (format,
        // JS runtime, age gate, region lock). Tell the user cookies
        // are fine so they don't keep tweaking that knob.
        setCookieTest({
          state: 'ok',
          message: 'cookies ok · URL has a separate issue',
        });
      }
    } catch (err: any) {
      setCookieTest({ state: 'fail', message: String(err?.message ?? err) });
    }
  }, [latchPath, cookiesFromBrowser, cookiesFile, parsedUrls]);

  // Self-update yt-dlp via the wrapper. Output streams into
  // updateState.log; the small overlay shows the last few lines.
  const onUpdateYtDlp = useCallback(async () => {
    if (updateState.running) return;
    const jobId = uid();
    setUpdateState({ running: true, log: [] });
    try {
      await invoke('latch_update_ytdlp', {
        windowLabel: 'main',
        jobId,
        binaryPath: latchPath,
      });
    } catch (err: any) {
      setUpdateState({ running: false, log: [String(err?.message ?? err)], failed: true });
    }
  }, [updateState.running, latchPath]);

  // Pick the next browser to suggest for a retry. Skips the one that
  // already failed for this item so the suggestion is actually new.
  const suggestNextBrowser = useCallback((failed: string | undefined) => {
    if (cookiesFromBrowser && cookiesFromBrowser !== failed) return cookiesFromBrowser;
    const candidates = ['firefox', 'chrome', 'edge', 'brave'].filter(b => b !== failed);
    return candidates[0] ?? 'firefox';
  }, [cookiesFromBrowser]);

  // Load a cookies.txt (Netscape) file — the escape hatch when no browser
  // cookie store is readable. Persists into the shared cookie prefs.
  const onPickCookiesFile = useCallback(async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Select a cookies.txt file',
        filters: [{ name: 'cookies', extensions: ['txt'] }],
      });
      if (typeof picked === 'string') {
        setCookiesFile(picked);
        setCookieTest({ state: 'idle' });
      }
    } catch { /* dialog cancelled / unavailable */ }
  }, []);

  const hasCookieSource = !!cookiesFromBrowser || !!cookiesFile;

  // Domains known to wall downloads behind a sign-in. Drives the pre-flight
  // hint so a first-timer sees the fix before hitting the first failure.
  const isGatedUrl = useCallback((u: string) => {
    const GATED = ['youtube.com', 'youtu.be'];
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      return GATED.some(h => host === h || host.endsWith('.' + h));
    } catch { return /youtu\.?be/i.test(u); }
  }, []);
  const gatedPending = useMemo(
    () => !hasCookieSource && parsedUrls.some(isGatedUrl),
    [hasCookieSource, parsedUrls, isGatedUrl],
  );

  // Guided recovery from a bot-wall failure. With a readable cookie source
  // (current pick or a detected Firefox) we offer a one-click "use it & retry";
  // otherwise we explain the two real fixes (Firefox sign-in, or cookies.txt).
  const onFixBotWall = useCallback(async (url: string, failedBrowser: string | undefined) => {
    let recommended = '';
    try { recommended = (await invoke<{ recommended: string }>('detect_cookie_browsers')).recommended; } catch {}
    const usable = (cookiesFromBrowser && cookiesFromBrowser !== failedBrowser) ? cookiesFromBrowser : recommended;
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    if (usable) {
      const cap = usable.charAt(0).toUpperCase() + usable.slice(1);
      const ok = await confirmInWindow({
        title: 'This site blocked the download',
        message: `${host} blocks downloads until it sees you're signed in. Latch can use your ${cap} sign-in to get past it.\n\nMake sure you're signed into the site in ${cap}, then retry.`,
        confirmLabel: `Use ${cap} & retry`,
        cancelLabel: 'Not now',
      });
      if (ok) { setCookiesFromBrowser(usable); enqueueExtract([url], usable); }
    } else {
      await infoInWindow({
        title: 'This site blocked the download',
        message: `${host} blocks downloads until it sees you're signed in, and Latch couldn't find a browser to borrow that sign-in from.\n\nTwo ways to fix it:\n  1. Install Firefox, sign into the site there, then pick Firefox under Cookies.\n  2. Export a cookies.txt from your browser and load it with "Use cookies.txt".`,
        okLabel: 'Got it',
      });
    }
  }, [cookiesFromBrowser, enqueueExtract]);

  // Pre-flight cookie setup (from the gated-URL hint) — like onFixBotWall but
  // it doesn't extract anything; the user hasn't pressed Extract yet.
  const onSetupCookies = useCallback(async () => {
    let recommended = '';
    try { recommended = (await invoke<{ recommended: string }>('detect_cookie_browsers')).recommended; } catch {}
    if (recommended === 'firefox') {
      const ok = await confirmInWindow({
        title: 'Set up cookies for gated sites',
        message: "YouTube and similar sites block downloads unless they see you're signed in. Latch can use your Firefox sign-in.\n\nMake sure you're signed into the site in Firefox.",
        confirmLabel: 'Use Firefox',
        cancelLabel: 'Not now',
      });
      if (ok) setCookiesFromBrowser('firefox');
    } else {
      await infoInWindow({
        title: 'Set up cookies for gated sites',
        message: "YouTube and similar sites block downloads unless they see you're signed in, and Latch couldn't find a browser to borrow a sign-in from.\n\nFix it by either:\n  1. Install Firefox, sign into the site, then pick Firefox under Cookies.\n  2. Export a cookies.txt and load it with \"Use cookies.txt\".",
        okLabel: 'Got it',
      });
    }
  }, []);

  // Optimistic cancel — flip the row to 'cancelled' and decrement the
  // in-flight counter on the JS side immediately, then fire the IPC.
  // The wrapper SHOULD also emit a 'cancelled' event when its yt-dlp
  // child dies, but in practice that event sometimes never arrives
  // (kill races, OS-level signal swallowing, playlist mode swallowing
  // the per-track cancel). Without an optimistic update the row spins
  // forever and the pump never frees the slot. The downstream event
  // handler is idempotent — if 'cancelled' DOES arrive later it
  // re-applies the same state and the inFlight clamp prevents the
  // counter from going negative.
  const onCancelItem = useCallback((jobId: string, itemId?: string) => {
    void invoke('latch_cancel', { jobId });
    if (itemId) {
      setItems(prev => prev.map(it =>
        it.id === itemId && isActive(it.status)
          ? { ...it, status: 'cancelled' }
          : it
      ));
      inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      queueMicrotask(() => pumpRef.current?.());
    }
  }, []);

  // Remove a terminal-state row from the list. Active items use the
  // cancel path (onCancelItem) — calling this on an active row is a
  // bug, so the row's X handler chooses between them by status.
  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(it => it.id !== id));
    if (lastSelectedRef.current === id) lastSelectedRef.current = null;
  }, []);

  // Wipe every non-active item from the list. Skipping active items
  // keeps the in-flight progress visible — clearing should be safe
  // even mid-batch. Done files on disk are untouched.
  const clearFinished = useCallback(() => {
    setItems(prev => prev.filter(it => isActive(it.status)));
    lastSelectedRef.current = null;
  }, []);

  // Selection click semantics — mirror Lathe's inputs panel so muscle
  // memory carries across tools.
  const selectItem = useCallback((id: string, mode: 'single' | 'toggle' | 'range') => {
    setItems(prev => {
      if (mode === 'single') {
        lastSelectedRef.current = id;
        return prev.map(it => ({ ...it, selected: it.id === id }));
      }
      if (mode === 'toggle') {
        lastSelectedRef.current = id;
        return prev.map(it => it.id === id ? { ...it, selected: !it.selected } : it);
      }
      const anchor    = lastSelectedRef.current;
      const targetIdx = prev.findIndex(it => it.id === id);
      const anchorIdx = anchor ? prev.findIndex(it => it.id === anchor) : -1;
      if (targetIdx < 0 || anchorIdx < 0) {
        lastSelectedRef.current = id;
        return prev.map(it => ({ ...it, selected: it.id === id }));
      }
      const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      return prev.map((it, i) => ({ ...it, selected: i >= lo && i <= hi }));
    });
  }, []);

  const selectAllItems = useCallback(() => {
    setItems(prev => prev.map(it => ({ ...it, selected: true })));
  }, []);

  const clearSelection = useCallback(() => {
    setItems(prev => prev.map(it => ({ ...it, selected: false })));
    lastSelectedRef.current = null;
  }, []);

  // Reveal a finished extract in the OS file manager — Explorer on
  // Windows with the file pre-selected, Finder on macOS, xdg-open
  // parent on Linux. Wraps os_reveal_path which is shared with the
  // main file-explorer "Show in Folder" action.
  const onRevealItem = useCallback((path: string) => {
    if (!path) return;
    void invoke('os_reveal_path', { path }).catch(err => {
      console.warn('os_reveal_path failed:', err);
    });
  }, []);

  // Status-bar source: prefer the first actively-extracting item (the
  // one the progress bar is tracking). Falls back to the freshest queued
  // entry so the bar surfaces "queued" before yt-dlp has emitted its
  // first progress event.
  const statusItem = useMemo(() => {
    const live = items.find(it => it.status === 'extracting');
    if (live) return live;
    return items.find(it => it.status === 'queued');
  }, [items]);
  const activeCount = useMemo(
    () => items.filter(it => isActive(it.status)).length,
    [items]
  );
  // Done items the user actually wants to drag/export. Multi-select
  // drag-out drags all selected-and-done; if nothing is selected,
  // single-row drag still works on whatever row started it.
  const selectedDonePaths = useMemo(
    () => items.filter(it => it.selected && it.status === 'done' && it.output).map(it => it.output!),
    [items]
  );
  // Batch-aware progress: finished/total + summed percent over the items
  // of the CURRENT batch only, so old session rows don't skew the bar.
  const batchProgress = useMemo(() => {
    const bid = batchSeqRef.current;
    const batch = items.filter(it => it.batchId === bid);
    if (batch.length === 0) return null;
    const finished = batch.filter(it => !isActive(it.status)).length;
    const activePct = batch.reduce((a, it) =>
      a + (it.status === 'extracting' ? Math.min(100, Math.max(0, it.percent)) : 0), 0);
    return { finished, total: batch.length, overall: ((finished * 100) + activePct) / batch.length };
  }, [items]);
  const selectedCount = useMemo(
    () => items.filter(it => it.selected).length,
    [items]
  );

  return (
    <div
      className="h-screen flex flex-col font-mono select-none text-zinc-300 relative"
      style={{ background: THEME_BG[theme] ?? '#09090b' }}
    >
      {/* Title bar */}
      <div
        data-tauri-drag-region
        className="h-7 bg-zinc-950 border-b border-zinc-800 flex items-center px-2 shrink-0"
      >
        <Download size={11} className="text-zinc-400 mr-1.5" />
        <span
          data-tauri-drag-region
          className="text-[0.625rem] font-bold uppercase tracking-tight text-zinc-300"
        >
          Latch
        </span>
        {binStatus && (
          <span
            className="ml-1.5 flex items-center"
            title={
              binStatus.resolved
                ? `Connected · ${binStatus.source}\n${binStatus.path}`
                : `Not connected\n${binStatus.message}`
            }
          >
            {binStatus.resolved
              ? <Link2     size={10} className="text-emerald-400" />
              : <Link2Off  size={10} className="text-zinc-400" />}
          </span>
        )}
        <button
          onClick={onUpdateYtDlp}
          disabled={!binStatus?.resolved || updateState.running}
          className="ml-auto text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-0.5 transition-none disabled:opacity-30 disabled:hover:bg-transparent"
          title="Check for yt-dlp updates"
        >
          <RefreshCw size={11} className={updateState.running ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => { void getCurrentWindow().minimize().catch(() => {}); }}
          className="text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-0.5 transition-none"
          title="Minimize"
        >
          <Minus size={11} />
        </button>
        <button
          onClick={close}
          className="text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-0.5 transition-none"
          title="Close"
        >
          <X size={11} />
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* LEFT: URL — input prompt + queued-URL display. Two layouts:
            terminal (faux shell with $-prompt + line-numbered rows) or
            cards (thumbnail-style stack). View toggle in the header is
            persisted to localStorage. Both modes feed the same
            inputQueue → Extract pipeline; only the rendering differs. */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-zinc-800">
          <div className="h-7 px-2 border-b border-zinc-800 flex items-center gap-2 shrink-0">
            <span className="text-[0.5625rem] uppercase font-bold tracking-tight text-zinc-500">
              URL
            </span>
            {inputQueue.length > 0 && (
              <span className="text-[0.5625rem] text-zinc-600">
                · {inputQueue.length}
              </span>
            )}
            {/* View toggle — segmented control. ml-auto pushes it to
                the right edge of the header. */}
            <div className="ml-auto flex items-center bg-zinc-900 border border-zinc-800">
              <button
                onClick={() => setUrlViewMode('terminal')}
                className={`flex items-center justify-center px-1.5 h-4 transition-none ${
                  urlViewMode === 'terminal'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Terminal view"
                aria-pressed={urlViewMode === 'terminal'}
              >
                <Terminal size={9} />
              </button>
              <button
                onClick={() => setUrlViewMode('cards')}
                className={`flex items-center justify-center px-1.5 h-4 transition-none ${
                  urlViewMode === 'cards'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Cards view"
                aria-pressed={urlViewMode === 'cards'}
              >
                <LayoutList size={9} />
              </button>
            </div>
          </div>

          {gatedPending && (
            <button
              onClick={() => void onSetupCookies()}
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-zinc-800 text-[0.5rem] leading-snug text-[color:var(--theme-warn-fg)] hover:bg-zinc-900/60 transition-none text-left cursor-pointer"
              title="YouTube blocks downloads without a browser sign-in. Click to set one up."
            >
              <ShieldAlert size={9} className="shrink-0" />
              <span className="flex-1">YouTube usually blocks downloads without a browser sign-in — set a cookie source ▸</span>
            </button>
          )}

          {urlViewMode === 'terminal' ? (
            /* ─── TERMINAL VIEW ───────────────────────────────────────
                $ prompt with blinking block caret, italicised hint
                above when empty, line-numbered selectable rows below. */
            <div
              className="flex-1 flex flex-col px-2 py-2 gap-1 min-h-0 cursor-text"
              onClick={(e) => {
                // Click anywhere in the empty area of the panel re-
                // focuses the prompt. Rows stopPropagation so clicking
                // a row doesn't steal focus from selection.
                if (e.target === e.currentTarget) {
                  promptInputRef.current?.focus();
                  clearQueuedSelection();
                }
              }}
            >
              {/* Hint above the prompt — only shown while the user has
                  nothing in the buffer and no rows queued. */}
              {!inputBuffer && inputQueue.length === 0 && (
                <span className="text-[0.5625rem] italic text-zinc-700 leading-tight font-mono select-none">
                  input URL or yt-dlp search…
                </span>
              )}
              {/* The prompt line. Hidden real <input> captures keystrokes
                  via the wrapper's onClick → focus; the visible text +
                  block caret are siblings that render the same value.
                  The scroll container clips long URLs at the panel edge
                  and the auto-scroll effect keeps the caret end-visible
                  (terminal behavior — see the last-N-chars window). */}
              <div
                className="font-mono flex items-center gap-1.5 text-[0.625rem] relative min-w-0"
                onClick={() => promptInputRef.current?.focus()}
              >
                <span className="text-emerald-400 font-bold select-none shrink-0">latch</span>
                <span className="text-zinc-400 select-none shrink-0">$</span>
                <div
                  ref={promptScrollRef}
                  className="flex-1 min-w-0 overflow-x-hidden whitespace-nowrap flex items-center"
                >
                  <span className="text-zinc-100">{inputBuffer}</span>
                  <span className={`wd-latch-caret${inputFocused ? ' wd-latch-caret--active' : ''}`} />
                </div>
                {/* "press Enter" hint — only visible while there's text
                    in the buffer and the prompt is focused. Sits at the
                    right edge of the prompt line so it doesn't fight
                    with the scrolling URL display. */}
                {inputBuffer && inputFocused && (
                  <span className="text-[0.5rem] italic text-zinc-600 shrink-0 select-none">
                    enter ↵
                  </span>
                )}
                <input
                  ref={promptInputRef}
                  value={inputBuffer}
                  onChange={(e) => setInputBuffer(e.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  onKeyDown={onPromptKeyDown}
                  onPaste={onPromptPaste}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  type="text"
                  aria-label="URL prompt"
                  // Off-screen but in tab order — captures keystrokes
                  // without rendering its own caret/text. caretColor
                  // transparent kills any browser fallback paint.
                  className="absolute -left-[9999px] opacity-0 w-0 h-0 pointer-events-none"
                  style={{ caretColor: 'transparent' }}
                />
              </div>
              {/* Queued URL rows — line-numbered, selectable. */}
              <div
                className="flex-1 min-h-0 overflow-y-auto -mx-2"
                onClick={(e) => {
                  if (e.target === e.currentTarget) clearQueuedSelection();
                }}
              >
                {inputQueue.map((q, idx) => (
                  <div
                    key={q.id}
                    className={`group flex items-center gap-2 px-2 py-0.5 text-[0.625rem] font-mono transition-none ${
                      q.selected
                        ? 'bg-zinc-800/70 text-zinc-100'
                        : 'hover:bg-zinc-900/60 text-zinc-300'
                    }`}
                    title={q.title ?? q.url}
                    onClick={(e) => {
                      e.stopPropagation();
                      const mode = e.shiftKey ? 'range' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'single';
                      selectQueuedUrl(q.id, mode);
                    }}
                  >
                    <span className="text-zinc-700 select-none shrink-0">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="shrink-0 w-2.5 flex items-center justify-center">
                      {q.kind === 'search' && q.probeState !== 'probing' && <Search size={8} className="text-zinc-500" />}
                      {q.probeState === 'probing' && <Loader2 size={8} className="animate-spin text-zinc-500" />}
                      {q.kind !== 'search' && q.probeState === 'ok' && !q.candidateGroup && <CheckCircle2 size={8} className="text-emerald-500" />}
                      {q.probeState === 'error'   && <span title={q.probeError ?? 'preview failed'} className="inline-flex items-center justify-center p-1 -m-1 cursor-help"><AlertTriangle size={11} className="text-[color:var(--theme-warn-fg)]" /></span>}
                    </span>
                    <span className={`flex-1 min-w-0 truncate ${q.candidateGroup ? 'text-sky-300/90' : ''}`}>
                      {q.title ?? q.url}
                    </span>
                    {q.duration ? (
                      <span className="text-zinc-600 shrink-0">{formatDuration(q.duration)}</span>
                    ) : null}
                    {/* Search candidates: keep-this-one button. Picking
                        dissolves the sibling hits; until then the row is
                        excluded from Extract. */}
                    {q.candidateGroup && (
                      <button
                        onClick={(e) => { e.stopPropagation(); pickCandidate(q.id); }}
                        className="text-emerald-500/80 hover:text-emerald-300 transition-none shrink-0 cursor-pointer"
                        title="Keep this result (clears the other candidates)"
                      >
                        <Check size={10} />
                      </button>
                    )}
                    {/* Source-kind glyph (informative only): film for video
                        hosts, music note for audio hosts. */}
                    {q.kind !== 'search' && (
                      <span
                        className="text-zinc-600 shrink-0"
                        title={linkSourceKind(q.url) === 'video' ? 'Video source' : 'Audio source'}
                      >
                        {linkSourceKind(q.url) === 'video' ? <Film size={9} /> : <Music size={9} />}
                      </span>
                    )}
                    {/* Chop entry point — audio-only in the standalone app
                        until the video-engine port (the chop window runs
                        its own download, so it doesn't wait on the probe).
                        Hidden while a search is still resolving. */}
                    {q.kind !== 'search' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void openChopWindow({ url: q.url, includeVideo: linkSourceKind(q.url) === 'video', latchPath, title: q.title, durationSec: q.duration, cookiesFromBrowser }); }}
                        className="wd-slide-action text-sky-500/80 hover:text-sky-300 shrink-0 cursor-pointer"
                        title="Chop: draw waveform selections and export clips"
                      >
                        <Scissors size={10} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeQueuedUrl(q.id); }}
                      className="wd-slide-action text-zinc-600 hover:text-zinc-300 shrink-0"
                      title="Remove"
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* ─── CARDS VIEW ──────────────────────────────────────────
                Standard input field at top, vertical card stack below
                showing each queued URL with thumbnail-slot + title +
                channel + duration. */
            <div className="flex-1 flex flex-col px-3 py-2 gap-2 min-h-0">
              <input
                ref={promptInputRef}
                value={inputBuffer}
                onChange={(e) => setInputBuffer(e.target.value)}
                onKeyDown={onPromptKeyDown}
                onPaste={onPromptPaste}
                placeholder="url or search: Enter to queue, Ctrl+Enter to extract"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-[0.625rem] px-2 h-6 font-mono focus:outline-none focus:border-zinc-500"
              />
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
                {inputQueue.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-[0.5625rem] text-zinc-700 px-4 text-center pointer-events-none">
                    queued URLs appear here as cards
                  </div>
                ) : (
                  inputQueue.map(q => (
                    <div
                      key={q.id}
                      className="group bg-zinc-900/40 border border-zinc-800 hover:border-zinc-700 px-2 py-1.5 flex items-start gap-2 text-[0.625rem] transition-none"
                      title={q.title ?? q.url}
                    >
                      {/* Thumbnail slot — uses the URL `latch expand`
                          returns when available, falls back to a
                          generic Download icon block. Image loads
                          lazily; broken/unreachable URLs degrade
                          silently to the icon via onError. */}
                      <div className="w-10 h-10 bg-zinc-900 border border-zinc-800 shrink-0 flex items-center justify-center overflow-hidden">
                        {q.thumbnail ? (
                          <img
                            src={q.thumbnail}
                            alt=""
                            loading="lazy"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              // Hide on load failure so the icon
                              // beneath becomes visible.
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <Download size={12} className="text-zinc-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col gap-0.5 pt-0.5">
                        <span className="truncate text-zinc-200">
                          {q.title ?? q.url}
                        </span>
                        <span className="text-[0.5rem] text-zinc-500 truncate flex items-center gap-1">
                          {q.probeState === 'probing' && (
                            <><Loader2 size={8} className="animate-spin" /> fetching metadata…</>
                          )}
                          {q.probeState === 'pending' && <span className="text-zinc-700">waiting…</span>}
                          {q.probeState === 'ok' && (
                            <>
                              {q.uploader && <span>{q.uploader}</span>}
                              {q.uploader && q.duration ? <span> · </span> : null}
                              {q.duration ? <span>{formatDuration(q.duration)}</span> : null}
                            </>
                          )}
                          {q.probeState === 'error' && (
                            <span className="text-[color:var(--theme-warn-dim)] truncate" title={q.probeError}>
                              {q.probeError || 'preview failed'}
                              {classifyError(q.probeError) === 'bot-wall'
                                ? ' — set Cookies in Advanced and retry'
                                : ''}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex flex-col items-center gap-1 shrink-0">
                        <button
                          onClick={() => removeQueuedUrl(q.id)}
                          className="wd-slide-action text-zinc-600 hover:text-zinc-300"
                          title="Remove"
                        >
                          <X size={10} />
                        </button>
                        {q.candidateGroup && (
                          <button
                            onClick={() => pickCandidate(q.id)}
                            className="text-emerald-500/80 hover:text-emerald-300 transition-none cursor-pointer"
                            title="Keep this result (clears the other candidates)"
                          >
                            <Check size={10} />
                          </button>
                        )}
                        {q.kind !== 'search' && (
                          <span
                            className="text-zinc-600"
                            title={linkSourceKind(q.url) === 'video' ? 'Video source' : 'Audio source'}
                          >
                            {linkSourceKind(q.url) === 'video' ? <Film size={10} /> : <Music size={10} />}
                          </span>
                        )}
                        {q.kind !== 'search' && (
                          <button
                            onClick={() => void openChopWindow({ url: q.url, includeVideo: linkSourceKind(q.url) === 'video', latchPath, title: q.title, durationSec: q.duration, cookiesFromBrowser })}
                            className="text-sky-500/80 hover:text-sky-300 transition-none cursor-pointer"
                            title="Chop: draw waveform selections and export clips (audio)"
                          >
                            <Scissors size={10} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          {/* Rights reminder — appears once a link is queued. Small + muted
              so it nudges without impeding. */}
          {inputQueue.length > 0 && (
            <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-t border-zinc-800 text-[0.5rem] leading-snug text-zinc-700">
              <AlertTriangle size={9} className="shrink-0" />
              <span>Only download material you own or have the rights to use.</span>
            </div>
          )}
        </div>

        {/* MIDDLE: format + destination + advanced + extract. Width
            matches Lathe's Configure column (210px) so the status-bar
            cells below align cleanly with the panels above. */}
        <div className="w-[210px] shrink-0 flex flex-col border-r border-zinc-800">
          <div className="h-7 px-2 border-b border-zinc-800 flex items-center gap-2 shrink-0">
            <span className="text-[0.5625rem] uppercase font-bold tracking-tight text-zinc-500">
              Config
            </span>
          </div>
          <div className="flex-1 flex flex-col px-3 py-2 gap-2 min-h-0 overflow-y-auto">
            {/* Download mode — segmented control. Audio forces yt-dlp's -x
                extract for every link; Video merges bestvideo+bestaudio for
                every link; Native downloads each link in its own type (a
                video host as video, an audio host as audio). The Format
                controls below show whichever apply. */}
            <div className="flex flex-col gap-0.5">
              <label className="text-[0.5rem] uppercase tracking-widest text-zinc-500">Mode</label>
              <div className="flex items-center bg-zinc-900 border border-zinc-800">
                {([
                  { v: 'audio',  label: 'Audio',  title: 'Download audio for every link' },
                  { v: 'video',  label: 'Video',  title: 'Download video for every link' },
                  { v: 'native', label: 'Native', title: "Download each link in its native type (video links as video, audio links as audio)" },
                ] as const).map(({ v, label, title }) => (
                  <button
                    key={v}
                    onClick={() => setMediaMode(v)}
                    title={title}
                    className={`flex-1 px-2 h-5 text-[0.5625rem] uppercase tracking-wider transition-none ${
                      mediaMode === v ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    aria-pressed={mediaMode === v}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {mediaMode !== 'video' && (
              <div className="flex flex-col gap-0.5">
                <label className="text-[0.5rem] uppercase tracking-widest text-zinc-500">{mediaMode === 'native' ? 'Audio format' : 'Format'}</label>
                <WdSelect<string>
                  value={audioFormat}
                  onChange={setAudioFormat}
                  ariaLabel="Audio format"
                  options={[
                    { value: '',     label: 'Original (no conversion)' },
                    { value: 'wav',  label: 'WAV (lossless)' },
                    { value: 'flac', label: 'FLAC (lossless)' },
                    { value: 'mp3',  label: 'MP3' },
                    { value: 'm4a',  label: 'M4A / AAC' },
                    { value: 'opus', label: 'OPUS' },
                  ]}
                />
                <span className="text-[0.5rem] text-zinc-600 leading-snug px-0.5 mt-0.5">
                  {audioFormat === ''
                    ? 'Source codec lands as-is (m4a / opus / webm).'
                    : `Re-encoded to ${audioFormat.toUpperCase()} via ffmpeg after download.`}
                </span>
              </div>
            )}
            {mediaMode !== 'audio' && (
              <div className="flex flex-col gap-0.5">
                <label className="text-[0.5rem] uppercase tracking-widest text-zinc-500">Container</label>
                <WdSelect<string>
                  value={videoFormat}
                  onChange={setVideoFormat}
                  ariaLabel="Video container"
                  options={[
                    { value: '',     label: 'Best (yt-dlp picks)' },
                    { value: 'mp4',  label: 'MP4' },
                    { value: 'webm', label: 'WEBM' },
                    { value: 'mkv',  label: 'MKV' },
                    { value: 'mov',  label: 'MOV' },
                  ]}
                />
                <span className="text-[0.5rem] text-zinc-600 leading-snug px-0.5 mt-0.5">
                  Best video + best audio, merged via ffmpeg.
                  {videoFormat ? ` Container forced to ${videoFormat.toUpperCase()}.` : ''}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              <label className="text-[0.5rem] uppercase tracking-widest text-zinc-500">Save to</label>
              <button
                onClick={onPickDir}
                className="bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 text-[0.625rem] px-2 h-5 flex items-center gap-1.5 text-left transition-none"
                title={outputDir || 'Pick output directory'}
              >
                <FolderOpen size={10} className="shrink-0" />
                <span className="flex-1 min-w-0 truncate">
                  {outputDir
                    ? outputDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
                    : 'Choose folder…'}
                </span>
              </button>
            </div>

            <button
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1 text-[0.5rem] uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-none mt-1"
            >
              {showAdvanced ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
              Advanced
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-1.5 pl-2 border-l border-zinc-800">
                <label className="flex items-center gap-1.5 text-[0.5625rem] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={noPlaylist}
                    onChange={(e) => setNoPlaylist(e.target.checked)}
                    className="accent-zinc-400"
                  />
                  Single video only
                </label>
                <span className="text-[0.5rem] text-zinc-600 -mt-1 leading-snug pl-5">
                  When a pasted URL expands into a playlist, queue only the
                  first track. Uncheck to add every track as its own row.
                </span>
                <label className="flex items-center gap-1.5 text-[0.5625rem] text-zinc-300 cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    checked={embedMetadata}
                    onChange={(e) => setEmbedMetadata(e.target.checked)}
                    className="accent-zinc-400"
                  />
                  Embed metadata
                </label>
                {/* Cover art — three toggles on the one source thumbnail.
                    Save + Embed default ON (a .png lands next to every
                    download and the art rides inside the file); Crop
                    center-squares both. Crop only bites when something
                    consumes the thumbnail, so it greys out when neither
                    Save nor Embed is on. */}
                <div className="flex items-center gap-1 text-[0.5rem] uppercase tracking-widest text-zinc-600 mt-1.5">
                  <ImageIcon size={8} /> Cover art
                </div>
                <label className="flex items-center gap-1.5 text-[0.5625rem] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={writeThumbnail}
                    onChange={(e) => setWriteThumbnail(e.target.checked)}
                    className="accent-zinc-400"
                  />
                  Save as PNG
                </label>
                <span className="text-[0.5rem] text-zinc-600 -mt-1 leading-snug pl-5">
                  Drops the cover art next to the download as a .png.
                </span>
                <label
                  className={`flex items-center gap-1.5 text-[0.5625rem] cursor-pointer mt-1 ${
                    (writeThumbnail || embedThumbnail) ? 'text-zinc-300' : 'text-zinc-600 cursor-not-allowed'
                  }`}
                  title={(writeThumbnail || embedThumbnail) ? undefined : 'Turn on Save as PNG or Embed first'}
                >
                  <input
                    type="checkbox"
                    checked={cropThumbnail}
                    disabled={!writeThumbnail && !embedThumbnail}
                    onChange={(e) => setCropThumbnail(e.target.checked)}
                    className="accent-zinc-400 disabled:opacity-40"
                  />
                  Crop to square
                </label>
                <span className="text-[0.5rem] text-zinc-600 -mt-1 leading-snug pl-5">
                  Center-crops 16:9 thumbnails to album-cover shape (saved + embedded).
                </span>
                <label className="flex items-center gap-1.5 text-[0.5625rem] text-zinc-300 cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    checked={embedThumbnail}
                    onChange={(e) => setEmbedThumbnail(e.target.checked)}
                    className="accent-zinc-400"
                  />
                  Embed into file
                </label>
                <span className="text-[0.5rem] text-zinc-600 -mt-1 leading-snug pl-5">
                  Muxes the cover art into the output (mp3 / m4a / opus / mp4).
                </span>
                <div className="flex flex-col gap-0.5 mt-1.5">
                  <label className="text-[0.5rem] uppercase tracking-widest text-zinc-600 flex items-center gap-1">
                    <Cookie size={8} /> Cookies from browser
                  </label>
                  <div className="flex items-center gap-1">
                    <div
                      className="flex-1 min-w-0"
                      title="Borrow your browser's session cookies. Required for YouTube and any site that walls downloads behind a sign-in. Chrome must be closed for cookie reads to succeed; Firefox is the most reliable."
                    >
                      <WdSelect<string>
                        value={cookiesFromBrowser}
                        onChange={(v) => { setCookiesFromBrowser(v); setCookieTest({ state: 'idle' }); }}
                        ariaLabel="Cookies from browser"
                        options={BROWSERS.map((b): WdSelectOption<string> => ({ value: b.value, label: b.label }))}
                      />
                    </div>
                    <button
                      onClick={onTestCookies}
                      disabled={(!cookiesFromBrowser && !cookiesFile) || cookieTest.state === 'testing'}
                      className="text-[0.5rem] uppercase tracking-wider px-1.5 h-5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-30 transition-none shrink-0"
                      title="Run a dry-run probe against the current URL (or a YouTube reference) using these cookies. Confirms the gate is unlocked without doing a real extraction."
                    >
                      Test
                    </button>
                  </div>
                  {cookieTest.state !== 'idle' && (
                    <div className="flex items-start gap-1 mt-0.5">
                      {cookieTest.state === 'testing' && <Loader2 size={8} className="text-zinc-500 animate-spin mt-0.5 shrink-0" />}
                      {cookieTest.state === 'ok'      && <CheckCircle2 size={8} className="text-emerald-400 mt-0.5 shrink-0" />}
                      {cookieTest.state === 'fail'    && <XCircle size={8} className="text-zinc-400 mt-0.5 shrink-0" />}
                      <span
                        className={`text-[0.5rem] leading-snug break-words ${
                          cookieTest.state === 'ok'   ? 'text-emerald-400/80' :
                          cookieTest.state === 'fail' ? 'text-zinc-400/80' :
                          'text-zinc-500'
                        }`}
                        title={cookieTest.message}
                      >
                        {cookieTest.message}
                      </span>
                    </div>
                  )}
                  {/* cookies.txt escape hatch — for when no browser store is
                      readable (Chrome locked/encrypted, no Firefox). */}
                  <div className="flex items-center gap-1 mt-0.5">
                    <button
                      onClick={onPickCookiesFile}
                      className="flex items-center gap-1 text-[0.5rem] uppercase tracking-wider px-1.5 h-5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-500 text-zinc-300 transition-none shrink-0 cursor-pointer"
                      title="Load a Netscape cookies.txt exported from your browser (yt-dlp --cookies). Use this when browser cookie reads fail."
                    >
                      <FileText size={8} /> {cookiesFile ? 'Change cookies.txt' : 'Use cookies.txt'}
                    </button>
                    {cookiesFile && (
                      <>
                        <span className="flex-1 min-w-0 truncate text-[0.5rem] text-emerald-400/80" title={cookiesFile}>
                          {cookiesFile.split(/[\\/]/).pop()}
                        </span>
                        <button
                          onClick={() => { setCookiesFile(''); setCookieTest({ state: 'idle' }); }}
                          className="text-zinc-600 hover:text-zinc-300 transition-none shrink-0 cursor-pointer"
                          title="Stop using the cookies.txt file"
                        >
                          <X size={9} />
                        </button>
                      </>
                    )}
                  </div>
                  {!hasCookieSource && (
                    <span className="flex items-start gap-1 text-[0.5rem] leading-snug text-[color:var(--theme-warn-fg)] mt-0.5">
                      <ShieldAlert size={8} className="shrink-0 mt-0.5" />
                      No cookie source set: YouTube and similar sites will likely block downloads.
                    </span>
                  )}
                  {firefoxAutoNotice && (
                    <span className="flex items-start gap-1 text-[0.5rem] leading-snug text-zinc-500 mt-0.5">
                      <Info size={8} className="shrink-0 mt-0.5 text-emerald-400/70" />
                      <span className="flex-1">Using Firefox cookies for sites that need a sign-in. Change it anytime here.</span>
                      <button
                        onClick={() => setFirefoxAutoNotice(false)}
                        className="text-zinc-600 hover:text-zinc-300 shrink-0 cursor-pointer"
                        title="Dismiss"
                      >
                        <X size={8} />
                      </button>
                    </span>
                  )}
                  <span className="text-[0.5rem] text-zinc-600 leading-snug pl-0.5 mt-0.5">
                    Required for YouTube. Chrome must be closed when extracting.
                    Firefox is most reliable.
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 mt-1">
                  <label className="text-[0.5rem] uppercase tracking-widest text-zinc-600">
                    Download range only
                  </label>
                  <input
                    type="text"
                    value={section}
                    onChange={(e) => setSection(e.target.value)}
                    placeholder="e.g. 00:30-02:15"
                    spellCheck={false}
                    className={`bg-zinc-900 border text-zinc-200 text-[0.5625rem] font-mono px-1.5 h-5 focus:outline-none ${
                      !section || SECTION_RE.test(section.trim())
                        ? 'border-zinc-700 focus:border-zinc-500'
                        : 'border-zinc-700/60 focus:border-zinc-600'
                    }`}
                  />
                  <span className="text-[0.5rem] text-zinc-600 leading-snug pl-0.5 mt-0.5">
                    Fetches just this slice (e.g. <span className="text-zinc-400">00:30-02:15</span>),
                    not the whole file: fast for grabbing one part, but keyframe-snapped.
                    For visual multi-region cuts use <span className="text-sky-400/80">Chop</span> (✂).
                    Empty = full file.
                  </span>
                </div>
              </div>
            )}

            <div className="border-t border-zinc-800 mt-1" />

            <button
              onClick={onExtract}
              disabled={!canExtract}
              className="px-4 h-7 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 border border-zinc-600 hover:border-zinc-500 disabled:opacity-30 disabled:hover:bg-zinc-700 text-[0.5625rem] uppercase font-bold transition-none"
            >
              Extract{parsedUrls.length > 1 ? ` (${parsedUrls.length})` : ''}
            </button>
          </div>
        </div>

        {/* RIGHT: landing zone — completed/failed downloads land here. */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-7 px-2 border-b border-zinc-800 flex items-center gap-2 shrink-0">
            <span className="text-[0.5625rem] uppercase font-bold tracking-tight text-zinc-500">
              Output
            </span>
            <span className="text-[0.5625rem] text-zinc-600 ml-auto">
              {selectedCount > 0
                ? <><span className="text-zinc-300">{selectedCount}</span> / {items.length}</>
                : items.length
              }
            </span>
            <button
              onClick={selectAllItems}
              disabled={items.length === 0 || items.every(it => it.selected)}
              className="text-zinc-400 hover:text-zinc-100 disabled:opacity-30 disabled:hover:text-zinc-400 p-0.5 transition-none"
              title="Select all"
            >
              <CheckSquare size={11} />
            </button>
            <button
              onClick={clearFinished}
              disabled={!items.some(it => !isActive(it.status))}
              className="text-zinc-400 hover:text-zinc-100 disabled:opacity-30 disabled:hover:text-zinc-400 p-0.5 transition-none"
              title="Clear finished items (active items stay)"
            >
              <Trash2 size={11} />
            </button>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto px-1 py-1"
            onClick={(e) => {
              // Click on the panel's empty space (outside any row)
              // clears selection. Rows stopPropagation their clicks.
              if (e.target === e.currentTarget) clearSelection();
            }}
          >
            {items.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[0.5625rem] text-zinc-700 px-4 text-center pointer-events-none">
                Outputs appear here
              </div>
            ) : (
              items.map(it => {
                const dragOK = it.status === 'done' && !!it.output;
                return (
                <div
                  key={it.id}
                  className={`group flex items-start gap-1.5 px-1.5 py-1 text-[0.625rem] ${
                    it.selected
                      ? 'bg-zinc-800/70 text-zinc-100'
                      : 'hover:bg-zinc-900/60'
                  } ${dragOK ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
                  title={it.error ?? it.output ?? it.url}
                  onClick={(e) => {
                    e.stopPropagation();
                    const mode = e.shiftKey ? 'range' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'single';
                    selectItem(it.id, mode);
                  }}
                  draggable={dragOK}
                  onDragStart={(e) => {
                    if (!dragOK) return;
                    // preventDefault stops the WebView from rendering its
                    // own drag image; the overlay window owns the chip.
                    e.preventDefault();
                    const bulk = it.selected && selectedDonePaths.length > 1;
                    const paths = bulk ? selectedDonePaths : [it.output!];
                    const name = bulk
                      ? `${paths.length} files`
                      : (it.title ?? it.output!.split(/[\\/]/).pop() ?? 'audio');
                    void (async () => {
                      await startOverlayDrag({
                        paths,
                        fileName:    name,
                        isDirectory: false,
                        count:       paths.length,
                      });
                      try {
                        await invoke('start_os_file_drag', {
                          paths,
                          previewPng:  null,
                          transparent: true,
                        });
                      } catch (err) {
                        console.warn('start_os_file_drag (latch) failed:', err);
                        await endOverlayDrag();
                      }
                    })();
                  }}
                >
                  <span className="mt-0.5 shrink-0">
                    {it.status === 'done' && <CheckCircle2 size={10} className="text-emerald-400" />}
                    {it.status === 'failed' && <XCircle size={10} className="text-zinc-400" />}
                    {it.status === 'cancelled' && <XCircle size={10} className="text-zinc-500" />}
                    {(it.status === 'extracting' || it.status === 'queued') &&
                      <Loader2 size={10} className="text-zinc-300 animate-spin" />}
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col">
                    <span className="truncate text-zinc-300">{it.title ?? it.url}</span>
                    {it.status === 'extracting' && (
                      <span className="text-[0.5rem] text-zinc-500 mt-0.5">
                        {it.percent.toFixed(0)}% · {it.speed ?? '—'} · ETA {it.eta ?? '—'}
                      </span>
                    )}
                    {it.status === 'failed' && it.error && (
                      <>
                        <span
                          className="text-[0.5rem] text-zinc-400/80 mt-0.5 leading-snug break-words"
                          title={it.error}
                        >
                          {it.error}
                        </span>
                        {(() => {
                          const kind = classifyError(it.error);
                          if (kind === 'unknown') return null;
                          const retryBrowser = suggestNextBrowser(it.lastCookies);
                          return (
                            <div className="flex items-center gap-1 mt-1 flex-wrap">
                              {kind === 'bot-wall' && (
                                hasCookieSource ? (
                                  <button
                                    onClick={() => enqueueExtract([it.url], retryBrowser)}
                                    className="flex items-center gap-1 text-[0.5rem] uppercase tracking-wider px-1.5 h-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-[color:var(--theme-warn-border)] text-[color:var(--theme-warn-fg)] transition-none"
                                    title="Retry with browser cookies. yt-dlp will copy your session cookies to bypass the bot wall."
                                  >
                                    <Cookie size={8} /> Retry with {retryBrowser}
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => void onFixBotWall(it.url, it.lastCookies)}
                                    className="flex items-center gap-1 text-[0.5rem] uppercase tracking-wider px-1.5 h-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-[color:var(--theme-warn-border)] text-[color:var(--theme-warn-fg)] transition-none"
                                    title="This site blocked the download to check you're not a bot. Click for the one-step fix."
                                  >
                                    <ShieldAlert size={8} /> Fix bot block
                                  </button>
                                )
                              )}
                              {kind === 'cookie-locked' && (
                                <span className="flex items-center gap-1 text-[0.5rem] text-[color:var(--theme-warn-dim)] leading-snug">
                                  <AlertTriangle size={8} className="shrink-0" />
                                  Close {it.lastCookies ?? 'the browser'} and retry, or pick Firefox in Advanced.
                                </span>
                              )}
                              {kind === 'extractor-outdated' && (
                                <button
                                  onClick={onUpdateYtDlp}
                                  disabled={updateState.running}
                                  className="flex items-center gap-1 text-[0.5rem] uppercase tracking-wider px-1.5 h-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-500 text-zinc-300 transition-none disabled:opacity-30"
                                  title="Check for yt-dlp updates (often resolves a failed download)"
                                >
                                  <RefreshCw size={8} /> Update yt-dlp
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </div>
                  {/* Reveal — finished item, open OS file manager with
                      the file pre-selected. Skipped on Linux when the
                      file lives outside the user's home (Tauri can't
                      reliably xdg-open into select-on-launch). */}
                  {it.status === 'done' && it.output && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onRevealItem(it.output!); }}
                      className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-none"
                      title="Reveal in file manager"
                    >
                      <FolderSearch size={10} />
                    </button>
                  )}
                  {/* X — context-sensitive: cancel for in-flight jobs,
                      remove-from-list for terminal-state rows. */}
                  {isActive(it.status) ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCancelItem(it.jobId, it.id); }}
                      className="shrink-0 text-zinc-600 hover:text-zinc-400 transition-none"
                      title="Cancel"
                    >
                      <X size={10} />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeItem(it.id); }}
                      className="wd-slide-action shrink-0 text-zinc-600 hover:text-zinc-300"
                      title="Remove from list (file on disk untouched)"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Status bar — three cells aligned with the columns above. URL
          info on the left (cookies chip, since cookies are what gate
          URL fetches), binary chip + Output column under the middle,
          active extraction + selection summary under Downloads. A 1px
          progress fill spans full-width below. */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950">
        <div className="h-5 flex items-stretch text-[0.5625rem] tabular-nums">
          {/* URL CELL */}
          <div className="flex-1 min-w-0 flex items-center px-2 gap-2 border-r border-zinc-800 text-zinc-600">
            {cookiesFromBrowser ? (
              <span className="flex items-center gap-1 shrink-0 text-zinc-500" title={`Sending cookies from ${cookiesFromBrowser}`}>
                <Cookie size={9} /> {cookiesFromBrowser}
              </span>
            ) : (
              <span className="truncate">
                {candidateCount > 0
                  ? `pick a search result · ${candidateCount} candidates`
                  : parsedUrls.length === 0
                    ? 'Paste a URL or type a search'
                    : parsedUrls.length === 1
                      ? '1 URL · Ctrl+Enter to extract'
                      : `${parsedUrls.length} URLs queued`}
              </span>
            )}
          </div>

          {/* OUTPUT CELL */}
          <div className="w-[210px] shrink-0 flex items-center px-2 gap-2 border-r border-zinc-800">
            {binStatus && (
              <span
                className="flex items-center gap-1 shrink-0"
                title={
                  binStatus.resolved
                    ? `Connected · ${binStatus.source}\n${binStatus.path}`
                    : binStatus.message
                }
              >
                {binStatus.resolved
                  ? <Link2     size={9} className="text-emerald-400" />
                  : <Link2Off  size={9} className="text-zinc-400" />}
                <span className="text-zinc-500 uppercase tracking-wider">
                  {binStatus.resolved ? 'latch.exe' : 'no binary'}
                </span>
              </span>
            )}
            {activeCount > 0 && (
              <span className="ml-auto text-zinc-500 shrink-0 flex items-center gap-1">
                <Loader2 size={8} className="animate-spin text-zinc-400" />
                {activeCount} live
              </span>
            )}
            {/* About — info glyph opposite the latch.exe chip; hover
                reveals the "ABOUT" label, click opens the About window. */}
            <button
              onClick={() => { void openAboutWindow(); }}
              className="wd-about ml-auto flex items-center gap-1 text-zinc-600 hover:text-zinc-300 shrink-0 cursor-pointer"
              title="About Latch"
            >
              <span className="wd-about-label uppercase tracking-wider text-[0.5rem]">About</span>
              <Info size={10} className="shrink-0" />
            </button>
          </div>

          {/* DOWNLOADS CELL */}
          <div className="flex-1 min-w-0 flex items-center px-2 gap-2">
            {statusItem ? (
              <>
                <span className="flex-1 min-w-0 truncate text-zinc-300" title={statusItem.title ?? statusItem.url}>
                  {statusItem.title ?? statusItem.url}
                </span>
                {batchProgress && batchProgress.total > 1 && (
                  <span className="text-zinc-500 shrink-0">
                    {batchProgress.finished}/{batchProgress.total}
                  </span>
                )}
                <span className="text-zinc-400 shrink-0">
                  {statusItem.status === 'extracting'
                    ? `${statusItem.percent.toFixed(0)}%`
                    : 'queued'}
                </span>
                {statusItem.status === 'extracting' && (
                  <span className="text-zinc-600 shrink-0">
                    {statusItem.speed ?? '—'} · {statusItem.eta ?? '—'}
                  </span>
                )}
              </>
            ) : (
              <span className="text-zinc-600 truncate">
                {selectedCount > 0
                  ? `${selectedCount} selected`
                  : items.length === 0
                    ? 'Ready'
                    : `${items.length} item${items.length === 1 ? '' : 's'} · idle`}
              </span>
            )}
          </div>
        </div>
        <div className="h-0.5 w-full bg-zinc-900 relative overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-zinc-300 transition-[width] duration-150 ease-linear"
            style={{
              // Batch-aware: tracks finished + in-flight percent across the
              // whole current batch, not just the row the status cell shows.
              width: activeCount > 0 && batchProgress
                ? `${Math.min(100, Math.max(0, batchProgress.overall))}%`
                : '0%',
            }}
          />
        </div>
      </div>

      {/* yt-dlp update overlay — same modal style as bootstrap, but
          shows the streaming log so the user can see what -U is doing.
          Doesn't block extracts; just covers the body so the title-bar
          spinner stays visible. */}
      {(updateState.running || updateState.failed) && (
        <div className="absolute inset-0 top-7 bg-zinc-950/90 backdrop-blur-sm flex flex-col items-center justify-center gap-2 text-center px-6">
          <RefreshCw size={20} className={`text-zinc-300 ${updateState.running ? 'animate-spin' : ''}`} />
          <span className="text-[0.625rem] uppercase tracking-widest text-zinc-200 font-bold">
            {updateState.running ? 'Updating yt-dlp…' : (updateState.failed ? 'Update failed' : 'Update complete')}
          </span>
          {updateState.log.length > 0 && (
            <div className="w-[320px] max-h-[120px] overflow-y-auto bg-zinc-900/60 border border-zinc-800 px-2 py-1 text-left">
              {updateState.log.map((l, i) => (
                <div key={i} className="text-[0.5rem] text-zinc-400 font-mono leading-tight truncate" title={l}>
                  {l}
                </div>
              ))}
            </div>
          )}
          {!updateState.running && (
            <button
              onClick={() => setUpdateState({ running: false, log: [] })}
              className="mt-1 px-3 h-5 text-[0.5rem] uppercase tracking-wider bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {bootstrap.stage !== 'idle' && (
        <div className="absolute inset-0 top-7 bg-zinc-950/90 backdrop-blur-sm flex flex-col items-center justify-center gap-2 text-center px-6">
          <CloudDownload size={22} className="text-zinc-300" />
          <span className="text-[0.625rem] uppercase tracking-widest text-zinc-200 font-bold">
            {bootstrap.stage === 'downloading' && `Downloading ${bootstrap.binary ?? 'tool'}…`}
            {bootstrap.stage === 'extracting'  && `Extracting ${bootstrap.binary ?? 'archive'}…`}
            {bootstrap.stage === 'failed'      && 'Bootstrap failed'}
          </span>
          {bootstrap.stage === 'downloading' && bootstrap.total ? (
            <>
              <div className="w-[220px] h-1 bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-zinc-300 transition-[width] duration-150 ease-linear"
                  style={{ width: `${Math.min(100, bootstrap.percent ?? 0)}%` }}
                />
              </div>
              <span className="text-[0.5rem] tabular-nums text-zinc-500">
                {(bootstrap.percent ?? 0).toFixed(0)}% · {formatBytes(bootstrap.bytes ?? 0)} / {formatBytes(bootstrap.total)}
              </span>
            </>
          ) : (
            <span className="text-[0.5rem] text-zinc-500 max-w-[260px]">
              {bootstrap.stage === 'failed'
                ? bootstrap.message ?? 'Check Settings → Processing for the latch.exe path.'
                : 'First-run setup. Cached next to latch.exe so subsequent runs are instant.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
