// Mouse wheel vs trackpad, for the visualizers' wheel listeners.
//
// Windows needs no classification: the raw-HID layer owns the touchpad and
// stands the wheel down while it is live, so every wheel event that gets
// through is a mouse. A WKWebView wheel event carries no device at all, and
// WebKit reports a slow notch of a mouse wheel (AppKit's accelerated 0.1 line,
// x40 px) as deltaY 4: the number a trackpad emits too. The old integer/>=30
// heuristic therefore read a real mouse as a trackpad. The Rust host
// (mac_scroll_source.rs) classifies each NSEvent natively and writes the result
// to `window.__wdScrollSource` whenever the device changes; that tag decides,
// and the heuristic only runs before the first tag arrives.

export type NativeScrollSource = 'wheel' | 'smooth' | 'touch';

export interface NativeScrollTag {
  src: NativeScrollSource;
  precise?: boolean;
  phase?: number;
  mom?: number;
  dy?: number;
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface WheelClass {
  /** Take the view's mouse-wheel path (the one Windows always takes). */
  isMouseWheel: boolean;
  /** platform = not macOS; native = AppKit tag; heuristic = no tag yet. */
  via: 'platform' | 'native' | 'heuristic';
  /** deltaY to feed the mouse-wheel zoom gain, in Windows units (a notch is
   *  100). Equals the event's deltaY everywhere except a mac notched wheel. */
  zoomDeltaY: number;
}

/** WebKit's Scrollbar::pixelsPerLineStep: one AppKit wheel line in DOM px. */
export const MAC_LINE_PX = 40;
/** WebView2's deltaY for one wheel notch at 100% scale. */
export const WINDOWS_NOTCH_DELTA = 100;
/** Ceiling on Windows notches per mac event: AppKit accelerates a fast spin
 *  to several lines per event; past this it would leap rather than zoom. */
export const MAX_NOTCHES_PER_EVENT = 3;

export function parseNativeScrollTag(raw: unknown): NativeScrollTag | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = (raw as { src?: unknown }).src;
  if (src !== 'wheel' && src !== 'smooth' && src !== 'touch') return null;
  return raw as NativeScrollTag;
}

/** A mac notched-wheel event in Windows units. AppKit sends one event per
 *  detent with an accelerated line delta (0.1 for a slow click), so each event
 *  is at least one Windows notch, and a fast-spin event (several lines, or a
 *  few clicks WebKit coalesced) is that many notches up to the ceiling. Sign
 *  is the event's: deltaY > 0 = wheel toward the user, same as WebView2. */
export function macNotchDeltaY(e: WheelLike): number {
  const dy = macMouseDeltaY(e);
  if (dy === 0 || !Number.isFinite(dy)) return 0;
  const lines = e.deltaMode === 1 ? Math.abs(dy)
    : e.deltaMode === 2 ? MAX_NOTCHES_PER_EVENT
    : Math.abs(dy) / MAC_LINE_PX;
  const notches = Math.min(MAX_NOTCHES_PER_EVENT, Math.max(1, lines));
  return Math.sign(dy) * WINDOWS_NOTCH_DELTA * notches;
}

/** AppKit turns Shift + mouse wheel into a horizontal scroll (deltaY 0, the
 *  value moved to deltaX, same sign). The views give Shift + wheel a meaning
 *  of their own (the spectrogram's time-only zoom), so undo the swap. */
export function macMouseDeltaY(e: WheelLike): number {
  return e.deltaY === 0 && e.shiftKey ? e.deltaX : e.deltaY;
}

/** The pre-tag heuristic, unchanged from what the views used before. */
export function heuristicMouseWheel(e: WheelLike): boolean {
  return e.deltaMode === 1
    || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 30);
}

export function classifyWheel(e: WheelLike, mac: boolean, native: NativeScrollTag | null): WheelClass {
  if (!mac) return { isMouseWheel: true, via: 'platform', zoomDeltaY: e.deltaY };
  if (native) {
    switch (native.src) {
      case 'touch':  return { isMouseWheel: false, via: 'native', zoomDeltaY: e.deltaY };
      case 'wheel':  return { isMouseWheel: true, via: 'native', zoomDeltaY: macNotchDeltaY(e) };
      // A smoothing utility already spreads each notch over many pixel events,
      // like a Windows hi-res wheel: the raw deltas carry the zoom.
      case 'smooth': return { isMouseWheel: true, via: 'native', zoomDeltaY: macMouseDeltaY(e) };
    }
  }
  return { isMouseWheel: heuristicMouseWheel(e), via: 'heuristic', zoomDeltaY: e.deltaY };
}

/** Budget for the wheel receipts: a line when the classification changes, or
 *  a reminder every `repeatMs`, never more than `perMinute` a minute. */
export function createReceiptGate(perMinute = 6, repeatMs = 15000) {
  let windowStart = -Infinity;
  let used = 0;
  let lastKey = '';
  let lastAt = -Infinity;
  return (key: string, now: number): boolean => {
    if (key === lastKey && now - lastAt < repeatMs) return false;
    if (now - windowStart >= 60000) { windowStart = now; used = 0; }
    if (used >= perMinute) return false;
    used++;
    lastKey = key;
    lastAt = now;
    return true;
  };
}

export function receiptKey(view: string, c: WheelClass, native: NativeScrollTag | null): string {
  return `${view}|${c.via}|${c.isMouseWheel ? 'mouse' : 'trackpad'}|${native?.src ?? 'none'}`;
}

export function formatReceipt(
  view: string,
  c: WheelClass,
  native: NativeScrollTag | null,
  e: WheelLike & { wheelDeltaY?: number },
): string {
  const n = native
    ? `native=${native.src} precise=${native.precise ?? '?'} phase=${native.phase ?? '?'} mom=${native.mom ?? '?'} ndy=${native.dy ?? '?'}`
    : 'native=none';
  return `[wheel-source] ${view} ${c.isMouseWheel ? 'mouse' : 'trackpad'} via=${c.via} ${n}`
    + ` dy=${e.deltaY} dx=${e.deltaX} wdy=${e.wheelDeltaY ?? '?'} mode=${e.deltaMode}`
    + ` ctrl=${!!e.ctrlKey} meta=${!!e.metaKey} shift=${!!e.shiftKey} zoomDy=${c.zoomDeltaY}`;
}
