// Standalone audition engine shim — same call surface the Chop window
// uses against WAVdesk's playbackEngine, backed by the Rust rodio
// engine (src-tauri/audio.rs) instead of the wavdesk audio-daemon.
// Position/state arrive as ~30 Hz `audio-pos` events; the region loop
// itself runs Rust-side (setLoop/clearLoop), checked every ~4 ms.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type EngineState = 'playing' | 'paused' | 'stopped';

interface PosEvent {
  path:    string;
  posSec:  number;
  state:   EngineState | 'error';
  message?: string;
}

let curPath = '';
let curPos = 0;
let curState: EngineState = 'stopped';

const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

void listen<PosEvent>('audio-pos', (e) => {
  const p = e.payload;
  if (p.state === 'error') {
    console.warn('audio engine:', p.message);
    curState = 'stopped';
  } else {
    curState = p.state;
  }
  curPath = p.path ?? '';
  curPos = Number(p.posSec) || 0;
  notify();
});

const cmd = (action: string, extra: Record<string, unknown> = {}) => {
  void invoke('audio_cmd', { action, ...extra }).catch((err) =>
    console.warn(`audio_cmd ${action} failed:`, err));
};

export const playbackEngine = {
  // `mode` kept for surface parity with WAVdesk ('full'); unused here.
  play(path: string, _mode: string, opts?: { startSec?: number }): Promise<void> {
    curPath = path; // optimistic — the next pos event confirms
    curState = 'playing';
    notify();
    cmd('play', { path, sec: opts?.startSec ?? 0 });
    return Promise.resolve();
  },
  // Region start and bounds cross the native boundary atomically. Separate
  // play()/setLoop() invokes can be scheduled out of order in an optimized
  // build, allowing Play's loop reset to win intermittently.
  playLoop(path: string, startSec: number, endSec: number): Promise<void> {
    curPath = path;
    curPos = startSec;
    curState = 'playing';
    notify();
    cmd('play-loop', { path, sec: startSec, endSec });
    return Promise.resolve();
  },
  pause(): void { cmd('pause'); },
  resume(): Promise<void> { cmd('resume'); return Promise.resolve(); },
  stop(_opts?: { fadeMs?: number }): void {
    curState = 'stopped';
    notify();
    cmd('stop');
  },
  seek(sec: number): void { cmd('seek', { sec }); },
  setLoop(startSec: number, endSec: number): void { cmd('set-loop', { sec: startSec, endSec }); },
  clearLoop(): void { cmd('clear-loop'); },

  getPosition(): number { return curPos; },
  getCurrentPath(): string { return curPath; },
  getState(): EngineState { return curState; },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};
