import React, { useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import ExtractApp from './ExtractApp';
import ChopApp from './ChopApp';
import DialogApp from './DialogApp';
import AboutApp from './AboutApp';
import SettingsApp from './SettingsApp';
import DragOverlayApp from './DragOverlayApp';
import { subscribeOpenDialogs, getOpenDialogCount } from './dialogWindows';
import './styles.css';

// Window routing by query param — the main window is the Extract app,
// `?wd=chop` is the Chop satellite (chopWindow.ts), `?wd=dialog` is a
// spawned dialog window (dialogWindows.ts), `?wd=about` is the About
// window (aboutWindow.ts), `?wd=settings` is the Settings window
// (settingsWindow.ts).
const wd = new URLSearchParams(window.location.search).get('wd');

// macOS draws undecorated NSWindows with square corners (Windows 11's DWM
// rounds every top-level window for free): tag the root so the stylesheet
// can round the shell ourselves. EXCLUDE the drag-overlay window — its
// transparent chip surface must never clip to a radius.
if (navigator.platform.startsWith('Mac') && wd !== 'drag-overlay') {
  document.documentElement.classList.add('wd-mac');
}

// No native browser context menu anywhere except text fields.
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea')) return;
  e.preventDefault();
});

// Blocks input on the parent window while a dialog window is up.
function DialogLock() {
  const count = useSyncExternalStore(subscribeOpenDialogs, getOpenDialogCount);
  return count > 0
    ? <div style={{ position: 'fixed', inset: 0, zIndex: 99999 }} />
    : null;
}

// NO StrictMode — WAVdesk parity. StrictMode's dev double-mount spawns
// TWO native video engines per chop open; the dying one's cleanup
// (stop / loop-clear ops) lands inside the live one's decoder session
// and the loops/clock fall apart in ways no app code can defend against.
ReactDOM.createRoot(document.getElementById('root')!).render(
  wd === 'dialog' ? (
    <DialogApp />
  ) : wd === 'about' ? (
    <AboutApp />
  ) : wd === 'settings' ? (
    <SettingsApp />
  ) : wd === 'drag-overlay' ? (
    <DragOverlayApp />
  ) : wd === 'chop' ? (
    <>
      <ChopApp />
      <DialogLock />
    </>
  ) : (
    <>
      <ExtractApp />
      <DialogLock />
    </>
  ),
);
