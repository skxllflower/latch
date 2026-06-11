// Video extension predicates for the preview router. Trimmed fork of
// WAVdesk's audioFormats.ts — only what VideoPreview's routing needs.

const VIDEO_EXTS: ReadonlyArray<string> = [
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv',
  '.flv', '.mpg', '.mpeg', '.ogv', '.mts', '.m2ts', '.3gp',
];

// Containers WebView2/Chromium decodes reliably in a <video> element —
// the graceful-degradation direct-play path when lathe is missing.
// Deliberately tight: only web-standard containers play direct.
const CHROMIUM_VIDEO_EXTS: ReadonlyArray<string> = ['.mp4', '.m4v', '.webm', '.ogv'];

function endsWithAny(lower: string, exts: ReadonlyArray<string>): boolean {
  for (const ext of exts) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function isVideoPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return endsWithAny(path.toLowerCase(), VIDEO_EXTS);
}

export function isChromiumPlayableVideo(path: string | undefined | null): boolean {
  if (!path) return false;
  return endsWithAny(path.toLowerCase(), CHROMIUM_VIDEO_EXTS);
}
