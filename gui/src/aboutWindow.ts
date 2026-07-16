// About window opener — spawns a small owned WebviewWindow (route
// ?wd=about) carrying app identity, version, and third-party license
// notices. Single-instance: if it's already open we refocus instead of
// spawning a second one. Centering mirrors dialogWindows.ts (physical
// pixels — logical positions drift on mixed-DPI multi-monitor setups,
// and the scaleFactor multiply is silent on 1.0x displays).

import { getCurrentWindow, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isMac } from './platform';

const THEME_BG = '#09090b';
const W = 420;
const H = 500;
const LABEL = 'about';

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

export async function openAboutWindow(): Promise<void> {
  // Single-instance — refocus an already-open About window.
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
    url: '/?wd=about',
    title: 'About Latch',
    width: W,
    height: H,
    minWidth: W,
    maxWidth: W,
    minHeight: H,
    maxHeight: H,
    ...(isMac ? { transparent: true, backgroundColor: '#00000000' } : { backgroundColor: THEME_BG }),
    resizable: false,
    decorations: false,
    alwaysOnTop: true,
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
  win.once('tauri://error', (e) => console.error('About window error:', e));
}
