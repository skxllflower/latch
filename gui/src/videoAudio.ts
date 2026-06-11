// Decodes a video's audio track once (AudioContext.decodeAudioData handles
// the demux + decode for MP4/MOV/WebM/…) and serves two things from it:
//   • waveform peaks for the scrubber timeline
//   • a reversed copy for true reversed-tape audio during reverse shuttle
//
// Forward audio still plays through the <video> element; this WebAudio path
// is only used for reverse (which the <video> can't do). Bounded by duration
// so a long film doesn't decode gigabytes of PCM into memory.

const PEAKS = 1400;                 // waveform resolution (columns sampled)
const MAX_AUDIO_SEC = 30 * 60;      // skip decode beyond 30 min (memory guard)
const MAX_REVERSE_SEC = 12 * 60;    // reversed copy doubles memory — cap tighter

export class VideoAudio {
  readonly ready: Promise<boolean>;
  peaks: Float32Array | null = null;   // 0..1 abs peak per column (channel-mixed)
  duration = 0;
  private ctx: AudioContext | null = null;
  private reversed: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private volume = 1;            // 0..1, mirrors the player's volume/mute
  private failed = false;

  constructor(url: string, knownDurationSec: number) {
    this.ready = this.init(url, knownDurationSec).then(() => this.isReady).catch(() => false);
  }

  get isReady() { return !this.failed && !!this.peaks; }
  get hasReverse() { return !!this.reversed; }

  private async init(url: string, knownDuration: number): Promise<void> {
    if (knownDuration > MAX_AUDIO_SEC) { this.failed = true; return; }
    const ab = await (await fetch(url)).arrayBuffer();
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) { this.failed = true; return; }
    this.ctx = new Ctx();
    let buffer: AudioBuffer;
    try {
      buffer = await this.ctx.decodeAudioData(ab);
    } catch {
      this.failed = true;            // no audio track / unsupported codec
      try { await this.ctx.close(); } catch { /* ok */ }
      this.ctx = null;
      return;
    }
    this.duration = buffer.duration;
    this.peaks = computePeaks(buffer, PEAKS);
    if (this.duration <= MAX_REVERSE_SEC) this.reversed = makeReversed(this.ctx, buffer);
    // `buffer` (full forward PCM) is no longer needed — peaks + reversed cover
    // our uses; let it GC.
  }

  // Start reversed playback from forward time `fromTime`, backward at `rate`.
  // Returns the AudioContext clock time at start (for position tracking).
  playReverse(fromTime: number, rate: number): number {
    this.stop();
    if (!this.ctx || !this.reversed) return 0;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.gain) { this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); }
    this.gain.gain.value = this.volume;   // honor the player's volume/mute
    const src = this.ctx.createBufferSource();
    src.buffer = this.reversed;
    src.playbackRate.value = Math.max(0.0625, rate);
    // Reversed-buffer time r maps to forward time (duration − r), so to start
    // at forward `fromTime` we offset into the reversed buffer by duration−fromTime.
    src.connect(this.gain);
    src.start(0, Math.max(0, this.duration - fromTime));
    this.src = src;
    return this.ctx.currentTime;
  }

  // Mirror the player's volume (0..1; pass 0 for mute) onto the reverse bus.
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  // Forward-time position now, given the start clock time / from-time / rate.
  positionAt(startCtxTime: number, fromTime: number, rate: number): number {
    if (!this.ctx) return fromTime;
    return Math.max(0, fromTime - (this.ctx.currentTime - startCtxTime) * rate);
  }

  stop() {
    if (this.src) { try { this.src.stop(); } catch { /* already stopped */ } this.src.disconnect(); this.src = null; }
  }

  close() {
    this.stop();
    try { this.gain?.disconnect(); } catch { /* ok */ }
    this.gain = null;
    try { void this.ctx?.close(); } catch { /* ok */ }
    this.ctx = null; this.reversed = null; this.peaks = null; this.failed = true;
  }
}

function computePeaks(buf: AudioBuffer, n: number): Float32Array {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const len = ch0.length;
  const peaks = new Float32Array(n);
  const step = Math.max(1, Math.floor(len / n));
  for (let i = 0; i < n; i++) {
    const start = i * step, end = Math.min(len, start + step);
    let max = 0;
    for (let j = start; j < end; j++) {
      const a = ch1 ? (Math.abs(ch0[j]) + Math.abs(ch1[j])) / 2 : Math.abs(ch0[j]);
      if (a > max) max = a;
    }
    peaks[i] = max;
  }
  return peaks;
}

function makeReversed(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = rev.getChannelData(c), n = s.length;
    for (let i = 0; i < n; i++) d[i] = s[n - 1 - i];
  }
  return rev;
}
