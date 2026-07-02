// Latch settings bridge — typed access to the Rust settings.json store.
// getSettings reads the whole record; patchSettings writes ONLY the keys you
// pass (the Rust side read-merge-writes, so a partial patch never clobbers a
// sibling field). resolveToolStatus previews where a tool path resolves for the
// Settings readout — it takes the current field value as an explicit override
// (empty = preview the auto resolution).

import { invoke } from '@tauri-apps/api/core';

export interface LatchSettings {
  // Explicit tool-path overrides. Empty = auto-resolve.
  ytdlpPath:   string;
  ffmpegPath:  string;
  lathePath:   string;
  // Default extraction output folder (empty = OS Downloads).
  downloadDir: string;
  // Chop clips folder (empty = Documents/Vacant Systems/Latch Clips).
  clipsDir:    string;
}

export interface ToolStatus {
  resolved: boolean;
  path:     string;
  // "configured" | "env" | "portable" | "managed" | "registry" | "installed"
  // | "dev" | "missing"
  source:   string;
  message:  string;
}

const EMPTY: LatchSettings = {
  ytdlpPath: '', ffmpegPath: '', lathePath: '', downloadDir: '', clipsDir: '',
};

export async function getSettings(): Promise<LatchSettings> {
  try {
    const s = await invoke<Partial<LatchSettings>>('settings_get');
    return { ...EMPTY, ...(s ?? {}) };
  } catch {
    return { ...EMPTY };
  }
}

export async function patchSettings(patch: Partial<LatchSettings>): Promise<void> {
  await invoke('settings_set', { patch });
}

export async function resolveToolStatus(name: string, configured: string): Promise<ToolStatus> {
  return invoke<ToolStatus>('resolve_tool_status', { name, configured });
}
