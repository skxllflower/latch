// Render the in-window drag chip to a PNG bitmap so `drag::start_drag` can
// use it as the OS drag image — the only way to keep the visual following the
// cursor once it exits our window. The React chip can't live outside the
// WebView's bounds; the OS compositor clips `position: fixed` at the window
// edge. A bitmap handed to DoDragDrop / NSDraggingSource / XDND can.
//
// Theme-appropriate: reads live CSS vars so the chip matches the current
// theme at drag-start. Cannot update mid-drag (OS owns the image), but drag
// lifetimes are short enough that a mid-drag theme switch is a non-issue.

export interface DragChipOptions {
  name: string;
  isDirectory: boolean;
  count: number; // total dragged items (1 = single)
  /** Scale factor applied to all dimensions (chip height, padding,
   *  icon size, font size). Default 1. The mini-mode visualizer
   *  drag-out passes a slightly larger value to make the chip stand
   *  out alongside the bigger source surface. */
  scale?: number;
}

export function buildDragChipPng(opts: DragChipOptions): Uint8Array | null {
  try {
    const { name, isDirectory, count } = opts;
    const scale = opts.scale ?? 1;
    const cs = getComputedStyle(document.documentElement);

    const bg     = readVar(cs, '--theme-bg-surface',    '#27272a');
    const border = readVar(cs, '--theme-border-hover',  '#52525b');
    const fg     = readVar(cs, '--theme-text-secondary','#a1a1aa');
    const bgBadge= readVar(cs, '--theme-bg-hover',      '#3f3f46');
    const fgBadge= readVar(cs, '--theme-text-primary',  '#fafafa');
    const radius = parseFloat(cs.getPropertyValue('--theme-radius')) || 0;
    const fontFamily = cs.fontFamily || 'ui-monospace, monospace';

    // HiDPI: encode at devicePixelRatio so the bitmap stays crisp when the
    // shell scales it up on high-DPI monitors. Windows/macOS drag APIs respect
    // the pixel dimensions of the supplied image.
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    const maxChars = 36;
    const displayName = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
    const showBadge = count > 1;
    const badgeText = `+${count - 1}`;

    // Measure in logical px (no DPR scaling on the measurement context — scaling
    // happens at draw-time via ctx.scale).
    const fontPx       = 10 * scale;
    const badgeFontPx  = 9 * scale;
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) return null;
    measure.font = `${fontPx}px ${fontFamily}`;
    const nameWidth = measure.measureText(displayName).width;
    measure.font = `600 ${badgeFontPx}px ${fontFamily}`;
    const badgeTextWidth = showBadge ? measure.measureText(badgeText).width : 0;

    const padX     = 8 * scale;
    const iconSize = 10 * scale;
    const iconGap  = 6 * scale;
    const badgeGap = 6 * scale;
    const badgePadX = 5 * scale;
    const badgeH   = 12 * scale;
    const badgeW = showBadge ? Math.ceil(badgeTextWidth) + badgePadX * 2 : 0;

    const chipH = 22 * scale;
    const chipW = Math.ceil(padX + iconSize + iconGap + nameWidth + (showBadge ? badgeGap + badgeW : 0) + padX);

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(chipW * dpr);
    canvas.height = Math.ceil(chipH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpr, dpr);

    // Body
    roundedRectPath(ctx, 0.5, 0.5, chipW - 1, chipH - 1, clampRadius(radius, chipW, chipH));
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Icon
    const iconX = padX;
    const iconY = (chipH - iconSize) / 2;
    ctx.save();
    ctx.translate(iconX, iconY);
    ctx.strokeStyle = fg;
    ctx.fillStyle = fg;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    if (isDirectory) drawFolderIcon(ctx, iconSize);
    else drawAudioFileIcon(ctx, iconSize);
    ctx.restore();

    // Filename
    ctx.fillStyle = fg;
    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName, padX + iconSize + iconGap, chipH / 2 + 0.5);

    // Badge
    if (showBadge) {
      const badgeX = padX + iconSize + iconGap + nameWidth + badgeGap;
      const badgeY = (chipH - badgeH) / 2;
      roundedRectPath(ctx, badgeX, badgeY, badgeW, badgeH, clampRadius(radius, badgeW, badgeH));
      ctx.fillStyle = bgBadge;
      ctx.fill();
      ctx.fillStyle = fgBadge;
      ctx.font = `600 ${badgeFontPx}px ${fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, badgeX + badgePadX, badgeY + badgeH / 2 + 0.5);
    }

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Variant chip used by the mini-mode visualizer drag-out. Drops the
// generic file icon AND the entire chip frame (no border, no rounded
// corners) — the chip is just a screenshot of the waveform with the
// filename in a strip directly underneath, on the same bg color
// sampled from the waveform canvas itself. Reads as "I'm dragging
// this specific sound out", with no extraneous chrome.
//
// Layout (one continuous opaque block, no frame line between):
//   +-----------------+
//   |    waveform     |
//   +-----------------+
//   |    filename     |
//   +-----------------+
//
// Every pixel is fully opaque — bg fill is set first, then the
// waveform drawImage'd on top, then text fillText'd onto solid bg.
// This kills the edge-fade Windows applies when the OS drag image
// has alpha-channel transparent pixels (text antialiasing and
// rounded corners both used to leak through to the OS as semi-
// transparent edges that compositor would feather).
//
// Defaults to scale=1.5 so the chip stands out alongside the larger
// source pane it's leaving.
export function buildWaveformDragChipPng(opts: {
  name: string;
  waveformCanvas: HTMLCanvasElement | null;
  scale?: number;
}): Uint8Array | null {
  try {
    const { name, waveformCanvas } = opts;
    const scale = opts.scale ?? 1.5;
    const cs = getComputedStyle(document.documentElement);

    const fg     = readVar(cs, '--theme-text-primary',  '#fafafa');
    const fontFamily = cs.fontFamily || 'ui-monospace, monospace';

    const dpr = Math.max(1, window.devicePixelRatio || 1);

    // Sample the bg color from the waveform canvas's top-left pixel —
    // guarantees the strip below merges seamlessly with the waveform
    // (theme-aware without dragChipPng having to know which theme is
    // active). Falls back to a near-black so the strip still reads if
    // sampling fails (canvas tainted, etc.).
    const bg = sampleCanvasBg(waveformCanvas) ?? '#0a0a0a';

    const maxChars = 36;
    const displayName = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;

    const fontPx     = 11 * scale;
    const labelPadX  = 6  * scale;
    const labelPadY  = 5  * scale;
    const thumbW     = 130 * scale;
    const thumbH     = 44  * scale;

    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) return null;
    measure.font = `600 ${fontPx}px ${fontFamily}`;
    const nameWidth = measure.measureText(displayName).width;

    const labelH = Math.ceil(fontPx + labelPadY * 2);
    const chipW  = Math.max(thumbW, Math.ceil(nameWidth + labelPadX * 2));
    const chipH  = thumbH + labelH;

    const canvas = document.createElement('canvas');
    canvas.width  = Math.ceil(chipW * dpr);
    canvas.height = Math.ceil(chipH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpr, dpr);

    // 1. Solid bg fill across the entire chip — this is the canvas
    //    every later pixel composites against, so antialiased text
    //    and waveform edges end up fully opaque.
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, chipW, chipH);

    // 2. Waveform — top, full chip width when the chip stretched to
    //    accommodate a long filename. A strip-shaped source (a real
    //    waveform) stretches like before — mild squish is fine and cropping
    //    would cut off the end of the waveform. A frame-shaped source (a
    //    video thumbnail, ~16:9 vs the ~3:1 strip) cover-crops centered
    //    instead: squashing it was the "weird stretched out" chip.
    const thumbDrawW = chipW;
    if (waveformCanvas && waveformCanvas.width > 0 && waveformCanvas.height > 0) {
      const srcW = waveformCanvas.width, srcH = waveformCanvas.height;
      const srcAspect = srcW / srcH, dstAspect = thumbDrawW / thumbH;
      if (srcAspect < dstAspect * 0.8 || srcAspect > dstAspect * 1.25) {
        let cw = srcW, ch = srcH;
        if (srcAspect < dstAspect) ch = srcW / dstAspect; else cw = srcH * dstAspect;
        ctx.drawImage(waveformCanvas, (srcW - cw) / 2, (srcH - ch) / 2, cw, ch, 0, 0, thumbDrawW, thumbH);
      } else {
        ctx.drawImage(waveformCanvas, 0, 0, thumbDrawW, thumbH);
      }
    }

    // 3. Filename — centered in the strip below.
    ctx.fillStyle = fg;
    ctx.font = `600 ${fontPx}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName, chipW / 2, thumbH + labelH / 2);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Crop a horizontal fraction [x0frac, x1frac] of a source canvas to a
// PNG data URL + sampled bg. Used by the Latch chop drag-out so the
// floating chip shows just the dragged region's slice of the on-screen
// waveform. Off-screen / too-thin slices fall back to the whole view.
export function cropCanvasFractionToDataUrl(
  src: HTMLCanvasElement, x0frac: number, x1frac: number,
): { url: string; bg: string | null } | null {
  try {
    const cw = src.width, ch = src.height;
    if (cw <= 0 || ch <= 0) return null;
    let sx0 = Math.round(Math.max(0, Math.min(1, x0frac)) * cw);
    let sx1 = Math.round(Math.max(0, Math.min(1, x1frac)) * cw);
    if (sx1 - sx0 < 4) { sx0 = 0; sx1 = cw; }
    const sw = sx1 - sx0;
    const off = document.createElement('canvas');
    off.width = sw; off.height = ch;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, sx0, 0, sw, ch, 0, 0, sw, ch);
    return { url: off.toDataURL('image/png'), bg: sampleCanvasBg(off) };
  } catch {
    return null;
  }
}

// Draw a centered translucent play-button glyph over a captured video
// frame and return it as a PNG data URL + sampled bg. Used by the chop
// drag-out chip in video mode. Mutates the supplied (offscreen) canvas.
export function videoFrameToChipDataUrl(
  frame: HTMLCanvasElement,
): { url: string; bg: string | null } | null {
  try {
    const w = frame.width, h = frame.height;
    if (w <= 0 || h <= 0) return null;
    const ctx = frame.getContext('2d');
    if (!ctx) return null;
    const cx = w / 2, cy = h / 2;
    const r = Math.max(12, Math.min(w, h) * 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(1.5, r * 0.08);
    ctx.stroke();
    const t = r * 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - t * 0.5, cy - t);
    ctx.lineTo(cx - t * 0.5, cy + t);
    ctx.lineTo(cx + t, cy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    return { url: frame.toDataURL('image/png'), bg: sampleCanvasBg(frame) };
  } catch {
    return null;
  }
}

// Render a crisp mini-waveform from [min,max,rms] peak bins into a fixed
// landscape PNG data URL (+ its dark bg). Used by the chop drag-out chip:
// fetching peaks for just the region (generate_waveform range) and drawing
// them here is sharp at any zoom, unlike cropping the on-screen canvas
// (which has too few horizontal pixels for a narrow selection).
export function peaksToChipDataUrl(
  points: [number, number, number][], color: string,
): { url: string; bg: string } | null {
  try {
    const N = points.length;
    if (!N) return null;
    const scale = 2;                       // supersample for crisp downscale
    const W = 320 * scale, H = 84 * scale;
    const bg = '#0c0c0d';
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const mid = H / 2;
    const amp = mid * 0.92;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const bin = Math.min(N - 1, Math.floor((x / W) * N));
      const mn = Math.max(-1, Math.min(1, points[bin][0]));
      const mx = Math.max(-1, Math.min(1, points[bin][1]));
      ctx.moveTo(x + 0.5, mid - mx * amp);
      ctx.lineTo(x + 0.5, mid - mn * amp);
    }
    ctx.stroke();
    return { url: canvas.toDataURL('image/png'), bg };
  } catch {
    return null;
  }
}

/** Read the top-left pixel of the supplied canvas as a CSS rgb()
 *  string. Used by the waveform drag chip to match the waveform's
 *  own bg color exactly. Returns null on getImageData failure
 *  (CORS / tainted canvas / etc.). */
export function sampleCanvasBg(canvas: HTMLCanvasElement | null): string | null {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
  } catch {
    return null;
  }
}

function readVar(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = cs.getPropertyValue(name).trim();
  return v || fallback;
}

function clampRadius(r: number, w: number, h: number): number {
  return Math.max(0, Math.min(r, w / 2, h / 2));
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Hand-drawn folder glyph at 10x10 base. Strokes a tabbed-rectangle outline.
function drawFolderIcon(ctx: CanvasRenderingContext2D, size: number) {
  const s = size / 10;
  ctx.beginPath();
  ctx.moveTo(0.5 * s, 3 * s);
  ctx.lineTo(3.5 * s, 3 * s);
  ctx.lineTo(4.5 * s, 2 * s);
  ctx.lineTo(9.5 * s, 2 * s);
  ctx.lineTo(9.5 * s, 8.5 * s);
  ctx.lineTo(0.5 * s, 8.5 * s);
  ctx.closePath();
  ctx.stroke();
}

// Hand-drawn audio-file glyph at 10x10 base. Document outline with a corner
// fold + a small note head inside — reads as "audio file" without needing
// the full lucide FileAudio path complexity.
function drawAudioFileIcon(ctx: CanvasRenderingContext2D, size: number) {
  const s = size / 10;
  // Document outline with corner fold
  ctx.beginPath();
  ctx.moveTo(1.5 * s, 1 * s);
  ctx.lineTo(6.5 * s, 1 * s);
  ctx.lineTo(8.5 * s, 3 * s);
  ctx.lineTo(8.5 * s, 9 * s);
  ctx.lineTo(1.5 * s, 9 * s);
  ctx.closePath();
  ctx.stroke();
  // Corner fold
  ctx.beginPath();
  ctx.moveTo(6.5 * s, 1 * s);
  ctx.lineTo(6.5 * s, 3 * s);
  ctx.lineTo(8.5 * s, 3 * s);
  ctx.stroke();
  // Note stem
  ctx.beginPath();
  ctx.moveTo(5.5 * s, 5 * s);
  ctx.lineTo(5.5 * s, 7.3 * s);
  ctx.stroke();
  // Note head
  ctx.beginPath();
  ctx.ellipse(4.7 * s, 7.3 * s, 1 * s, 0.75 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}
