import React from 'react';
import ReactDOM from 'react-dom/client';
import ExtractApp from './ExtractApp';
import ChopApp from './ChopApp';
import './styles.css';

// Window routing by query param — the main window is the Extract app,
// `?wd=chop` is the Chop satellite window (see chopWindow.ts).
const wd = new URLSearchParams(window.location.search).get('wd');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {wd === 'chop' ? <ChopApp /> : <ExtractApp />}
  </React.StrictMode>,
);
