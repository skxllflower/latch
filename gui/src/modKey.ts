// Platform-appropriate modifier labels for shortcut DISPLAY strings only.
// The handlers already accept Ctrl and Cmd (metaKey) on their own; these just
// make the visible hints read naturally on macOS (Command instead of Ctrl,
// Option instead of Alt).
import { isMac } from './platform';

// Primary accelerator modifier: Command on mac, Ctrl elsewhere.
export const MOD_LABEL: string = isMac ? '⌘' : 'Ctrl';   // ⌘
// Fine-adjust / secondary modifier: Option on mac, Alt elsewhere.
export const OPT_LABEL: string = isMac ? '⌥' : 'Alt';    // ⌥

// Rewrite an accelerator hint string for display: "Ctrl+F" -> "⌘+F" on mac.
// Word-boundary matched so only the literal "Ctrl" token is swapped. No-op
// off mac. Alt is intentionally NOT rewritten here (some "Alt+F4" style hints
// are Windows-only and must not be relabelled); use OPT_LABEL explicitly for
// the fine-adjust hints that do map to Option on mac.
export function modAccel(s: string): string {
  return isMac ? s.replace(/\bCtrl\b/g, MOD_LABEL) : s;
}
