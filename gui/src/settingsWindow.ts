// Settings window opener — spawns a small owned WebviewWindow (route
// ?wd=settings) for tool paths + download folders. Modeled on aboutWindow.ts:
// single-instance (refocus if already open), physical-pixel centering on the
// parent (logical positions drift on mixed-DPI multi-monitor setups). Larger
// and resizable since it holds real controls, not a static notice.

import { getCurrentWindow, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const THEME_BG = '#09090b';
const W = 540;
const H = 620;
const LABEL = 'settings';

async function computeCenterOnParent(): Promise<PhysicalPosition | null> {
  try {
    const me = getCurrentWindow();
    const [pos, size, mon] = await Promise.all([
      me.outerPosition(),
      me.outerSize(),
      currentMonitor(),
    ]);
    const s = mon?.scaleFactor ?? 1;
    return new PhysicalPosition(
      Math.round(pos.x + (size.width - W * s) / 2),
      Math.round(pos.y + (size.height - H * s) / 2),
    );
  } catch { return null; }
}

export async function openSettingsWindow(): Promise<void> {
  // Single-instance — refocus an already-open Settings window.
  try {
    const existing = await WebviewWindow.getByLabel(LABEL);
    if (existing) {
      try { await existing.show(); } catch { /* ignore */ }
      try { await existing.setFocus(); } catch { /* ignore */ }
      return;
    }
  } catch { /* fall through to spawn */ }

  const targetPos = await computeCenterOnParent();
  const win = new WebviewWindow(LABEL, {
    url: '/?wd=settings',
    title: 'Latch Settings',
    width: W,
    height: H,
    minWidth: 460,
    minHeight: 420,
    backgroundColor: THEME_BG,
    resizable: true,
    decorations: false,
    // Unlike the static About notice, Settings opens native file/folder
    // pickers — keep it off always-on-top so those don't land behind it.
    alwaysOnTop: false,
    parent: getCurrentWindow().label,
    visible: false,
  });

  win.once('tauri://created', () => {
    void (async () => {
      if (targetPos) {
        try { await win.setPosition(targetPos); }
        catch { try { await win.center(); } catch { /* best effort */ } }
      } else {
        try { await win.center(); } catch { /* best effort */ }
      }
      try { await win.show(); } catch { /* ignore */ }
      try { await win.setFocus(); } catch { /* ignore */ }
    })();
  });
  win.once('tauri://error', (e) => console.error('Settings window error:', e));
}
