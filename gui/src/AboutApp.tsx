// About window body (route ?wd=about). Static app identity plus the
// third-party license notices Latch is obliged to surface (FFmpeg, yt-dlp).
// Opened from the status-bar info button (aboutWindow.ts). Closed via the
// titlebar X or Esc. URLs render as selectable text — there's no URL-opener
// plugin wired up, and copy-to-clipboard is enough for a notices panel.

import React, { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X } from 'lucide-react';
import appIcon from './assets/app-icon.svg';

const VERSION = '1.0';

const close = () => { void getCurrentWindow().close().catch(() => {}); };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.5625rem] font-bold uppercase tracking-wider text-zinc-300">{title}</span>
      <p className="text-[0.625rem] leading-relaxed text-zinc-500">{children}</p>
    </div>
  );
}

function Url({ href }: { href: string }) {
  return (
    <span
      onClick={() => { void invoke('os_open_url', { url: href }); }}
      className="text-emerald-500/80 hover:text-emerald-300 hover:underline cursor-pointer break-all"
    >
      {href}
    </span>
  );
}

export default function AboutApp() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-screen flex flex-col font-mono select-none text-zinc-300 bg-[#09090b] overflow-hidden">
      {/* Titlebar */}
      <div
        data-tauri-drag-region
        className="h-7 bg-zinc-950 border-b border-zinc-800 flex items-center px-2 shrink-0"
      >
        <span
          data-tauri-drag-region
          className="text-[0.625rem] font-bold uppercase tracking-tight text-zinc-400"
        >
          About
        </span>
        <button
          onClick={close}
          className="ml-auto text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 p-0.5 transition-none cursor-pointer"
          title="Close"
        >
          <X size={11} />
        </button>
      </div>

      {/* Identity */}
      <div className="flex flex-col items-center gap-0.5 pt-5 pb-4 shrink-0 border-b border-zinc-900">
        <img src={appIcon} alt="" draggable={false} className="w-14 h-14 mb-2" />
        <span className="text-[1.125rem] font-bold tracking-[0.3em] text-zinc-100 pl-[0.3em]">LATCH</span>
        <span className="text-[0.5625rem] uppercase tracking-wider text-zinc-500">by Vacant Systems</span>
        <span className="text-[0.5625rem] tabular-nums text-zinc-600">Version {VERSION}</span>
      </div>

      {/* Notices — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        <p className="text-[0.625rem] leading-relaxed text-zinc-500">
          Latch is a standalone media downloader and clipper. It builds on
          open-source software, used and distributed under the terms below.
        </p>

        <Notice title="yt-dlp">
          Downloading is performed by yt-dlp, which Latch fetches on first
          run and invokes as a separate program. yt-dlp is released into the
          public domain under The Unlicense. Source: <Url href="https://github.com/yt-dlp/yt-dlp" />
        </Notice>

        <Notice title="FFmpeg">
          Latch uses FFmpeg, which it downloads from the project's official
          builds on first run and invokes as a separate program. FFmpeg is
          free software licensed under the GNU General Public License (GPL)
          v3 and the GNU Lesser General Public License (LGPL); the bundled
          build is the GPL build. FFmpeg is a trademark of Fabrice Bellard.
          Source and full license text: <Url href="https://ffmpeg.org" />
        </Notice>

        <Notice title="Other components">
          Latch also includes software distributed under permissive licenses
          (MIT, Apache-2.0, BSD), including the Tauri framework, the Rust
          crate ecosystem, and React. Full license texts are available on
          request.
        </Notice>

        <div className="border-t border-zinc-900 pt-3 mt-1">
          <p className="text-[0.5625rem] leading-relaxed text-zinc-600">
            © 2026 Vacant Systems. All rights reserved. Latch is proprietary
            software. Latch is a download tool; users are responsible for
            complying with the terms of service of any site they access and
            with applicable copyright law.
          </p>
        </div>
      </div>
    </div>
  );
}
