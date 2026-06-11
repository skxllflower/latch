// Shared image-analysis helpers used by both ImageView (static images) and
// VideoView (live frames): channel definitions, histogram, median-cut palette.
// Kept framework-free so either canvas surface can feed in a sampled RGBA
// buffer and get back a histogram / palette / hex.

import type { WdSelectOption } from './WdSelect';

export type ImageChannel = 'rgb' | 'r' | 'g' | 'b' | 'a' | 'luma';

export const CHANNEL_OPTIONS: WdSelectOption<ImageChannel>[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
  { value: 'a', label: 'Alpha' },
  { value: 'luma', label: 'Luma' },
];

export type Swatch = { r: number; g: number; b: number };
export type Histogram = { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; max: number };

export function buildHistogram(data: Uint8ClampedArray, sw: number, sh: number): Histogram {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const step = Math.max(1, Math.floor((sw * sh) / 200000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    const rr = data[i], gg = data[i + 1], bb = data[i + 2];
    r[rr]++; g[gg]++; b[bb]++;
    l[(0.2126 * rr + 0.7152 * gg + 0.0722 * bb) | 0]++;
  }
  let max = 1;
  for (let i = 1; i < 255; i++) {  // ignore pure 0/255 spikes for scaling
    if (r[i] > max) max = r[i];
    if (g[i] > max) max = g[i];
    if (b[i] > max) max = b[i];
  }
  return { r, g, b, l, max };
}

// Median-cut palette. Popularity-by-area drowned vivid-but-small regions
// (a sunset behind a grey road read as all-grey). Median cut instead splits
// the COLOR SPACE — repeatedly halving the box with the widest channel range
// — so distinct color regions each earn a swatch even when small. Swatches
// are sorted by hue for a pleasing left-to-right strip.
export function extractPalette(data: Uint8ClampedArray): Swatch[] {
  const px: number[][] = [];
  const stride = Math.max(1, Math.floor((data.length / 4) / 24000)) * 4;  // ~24k samples
  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] < 16) continue;  // skip ~transparent
    px.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (px.length === 0) return [];

  const boxStats = (box: number[][]) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const p of box) {
      if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
      if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
      if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
    }
    const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
    const range = Math.max(dr, dg, db);
    const axis = range === dr ? 0 : range === dg ? 1 : 2;
    return { range, axis };
  };

  const TARGET = 6;
  const boxes: number[][][] = [px];
  while (boxes.length < TARGET) {
    let bi = -1, best = -1;
    for (let k = 0; k < boxes.length; k++) {
      if (boxes[k].length < 2) continue;
      const r = boxStats(boxes[k]).range;
      if (r > best) { best = r; bi = k; }
    }
    if (bi < 0 || best <= 0) break;
    const box = boxes[bi];
    const { axis } = boxStats(box);
    box.sort((a, b) => a[axis] - b[axis]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  const swatches: Swatch[] = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
    return { r: Math.round(r / box.length), g: Math.round(g / box.length), b: Math.round(b / box.length) };
  });

  const out: Swatch[] = [];
  for (const c of swatches) {
    if (out.some((o) => Math.abs(o.r - c.r) + Math.abs(o.g - c.g) + Math.abs(o.b - c.b) < 36)) continue;
    out.push(c);
  }
  out.sort((a, b) => swatchHue(a) - swatchHue(b));
  return out.slice(0, 5);
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
export const swatchHex = (s: Swatch) => `#${hex2(s.r)}${hex2(s.g)}${hex2(s.b)}`;

// Hue (0..360) for ordering the strip; near-greys sort to the front.
export function swatchHue(s: Swatch): number {
  const r = s.r / 255, g = s.g / 255, b = s.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 1e-4) return -1;  // grey
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function drawHistogram(c: HTMLCanvasElement, h: Histogram, channel: ImageChannel): void {
  const ctx = c.getContext('2d')!;
  const w = c.width, ht = c.height;
  ctx.clearRect(0, 0, w, ht);
  const bins = (chan: Uint32Array, color: string) => {
    ctx.beginPath();
    ctx.moveTo(0, ht);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * w;
      const y = ht - Math.min(1, chan[i] / h.max) * (ht - 2);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, ht);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  // source-over (not 'lighter') so the curves read on light themes too.
  if (channel === 'rgb') {
    bins(h.r, 'rgba(248,113,113,0.5)');
    bins(h.g, 'rgba(74,222,128,0.5)');
    bins(h.b, 'rgba(96,165,250,0.5)');
  } else if (channel === 'r') bins(h.r, 'rgba(248,113,113,0.75)');
  else if (channel === 'g') bins(h.g, 'rgba(74,222,128,0.75)');
  else if (channel === 'b') bins(h.b, 'rgba(96,165,250,0.75)');
  else bins(h.l, 'rgba(161,161,170,0.8)');
}

// Eyedropper cursor (pipette SVG, hotspot at the tip 2,20). Shared so the
// palette strips in both views feel identical.
export const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>',
)}") 2 20, crosshair`;
