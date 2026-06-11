// Cross-process drop target resolution. Maps a Windows process exe
// filename (the basename the native chip thread captured via
// WindowFromPoint → QueryFullProcessImageNameW) to a friendly label
// the drag chip displays.
//
// Extensible: append new exe → label entries here as users surface
// apps they drop into. Pattern matchers cover version-suffixed exes
// (Cubase14.exe, Ableton Live 12 Suite.exe, etc.) so we don't need
// to enumerate every release.
//
// Fallback: any exe not in the table or pattern list still renders
// SOMETHING informative — strip ".exe", capitalize the first letter,
// done. "Send Kick.wav to Cubase15" beats a blank target label.

import type { DragChipVerb } from './DragChip';

// All keys lowercase — lookup case-folds the input so the table
// reads cleanly.
const EXE_LABELS: Record<string, string> = {
  // ── DAWs ──────────────────────────────────────────────────
  'fl64.exe':                              'FL Studio',
  'fl.exe':                                'FL Studio',
  'flstudio.exe':                          'FL Studio',
  'reaper.exe':                            'Reaper',
  'reaper_x64.exe':                        'Reaper',
  'studio one.exe':                        'Studio One',
  'protools.exe':                          'Pro Tools',
  'bitwig studio.exe':                     'Bitwig Studio',
  'mixbus.exe':                            'Mixbus',
  'cakewalk.exe':                          'Cakewalk',
  'reason.exe':                            'Reason',
  'logic pro.exe':                         'Logic Pro',
  // ── Chat / messaging ─────────────────────────────────────
  'discord.exe':                           'Discord',
  'slack.exe':                             'Slack',
  'telegram.exe':                          'Telegram',
  'signal.exe':                            'Signal',
  'whatsapp.exe':                          'WhatsApp',
  // ── Browsers ─────────────────────────────────────────────
  'chrome.exe':                            'Chrome',
  'firefox.exe':                           'Firefox',
  'msedge.exe':                            'Edge',
  'opera.exe':                             'Opera',
  'brave.exe':                             'Brave',
  // ── Windows shell ────────────────────────────────────────
  // explorer.exe is BOTH the desktop / taskbar host AND every File
  // Explorer window. Resolving the actual folder under the cursor
  // requires IShellWindows COM enumeration — a planned follow-up;
  // for now both contexts share the "File Explorer" label.
  'explorer.exe':                          'File Explorer',
  // ── Image editors ────────────────────────────────────────
  'photoshop.exe':                         'Photoshop',
  'gimp.exe':                              'GIMP',
  'gimp-2.10.exe':                         'GIMP',
  'krita.exe':                             'Krita',
  'paintdotnet.exe':                       'Paint.NET',
  'affinity photo.exe':                    'Affinity Photo',
  // ── Video / motion editors ───────────────────────────────
  'resolve.exe':                           'DaVinci Resolve',
  'premiere.exe':                          'Premiere Pro',
  'adobe premiere pro.exe':                'Premiere Pro',
  'afterfx.exe':                           'After Effects',
  'vegas.exe':                             'Vegas Pro',
  'shotcut.exe':                           'Shotcut',
  'kdenlive.exe':                          'Kdenlive',
};

// Patterns for exes whose names carry a version / edition suffix
// that makes an exhaustive EXE_LABELS list intractable. Walked
// after the exact lookup, so EXE_LABELS entries always win on the
// rare case both match.
const EXE_PATTERN_LABELS: Array<[RegExp, string]> = [
  [/^ableton live/,    'Ableton Live'],   // Ableton Live 11 Suite.exe, Ableton Live 12 Standard.exe, …
  [/^cubase\d+/,       'Cubase'],         // Cubase14.exe, Cubase13.exe, …
  [/^nuendo\d+/,       'Nuendo'],
  [/^fl studio/,       'FL Studio'],
  [/^reaper/,          'Reaper'],
  [/^studio one/,      'Studio One'],
  [/^bitwig/,          'Bitwig Studio'],
  [/^cakewalk/,        'Cakewalk'],
  [/^renoise/,         'Renoise'],
];

/**
 * Resolve an exe basename ("Discord.exe", "Ableton Live 12 Suite.exe")
 * + an optional Explorer folder path into a single user-facing label.
 *
 * When `folderPath` is non-empty (cursor is over an Explorer window
 * and the IShellWindows COM walk found a real path), the leaf folder
 * name wins — "Copy Kick.wav to Kicks" reads more usefully than
 * "Copy Kick.wav to File Explorer". Falls back to the exe-keyed label
 * table → version-pattern matchers → titlecased basename, in that
 * order. Empty exe + empty folderPath returns empty string so caller
 * can defer to internal drag context.
 */
export function resolveExternalLabel(exe: string, folderPath: string = ''): string {
  // Explorer with a resolved folder path beats the generic exe label.
  if (folderPath) {
    const leaf = folderBasename(folderPath);
    if (leaf) return leaf;
  }
  if (!exe) return '';
  const lower = exe.toLowerCase();
  const exact = EXE_LABELS[lower];
  if (exact) return exact;
  for (const [pattern, label] of EXE_PATTERN_LABELS) {
    if (pattern.test(lower)) return label;
  }
  // Last resort: the original-case exe with .exe stripped + first
  // letter uppercased. "discord-canary.exe" → "Discord-canary",
  // "VLC.exe" → "VLC". Worse than a curated label but always safe.
  const base = exe.replace(/\.exe$/i, '');
  return base.length > 0
    ? base.charAt(0).toUpperCase() + base.slice(1)
    : '';
}

/**
 * Resolve to the verb the drag chip should display. Most cross-process
 * drops are copy semantics from the user's mental model (source file
 * in WAVdesk's library stays put; target app gets its own copy /
 * import / upload), so 'Copy' is the universal default.
 *
 * Explorer is the one place where Ctrl-aware Move vs Copy reads
 * naturally — without a modifier the OS default is Move within the
 * same drive (Copy across drives), Ctrl forces Copy, Shift forces
 * Move. We mirror Windows' "Ctrl forces Copy, Shift forces Move,
 * default Move" convention; the chip is intent-suggestive, not
 * authoritative — the actual op is whatever IDataObject negotiates
 * at drop.
 */
export function resolveExternalVerb(
  exe:        string,
  folderPath: string  = '',
  ctrl:       boolean = false,
  shift:      boolean = false,
): DragChipVerb {
  if (!exe && !folderPath) return null;
  // Explorer (whether or not we have a folder path resolved) is the
  // filesystem-destination case where Move/Copy matters.
  if (exe.toLowerCase() === 'explorer.exe' || folderPath) {
    if (ctrl)  return 'Copy';
    if (shift) return 'Move';
    return 'Move'; // default: the OS will pick Copy for cross-drive
  }
  // DAWs / chat / browsers / image editors / etc — universal Copy
  // semantics from the user's perspective.
  return 'Copy';
}

// Leaf-segment of a Windows path. "C:\Users\me\Music\Kicks" → "Kicks";
// "C:\" → "C:\" (drive roots fall through to the full string since
// they have no leaf). Strips trailing separators first so "C:\Music\"
// resolves the same as "C:\Music".
function folderBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]/);
  const leaf = parts[parts.length - 1] ?? '';
  return leaf || trimmed;
}
