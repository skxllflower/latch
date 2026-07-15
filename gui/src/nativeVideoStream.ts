// Webview engine for native video preview (video_stream_server.rs +
// `lathe decode-server` / `lathe stream-frames`). Owns a localhost frame
// stream, a bounded decoded-frame buffer, and a playback clock, and presents
// the frame matching the clock; the audio daemon is the sync master (the
// clock eases onto its vaudio_pos events).
//
// The picture path never touches WebView2's <video> decoder (the thing that
// hard-crashes the host on big/exotic video): frames are decoded natively by
// lathe and drawn to a canvas, which Chromium handles reliably.
//
// Two stream dialects, told apart by the X-Wavdesk-Proto response header:
//
//  "pts" (persistent decode-server): chunks of [u64 LE pts us][u32 LE len]
//  [payload]; a zero-length chunk is a SEEK MARKER. seek/play/pause are
//  POSTs to /vcontrol (the decoder seeks IN-PROCESS — no re-spawn, which is
//  what makes scrubbing smooth). Frames carry their REAL time, so placement
//  across seeks is exact. Stale in-flight frames between issuing a seek and
//  its marker arriving are discarded (holdingForSeek + pendingMarkers).
//
//  "raw" (stream-frames fallback): headerless concatenated RGBA frames timed
//  by streamStart + index/fps; seek = abort + reconnect with start=<t>.
//
// Backpressure does the realtime throttling: the reader only fills the buffer
// ~BUFFER_AHEAD_SEC past the clock, so when it's full the socket buffer fills,
// the Rust server's write blocks, lathe blocks, and the decode paces to ~1x.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { latheStatus } from './latheStatus';
import { staleWrapFlushNeeded } from './liveLoopFlush';
import { isMac } from './platform';
import { logToFile } from './frontendLog';

export interface NativeStreamConfig {
  path: string;
  height: number;
  fps: number;
  // Whether to autoplay + start the audio session on open. Absent = true
  // (the historical behavior). false = mount paused at 0 with NO audio
  // session until the first play() (the chop window opens parked: the user
  // draws cuts before anything moves or sounds).
  autoplay?: boolean;
}

export interface NativeGeom {
  w: number;
  h: number;
  fps: number;
  dur: number;
  // HDR transfer of the source ('pq' / 'hlg'), or '' for SDR. The decoder
  // tone-maps HDR to SDR by default; setTonemap toggles the raw view.
  hdr: '' | 'pq' | 'hlg';
}

export interface NativeVideoCallbacks {
  onGeom?: (g: NativeGeom) => void;
  onDuration?: (d: number) => void;
  // Present this frame now. The ENGINE owns the bitmap's lifecycle (it closes
  // frames as they fall out of the buffer) — the consumer must NOT close it.
  onFrame: (bmp: ImageBitmap) => void;
  onTime?: (t: number) => void;
  onState?: (playing: boolean) => void;
  // A reverse shuttle ran out of video (clock hit 0): the engine stops itself;
  // the GUI clears its JKL level indicator here.
  onShuttleEnd?: () => void;
  onError?: (msg: string) => void;
}

// Read at most this far ahead of the clock, in seconds. Small = tight
// backpressure (decode ~1x) + low memory; big enough to smooth jitter.
const BUFFER_AHEAD_SEC = 0.6;
// Reverse reads much further ahead: backward chunks arrive in whole-GOP
// bursts with a decode gap between them — a 0.6s buffer drains dry
// during the gap (the scoop-and-wait look). Cover a typical GOP.
const BUFFER_AHEAD_REVERSE_SEC = 3.0;

// Present frames this far AHEAD of the (audio-driven) clock to compensate for
// the video pipeline's latency. Decode + transport are already absorbed by the
// frame buffer (frames sit in `frames` ahead of the clock before display), so
// the only UN-absorbed latency is the last hop — onFrame → canvas draw →
// compositor → display ≈ 1-2 frames. 0.18 over-compensated: the picture ran
// AHEAD of the sound/waveform by (lead - real latency), which the loop's
// freeze used to mask and the seam fix exposed. Tune to taste: raise if video
// lags audio, lower if it leads.
const VIDEO_AV_LEAD_SEC = 0.05;

// Seek debounce. Persistent commands are cheap (no re-spawn) but each still
// costs the decoder a keyframe + decode-forward, so a held scrub coalesces;
// raw restarts both ffmpeg pipes and needs the wider window.
const SEEK_DEBOUNCE_PTS_MS = 50;
const SEEK_DEBOUNCE_RAW_MS = 120;

// macOS WKWebView stream-stall watchdog. WebKit can permanently WEDGE a
// streaming fetch body after the JS reader goes idle: while the engine sits
// paused (the chop window's parked open) the reader stops pulling, WebKit's
// network process buffers ~20MB off the socket and suspends the connection —
// and when the reader resumes, the resume is sometimes lost and reader.read()
// never settles again, even though the server keeps writing (the same stream
// drains fine via curl, and a FRESH connection always flows). Field symptom:
// black video + frozen playhead with audio playing on — zero frames means
// `started` never flips, so the clock never runs. The wedge also strikes
// periodically (~every 4-7s / ~100MB observed) during SUSTAINED playback in
// the busy chop window. Detection: playing forward, buffer starved, and no
// stream bytes for STALL_MS (the reader refreshes its byte stamp while
// backpressure-idle, so a legitimately full buffer never trips this). Cure:
// abort + reconnect at the clock. STALL_MS is tuned so the respawn lands
// about when the 0.6s frame buffer runs dry — the hiccup is barely visible.
// SLOW_MS covers the windows where a byte gap is LEGITIMATE (a fresh
// connection's first decode, an in-flight seek's keyframe+decode-forward on
// heavy files) so a slow 4K can't trigger a respawn livelock. Mac-only;
// WebView2's fetch streaming has no such wedge and Windows stays untouched.
const STREAM_STALL_MS = 600;
const STREAM_STALL_SLOW_MS = 4000;
// Lowered from 0.25 with the forward frame-count cap below: an 8-frame forward
// buffer is ~0.27s@30fps but only ~0.13s@60fps, so a 0.25 "starved" line would
// read a HEALTHY capped 60fps buffer as starved (breaking the watchdog's clean-
// play reset). 0.1 sits below the cap at any sane fps yet still means "nearly
// dry" for the reconnect-fire test — the watchdog only fires once the buffer is
// genuinely near-empty AND bytes have stopped, never on deliberate backpressure.
const STREAM_STALL_STARVED_SEC = 0.1;
// Forward frame-buffer ceiling (GC / RSS hygiene). Bounding only by
// BUFFER_AHEAD_SEC lets the forward buffer fill to ~18 frames (0.6s@30fps); at
// 3.3MB/frame (1152x720x4) that pins ~60MB of live ImageBitmaps (the field
// bufLen:16 = 53MB). 8 frames is the depth presentation actually needs (it
// matches the decode-warmup start floor) and holds ~26MB. Reverse keeps its
// deep seconds-based buffer — backward GOP bursts need the runway.
const MAX_BUFFERED_FRAMES_FWD = 8;
// Reusable RGBA read-buffer ring (the GC-storm fix). The reader used to COPY
// each frame's payload into a FRESH Uint8Array(frameSize) every frame —
// ~100MB/s of stop-the-world heap garbage at 30fps. A small ring is reused
// instead: createImageBitmap SNAPSHOTS the ImageData, so a slot is free the
// instant its await resolves (2 would suffice for the double-buffer; 4 for slack).
const FRAME_BUF_RING = 4;
// Memory receipt cadence: one churn/pool line every 10s during playback.
const MEM_RECEIPT_MS = 10000;
// Churn backoff for the stall watchdog. A watchdog reconnect forces a keyframe
// re-decode, which on a heavy file (even with VideoToolbox) can itself exceed
// the fast stall tier — so the respawn's OWN first decode looks like a fresh
// stall and the watchdog reconnect-loops: keyframe decode → watchdog → abort →
// keyframe decode → watchdog = the loop-wrap freeze. Guards: (a) an intentional
// re-cue/seek (loop wrap included) arms the SLOW tier via seekInFlight(), so its
// decode-forward is never mistaken for a wedge; (b) cap reconnects per rolling
// window, and on consecutive stalls with no clean playback between them GROW the
// fast tier (600 → 1200 → 2400) so each retry gives the respawn more room; a
// clean stretch resets it. Beyond the cap, HOLD the stream (the frozen frame is
// the buffering surface) — more churn only deepens the hole.
const STREAM_STALL_MAX_MS = 2400;
const STALL_RECONNECT_CAP = 5;
const STALL_RECONNECT_WINDOW_MS = 60000;
const STALL_CLEAN_PLAY_MS = 3000;

// A clock within this of the true duration is treated as end-of-file: seeking
// or playing backward out of it takes the fresh-reconnect path (see seek()),
// because the persistent decoder parked at EOF has a WKWebView-wedgeable body.
const EOF_EPS_SEC = 0.05;

// The AUDIO pipeline's decode look-ahead in content seconds: the Rust deck's
// PCM queue (0.75s — see VA_Q_CAP_MS in audio.rs) + the OS pipe + slack. This
// is the part of the decode horizon JS can't inspect directly; the VIDEO side
// is checked against the actual frame buffer instead. staleWrapFlushNeeded()
// combines the two: a loop-bounds handoff (grab OR drop) only pays the flush
// re-cue when stale data at/beyond the relevant out-point can actually be
// queued — a grab far from the walls stays glitchless. (The old blanket 2.75s
// clock window fired for most of a small region's cycle: the grab hiccup.)
const AUDIO_PIPELINE_LOOKAHEAD_SEC = 1.0;

// present()'s settled-loop escape hatch: with the gapless decoder loop armed,
// the audio master must wrap AT the out-point (the deck's rebase is sample-
// exact; event jitter is ~1 tick). If the clock sails this far past it, the
// decoders are NOT actually looping (a lost/raced arm — e.g. a stale live-drag
// callback disarming behind a drop's re-arm) — re-take authority instead of
// hard-following the audio out of the region forever.
const LOOP_WRAP_OVERDUE_SEC = 0.3;

// Live-wall bounce seeks: seek()'s trailing debounce alone can be STARVED when
// a dragged wall keeps crossing the clock (every crossing re-arms the timer,
// no command ever issues, and the DISARMED audio free-runs seconds past the
// region — the left-edge-drag escape). Guarantee a leading issue at least this
// often during a sustained chase.
const LIVE_BOUNCE_MAX_GAP_MS = 120;

// A vaudio_pos within this of an in-flight seek's target counts as post-seek
// audio; anything farther is the OLD cursor still emitting and must not steer
// the clock (it would yank the playhead straight back past a just-bounced
// wall). Bounded so a lost marker can't gate the audio master forever — the
// deck's own watchdog reopens its side at 1.5s.
const SEEK_AUDIO_NEAR_SEC = 1.25;
const SEEK_AUDIO_PENDING_MAX_MS = 4000;

// Freeze-through-seek (retrigger / stop). A seek issued with `freeze` HOLDS the
// last displayed frame until a frame AT/AFTER the cue point lands, instead of
// painting whatever arrives first. The decoder emits its keyframe→cue frames on
// the way to the seek target (they clear the stale-frame gate as legitimate
// post-seek data), and painting one of those flashes a WRONG frame for a tick —
// the region-trigger / stop flash. A scrub still shows the earliest arriving
// frame (responsive); only the chop retrigger/stop paths opt into the freeze.
// A frame within this tolerance of the target counts as "the cue frame" (covers
// the decoder landing a hair before the exact target). Time-capped so a wedged
// decoder can never blank the picture forever — past the cap, paint whatever's
// there.
const SEEK_FREEZE_TARGET_TOL_SEC = 0.06;
const SEEK_FREEZE_MAX_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function parseGeomHeader(h: string | null): NativeGeom | null {
  if (!h) return null;
  let w = 0, hh = 0, fps = 0, dur = 0;
  let hdr: NativeGeom['hdr'] = '';
  for (const part of h.split(';')) {
    const [k, v] = part.split('=');
    if (k === 'hdr') { hdr = v === 'pq' || v === 'hlg' ? v : ''; continue; }
    const n = Number(v);
    if (k === 'w') w = n;
    else if (k === 'h') hh = n;
    else if (k === 'fps') fps = n;
    else if (k === 'dur') dur = n;
  }
  return w > 0 && hh > 0 ? { w, h: hh, fps, dur, hdr } : null;
}

export class NativeVideoEngine {
  private readonly cfg: NativeStreamConfig;
  private readonly cb: NativeVideoCallbacks;

  private frames: { t: number; bmp: ImageBitmap }[] = [];
  private w = 0;
  private h = 0;
  private fps = 30;
  private frameSize = 0;
  // Reusable RGBA read-buffer ring + memory-receipt counters (see FRAME_BUF_RING
  // / MEM_RECEIPT_MS). The ring reuses payload buffers across frames instead of
  // allocating a fresh 3.3MB Uint8Array each; the counters feed the 10s receipt.
  private bufRing: Uint8Array[] = [];
  private bufRingIdx = 0;
  private memFramesDecoded = 0;   // frames pushed since the last receipt
  private memBufFresh = 0;        // ring buffers newly allocated since last receipt
  private memBufReused = 0;       // ring buffers reused since last receipt
  private lastMemReceiptAt = 0;
  private _duration = 0;
  private _playing = false;
  private clock = 0;          // playback position, seconds
  private lastNow = 0;        // wall clock at last present() tick
  private streamStart = 0;    // raw mode: -ss offset of the live connection
  private frameIdx = 0;       // raw mode: frame counter within the connection
  private presentedT = -1;    // t of the frame currently on screen
  private lastTimeEmit = 0;
  private endpointBase = '';
  private ac: AbortController | null = null;
  private connToken = 0;      // bumped on (re)connect; stale readers self-cancel
  private raf = 0;
  private frameTimer = 0; // macOS rAF-park fallback (see scheduleFrame)
  private destroyed = false;

  // Transport state mirrored from the GUI. rate is tape-style (the daemon
  // repitches the stream; position events already track it). loopRegion wraps
  // the clock back to inSec when it crosses outSec.
  private rate = 1;
  private volume = 1;
  private loopRegion: { inSec: number; outSec: number } | null = null;
  // True while the DECODERS hold the loop region (persistent dialect): they
  // wrap themselves gaplessly and the clock just follows; false = raw-dialect
  // fallback, where present() wraps with a plain seek.
  private decoderLoop = false;
  // The bounds the decoders are ACTUALLY armed at (set when the arm roundtrip
  // lands). beginLiveLoop() needs the OLD out-point after setLoopBounds has
  // already overwritten loopRegion with the live gesture bounds.
  private decoderLoopRegion: { inSec: number; outSec: number } | null = null;
  // True while a live region-drag is feeding fresh loop bounds every frame
  // (setLoopBounds). The gapless decoder loop can't chase a wall that's still
  // moving, so present() bounces the clock at the LIVE in/out via a re-cue
  // seek while this holds; setLoopRegion re-arms the gapless loop (and clears
  // this) once the drag settles. No per-move decoder re-arm — that re-arm
  // thrash was the drag "freakout".
  private liveLoopActive = false;
  // Streamed height (the engine reconnects at the current clock when the
  // display target outgrows/shrinks past it — fullscreen, popout resize).
  private curHeight: number;
  private connectedHeight = 0;     // height the live stream was opened at
  // HDR→SDR tone-mapping: the decoder defaults ON for HDR sources; this
  // mirrors the toggle so reconnects re-apply an OFF state.
  private tonemapOn = true;
  // Persistent streams never EOF on their own; an instant-death respawn loop
  // (file deleted, decoder crashing on load) is capped here.
  private connectedAt = 0;
  private quickDeaths = 0;

  // Playback direction. -1 = TRUE reverse: the decoders stream backward
  // (backward-GOP video chunks, sample-reversed audio), the reversed audio
  // plays audibly and stays the clock MASTER (vaudio_pos descends), and the
  // video follows — same sync model as forward, just with a negative slope.
  // (NEVER WebCodecs here; that decoder is the host-crasher this engine
  // exists to avoid.)
  private dir: 1 | -1 = 1;
  // JKL shuttle: a forward/reverse speed override riding the audio-rate path
  // (tape-style, audio caps at 4x). 0 = no shuttle (the speed button's rate).
  private shuttleRate = 0;

  // Persistent (pts) dialect state.
  private persistent = false;
  private streamId = '';
  // Stale-frame gate around an in-process seek: holdingForSeek covers the
  // window between seek() snapping locally and the debounced /vcontrol POST;
  // pendingMarkers counts seek commands whose marker hasn't come back. Frames
  // are accepted only when both are clear.
  private holdingForSeek = false;
  private pendingMarkers = 0;
  // Freeze-through-seek gate (see SEEK_FREEZE_*). While set, present() holds the
  // last displayed frame and paints nothing until a frame at/after the cue point
  // is buffered — killing the pre-target keyframe flash on a retrigger/stop seek.
  private seekFreeze = false;
  private seekFreezeTarget = 0;
  private seekFreezeAt = 0;

  // Audio-master sync. The daemon plays the video's audio and emits
  // vaudio_pos; when audio is present it drives the clock and the video
  // follows. No audio track → audioActive stays false and we fall back to
  // the wall-clock (muted video).
  private audioActive = false;
  private audioPos = 0;       // last vaudio_pos (sec)
  private audioPosAt = 0;     // performance.now() when audioPos arrived
  // Gates the audio master out of the clock while a seek's post-seek position
  // hasn't landed: a stale (pre-seek) cursor steering the clock is exactly the
  // playhead-yanked-back-past-the-wall escape during loop bounces.
  private audioSeekPending = false;
  private audioSeekTarget = 0;
  private audioSeekPendingAt = 0;
  // Set once the first frame is buffered: the clock holds until then (no startup
  // race), then runs on the wall clock and eases onto the audio position. Reset
  // on seek so the same hold re-arms while the new position spins up.
  private started = false;
  // Stall watchdog (see STREAM_STALL_MS): wall time of the last stream-byte
  // arrival; refreshed while the reader idles on PURPOSE (backpressure, an
  // in-flight connect) so only a wedged read() lets it go stale.
  private lastReadAt = 0;
  private connFetching = false;
  // Stall-watchdog churn backoff (see STREAM_STALL_MAX_MS): reconnect timestamps
  // in the rolling window, the consecutive-stall streak that grows the fast
  // tier, the running clean-playback stamp that resets it, and the past-cap hold.
  private stallReconnects: number[] = [];
  private stallStreak = 0;
  private stallCleanSince = 0;
  private stallHeld = false;
  // Perf receipt budget: throttle stamp for the present()-tick timing warn (a
  // multi-second synchronous main-thread block would otherwise freeze the UI
  // with NO log line — the "silent hang").
  private lastSlowTickLog = 0;
  // Paused mount: idle the decoder AFTER the first frame is buffered (pausing
  // before it could leave `frames` empty forever — no onReady, stuck Loading).
  private deferInitialPause = false;
  private seekTimer = 0;      // debounce: coalesces a held scrub / arrow flurry
  private unlistenAudio: (() => void) | null = null;

  constructor(cfg: NativeStreamConfig, cb: NativeVideoCallbacks) {
    this.cfg = cfg;
    this.cb = cb;
    this.curHeight = cfg.height;
    this.lastNow = performance.now();
    this.lastReadAt = performance.now();
    this._playing = cfg.autoplay ?? true; // default: autoplay on open
    void this.connect(0);
    // Only spin up the audio session for an autoplaying mount. A paused mount
    // (the chop window's parked open) starts NO session — play() lazily starts
    // it at the current clock, so nothing is audible until the user asks.
    if (this._playing) void this.startAudio();
    this.scheduleFrame();
    this.cb.onState?.(this._playing);
  }

  // Drive present(). rAF is the primary tick (vsync-aligned, smooth). But on
  // macOS WKWebView PARKS requestAnimationFrame for a satellite window whose
  // compositor isn't ticking (the same reason ChopApp's reveal uses a timer
  // fallback) — the rAF loop fires once, re-arms, and then never fires again.
  // That froze the whole engine: frames still buffer, but present() never runs
  // to display them OR start the clock, so the picture stays black and the
  // playhead never moves. A setTimeout keeps the loop alive there; whichever
  // fires first runs the tick and cancels the other. Windows/WebView2 rAF is
  // reliable, so the fallback is mac-only and leaves that path untouched.
  private scheduleFrame(): void {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frameTick);
    if (isMac) this.frameTimer = window.setTimeout(this.frameTick, 24);
  }

  private frameTick = (): void => {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.frameTimer) { window.clearTimeout(this.frameTimer); this.frameTimer = 0; }
    // Budgeted perf receipt (mac): time the present() tick. A single tick over
    // 100ms is a main-thread stall — the kind that freezes the whole UI with no
    // other log line (the "silent hang"). Throttled to one line per 2s.
    const t0 = isMac ? performance.now() : 0;
    this.present();
    if (isMac) {
      const took = performance.now() - t0;
      if (took > 100 && performance.now() - this.lastSlowTickLog > 2000) {
        this.lastSlowTickLog = performance.now();
        this.log('warn', `present tick took ${Math.round(took)}ms (frames=${this.frames.length}) - main-thread stall`);
      }
    }
    this.scheduleFrame();
  };

  // A seek/re-cue is being serviced (loop-wrap re-cue, scrub, retrigger, or a
  // fresh connection's first decode): from seek()'s local snap (holdingForSeek +
  // the debounce timer still pending) through the decoder's marker coming back.
  // Arms the stall watchdog's SLOW tier so an intentional keyframe re-decode is
  // never mistaken for a wedged fetch body — the loop-wrap churn fix.
  private seekInFlight(): boolean {
    return this.holdingForSeek || this.pendingMarkers > 0 ||
      this.seekTimer !== 0 || this.frameIdx === 0;
  }

  // Subscribe to the daemon's video-audio position, then ask it to start playing
  // this file's audio. Best-effort: if there's no audio track the daemon reports
  // vaudio_state{active:false} and the video stays on the wall-clock, muted.
  // Idempotent (audioStarted latch): an autoplay mount runs it from the ctor;
  // a paused mount defers it to the first play(), which passes the clock so
  // the session begins where the playhead is parked.
  private audioStarted = false;

  private async startAudio(startSec = 0): Promise<void> {
    if (this.audioStarted) return;
    this.audioStarted = true;
    try {
      this.unlistenAudio = await listen('audio_event', (e) => {
        const p = e.payload as { event?: string; sec?: number; active?: boolean } | null;
        if (!p) return;
        if (p.event === 'vaudio_pos' && typeof p.sec === 'number') {
          if (this.audioSeekPending) {
            // A position far from the in-flight seek's target is the OLD
            // cursor still emitting/in transit — letting it steer the clock
            // yanks the playhead straight back past a just-bounced wall.
            const near = Math.abs(p.sec - this.audioSeekTarget) <= SEEK_AUDIO_NEAR_SEC;
            const expired = performance.now() - this.audioSeekPendingAt > SEEK_AUDIO_PENDING_MAX_MS;
            if (!near && !expired) return;
            this.audioSeekPending = false;
          }
          // Only a position event activates the audio clock — it carries the
          // anchor (audioPos + audioPosAt) the ease needs. (vaudio_state{active:
          // true} is just "audio is coming"; activating on it would ease from an
          // un-anchored audioPosAt=0 and race to page-uptime seconds.)
          this.audioPos = p.sec;
          this.audioPosAt = performance.now();
          this.audioActive = true;
        } else if (p.event === 'vaudio_state' && !p.active) {
          this.audioActive = false; // confirmed no audio track → wall clock, muted
          this.audioSeekPending = false;
        }
      });
    } catch { this.unlistenAudio = null; }
    if (this.destroyed) { this.unlistenAudio?.(); return; }
    const lathe = latheStatus.get().path ?? '';
    try {
      await invoke('start_video_audio', { path: this.cfg.path, start: startSec, lathe });
      // The daemon resets per-stream volume/rate to 1.0 at begin — re-apply
      // what the GUI set (it may have called the setters before the stream
      // existed, where the daemon-side ops were no-ops).
      void invoke('set_video_audio_volume', { vol: this.volume }).catch(() => {});
      if (this.rate !== 1) void invoke('set_video_audio_rate', { rate: this.rate }).catch(() => {});
      // Backend retains this across startup too; resend the latest JS intent
      // after the awaited start as an idempotent belt-and-braces sync. This
      // also covers a region change that occurred while start was awaiting.
      const r = this.loopRegion;
      void invoke('set_video_audio_loop', {
        inSec: r ? r.inSec : 0,
        outSec: r ? r.outSec : 0,
      }).catch(() => {});
    } catch { /* no audio / failure → muted video (wall clock) */ }
  }

  get duration(): number { return this._duration; }
  get playing(): boolean { return this._playing; }
  get currentTime(): number { return this.clock; }

  play(): void {
    if (this.destroyed || this._playing) return;
    if (this.dir > 0 && this._duration > 0 && this.clock >= this._duration) this.seek(0);
    this._playing = true;
    this.lastNow = performance.now();
    void this.control('play');
    // Paused mount (autoplay:false): no audio session exists yet — start it
    // at the parked clock. Otherwise just resume the existing session.
    if (this.audioStarted) void invoke('resume_video_audio').catch(() => {});
    else void this.startAudio(this.clock);
    this.cb.onState?.(true);
  }

  pause(): void {
    if (this.destroyed || !this._playing) return;
    this._playing = false;
    void this.control('pause');
    void invoke('pause_video_audio').catch(() => {});
    this.cb.onState?.(false);
  }

  toggle(): void { this._playing ? this.pause() : this.play(); }

  // Volume fader (0..1; the daemon composes it with the Control Room master).
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    void invoke('set_video_audio_volume', { vol: this.volume }).catch(() => {});
  }

  // Playback rate (tape-style: pitch follows speed). The audio is repitched in
  // the daemon and stays the clock master — its position events advance at the
  // new rate, so the video follows automatically; the wall-clock fallback and
  // the A/V lead are scaled here for the muted / between-events cases.
  setRate(r: number): void {
    this.rate = Math.max(0.25, Math.min(4, r));
    void invoke('set_video_audio_rate', { rate: this.rate }).catch(() => {});
  }

  // Loop the in→out section while playing. null clears. In the persistent
  // dialect BOTH decoders arm the region and wrap themselves GAPLESSLY (the
  // audio is sample-exact; position rebases ride the in-band wrap markers);
  // the raw fallback keeps the old seek-at-out behavior in present().
  // Loop ops are CHAINED: armDecoderLoop awaits the decoder roundtrip,
  // so two quick calls (the clear+re-arm pair every region activation
  // produces, or the arm burst while resizing) can resolve OUT OF ORDER
  // — the slower CLEAR lands after the newer ARM and the decoders end
  // up disarmed (the trace showed arm→clear pairs 1ms apart). Each link
  // re-reads loopRegion at run time, so bursts collapse to the newest
  // state and ops reach both decoders strictly in order.
  private loopChain: Promise<void> = Promise.resolve();

  setLoopRegion(region: { inSec: number; outSec: number } | null): void {
    this.loopRegion = region && region.outSec > region.inSec ? region : null;
    this.liveLoopActive = false; // settled bounds → the gapless decoder loop owns the wrap
    this.queueArmLoop();
    // Live region-resize rescue. A resize that drags the out-point behind the
    // playhead (or the in-point ahead of it) leaves the clock OUTSIDE the new
    // loop: both decoders are still cued to a now-stale spot and keep
    // streaming the OLD span — the freeze / "2-3 old loops before the new one
    // takes" / chaos. Force an immediate wrap to the new in-point through the
    // seek path so BOTH decoders re-cue and the loop re-arms at the right spot,
    // reading LIVE bounds (this.clock / this.loopRegion), not a stale
    // mirror-effect closure. Forward playback only, and only when actually
    // stranded — normal region activation seeks to the in-point FIRST, so the
    // clock is already inside and this no-ops.
    const r = this.loopRegion;
    if (r && this._playing && this.dir > 0) {
      if (this.clock > r.outSec + 0.02 || this.clock < r.inSec - 0.02) {
        this.seek(r.inSec);
      } else if (this.pipelineStaleBeyond(r.outSec)) {
        // Settled re-arm with the decode pipeline possibly already PAST the
        // new out-point (right-edge shrink release: the decoders free-ran
        // while disarmed for the gesture). The arm alone can't un-queue the
        // stale post-out PCM/frames — only a seek's markers flush both
        // streams — so without this the playhead (audio master) sails past
        // the settled wall until the pipes drain. Re-cue in place; the armed
        // decoders then wrap exactly at the settled out.
        this.seek(this.clock);
      }
    }
  }

  // Can the decode pipeline already hold data at/beyond `outSec`? Video side
  // from the actual frame buffer; audio side from the clock vs the PCM
  // pipeline look-ahead. See liveLoopFlush.ts.
  private pipelineStaleBeyond(outSec: number, seamBuffered?: boolean): boolean {
    let seam = seamBuffered ?? false;
    if (seamBuffered === undefined) {
      for (let i = 1; i < this.frames.length; i++) {
        if (this.frames[i].t < this.frames[i - 1].t) { seam = true; break; }
      }
    }
    return staleWrapFlushNeeded({
      playing: this._playing,
      dirForward: this.dir > 0,
      clock: this.clock,
      outSec,
      seamBuffered: seam,
      lastBufferedT: this.frames.length ? this.frames[this.frames.length - 1].t : null,
      audioLookaheadSec: AUDIO_PIPELINE_LOOKAHEAD_SEC,
    });
  }

  // Live region-drag bounds update: refresh the loop bounds present() reads
  // WITHOUT re-arming the gapless decoder loop. The overlay fires this every
  // gesture tick; present() then bounces the clock at these LIVE walls (a
  // re-cue seek per wrap, not per move), so the loop tracks the dragged edges
  // in real time. setLoopRegion re-arms the gapless loop once the drag settles.
  setLoopBounds(inSec: number, outSec: number): void {
    // WKWebView's persistent stream is fragile while an in-process seek is
    // decode-forwarding. Keep the settled decoder loop armed during a Mac
    // pointer gesture; setLoopRegion applies the final bounds on release.
    if (isMac) return;
    const prev = this.loopRegion;
    const wasLive = this.liveLoopActive;
    this.loopRegion = outSec > inSec ? { inSec, outSec } : null;
    this.liveLoopActive = this.loopRegion != null;
    if (!wasLive && this.liveLoopActive) this.beginLiveLoop(prev);
  }

  // Gesture-start handoff (the FIRST setLoopBounds of a drag) — one op per
  // gesture, never per move. The decoders still hold the loop armed at the
  // grab-time bounds and would keep wrapping there (they OWN gapless
  // wrapping — the walls present() moves can't overrule what the stream
  // actually contains: the old out-wrap kept playing right through a
  // rapid expand). Disarm them once so present()'s live-wall seek-bounce is
  // the sole wrap authority for the gesture; armDecoderLoop collapses to a
  // CLEAR while liveLoopActive holds, which also neutralizes any arm still
  // queued on the chain. And if the decoders may already have PRE-BUFFERED a
  // wrap at the old out-point (a seam is in the local buffer, or the playhead
  // is within the pipeline look-ahead of it), re-cue with an in-place seek:
  // its markers are the only boundary that flushes the stale post-wrap
  // frames/PCM on BOTH streams (that residue was the "old loop plays 1-2
  // more wraps after a quick resize-release"). Post-wrap frames already in
  // the local buffer are dropped either way — with the decoder disarmed the
  // seam-guarded scans in present() no longer protect against them.
  private beginLiveLoop(prev: { inSec: number; outSec: number } | null): void {
    const old = this.decoderLoopRegion ?? prev;
    this.queueArmLoop(); // liveLoopActive holds → the chain link sends a CLEAR
    let seam = -1;
    for (let i = 1; i < this.frames.length; i++) {
      if (this.frames[i].t < this.frames[i - 1].t) { seam = i; break; }
    }
    if (seam > 0) {
      for (let i = seam; i < this.frames.length; i++) this.frames[i].bmp.close();
      this.frames.length = seam;
    }
    if (old && this.pipelineStaleBeyond(old.outSec, seam > 0)) {
      this.seek(this.clock);
    }
  }

  private queueArmLoop(): void {
    this.loopChain = this.loopChain.then(() => this.armDecoderLoop()).catch(() => {});
  }

  private async armDecoderLoop(): Promise<void> {
    // While a live drag holds, the decoders must stay DISARMED — present()
    // owns the wrap at the moving walls — so any queued arm collapses to a
    // CLEAR (an activation's arm still in flight can't re-arm the old cage
    // behind the gesture's back).
    const r = this.liveLoopActive ? null : this.loopRegion;
    const params = { in: r ? r.inSec : 0, out: r ? r.outSec : 0 };
    if (this.persistent) {
      // ALWAYS send — out <= in is the decoder-side CLEAR. The old
      // `!!r && control(...)` short-circuit skipped the video decoder's
      // clear entirely, leaving a STALE loop wrapping inside it (video
      // visibly loops a region the engine no longer knows about) while
      // the audio deck below received its clear — permanent A/V loop
      // asymmetry.
      const ok = await this.control('loop', undefined, params);
      this.decoderLoop = !!r && ok;
    } else {
      this.decoderLoop = false;
    }
    this.decoderLoopRegion = this.decoderLoop && r ? { ...r } : null;
    void invoke('set_video_audio_loop', { inSec: params.in, outSec: params.out }).catch(() => {});
  }

  // Re-stream at a new capped height (display target grew/shrank: fullscreen,
  // popout resize). Reconnects at the current clock; audio is untouched, so a
  // mid-play switch is just a brief picture swap. Deferred while reversing (a
  // fresh stream starts forward) — it lands when the shuttle lets go.
  setHeight(h: number): void {
    if (this.destroyed || h === this.curHeight || h <= 0) return;
    this.curHeight = h;
    if (this.dir < 0) return;
    void this.connect(this.clock);
  }

  // Toggle HDR→SDR tone-mapping (only meaningful for hdr-flagged sources;
  // the decoder defaults ON).
  setTonemap(on: boolean): void {
    this.tonemapOn = on;
    void this.control('tonemap', undefined, undefined, on);
  }

  // The unsigned rate the audio master is running at (shuttle overrides the
  // speed button). Drives the wall-clock fallback, the between-events audio
  // extrapolation, and the A/V lead. Multiply by `dir` for the clock slope.
  private effRate(): number {
    return this.shuttleRate > 0 ? this.shuttleRate : this.rate;
  }

  // Flip the playback direction at the current clock: one dir-carrying seek
  // re-points BOTH decoders (each emits a marker, so the stale-frame gating
  // is identical to a normal seek), immediately — a held J shouldn't wait out
  // the scrub debounce.
  private setDirection(d: 1 | -1): void {
    if (this.dir === d) return;
    this.dir = d;
    if (this.seekTimer) { window.clearTimeout(this.seekTimer); this.seekTimer = 0; }
    const tt = this.clock;
    this.presentedT = -1;
    this.started = false;
    // Returning to forward with a resolution switch deferred during reverse:
    // reconnect (lands the new height AND the direction); audio still gets
    // its own dir-flip seek since connect() only restarts the picture.
    if (d === 1 && this.persistent && this.connectedHeight !== this.curHeight) {
      void this.connect(tt);
      void invoke('seek_video_audio', { sec: tt, dir: 1 }).catch(() => {});
      if (!this._playing) void invoke('pause_video_audio').catch(() => {});
      return;
    }
    this.holdingForSeek = true;
    this.clearBuffer();
    this.applySeek(tt);
  }

  // JKL shuttle level: 0 = stop (pause), +N = forward N×, −N = TRUE reverse N×
  // (reversed audio plays and stays the clock master).
  shuttle(level: number): void {
    if (this.destroyed) return;
    const lv = Math.max(-8, Math.min(8, Math.round(level)));
    if (lv !== 0) {
      this.shuttleRate = Math.min(4, Math.abs(lv));
      void invoke('set_video_audio_rate', { rate: this.shuttleRate }).catch(() => {});
      this.setDirection(lv > 0 ? 1 : -1);
      this.play();
    } else {
      this.shuttleRate = 0;
      void invoke('set_video_audio_rate', { rate: this.rate }).catch(() => {});
      this.setDirection(1); // re-anchors forward exactly where the shuttle stopped
      this.pause(); // shuttle-stop = pause (mirrors the <video> path)
    }
  }

  // `freeze` holds the last displayed frame through the seek until the cue frame
  // lands (retrigger / stop) instead of flashing the decoder's pre-cue keyframe
  // frames. Absent = the responsive scrub behavior (paint the earliest arrival).
  seek(t: number, freeze = false): void {
    if (this.destroyed) return;
    const tt = Math.max(0, this._duration > 0 ? Math.min(this._duration, t) : Math.max(0, t));
    // EOF-exit: seek/play BACKWARD out of a stream parked at end-of-file (the
    // owner's chop "black video + frozen playhead"). Captured BEFORE the clock
    // snaps below.
    const atEofExit = this._duration > 0 &&
      this.clock >= this._duration - EOF_EPS_SEC &&
      tt < this.clock - EOF_EPS_SEC;
    if (atEofExit) {
      this.log('info', `seek to ${tt.toFixed(2)}s out of end-of-file (dur ${this._duration.toFixed(2)}s)`);
    }
    // Snap clock + scrubber to the target immediately, then HOLD there: empty
    // the buffer and re-arm the first-frame gate so present() can't advance
    // past tt until frames from the new position arrive. The actual command is
    // DEBOUNCED so a flurry of arrow presses / a held scrub coalesces.
    this.clock = tt;
    this.audioPos = tt;
    this.audioPosAt = performance.now();
    // Gate the audio master until a post-seek position lands: the deck's OLD
    // cursor keeps emitting for a beat, and adopting it would yank the clock
    // straight back to the pre-seek spot (past a just-bounced loop wall).
    this.audioSeekPending = true;
    this.audioSeekTarget = tt;
    this.audioSeekPendingAt = performance.now();
    this.lastNow = performance.now();
    this.presentedT = -1;
    this.started = false;
    // Arm (or, on a plain scrub, disarm) the freeze gate. A later non-freeze
    // seek clears a stale freeze so it never survives past its own cue.
    this.seekFreeze = freeze;
    this.seekFreezeTarget = tt;
    this.seekFreezeAt = performance.now();
    if (this.persistent) {
      // The stream stays OPEN: discard in-flight pre-seek frames until the
      // decoder's marker comes back through the same body.
      this.holdingForSeek = true;
      this.clearBuffer();
    } else {
      // Raw dialect: the stream is sequential from its -ss; abort it now (no
      // stale frames drift the playhead forward) and reconnect at tt.
      this.ac?.abort();
      this.connToken++;
      this.clearBuffer();
    }
    this.cb.onTime?.(tt);
    if (this.seekTimer) window.clearTimeout(this.seekTimer);
    // EOF-exit on macOS: the persistent decoder idles at end-of-file and its
    // fetch body gets WEDGED by WKWebView while the reader sits idle there (see
    // the stall-watchdog note). An in-process /vcontrol seek DOES resume the
    // decoder (verified in the decode-server lab), but the wedged body delivers
    // ~one frame and starves, and the stall watchdog then reconnect-loops one-
    // frame-at-a-time forever (the chop "black video + frozen playhead" after a
    // prior EOF). A FRESH connection is the one path that always flows, so
    // restart there instead of reusing the parked stream. Mac-only: WebView2
    // has no such wedge and the in-process seek is smoother on Windows.
    if (isMac && atEofExit && !this.loopRegion) {
      this.seekTimer = 0;
      this.log('info', `replay out of end-of-file via fresh reconnect at ${tt.toFixed(2)}s (healthy path)`);
      void invoke('seek_video_audio', { sec: tt, dir: 1 }).catch(() => {});
      if (!this._playing) void invoke('pause_video_audio').catch(() => {});
      void this.connect(tt);
      return;
    }
    const debounce = this.persistent ? SEEK_DEBOUNCE_PTS_MS : SEEK_DEBOUNCE_RAW_MS;
    this.seekTimer = window.setTimeout(() => { this.seekTimer = 0; this.applySeek(tt); }, debounce);
  }

  private applySeek(tt: number): void {
    if (this.destroyed) return;
    this.lastSeekCmdAt = performance.now();
    if (this.persistent) {
      const issuedConnToken = this.connToken;
      const issuedStreamId = this.streamId;
      this.pendingMarkers++;
      this.holdingForSeek = false;
      void this.control('seek', tt).then((ok) => {
        if (ok || this.destroyed) return;
        // Ignore a late failure from a decoder that another fallback already
        // replaced. Reconnecting again would abort the fresh stream.
        if (issuedConnToken !== this.connToken || issuedStreamId !== this.streamId) return;
        // Decoder gone (control 404 / network failure): the marker will never
        // come, which would discard frames forever. Reconnect — /vstream
        // spawns a fresh decoder at tt.
        this.pendingMarkers = 0;
        this.dir = 1; // a fresh stream starts forward
        void this.connect(tt);
      });
    } else {
      this.dir = 1;
      void this.connect(tt); // new frame stream at tt (raw pipe is forward-only)
    }
    void invoke('seek_video_audio', { sec: tt, dir: this.dir }).catch(() => {});
    // The daemon keeps play/pause state across seeks, but re-assert pause in
    // case any layer resumed (raw fallback restarts the audio playing).
    if (!this._playing) void invoke('pause_video_audio').catch(() => {});
  }

  // Wall-bounce seek for the loop paths in present(). Keeps seek()'s trailing
  // coalesce, but fires the leading edge when no command has issued recently:
  // a wall that keeps crossing the clock (live left-edge drag) re-calls seek()
  // every frame, and the pure trailing debounce then NEVER issues — the
  // disarmed audio free-runs past the region while the clock sits parked.
  private lastSeekCmdAt = 0;
  private liveBounceSeek(t: number): void {
    this.seek(t);
    if (performance.now() - this.lastSeekCmdAt >= LIVE_BOUNCE_MAX_GAP_MS) {
      if (this.seekTimer) { window.clearTimeout(this.seekTimer); this.seekTimer = 0; }
      this.applySeek(t);
    }
  }

  // POST a transport command to the persistent decoder. True on 2xx. Seeks
  // carry the playback direction (the decoder streams backward for -1); loop
  // carries the region bounds.
  private async control(
    op: 'seek' | 'play' | 'pause' | 'loop' | 'tonemap',
    sec?: number,
    loop?: { in: number; out: number },
    on?: boolean,
  ): Promise<boolean> {
    if (!this.persistent || !this.streamId || !this.endpointBase) return false;
    const base = this.endpointBase.replace('/vstream', '/vcontrol');
    const url =
      `${base}?id=${this.streamId}&op=${op}` +
      (sec !== undefined ? `&sec=${sec}&dir=${this.dir}` : '') +
      (loop ? `&in=${loop.in}&out=${loop.out}` : '') +
      (on !== undefined ? `&on=${on ? 1 : 0}` : '');
    try {
      const r = await fetch(url, { method: 'POST' });
      return r.ok;
    } catch {
      return false;
    }
  }

  // Diagnostics line into BOTH the webview console (dev) and latch.log (field
  // receipts). The engine's mac stall-watchdog / loop-overdue / EOF-replay
  // warns previously reached only console.* and never survived to the log file.
  private log(level: 'error' | 'warn' | 'info', msg: string): void {
    const base = this.cfg.path.split(/[/\\]/).pop() ?? this.cfg.path;
    const line = `[nativeVideo] ${base}: ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
    logToFile(level, 'nativeVideo', `${base}: ${msg}`);
  }

  destroy(): void {
    this.destroyed = true;
    this.connToken++;
    if (this.seekTimer) { window.clearTimeout(this.seekTimer); this.seekTimer = 0; }
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.frameTimer) { window.clearTimeout(this.frameTimer); this.frameTimer = 0; }
    this.ac?.abort(); // server kills the decoder when the socket drops
    if (this.unlistenAudio) { this.unlistenAudio(); this.unlistenAudio = null; }
    void invoke('stop_video_audio').catch(() => {});
    this.clearBuffer();
  }

  private clearBuffer(): void {
    for (const f of this.frames) f.bmp.close();
    this.frames = [];
  }

  // A frameSize-matched reusable read buffer (see FRAME_BUF_RING). The reader
  // fills this instead of a fresh Uint8Array per frame; createImageBitmap
  // snapshots the ImageData built over it, so by the time the read() → decode
  // await resolves the slot is free for reuse a full ring-lap later. A slot is
  // rebuilt only when frameSize changes (a height reconnect), so a stale view
  // can never outrun the payload.
  private nextRingBuf(): Uint8Array {
    let b = this.bufRing[this.bufRingIdx];
    if (!b || b.length !== this.frameSize) {
      b = new Uint8Array(this.frameSize);
      this.bufRing[this.bufRingIdx] = b;
      this.memBufFresh++;
    } else {
      this.memBufReused++;
    }
    this.bufRingIdx = (this.bufRingIdx + 1) % FRAME_BUF_RING;
    return b;
  }

  private bufferedAhead(): number {
    if (this.frames.length === 0) return 0;
    // With a decoder loop armed the buffer holds wrapped cycles whose
    // times RESTART at the in-point — `last.t - clock` goes NEGATIVE
    // right after the decoder wraps, the reader thinks it's starving,
    // and the decoder free-runs whole cycles into the buffer (the
    // burst-play-then-freeze wrap). Frame COUNT is wrap-immune.
    if (this.decoderLoop && this.dir > 0) {
      return this.frames.length / Math.max(1, this.fps);
    }
    // "Ahead" is in PLAYBACK order: above the clock going forward, below it in
    // reverse (the stream's times descend there).
    const last = this.frames[this.frames.length - 1].t;
    return this.dir > 0 ? last - this.clock : this.clock - last;
  }

  private async connect(start: number): Promise<void> {
    this.ac?.abort();
    this.clearBuffer();
    const token = ++this.connToken;
    this.streamStart = start;
    this.frameIdx = 0;
    this.persistent = false;
    this.streamId = '';
    this.holdingForSeek = false;
    this.pendingMarkers = 0;
    // A reconnect streams from `start` (the cue for a seek-fallback), so there
    // are no pre-cue frames to guard against — drop any freeze so the first
    // frame paints.
    this.seekFreeze = false;
    this.dir = 1; // a fresh stream always starts forward
    this.decoderLoop = false; // re-armed after the headers land
    this.decoderLoopRegion = null;
    const ac = new AbortController();
    this.ac = ac;

    try {
      if (!this.endpointBase) {
        this.endpointBase = (await invoke<string>('video_stream_endpoint').catch(() => '')) || '';
      }
      if (!this.endpointBase) { this.cb.onError?.('frame server not available'); return; }
      if (token !== this.connToken) return;

      const lathePath = latheStatus.get().path ?? '';
      const url =
        `${this.endpointBase}?path=${encodeURIComponent(this.cfg.path)}` +
        `&height=${this.curHeight}&fps=${this.cfg.fps}&start=${start}` +
        `&lathe=${encodeURIComponent(lathePath)}`;

      this.connFetching = true;
      let resp: Response;
      try {
        resp = await fetch(url, { signal: ac.signal });
      } finally {
        this.connFetching = false;
      }
      this.lastReadAt = performance.now();
      if (token !== this.connToken) return;
      if (!resp.ok || !resp.body) { this.cb.onError?.(`stream HTTP ${resp.status}`); return; }

      const geom = parseGeomHeader(resp.headers.get('x-wavdesk-geom'));
      if (!geom) { this.cb.onError?.('missing/invalid geometry header'); return; }
      this.w = geom.w;
      this.h = geom.h;
      this.fps = geom.fps > 0 ? geom.fps : this.cfg.fps;
      this.frameSize = geom.w * geom.h * 4;
      this.streamId = resp.headers.get('x-wavdesk-stream-id') ?? '';
      this.persistent = resp.headers.get('x-wavdesk-proto') === 'pts' && this.streamId !== '';
      if (geom.dur > 0 && this._duration === 0) { this._duration = geom.dur; this.cb.onDuration?.(geom.dur); }
      this.cb.onGeom?.(geom);
      this.connectedHeight = this.curHeight;
      this.connectedAt = performance.now();
      // A fresh decoder knows nothing of the loop region — re-arm it. Same
      // for a tone-map the user toggled OFF (the decoder defaults ON for HDR).
      if (this.loopRegion) this.queueArmLoop();
      if (!this.tonemapOn && geom.hdr) void this.control('tonemap', undefined, undefined, false);
      // Paused mount (autoplay:false / reconnect while paused): idle the fresh
      // decoder so it doesn't free-run into a backpressured pipe (feeding the
      // WKWebView wedge above). Deferred to the first buffered frame — pausing
      // before it would leave `frames` empty and the pane stuck on Loading.
      this.deferInitialPause = !this._playing && this.persistent;

      const reader = resp.body.getReader();
      const queue: Uint8Array[] = [];
      let queued = 0;
      // `dest`, when given, receives the bytes instead of a fresh allocation —
      // the per-frame payload reuses a ring buffer (nextRingBuf) to kill the
      // 3.3MB/frame heap churn. The small header read passes no dest.
      const readExact = async (n: number, dest?: Uint8Array): Promise<Uint8Array | null> => {
        while (queued < n) {
          const { value, done } = await reader.read();
          this.lastReadAt = performance.now();
          if (done) return null;
          if (value && value.length) { queue.push(value); queued += value.length; }
        }
        const out = dest && dest.length === n ? dest : new Uint8Array(n);
        let off = 0;
        while (off < n) {
          const head = queue[0];
          const take = Math.min(head.length, n - off);
          out.set(head.subarray(0, take), off);
          if (take === head.length) queue.shift();
          else queue[0] = head.subarray(take);
          queued -= take;
          off += take;
        }
        return out;
      };

      while (token === this.connToken && !this.destroyed) {
        // Backpressure: don't read past the buffer ceiling — except while
        // waiting out a seek, when the pipe must drain to reach the marker no
        // matter how full the (about-to-be-cleared) buffer is. Forward is capped
        // by FRAME COUNT (MAX_BUFFERED_FRAMES_FWD) so live ImageBitmap memory
        // stays bounded regardless of fps/decode-run-ahead; reverse keeps the
        // deep seconds-based runway for whole-GOP backward bursts.
        while (
          token === this.connToken && !this.destroyed &&
          (this.dir < 0
            ? this.bufferedAhead() > BUFFER_AHEAD_REVERSE_SEC
            : this.frames.length >= MAX_BUFFERED_FRAMES_FWD) &&
          !(this.persistent && (this.holdingForSeek || this.pendingMarkers > 0))
        ) {
          this.lastReadAt = performance.now(); // idle on purpose — not a stall
          await sleep(12);
        }
        if (token !== this.connToken || this.destroyed) break;

        let frameT: number;
        let payload: Uint8Array | null;
        if (this.persistent) {
          const hdr = await readExact(12);
          if (!hdr) break; // decoder exited
          const dv = new DataView(hdr.buffer, hdr.byteOffset, 12);
          frameT = Number(dv.getBigUint64(0, true)) / 1e6;
          const len = dv.getUint32(8, true);
          if (len === 0) {
            // Seek marker: the boundary between stale and fresh. Drop anything
            // that slipped into the buffer and, once the LAST outstanding
            // seek's marker is in, start accepting frames again.
            this.pendingMarkers = Math.max(0, this.pendingMarkers - 1);
            this.clearBuffer();
            continue;
          }
          if (len === 0xffffffff) {
            // Wrap marker (gapless loop): continuity — the buffered tail still
            // plays out; present() handles the clock. Nothing to flush.
            continue;
          }
          if (len !== this.frameSize) { this.cb.onError?.('frame stream desync'); break; }
          payload = await readExact(len, this.nextRingBuf());
          if (!payload) break;
          if (this.holdingForSeek || this.pendingMarkers > 0) continue; // stale
        } else {
          frameT = this.streamStart + this.frameIdx / this.fps;
          payload = await readExact(this.frameSize, this.nextRingBuf());
          if (!payload) break; // EOF (end of video in the raw dialect)
        }
        if (token !== this.connToken) break;
        // Frames are opaque sRGB-ish RGBA already — skip the alpha/color
        // conversion passes (a per-frame cost at video rates).
        const bmp = await createImageBitmap(
          new ImageData(new Uint8ClampedArray(payload.buffer, payload.byteOffset, this.frameSize), this.w, this.h),
          { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
        );
        if (token !== this.connToken || this.destroyed) { bmp.close(); break; }
        this.frames.push({ t: frameT, bmp });
        this.frameIdx++;
        this.memFramesDecoded++;
        // Paused mount: first frame is in (present() can paint it and fire
        // onReady) — NOW idle the decoder. Re-check _playing live: a play()
        // racing the first frame must not be immediately re-paused.
        if (this.deferInitialPause) {
          this.deferInitialPause = false;
          if (!this._playing) void this.control('pause');
        }
      }
      try { await reader.cancel(); } catch { /* ignore */ }

      // A persistent stream never EOFs on its own (the decoder idles at end of
      // video) — the body ending means the decoder died. Resurrect at the
      // current position rather than freezing, but an instant-death respawn
      // loop (file gone, decoder crashing on load) gets three strikes.
      if (this.persistent && token === this.connToken && !this.destroyed) {
        this.quickDeaths = performance.now() - this.connectedAt < 2000 ? this.quickDeaths + 1 : 0;
        if (this.quickDeaths >= 3) {
          this.cb.onError?.('video stream failed repeatedly');
          return;
        }
        await sleep(300);
        if (token === this.connToken && !this.destroyed) void this.connect(this.clock);
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      if (token === this.connToken && !this.destroyed && !aborted) {
        if (this.persistent) {
          this.quickDeaths = performance.now() - this.connectedAt < 2000 ? this.quickDeaths + 1 : 0;
          if (this.quickDeaths < 3) {
            const resumeAt = this.clock;
            this.log('warn', `stream read failed (${e}) - recovering at ${resumeAt.toFixed(2)}s`);
            await sleep(300);
            if (token === this.connToken && !this.destroyed) void this.connect(resumeAt);
            return;
          }
        }
        this.log('error', `stream read failed repeatedly: ${e}`);
        this.cb.onError?.(`stream read failed: ${e}`);
      }
    }
  }

  private present = (): void => {
    if (this.destroyed) return;
    const now = performance.now();
    const dt = (now - this.lastNow) / 1000;

    // Churn-backoff bookkeeping: a clean playback stretch (bytes flowing AND the
    // buffer not starved) resets the consecutive-stall tier growth and releases
    // a past-cap hold. Reset the running stamp the moment health lapses.
    if (isMac && this._playing && this.dir > 0) {
      const healthy = now - this.lastReadAt < STREAM_STALL_MS &&
                      this.bufferedAhead() >= STREAM_STALL_STARVED_SEC;
      if (healthy) {
        if (this.stallCleanSince === 0) this.stallCleanSince = now;
        if (now - this.stallCleanSince >= STALL_CLEAN_PLAY_MS) {
          this.stallStreak = 0;
          this.stallHeld = false;
        }
      } else {
        this.stallCleanSince = 0;
      }
    }

    // WKWebView stream-stall watchdog (see STREAM_STALL_MS): playing forward,
    // buffer starved, no stream bytes — the fetch body is wedged; a fresh
    // connection is the only cure. A seek/re-cue in flight (the loop-wrap re-cue
    // included) arms the SLOW tier — its keyframe decode-forward is a LEGITIMATE
    // byte gap. Otherwise the fast tier applies, grown by the consecutive-stall
    // streak so a heavy keyframe re-decode can't be mistaken for a wedge.
    const grownStall = STREAM_STALL_MS * (1 << Math.min(this.stallStreak, 4));
    const stallMs = this.seekInFlight()
      ? STREAM_STALL_SLOW_MS
      : Math.min(STREAM_STALL_MAX_MS, grownStall);
    if (
      isMac && this._playing && this.dir > 0 && !this.connFetching &&
      this.endpointBase !== '' &&
      now - this.lastReadAt > stallMs &&
      this.bufferedAhead() < STREAM_STALL_STARVED_SEC &&
      !(this._duration > 0 && this.clock >= this._duration - 1)
    ) {
      this.stallReconnects = this.stallReconnects.filter((t) => now - t < STALL_RECONNECT_WINDOW_MS);
      if (this.stallReconnects.length >= STALL_RECONNECT_CAP) {
        // Reconnect cap hit: more respawns only deepen the churn. HOLD the
        // stream (the held frame is the buffering surface) until the rolling
        // window frees a slot or a clean stretch recovers. Budgeted: one line.
        if (!this.stallHeld) {
          this.stallHeld = true;
          this.log('warn',
            `stall reconnect cap (${STALL_RECONNECT_CAP}/${STALL_RECONNECT_WINDOW_MS / 1000}s) reached at ${this.clock.toFixed(2)}s - holding stream`);
        }
        this.lastReadAt = now; // cooldown; don't spin the watchdog
      } else {
        this.stallReconnects.push(now);
        this.stallStreak++;
        this.log('warn',
          `stream stalled (${Math.round(now - this.lastReadAt)}ms without bytes, ` +
          `${this.frames.length} frames buffered) - reconnecting at ${this.clock.toFixed(2)}s (streak ${this.stallStreak})`);
        this.lastReadAt = now; // cooldown; connect() keeps it fresh from here
        void this.connect(this.clock);
      }
    }

    // Memory receipt (budgeted, removable): every MEM_RECEIPT_MS during
    // playback report frames decoded, ring reuse, and approximate MB moved, so a
    // churn regression (fresh-alloc creeping back in) shows up in latch.log.
    // memBufFresh should read ~FRAME_BUF_RING once at warmup, then 0.
    if (this._playing && now - this.lastMemReceiptAt > MEM_RECEIPT_MS) {
      if (this.lastMemReceiptAt !== 0 && this.frameSize > 0) {
        const mb = (n: number) => (n * this.frameSize / 1e6).toFixed(1);
        const secs = Math.round((now - this.lastMemReceiptAt) / 1000);
        this.log('info',
          `mem: ${this.memFramesDecoded} frames decoded/${secs}s (~${mb(this.memFramesDecoded)}MB moved via pooled ring), ` +
          `ring ${this.bufRing.length}/${FRAME_BUF_RING} bufs (${this.memBufFresh} fresh/${this.memBufReused} reused), ` +
          `live ${this.frames.length} frames (~${mb(this.frames.length)}MB bitmaps)`);
      }
      this.lastMemReceiptAt = now;
      this.memFramesDecoded = 0;
      this.memBufFresh = 0;
      this.memBufReused = 0;
    }

    // Hold until the first frame is buffered, then start the clock — so there's
    // no audio-wait freeze and no racing ahead of the picture.
    if (!this.started && this._playing && this.frames.length > 0) this.started = true;

    if (this.started && this._playing) {
      // Signed clock: forward at +rate, TRUE reverse at -rate (the reversed
      // audio's position descends and remains the master either way).
      this.clock += dt * this.effRate() * this.dir;
      if (this.audioActive && !this.audioSeekPending) {
        // Audio is the master, but EASE onto it rather than snapping: smooth
        // startup takeover + rejection of bursty/late position events. A big
        // drift (a seek) snaps. Between events the position extrapolates at
        // the playback rate (the daemon's cursor advances at rate too).
        const target = this.audioPos + ((now - this.audioPosAt) / 1000) * this.effRate() * this.dir;
        const err = target - this.clock;
        // Snap (never smooth-glide) across a loop seam: the audio cursor jumps
        // BACK to the in-point at a wrap, so a small NEGATIVE err while looping
        // is a wrap, not drift — easing it would sweep the playhead smoothly
        // backwards across the seam (the recurring "phantom bounce"). Big
        // drifts snap too.
        if (Math.abs(err) > 0.75 || (this.loopRegion && err < -0.02)) this.clock = target;
        else this.clock += err * Math.min(1, dt * 4);
      }
      if (this.dir < 0) {
        if (this.clock <= 0) {
          // Reverse ran out of video: stop the shuttle where it landed.
          this.clock = 0;
          this.shuttle(0);
          this.cb.onShuttleEnd?.();
        }
      } else if (this.liveLoopActive && this.loopRegion && this.clock < this.loopRegion.inSec - 0.02) {
        // The LEFT wall was dragged right past the playhead — snap the ball
        // back inside. The bounce target moves with the wall, live; the
        // leading-edge bounce seek keeps the AUDIO re-cued during a sustained
        // chase (a pure trailing debounce starves and the disarmed audio
        // free-runs past the out-point — the left-edge-drag escape).
        this.liveBounceSeek(this.loopRegion.inSec);
      } else if (this.loopRegion && this.clock >= this.loopRegion.outSec) {
        // Loop region wraps before the end-of-video check (out may sit at the
        // very end).
        if (!this.decoderLoop || this.liveLoopActive) {
          // Raw fallback OR a live region-drag (the decoder is still armed at
          // the grab-time out-point and can't chase the moving wall) — re-cue
          // to the LIVE in-point so the bounce lands on the current wall.
          this.liveBounceSeek(this.loopRegion.inSec);
        } else if (this.clock >= this.loopRegion.outSec + LOOP_WRAP_OVERDUE_SEC) {
          // The gapless decoder loop owns this wrap, but the audio master has
          // sailed past the out-point: the arm was lost or raced (e.g. a stale
          // live-drag callback queued a disarm behind a drop's re-arm). Without
          // this the hard-follow below tracks the escaped audio FOREVER.
          // Re-take authority: re-cue inside the region and re-send the arm.
          this.log('warn', `loop wrap overdue at ${this.clock.toFixed(2)}s (out ${this.loopRegion.outSec.toFixed(2)}s) - re-cueing + re-arming`);
          this.seek(this.loopRegion.inSec);
          this.queueArmLoop();
        } else if (this.audioActive && !this.audioSeekPending) {
          // Gapless: the decoders already wrapped; hard-follow the audio
          // cursor through the seam (the ease's snap threshold can exceed a
          // SHORT loop's whole length, which would smear the wrap).
          this.clock = this.audioPos + ((now - this.audioPosAt) / 1000) * this.effRate() * this.dir;
        } else {
          // Muted video: wrap the wall clock locally, keeping the overshoot
          // so cycle length stays exact.
          this.clock = this.loopRegion.inSec + (this.clock - this.loopRegion.outSec);
        }
      } else if (this._duration > 0 && this.clock >= this._duration) {
        this.clock = this._duration;
        this._playing = false;
        void this.control('pause'); // idle the decoder at end-of-video
        void invoke('pause_video_audio').catch(() => {});
        this.cb.onState?.(false);
      }
    } else if (this.started && this.audioActive && !this.audioSeekPending) {
      this.clock = this.audioPos; // paused: hold exactly at the audio cursor
    }
    this.lastNow = now;

    // Present slightly ahead of the clock to offset the video pipeline latency
    // so the picture lands on the sound (see VIDEO_AV_LEAD_SEC). The latency
    // is wall-time, so in content-seconds it scales with the playback rate;
    // "ahead" flips with the direction (reverse frames descend in time).
    const lead = VIDEO_AV_LEAD_SEC * this.effRate();
    // Gapless loop: after a wrap the buffer head still holds tail-of-cycle
    // frames; once the clock is back near the in-point they're BEHIND us in
    // loop order (the t-scan below would wedge on them) — drop them.
    if (this.decoderLoop && this.loopRegion && this.dir > 0) {
      const half = (this.loopRegion.outSec - this.loopRegion.inSec) / 2;
      while (this.frames.length > 1 && this.clock < this.frames[0].t - half) {
        this.frames[0].bmp.close();
        this.frames.shift();
      }
    }
    let idx = -1;
    for (let i = 0; i < this.frames.length; i++) {
      // Never scan ACROSS a wrap boundary (a t decrease): post-wrap
      // frames sit at the in-point, which is always <= a clock near the
      // out-point — walking into them burst-plays the next cycle early
      // and strands the tail. The head-shed above exposes the next
      // cycle once the clock itself wraps.
      if (this.decoderLoop && this.dir > 0 && i > 0 && this.frames[i].t < this.frames[i - 1].t) break;
      const ahead = this.dir > 0
        ? this.frames[i].t <= this.clock + lead
        : this.frames[i].t >= this.clock - lead;
      if (ahead) idx = i;
      else break;
    }
    if (idx < 0 && this.frames.length > 0) idx = 0; // nothing at the clock yet (just seeked) — show the earliest

    // Gapless seam: within `lead` of the out-point the picture should already
    // be showing the NEXT cycle's frames (the A/V lead carries across the wrap,
    // exactly as it leads mid-cycle) — otherwise it FREEZES on the out-frame
    // for ~`lead` seconds (the visible "last 5% stalls before it loops" bug),
    // because the scan above stops at the wrap boundary and there's nothing
    // past the out-point to advance to. Pick the post-wrap frame the WRAPPED
    // lead points at and DISPLAY that. Buffer management (the idx splice +
    // head-shed) is deliberately left on `idx`, so the pre-wrap tail is still
    // released the normal way once the clock itself wraps — this only changes
    // which already-buffered frame we paint.
    let showIdx = idx;
    if (this.decoderLoop && this.dir > 0 && this.loopRegion && this.clock + lead > this.loopRegion.outSec) {
      const wrapped = this.loopRegion.inSec + (this.clock + lead - this.loopRegion.outSec);
      let seam = -1;
      for (let i = 1; i < this.frames.length; i++) {
        if (this.frames[i].t < this.frames[i - 1].t) { seam = i; break; } // first post-wrap frame
      }
      if (seam >= 0) {
        let j = seam;
        for (let i = seam; i < this.frames.length; i++) {
          if (i > seam && this.frames[i].t < this.frames[i - 1].t) break; // stop before a 2nd cycle's seam
          if (this.frames[i].t <= wrapped) j = i; else break;
        }
        showIdx = j;
      }
    }

    if (idx > 0) {
      for (let i = 0; i < idx; i++) this.frames[i].bmp.close();
      this.frames.splice(0, idx);
      showIdx = Math.max(0, showIdx - idx); // reindex after the splice
    }
    const cur = this.frames[showIdx] ?? this.frames[0];
    // Freeze-through-seek: while frozen, hold the last displayed frame (paint
    // nothing) until a frame AT/AFTER the cue lands — so the decoder's on-the-way
    // keyframe frames never flash a wrong picture during a retrigger/stop seek.
    // Released the instant the cue frame is available, or by the time cap so a
    // wedged decoder can't blank the picture forever.
    if (this.seekFreeze) {
      if (now - this.seekFreezeAt > SEEK_FREEZE_MAX_MS) this.seekFreeze = false;
      else if (cur && cur.t >= this.seekFreezeTarget - SEEK_FREEZE_TARGET_TOL_SEC) this.seekFreeze = false;
    }
    if (cur && !this.seekFreeze && cur.t !== this.presentedT) {
      this.presentedT = cur.t;
      this.cb.onFrame(cur.bmp);
    }

    if (now - this.lastTimeEmit > 50) { this.lastTimeEmit = now; this.cb.onTime?.(this.clock); }
    // Re-scheduling is owned by frameTick (rAF + mac timer fallback), not here.
  };
}
