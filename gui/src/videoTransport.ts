// Tiny registry connecting the ONE live video preview's transport to global
// keyboard handling (FileExplorer's Space on a focused video row), so
// play/pause doesn't require hovering the preview pane. The main-window
// VideoView registers itself while it has a playable video; satellite windows
// (Latch chop) run their own React root, so their module instance is separate
// and never collides with the main window's.

let active: { toggle: () => void } | null = null;

export function registerVideoTransport(handle: { toggle: () => void }): () => void {
  active = handle;
  return () => {
    if (active === handle) active = null;
  };
}

// Toggle the registered preview. False = no live video preview (caller falls
// through to its default behavior).
export function toggleActiveVideo(): boolean {
  if (!active) return false;
  active.toggle();
  return true;
}
