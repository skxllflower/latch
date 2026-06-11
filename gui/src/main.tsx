import React, { useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import ExtractApp from './ExtractApp';
import ChopApp from './ChopApp';
import DialogApp from './DialogApp';
import DragOverlayApp from './DragOverlayApp';
import { subscribeOpenDialogs, getOpenDialogCount } from './dialogWindows';
import './styles.css';

// Window routing by query param — the main window is the Extract app,
// `?wd=chop` is the Chop satellite (chopWindow.ts), `?wd=dialog` is a
// spawned dialog window (dialogWindows.ts).
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {wd === 'dialog' ? (
      <DialogApp />
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
    )}
  </React.StrictMode>,
);
