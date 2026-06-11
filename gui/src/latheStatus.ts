// Lathe presence singleton. Holds whether `lathe.exe` is currently
// resolvable so format-classification, playback engine, and processing
// gate can read it synchronously without prop-drilling through the React
// tree. Same singleton pattern as clipboard.ts / toast.ts.
//
// Source of truth is the Rust-side `tool_binary_probe` IPC, which checks
// the configured Settings → Processing path, then env override, then the
// dev-default path. We re-probe on app boot and whenever the user edits
// the configured path mid-session — both refreshes happen from Home.tsx
// in response to settings changes.
//
// State is intentionally minimal — consumers only care "is Lathe usable
// right now?" not the resolution chain. The other fields surfaced by the
// probe (source, message) are kept for the LatheConvertApp's connected
// indicator and don't need to flow through this module.

import { invoke } from '@tauri-apps/api/core';

export interface LatheStatusSnapshot {
  // True iff a working lathe.exe was located. Drives the M4A/AAC playback
  // gate, the lossy-process dialog pre-empt, and any future surfaces that
  // need to skip Lathe-required code paths gracefully.
  resolved: boolean;
  // Resolved disk path of the binary. Empty when resolved=false. Surfaced
  // mostly for diagnostics; consumers shouldn't need it directly.
  path: string;
}

interface ToolBinaryProbeResult {
  resolved: boolean;
  path:     string;
  source:   string;
  message:  string;
}

type Listener = (snap: LatheStatusSnapshot) => void;

let state: LatheStatusSnapshot = { resolved: false, path: '' };
const listeners = new Set<Listener>();

const emit = () => {
  for (const fn of listeners) fn(state);
};

export const latheStatus = {
  get: (): LatheStatusSnapshot => state,

  // Re-probe via the Rust IPC. Caller passes the configured path from
  // settings (empty string = "use Rust-side fallbacks"). Idempotent —
  // if the result hasn't changed we don't notify subscribers, so this
  // is safe to call on every settings save.
  refresh: async (configuredPath: string): Promise<LatheStatusSnapshot> => {
    try {
      const r = await invoke<ToolBinaryProbeResult>('tool_binary_probe', {
        name: 'lathe',
        configured: configuredPath ?? '',
      });
      const next: LatheStatusSnapshot = {
        resolved: !!r?.resolved,
        path:     r?.path ?? '',
      };
      if (next.resolved !== state.resolved || next.path !== state.path) {
        state = next;
        emit();
      }
      return next;
    } catch (err) {
      console.debug('[latheStatus] tool_binary_probe failed', err);
      const next: LatheStatusSnapshot = { resolved: false, path: '' };
      if (next.resolved !== state.resolved || next.path !== state.path) {
        state = next;
        emit();
      }
      return next;
    }
  },

  subscribe: (fn: Listener): (() => void) => {
    listeners.add(fn);
    fn(state);
    return () => { listeners.delete(fn); };
  },
};
