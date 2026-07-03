// Pure decision: does a loop-bounds handoff need a flush re-cue seek?
//
// Used at BOTH ends of a live region-drag:
//   grab (beginLiveLoop)  — outSec = the OLD armed out-point. Disarming alone
//     leaves any PRE-BUFFERED wrap (post-out data from the old cycle) queued
//     in the pipes; only a seek's markers flush both streams.
//   drop (setLoopRegion)  — outSec = the NEW settled out-point. A shrink can
//     pull the out-point BEHIND data the disarmed decoders already streamed;
//     the arm alone can't un-queue that stale post-out PCM/frames, so the
//     playhead (audio master) sails past the settled wall until it drains.
//
// The flush costs a hiccup (buffer clear + decoder re-cue), so it must fire
// ONLY when stale data can actually be queued:
//   - a wrap seam is already in the local frame buffer, or
//   - the video buffer's newest frame has reached the out-point, or
//   - the clock is within the AUDIO pipeline's decode look-ahead of it
//     (the PCM queue/ring + pipe slack — the part JS cannot inspect).
// A grab far from the walls hits none of these and stays glitchless.
//
// Kept dependency-free so the drag harnesses can unit-test it in node.

export interface LoopFlushInputs {
  playing: boolean;
  dirForward: boolean;
  clock: number;
  outSec: number;
  // A wrap seam (t decrease) exists in the locally buffered frames.
  seamBuffered: boolean;
  // Newest buffered frame's time, or null when the buffer is empty / audio-only.
  lastBufferedT: number | null;
  // PCM pipeline decode look-ahead in seconds (queue/ring depth + pipe slack).
  audioLookaheadSec: number;
}

export function staleWrapFlushNeeded(i: LoopFlushInputs): boolean {
  if (!i.playing || !i.dirForward) return false;
  if (i.seamBuffered) return true;
  if (i.lastBufferedT != null && i.lastBufferedT >= i.outSec - 0.05) return true;
  return i.clock > i.outSec - i.audioLookaheadSec;
}
