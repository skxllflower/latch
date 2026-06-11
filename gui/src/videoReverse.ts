// WebCodecs reverse-playback decoder. HTML5 <video> can't play backward
// (no negative playbackRate), and seeking backward decodes from a keyframe
// every frame → steppy. This decodes whole GOPs (keyframe → next keyframe)
// via VideoDecoder, caches the frames as ImageBitmaps, and lets the player
// present them in reverse — buttery within a GOP, a brief decode when it
// crosses into the previous one.
//
// MP4/MOV only (mp4box is an ISOBMFF demuxer). Other containers / decode
// failures resolve `ready` to false so the caller falls back to seek-reverse.

import { createFile, DataStream } from 'mp4box';

// mp4box's DataStream.BIG_ENDIAN constant isn't in the published types.
const BIG_ENDIAN = (DataStream as unknown as { BIG_ENDIAN: number }).BIG_ENDIAN;

// Diagnostics — flip to true to trace decode timing in the console.
const DBG = false;
const LOG = (...a: unknown[]) => { if (DBG) console.info('[reverse]', ...a); };
const WARN = (...a: unknown[]) => console.warn('[reverse]', ...a);

interface Sample {
  number: number;      // decode order
  cts: number;         // composition (presentation) time, timescale units
  isSync: boolean;     // keyframe
  data: Uint8Array;
}

export class ReverseDecoder {
  readonly ready: Promise<boolean>;
  private samplesDec: Sample[] = [];   // decode order
  private samplesPts: Sample[] = [];   // presentation order (by cts)
  private timescale = 1;
  private decoder: VideoDecoder | null = null;
  private pending: VideoFrame[] = [];
  private decodeChain: Promise<unknown> = Promise.resolve();
  private cache = new Map<number, ImageBitmap>();   // keyed by cts
  private cacheOrder: number[] = [];
  private inflight = new Set<number>();             // GOP keyframe-indices decoding
  private readonly CACHE_MAX = 240;
  private failed = false;
  private _ready = false;
  lastError = '';
  get isReady() { return this._ready && !this.failed; }

  constructor(url: string) {
    this.ready = this.init(url)
      .then(() => { this._ready = !this.failed && this.samplesDec.length > 0; return this._ready; })
      .catch(() => { this._ready = false; return false; });
  }

  private async init(url: string): Promise<void> {
    const buf = await (await fetch(url)).arrayBuffer();
    // mp4box wants fileStart on the buffer.
    const ab = buf as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    LOG('fetched', buf.byteLength, 'bytes | VideoDecoder=', typeof VideoDecoder, 'EncodedVideoChunk=', typeof EncodedVideoChunk);

    const file = createFile();
    let codec = '';
    let description: Uint8Array | undefined;
    let codedW = 0, codedH = 0;

    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      file.onError = (e: any) => { WARN('mp4box onError', e); reject(new Error(String(e))); };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      file.onReady = (info: any) => {
        const track = info.videoTracks?.[0];
        if (!track) { WARN('no video track; total tracks=', info.tracks?.length); reject(new Error('no video track')); return; }
        this.timescale = track.timescale || 1;
        codec = track.codec;
        codedW = track.video?.width ?? track.track_width ?? 0;
        codedH = track.video?.height ?? track.track_height ?? 0;
        LOG('track', { codec, codedW, codedH, timescale: this.timescale, nb_samples: track.nb_samples });
        // Pull the codec-private description (avcC / hvcC / …) out of the
        // sample-description box for VideoDecoder.configure.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const trak: any = file.getTrackById(track.id);
          const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
          for (const entry of entries) {
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (box) {
              const ds = new DataStream(undefined, 0, BIG_ENDIAN);
              box.write(ds);
              description = new Uint8Array(ds.buffer, 8);   // strip the 8-byte box header
              break;
            }
          }
          LOG('description', description ? `${description.byteLength} bytes` : 'NONE (entries=' + entries.length + ')');
        } catch (e) { WARN('description extract threw', e); }
        file.setExtractionOptions(track.id, null, { nbSamples: 10_000_000 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        file.onSamples = (_id: number, _u: any, arr: any[]) => {
          for (const s of arr) {
            this.samplesDec.push({ number: s.number, cts: s.cts, isSync: !!s.is_sync, data: new Uint8Array(s.data) });
          }
        };
        file.start();
        resolve();
      };
      file.appendBuffer(ab as unknown as Parameters<typeof file.appendBuffer>[0]);
      file.flush();
    });

    const keyframes = this.samplesDec.filter((s) => s.isSync).length;
    LOG('samples', this.samplesDec.length, 'keyframes', keyframes);
    if (this.samplesDec.length === 0) { this.lastError = 'no samples'; throw new Error('no samples'); }
    this.samplesDec.sort((a, b) => a.number - b.number);
    this.samplesPts = [...this.samplesDec].sort((a, b) => a.cts - b.cts);

    if (typeof VideoDecoder === 'undefined') { this.lastError = 'no VideoDecoder'; throw new Error('no VideoDecoder'); }
    const cfg: VideoDecoderConfig = {
      codec, codedWidth: codedW, codedHeight: codedH, description,
      optimizeForLatency: true, hardwareAcceleration: 'no-preference',
    };
    try {
      const sup = await VideoDecoder.isConfigSupported(cfg);
      LOG('isConfigSupported', sup.supported, '| resolved codec', sup.config?.codec);
      if (!sup.supported) { this.lastError = `config unsupported: ${codec} (desc=${!!description})`; WARN(this.lastError); }
    } catch (e) { WARN('isConfigSupported threw', e); }

    this.decoder = new VideoDecoder({
      output: (frame) => this.pending.push(frame),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (e: any) => { this.lastError = `decoder error: ${e?.message ?? e}`; WARN(this.lastError); this.failed = true; },
    });
    try {
      this.decoder.configure(cfg);
      LOG('configured OK');
    } catch (e) {
      this.lastError = `configure threw: ${(e as Error)?.message ?? e}`;
      WARN(this.lastError);
      this.failed = true;
    }
  }

  // Nearest presentation sample at or before `timeSec`.
  private sampleAtTime(timeSec: number): Sample | null {
    const target = timeSec * this.timescale;
    const a = this.samplesPts;
    if (a.length === 0) return null;
    let lo = 0, hi = a.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].cts <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return a[best];
  }

  private evict() {
    while (this.cacheOrder.length > this.CACHE_MAX) {
      const cts = this.cacheOrder.shift()!;
      const bmp = this.cache.get(cts);
      if (bmp) { try { bmp.close(); } catch { /* ok */ } this.cache.delete(cts); }
    }
  }

  private keyframeIndexFor(num: number): number {
    for (let i = Math.min(num, this.samplesDec.length - 1); i >= 0; i--) {
      if (this.samplesDec[i]?.isSync) return i;
    }
    return 0;
  }
  private gopEndFor(kf: number): number {
    for (let i = kf + 1; i < this.samplesDec.length; i++) {
      if (this.samplesDec[i].isSync) return i - 1;
    }
    return this.samplesDec.length - 1;
  }
  // The keyframe frame is decoded first, so it's evicted (LRU) first — its
  // presence is a good proxy for "this GOP is still fully cached".
  private isGopCached(kf: number): boolean {
    return this.cache.has(this.samplesDec[kf].cts);
  }

  // Decode GOP [kf..end] and cache its frames as ImageBitmaps. Serialized via
  // decodeChain so only one decode runs at a time.
  private async decodeRange(kf: number, end: number): Promise<void> {
    if (this.failed || !this.decoder) return;
    if (this.isGopCached(kf)) return;
    this.pending = [];
    const t0 = performance.now();
    try {
      for (let i = kf; i <= end; i++) {
        const s = this.samplesDec[i];
        this.decoder.decode(new EncodedVideoChunk({ type: s.isSync ? 'key' : 'delta', timestamp: s.cts, data: s.data }));
      }
      await this.decoder.flush();
    } catch (e) {
      WARN('decode/flush threw', e);
      this.lastError = `decode/flush: ${(e as Error)?.message ?? e}`;
      this.failed = true;
      for (const f of this.pending) { try { f.close(); } catch { /* ok */ } }
      this.pending = [];
      return;
    }
    let made = 0;
    for (const frame of this.pending) {
      const cts = Number(frame.timestamp);
      if (!this.cache.has(cts)) {
        try { const bmp = await createImageBitmap(frame); this.cache.set(cts, bmp); this.cacheOrder.push(cts); made++; }
        catch (e) { WARN('createImageBitmap failed', e); }
      }
      try { frame.close(); } catch { /* ok */ }
    }
    LOG('GOP', { kf, end, made, ms: Math.round(performance.now() - t0), cache: this.cache.size });
    this.pending = [];
    this.evict();
  }

  // Non-blocking: ensure the GOP containing `timeSec` is decoding/decoded so
  // it's cached before the playhead crosses into it (kills boundary stalls).
  prefetch(timeSec: number): void {
    if (this.failed || !this.decoder || timeSec < 0) return;
    const s = this.sampleAtTime(timeSec);
    if (!s) return;
    const kf = this.keyframeIndexFor(s.number);
    if (this.inflight.has(kf) || this.isGopCached(kf)) return;
    const end = this.gopEndFor(kf);
    this.inflight.add(kf);
    this.decodeChain = this.decodeChain
      .then(() => this.decodeRange(kf, end))
      .catch(() => { /* keep the chain alive */ })
      .finally(() => { this.inflight.delete(kf); });
  }

  // Synchronous nearest-cached lookup — never decodes. Returns the nearest
  // cached frame within ~0.5s so decode lag shows a near frame (keeps moving)
  // rather than freezing; null only when nothing close is cached (caller then
  // seek-falls-back). In steady state prefetch keeps the exact frame cached.
  getCached(timeSec: number): ImageBitmap | null {
    const s = this.sampleAtTime(timeSec);
    if (!s) return null;
    let best: ImageBitmap | null = null;
    let bestD = Infinity;
    for (const [cts, bmp] of this.cache) {
      const d = Math.abs(cts - s.cts);
      if (d < bestD) { bestD = d; best = bmp; }
    }
    return bestD <= this.timescale * 0.5 ? best : null;
  }

  close() {
    this.failed = true;
    try { this.decoder?.close(); } catch { /* ok */ }
    this.decoder = null;
    this.inflight.clear();
    for (const bmp of this.cache.values()) { try { bmp.close(); } catch { /* ok */ } }
    this.cache.clear(); this.cacheOrder = [];
    for (const f of this.pending) { try { f.close(); } catch { /* ok */ } }
    this.pending = [];
  }
}
