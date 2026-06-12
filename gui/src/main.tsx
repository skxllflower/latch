import React, { useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import ExtractApp from './ExtractApp';
import ChopApp from './ChopApp';
import DialogApp from './DialogApp';
import AboutApp from './AboutApp';
import DragOverlayApp from './DragOverlayApp';
import { subscribeOpenDialogs, getOpenDialogCount } from './dialogWindows';
import './styles.css';

// Window routing by query param — the main window is the Extract app,
// `?wd=chop` is the Chop satellite (chopWindow.ts), `?wd=dialog` is a
// spawned dialog window (dialogWindows.ts), `?wd=about` is the About
// window (aboutWindow.ts).
const wd = new URLSearchParams(window.location.search).get('wd');

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
