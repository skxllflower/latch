// Pure, framework-free model for the Latch chop window's selection
// regions. Regions are kept sorted by startSec and may never overlap —
// every mutation clamps against its neighbours so the invariant holds
// by construction, which is what lets the overlay render the bands
// without ever worrying about crossing edges.

export type ClipState = 'none' | 'rendering' | 'ready' | 'error';

export interface ChopRegion {
  id: string;
  startSec: number;
  endSec: number;
  label: string;
  // Stable per-region accent (hex), assigned at creation so colors
  // don't shuffle as regions are sorted/added/removed.
  color: string;
  // Marked for the "export all" batch (the drag-out path ignores this
  // and renders on demand).
  staged: boolean;
  // Absolute path of this region's pre-rendered clip, once it exists.
  clipPath?: string;
  clipState: ClipState;
  // Second pre-render slot for the VIDEO variant. The dragout strip's right
  // half is always a video drag regardless of exportVideo, so an
  // audio-default region needs a video pre-render too or every video drag
  // re-renders under the held gesture (the mac ~1s bare-cursor gap).
  // Unused when exportVideo=true (the default slot IS video then).
  videoClipPath?: string;
  videoClipState?: ClipState;
  // Per-region override of the export-bar default. Only meaningful when
  // the source link includes video. undefined = follow the global.
  exportVideo?: boolean;
}

// Smallest region we allow — below this a cut is pointless and the two
// edge handles would sit on top of each other. ~20ms.
export const MIN_REGION_SEC = 0.02;

// Zero-crossing snap window (ms). A region edge released within this span of a
// waveform zero crossing is pulled to it (declick on export); the same window
// defines the file-edge exemption below. Shared by every chop host's
// snap-on-release so the search radius and the exemption stay in lockstep.
export const ZERO_CROSS_WINDOW_MS = 15;

// The file boundaries must ALWAYS be exactly selectable — the very first and
// very last sample — even with zero-cross snap ON. Without this the snap pulls
// a near-edge bound inward to the nearest interior crossing, so a file whose
// tail (or head) isn't at a crossing could never have its last (or first)
// half-cycle included. So: a bound targeting within the snap window of file
// start (0) or file end (duration) — or past them — resolves to the exact edge,
// with NO crossing search and NO backward clamp, ever. Returns the exact edge
// to snap to (0 or duration), or null when an interior crossing search should
// run for `sec`.
export function edgeSnapExempt(sec: number, duration: number): number | null {
  const win = ZERO_CROSS_WINDOW_MS / 1000;
  if (sec <= win) return 0;
  if (duration > 0 && sec >= duration - win) return duration;
  return null;
}

let _idSeq = 0;
export function nextRegionId(): string {
  _idSeq += 1;
  return `r${_idSeq}`;
}

// Distinct accents that read on the dark waveform bg. Cycled per
// creation so adjacent regions are easy to tell apart.
export const REGION_PALETTE = [
  '#38bdf8', '#f472b6', '#a3e635', '#fbbf24',
  '#c084fc', '#34d399', '#fb7185', '#60a5fa',
];
let _colorSeq = 0;
export function nextRegionColor(): string {
  const c = REGION_PALETTE[_colorSeq % REGION_PALETTE.length];
  _colorSeq += 1;
  return c;
}

const byStart = (a: ChopRegion, b: ChopRegion) => a.startSec - b.startSec;

export function sortRegions(regions: ChopRegion[]): ChopRegion[] {
  return [...regions].sort(byStart);
}

// Bound changes make any pre-rendered clip stale; reset it so the
// pre-render queue re-cuts. Label / staged / selection changes do NOT
// invalidate (they don't affect the cut bytes); exportVideo DOES (audio
// clip != video clip).
function invalidateClip(r: ChopRegion): ChopRegion {
  return {
    ...r,
    clipPath: undefined, clipState: 'none',
    videoClipPath: undefined, videoClipState: 'none',
  };
}

// The maximal free interval containing `sec`, or null if `sec` is inside
// an existing region (so a create there is rejected). Assumes sorted.
function freeGapContaining(
  regions: ChopRegion[],
  sec: number,
  duration: number,
): { lo: number; hi: number } | null {
  if (sec < 0 || sec > duration) return null;
  let lo = 0;
  let hi = duration;
  for (const r of regions) {
    if (sec > r.startSec && sec < r.endSec) return null; // inside a region
    if (r.endSec <= sec) lo = Math.max(lo, r.endSec);
    if (r.startSec >= sec) { hi = Math.min(hi, r.startSec); break; }
  }
  return { lo, hi };
}

// Create a default-width region anchored at `atSec` (double-click add).
// Clamps into the free gap; fills the gap if it's narrower than the
// default. Returns the new array + the new region id (or null if there
// was no room).
export function createDefaultRegion(
  regions: ChopRegion[],
  atSec: number,
  duration: number,
  defaultWidth: number,
): { regions: ChopRegion[]; id: string | null } {
  const sorted = sortRegions(regions);
  const gap = freeGapContaining(sorted, atSec, duration);
  if (!gap || gap.hi - gap.lo < MIN_REGION_SEC) return { regions, id: null };
  let start = atSec;
  let end = atSec + defaultWidth;
  if (end > gap.hi) { end = gap.hi; start = Math.max(gap.lo, end - defaultWidth); }
  if (start < gap.lo) { start = gap.lo; end = Math.min(gap.hi, start + defaultWidth); }
  if (end - start < MIN_REGION_SEC) { start = gap.lo; end = gap.hi; }
  const region: ChopRegion = {
    id: nextRegionId(), startSec: start, endSec: end,
    label: '', staged: true, clipState: 'none', color: nextRegionColor(),
  };
  return { regions: sortRegions([...regions, region]), id: region.id };
}

// Create a region by press-drag from `anchorSec` to `currentSec`,
// clamped to the free gap that contains the anchor. Returns id=null
// until the drag is at least MIN_REGION_SEC wide.
export function createDragRegion(
  regions: ChopRegion[],
  anchorSec: number,
  currentSec: number,
  duration: number,
): { regions: ChopRegion[]; id: string | null } {
  const sorted = sortRegions(regions);
  const gap = freeGapContaining(sorted, anchorSec, duration);
  if (!gap) return { regions, id: null };
  const lo = Math.max(gap.lo, Math.min(anchorSec, currentSec));
  const hi = Math.min(gap.hi, Math.max(anchorSec, currentSec));
  if (hi - lo < MIN_REGION_SEC) return { regions, id: null };
  const region: ChopRegion = {
    id: nextRegionId(), startSec: lo, endSec: hi,
    label: '', staged: true, clipState: 'none', color: nextRegionColor(),
  };
  return { regions: sortRegions([...regions, region]), id: region.id };
}

// Move one edge of a region to `toSec`. It can't cross its own opposite edge
// (minus MIN). A touching neighbour on the dragged side is PUSHED rather than
// acting as a brick wall: dragging past it shoves its facing edge along,
// shrinking it down to — but never past — MIN_REGION_SEC. So the clamp is the
// neighbour's FAR edge (± MIN), and the neighbour's near edge follows the
// dragged edge into the overlap (both regions' clips invalidate).
export function resizeEdge(
  regions: ChopRegion[],
  id: string,
  edge: 'start' | 'end',
  toSec: number,
  duration: number,
): ChopRegion[] {
  const sorted = sortRegions(regions);
  const idx = sorted.findIndex((r) => r.id === id);
  if (idx < 0) return regions;
  const r = sorted[idx];
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
  let { startSec, endSec } = r;
  let pushed: ChopRegion | null = null;
  if (edge === 'start') {
    // Floor is the PREV region's far edge (start + MIN), not its end — so the
    // drag can eat into it; the near edge (prev.endSec) is pushed to match.
    const floor = prev ? prev.startSec + MIN_REGION_SEC : 0;
    startSec = Math.max(0, Math.max(floor, Math.min(toSec, endSec - MIN_REGION_SEC)));
    if (prev && startSec < prev.endSec) pushed = invalidateClip({ ...prev, endSec: startSec });
  } else {
    const ceil = next ? next.endSec - MIN_REGION_SEC : duration;
    endSec = Math.min(duration, Math.min(ceil, Math.max(toSec, startSec + MIN_REGION_SEC)));
    if (next && endSec > next.startSec) pushed = invalidateClip({ ...next, startSec: endSec });
  }
  return sorted.map((x) => {
    if (x.id === id) return invalidateClip({ ...x, startSec, endSec });
    if (pushed && x.id === pushed.id) return pushed;
    return x;
  });
}

// Shift a whole region so its start lands at `newStartSec` (drag the
// body), clamped to the neighbour gap so the width is preserved and
// nothing overlaps.
export function moveRegion(
  regions: ChopRegion[],
  id: string,
  newStartSec: number,
  duration: number,
): ChopRegion[] {
  const sorted = sortRegions(regions);
  const idx = sorted.findIndex((r) => r.id === id);
  if (idx < 0) return regions;
  const r = sorted[idx];
  const width = r.endSec - r.startSec;
  const prevEnd = idx > 0 ? sorted[idx - 1].endSec : 0;
  const nextStart = idx < sorted.length - 1 ? sorted[idx + 1].startSec : duration;
  let start = Math.max(prevEnd, Math.min(newStartSec, nextStart - width));
  start = Math.max(0, Math.min(start, duration - width));
  return sorted.map((x) => (x.id === id ? invalidateClip({ ...x, startSec: start, endSec: start + width }) : x));
}

// Set a region to span [min(aSec,bSec), max(aSec,bSec)] clamped to its
// neighbour gap. Used for the live create-drag: feeding the fixed anchor
// and the moving cursor handles the cursor crossing the anchor cleanly
// (which a single-edge resize can't).
export function setRegionBounds(
  regions: ChopRegion[],
  id: string,
  aSec: number,
  bSec: number,
  duration: number,
): ChopRegion[] {
  const sorted = sortRegions(regions);
  const idx = sorted.findIndex((r) => r.id === id);
  if (idx < 0) return regions;
  const prevEnd = idx > 0 ? sorted[idx - 1].endSec : 0;
  const nextStart = idx < sorted.length - 1 ? sorted[idx + 1].startSec : duration;
  let lo = Math.max(0, Math.max(prevEnd, Math.min(aSec, bSec)));
  let hi = Math.min(duration, Math.min(nextStart, Math.max(aSec, bSec)));
  if (hi - lo < MIN_REGION_SEC) hi = Math.min(nextStart, lo + MIN_REGION_SEC);
  return sorted.map((x) => (x.id === id ? invalidateClip({ ...x, startSec: lo, endSec: hi }) : x));
}

export function deleteRegion(regions: ChopRegion[], id: string): ChopRegion[] {
  return regions.filter((r) => r.id !== id);
}

export function setLabel(regions: ChopRegion[], id: string, label: string): ChopRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, label } : r));
}

export function setStaged(regions: ChopRegion[], id: string, staged: boolean): ChopRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, staged } : r));
}

export function setExportVideo(regions: ChopRegion[], id: string, exportVideo: boolean): ChopRegion[] {
  return regions.map((r) => (r.id === id ? invalidateClip({ ...r, exportVideo }) : r));
}

// Stamp a region's clip render result (used by the pre-render queue).
export function setClip(
  regions: ChopRegion[],
  id: string,
  clipState: ClipState,
  clipPath?: string,
): ChopRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, clipState, clipPath } : r));
}

// Stamp the VIDEO-variant pre-render slot (see videoClipState on the model).
export function setVideoClip(
  regions: ChopRegion[],
  id: string,
  videoClipState: ClipState,
  videoClipPath?: string,
): ChopRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, videoClipState, videoClipPath } : r));
}

// Collapse a string to a safe, filesystem-friendly stem: strip illegal
// chars, single-space runs, drop trailing dots/spaces (Windows), and cap
// the length so a long video title can't make an unwieldy filename.
function sanitizeStem(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 60).replace(/[. ]+$/, '').trim();
}

// A safe, filesystem-friendly name for a region's exported clip. A region
// label wins; otherwise the source title + a 1-based index; otherwise a
// bare clip_NN. `baseName` is the media title from the chop seed.
export function regionFileStem(r: ChopRegion, index: number, baseName?: string): string {
  const num = String(index + 1).padStart(2, '0');
  const label = sanitizeStem(r.label || '');
  if (label) return label;
  const base = sanitizeStem(baseName || '');
  if (base) return `${base}_${num}`;
  return `clip_${num}`;
}

// Collision-proof mint stamp for clip filenames: yyMMdd-HHmmss, LOCAL time,
// taken at MINT (render creation). Mint time is monotonic per machine, so a
// filename freed by a shell reclaim (desktop drop deletes our redundant copy
// from Latch Clips) can never be re-minted identically by a later render —
// the destination collision that threw the OS replace prompt when two drags
// of re-rendered clips reused one name. No persisted ledger needed; the
// renderer's no-clobber (unique_output) stays as the clock-rollback backstop,
// and chronological name-sort in DAW browsers comes free. Mirrors WAVdesk's
// chopRegions.ts helpers — keep in lockstep.
export function mintChopStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The minted clip filename for a region: `<stem>_<yyMMdd-HHmmss>.<ext>`. */
export function stampedClipName(stem: string, ext: string, stamp?: string): string {
  return `${stem}_${stamp ?? mintChopStamp()}.${ext}`;
}
