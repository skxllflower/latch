// The dialog window body (route ?wd=dialog&id=..&kind=..). Lean fork of
// WAVdesk's DialogWindowApp covering confirm / prompt / info. Protocol:
// attach the config listener FIRST, then emit wd-dialog-ready {id}; the
// opener pushes wd-dialog-config-<id>; user action emits
// wd-dialog-result-<id> and the opener closes the window. Esc cancels,
// Enter confirms. Height auto-fits the rendered content once.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { X } from 'lucide-react';

interface DialogConfig {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  okLabel?: string;
  placeholder?: string;
  initial?: string;
  maxLength?: number;
}

const params = new URLSearchParams(window.location.search);
const DIALOG_ID = params.get('id') ?? '';
const KIND = (params.get('kind') ?? 'confirm') as 'confirm' | 'prompt' | 'info';

export default function DialogApp() {
  const [cfg, setCfg] = useState<DialogConfig | null>(null);
  const [text, setText] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sizedRef = useRef(false);

  const send = useCallback((result: boolean | string | null) => {
    void emit(`wd-dialog-result-${DIALOG_ID}`, { result });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await listen<DialogConfig>(`wd-dialog-config-${DIALOG_ID}`, (e) => {
        setCfg(e.payload);
        setText(e.payload.initial ?? '');
      });
      void emit('wd-dialog-ready', { id: DIALOG_ID });
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Fit the window height to the rendered content once it's known.
  useEffect(() => {
    if (!cfg || sizedRef.current) return;
    sizedRef.current = true;
    const h = (bodyRef.current?.scrollHeight ?? 0) + 28 /* titlebar */ + 2;
    if (h > 60) {
      void getCurrentWindow().setSize(new LogicalSize(360, Math.min(420, h))).catch(() => {});
    }
  }, [cfg]);

  const cancelResult = KIND === 'prompt' ? null : false;
  const confirm = useCallback(() => {
    if (KIND === 'prompt') {
      send(text.trim() ? text.trim() : null);
    } else {
      send(true);
    }
  }, [send, text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); send(cancelResult); }
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send, confirm, cancelResult]);

  const btn = 'px-3 h-6 text-[0.5625rem] uppercase font-bold tracking-tight border transition-none';

  return (
    <div className="h-screen flex flex-col font-mono select-none text-zinc-300 bg-[#09090b] overflow-hidden">
      <div
        data-tauri-drag-region
        className="h-7 bg-zinc-950 border-b border-zinc-800 flex items-center px-2 shrink-0"
      >
        <span
          data-tauri-drag-region
          className="text-[0.625rem] font-bold uppercase tracking-tight text-zinc-400"
        >
          {KIND === 'info' ? 'Notice' : KIND === 'prompt' ? 'Input' : 'Confirm Action'}
        </span>
        <button
          onClick={() => send(cancelResult)}
          className="ml-auto text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-0.5 transition-none"
          title="Close"
        >
          <X size={11} />
        </button>
      </div>

      <div ref={bodyRef} className="flex flex-col gap-2 px-4 py-3">
        {!cfg ? null : (
          <>
            <span className="text-[0.75rem] font-bold text-zinc-100 leading-snug">
              {cfg.title}
            </span>
            {cfg.message && (
              <span className="text-[0.625rem] text-zinc-400 leading-snug whitespace-pre-wrap">
                {cfg.message}
              </span>
            )}
            {KIND === 'prompt' && (
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={cfg.placeholder}
                maxLength={cfg.maxLength ?? 200}
                autoFocus
                spellCheck={false}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-[0.6875rem] px-2 h-7 focus:outline-none focus:border-zinc-500"
              />
            )}
            <div className="flex items-center justify-end gap-1.5 mt-1">
              {KIND !== 'info' && (
                <button
                  onClick={() => send(cancelResult)}
                  className={`${btn} bg-zinc-900/40 hover:bg-zinc-900/70 text-zinc-300 border-zinc-800`}
                >
                  {cfg.cancelLabel ?? 'Cancel'}
                </button>
              )}
              <button
                onClick={confirm}
                autoFocus={KIND !== 'prompt'}
                className={`${btn} bg-zinc-700 hover:bg-zinc-600 text-zinc-100 border-zinc-600`}
              >
                {KIND === 'info' ? (cfg.okLabel ?? 'OK') : (cfg.confirmLabel ?? 'OK')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
