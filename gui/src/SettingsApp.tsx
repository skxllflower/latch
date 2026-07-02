// Settings window body (route ?wd=settings). Tool-path overrides + download
// folders, persisted through the Rust settings.json store. Opened from the
// status-bar gear (settingsWindow.ts); closed via the titlebar X or Esc.
//
// Sections are deliberately self-contained (<Section>) so a Theme section can
// slot in for 0.1.1 without reshaping this file. Each field saves on its own
// (partial patch) so a single edit never rewrites unrelated settings.

import React, { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { downloadDir } from '@tauri-apps/api/path';
import { X, FileSearch, FolderOpen, RotateCcw, Link2, Link2Off } from 'lucide-react';
import appIcon from './assets/app-icon.svg';
import {
  getSettings, patchSettings, resolveToolStatus,
  type LatchSettings, type ToolStatus,
} from './settings';

const close = () => { void getCurrentWindow().close().catch(() => {}); };

// key = Settings field; name = resolver name (matches the Rust resolver).
const TOOLS: { key: 'ytdlpPath' | 'ffmpegPath' | 'lathePath'; name: string; label: string; blurb: string }[] = [
  { key: 'ytdlpPath',  name: 'yt-dlp', label: 'yt-dlp', blurb: 'Downloader' },
  { key: 'ffmpegPath', name: 'ffmpeg', label: 'ffmpeg', blurb: 'Audio / video encode' },
  { key: 'lathePath',  name: 'lathe',  label: 'lathe',  blurb: 'Chop video decode' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[0.5625rem] font-bold uppercase tracking-[0.15em] text-zinc-400 border-b border-zinc-800 pb-1">
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function IconButton(
  { onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode },
) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="shrink-0 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-1 transition-none cursor-pointer"
    >
      {children}
    </button>
  );
}

const inputCls =
  'flex-1 min-w-0 bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none ' +
  'px-1.5 py-1 text-[0.625rem] text-zinc-200 placeholder:text-zinc-600 font-mono';

function ResolvedReadout({ status, overridden }: { status: ToolStatus | null; overridden: boolean }) {
  if (!status) {
    return <span className="text-[0.5625rem] text-zinc-600">Resolving...</span>;
  }
  const ok = status.resolved;
  const label = overridden ? 'override' : status.source;
  return (
    <div className="flex items-center gap-1 text-[0.5625rem] leading-tight min-w-0">
      {ok
        ? <Link2 size={9} className="text-emerald-500/80 shrink-0" />
        : <Link2Off size={9} className="text-amber-500/70 shrink-0" />}
      <span className={`uppercase tracking-wider shrink-0 ${ok ? 'text-zinc-500' : 'text-amber-500/80'}`}>
        {label}
      </span>
      <span className="text-zinc-600 truncate" title={status.path || status.message}>
        {status.path || (ok ? '' : 'not found')}
      </span>
    </div>
  );
}

export default function SettingsApp() {
  const [settings, setSettings] = useState<LatchSettings | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ToolStatus | null>>({});
  const [dlDefault, setDlDefault] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshStatus = useCallback(async (name: string, configured: string) => {
    try {
      const st = await resolveToolStatus(name, configured);
      setStatuses(prev => ({ ...prev, [name]: st }));
    } catch {
      setStatuses(prev => ({ ...prev, [name]: null }));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettings(s);
      try { setDlDefault(await downloadDir()); } catch { /* ignore */ }
      for (const t of TOOLS) void refreshStatus(t.name, s[t.key]);
    })();
  }, [refreshStatus]);

  // Typing: in-memory only, no write until commit.
  const setField = useCallback((key: keyof LatchSettings, value: string) => {
    setSettings(prev => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  // Persist a single key (partial patch) and re-resolve if it's a tool path.
  const commitField = useCallback(async (key: keyof LatchSettings, value: string, toolName?: string) => {
    try { await patchSettings({ [key]: value } as Partial<LatchSettings>); } catch { /* ignore */ }
    if (toolName) void refreshStatus(toolName, value);
  }, [refreshStatus]);

  const browseTool = useCallback(async (key: keyof LatchSettings, toolName: string) => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: 'Program', extensions: ['exe'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (typeof picked === 'string') {
      setField(key, picked);
      void commitField(key, picked, toolName);
    }
  }, [setField, commitField]);

  const browseFolder = useCallback(async (key: keyof LatchSettings, current: string) => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: current || undefined });
    if (typeof picked === 'string') {
      setField(key, picked);
      void commitField(key, picked);
    }
  }, [setField, commitField]);

  const clearField = useCallback((key: keyof LatchSettings, toolName?: string) => {
    setField(key, '');
    void commitField(key, '', toolName);
  }, [setField, commitField]);

  return (
    <div className="h-screen flex flex-col font-mono select-none text-zinc-300 bg-[#09090b] overflow-hidden">
      {/* Titlebar */}
      <div
        data-tauri-drag-region
        className="h-7 bg-zinc-950 border-b border-zinc-800 flex items-center px-2 shrink-0"
      >
        <img src={appIcon} alt="" draggable={false} className="w-3.5 h-3.5 mr-1.5" />
        <span
          data-tauri-drag-region
          className="text-[0.625rem] font-bold uppercase tracking-tight text-zinc-400"
        >
          Settings
        </span>
        <button
          onClick={close}
          className="ml-auto text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-0.5 transition-none cursor-default"
          title="Close"
        >
          <X size={11} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-6">
        {!settings ? (
          <span className="text-[0.625rem] text-zinc-600">Loading...</span>
        ) : (
          <>
            <Section title="Tool Paths">
              <p className="text-[0.5625rem] leading-relaxed text-zinc-500 -mt-1">
                Leave a field empty to auto-resolve. Set a path to override.
                The resolved path in use is shown under each field.
              </p>
              {TOOLS.map(t => {
                const value = settings[t.key];
                const overridden = value.trim().length > 0;
                return (
                  <div key={t.name} className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[0.625rem] font-bold text-zinc-300">{t.label}</span>
                      <span className="text-[0.5rem] uppercase tracking-wider text-zinc-600">{t.blurb}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        value={value}
                        onChange={e => setField(t.key, e.target.value)}
                        onBlur={e => void commitField(t.key, e.target.value.trim(), t.name)}
                        placeholder="Auto"
                        spellCheck={false}
                        className={inputCls}
                      />
                      <IconButton onClick={() => void browseTool(t.key, t.name)} title="Browse for executable">
                        <FileSearch size={12} />
                      </IconButton>
                      {overridden && (
                        <IconButton onClick={() => clearField(t.key, t.name)} title="Clear (use auto)">
                          <RotateCcw size={12} />
                        </IconButton>
                      )}
                    </div>
                    <ResolvedReadout status={statuses[t.name] ?? null} overridden={overridden} />
                  </div>
                );
              })}
            </Section>

            <Section title="Downloads">
              {/* Default extraction output folder */}
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[0.625rem] font-bold text-zinc-300">Download folder</span>
                <div className="flex items-center gap-1">
                  <input
                    value={settings.downloadDir}
                    onChange={e => setField('downloadDir', e.target.value)}
                    onBlur={e => void commitField('downloadDir', e.target.value.trim())}
                    placeholder="Auto (your Downloads folder)"
                    spellCheck={false}
                    className={inputCls}
                  />
                  <IconButton onClick={() => void browseFolder('downloadDir', settings.downloadDir)} title="Choose folder">
                    <FolderOpen size={12} />
                  </IconButton>
                  {settings.downloadDir.trim().length > 0 && (
                    <IconButton onClick={() => clearField('downloadDir')} title="Clear (use default)">
                      <RotateCcw size={12} />
                    </IconButton>
                  )}
                </div>
                <span className="text-[0.5625rem] text-zinc-600 truncate" title={dlDefault}>
                  Default: {dlDefault || 'your Downloads folder'}
                </span>
              </div>

              {/* Chop clip export folder */}
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[0.625rem] font-bold text-zinc-300">Clip export folder</span>
                <div className="flex items-center gap-1">
                  <input
                    value={settings.clipsDir}
                    onChange={e => setField('clipsDir', e.target.value)}
                    onBlur={e => void commitField('clipsDir', e.target.value.trim())}
                    placeholder="Auto (Documents / Vacant Systems / Latch Clips)"
                    spellCheck={false}
                    className={inputCls}
                  />
                  <IconButton onClick={() => void browseFolder('clipsDir', settings.clipsDir)} title="Choose folder">
                    <FolderOpen size={12} />
                  </IconButton>
                  {settings.clipsDir.trim().length > 0 && (
                    <IconButton onClick={() => clearField('clipsDir')} title="Clear (use default)">
                      <RotateCcw size={12} />
                    </IconButton>
                  )}
                </div>
                <span className="text-[0.5625rem] text-zinc-600">
                  Default: Documents / Vacant Systems / Latch Clips
                </span>
              </div>
            </Section>

            {/* A Theme section slots in here for 0.1.1. */}
          </>
        )}
      </div>
    </div>
  );
}
