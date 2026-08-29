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
  // Local-file seed (Chop opened from a landed output, a dropped file, a
  // prompt path, or the open-file button): when set, the chop window SKIPS
  // the download pipeline and uses this file directly — the native video
  // engine plays it (or the audio engine for audio files) and the companion
  // display audio is extracted from it. Exports land in <sourceDir>/Latch
  // Chops instead of the Latch Clips folder. `url` is unused in this mode;
  // `latchPath` may be '' (the chop window resolves latch itself for the
  // companion-WAV + clip renders).
  localFile?: string;
  // Local-file handoff position (seconds): where the opener's player was
  // when Chop was pressed. The chop window opens its player HERE (paused)
  // so the two surfaces line up.
  startSec?: number;
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
