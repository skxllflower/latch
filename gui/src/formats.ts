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

// Audio extensions the chop pipeline accepts for local files — same
// vocabulary as WAVdesk's audioFormats.ts AUDIO_EXTS (ffmpeg-decodable).
const AUDIO_EXTS: ReadonlyArray<string> = [
  '.wav', '.wave', '.aif', '.aiff', '.flac', '.mp3', '.ogg', '.oga',
  '.m4a', '.aac', '.opus', '.wma', '.ape', '.mp2', '.mp1', '.mpc',
  '.ac3', '.dts', '.amr', '.spx', '.ra', '.wv', '.tta', '.tak', '.caf',
];

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

export function isAudioPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return endsWithAny(path.toLowerCase(), AUDIO_EXTS);
}

// Media-kind classifier for local files: drives includeVideo on chop
// seeds and media filtering for drops / prompt paths / the open dialog.
// Extension-based on purpose (never URL-host heuristics for local files).
export function kindForPath(path: string | undefined | null): 'audio' | 'video' | null {
  if (isVideoPath(path)) return 'video';
  if (isAudioPath(path)) return 'audio';
  return null;
}

// Bare extensions (no dot) for the file-open dialog's media filter.
export const MEDIA_DIALOG_EXTENSIONS: ReadonlyArray<string> =
  [...VIDEO_EXTS, ...AUDIO_EXTS].map((e) => e.slice(1));
