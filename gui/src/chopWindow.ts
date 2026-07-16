// Opener for the standalone Chop window (route ?wd=chop). Port of
// WAVdesk's latchChopWindow: spawn hidden, seed via a ready/seed
// handshake so we don't race the webview mount, reuse-or-focus an
// existing window. The label must appear in capabilities/default.json.

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isMac } from './platform';
import { listen, emitTo } from '@tauri-apps/api/event';

const LABEL = 'chop';

export interface ChopSeed {
  url: string;
  includeVideo: boolean;
  latchPath: string;
  title?: string;
  durationSec?: number;
  cookiesFromBrowser?: string;
}

export async function openChopWindow(seed: ChopSeed): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    try {
      await emitTo(LABEL, 'wd-latch-chop-seed', seed);
      await existing.setFocus();
    } catch { /* window may have just closed */ }
    return;
  }

  const win = new WebviewWindow(LABEL, {
    url:         '/?wd=chop',
    title:       'LATCH: CHOP',
    width:       720,
    height:      500,
    minWidth:    560,
    minHeight:   440,
    resizable:   true,
    decorations: false,
    transparent: true,
    // macOS: the CSS shell rounding (html.wd-mac) only reveals if the OS
    // window backdrop is fully transparent; an opaque default backgroundColor
    // paints square corner triangles (same fix as wavdesk's chop window).
    ...(isMac ? { backgroundColor: '#00000000' } : {}),
    visible:     false, // revealed after first paint to avoid the white flash
  });

  const un = await listen('wd-latch-chop-ready', () => {
    void emitTo(LABEL, 'wd-latch-chop-seed', seed);
    try { un(); } catch { /* ignore */ }
  });
  void win.once('tauri://error', () => { try { un(); } catch { /* ignore */ } });
}
