// Hook surface matching what the ported Chop components import from
// WAVdesk's PlaybackContext, backed by the playbackEngine shim's module
// store (no Provider needed — there's one engine per window).

import { useSyncExternalStore } from 'react';
import { playbackEngine, type EngineState } from './playbackEngine';

export function usePlaybackState(): EngineState {
  return useSyncExternalStore(playbackEngine.subscribe, playbackEngine.getState);
}

export function usePlaybackCurrentPath(): string {
  return useSyncExternalStore(playbackEngine.subscribe, playbackEngine.getCurrentPath);
}

export function usePlaybackPosition(): number {
  return useSyncExternalStore(playbackEngine.subscribe, playbackEngine.getPosition);
}

export function usePlaybackEngine() {
  return playbackEngine;
}
