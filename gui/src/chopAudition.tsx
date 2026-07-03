// Region-loop audition for the standalone Chop window. WAVdesk loops
// JS-side off a 60 Hz position subscription; here the loop runs in the
// Rust engine (checked every ~4 ms) — this leaf just arms/clears it and
// keeps the bounds fresh while a region is auditioned.

import React, { useEffect } from 'react';
import { playbackEngine } from './playbackEngine';
import { usePlaybackCurrentPath, usePlaybackState } from './PlaybackContext';

interface RegionLoopWatcherProps {
  path: string;
  startSec: number;
  endSec: number;
  looping: boolean;
  // Fired when playback stops while this watcher is armed (parity with
  // WAVdesk's non-looping end-of-region callback).
  onEnded: () => void;
}

export const RegionLoopWatcher: React.FC<RegionLoopWatcherProps> = ({
  path, startSec, endSec, looping, onEnded,
}) => {
  const curPath = usePlaybackCurrentPath();
  const state = usePlaybackState();

  // Keep the Rust loop's live bounds fresh (it reads them every ~4ms and owns
  // the wrap + strand-clamp). Setting bounds is cheap — just an atomic-style
  // update, no seek/restart — so a bounds change is NOT a re-arm. Crucially the
  // clear is split out to unmount ONLY: clearing on every bounds change (the
  // old cleanup) briefly disarmed the loop mid-drag, a tick could slip the
  // wrap = the "re-arm churn" the collision-physics loop must not have.
  useEffect(() => {
    if (looping) playbackEngine.setLoop(startSec, endSec);
  }, [startSec, endSec, looping]);
  useEffect(() => () => { playbackEngine.clearLoop(); }, []);

  useEffect(() => {
    if (curPath === path && state === 'stopped') onEnded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, curPath, path]);

  return null;
};
