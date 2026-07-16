// React state wrapper around the pure chopRegions model. The overlay
// computes new arrays with the pure ops and hands them back via
// setRegions; the rail uses the labelled helpers. Selection lives here
// too so the overlay and rail stay in sync.

import { useCallback, useState } from 'react';
import {
  ChopRegion,
  ClipState,
  createDefaultRegion,
  deleteRegion,
  setLabel as opSetLabel,
  setStaged as opSetStaged,
  setExportVideo as opSetExportVideo,
  setClip as opSetClip,
  setVideoClip as opSetVideoClip,
} from './chopRegions';

export interface UseChopRegions {
  regions: ChopRegion[];
  selectedId: string | null;
  /** Overlay onChange — replace the whole array (already clamped). */
  setRegions: (r: ChopRegion[]) => void;
  select: (id: string | null) => void;
  createDefault: (atSec: number, durationSec: number, defaultWidthSec: number) => void;
  remove: (id: string) => void;
  setLabel: (id: string, label: string) => void;
  setStaged: (id: string, staged: boolean) => void;
  setExportVideo: (id: string, v: boolean) => void;
  setClip: (id: string, state: ClipState, path?: string) => void;
  setVideoClip: (id: string, state: ClipState, path?: string) => void;
}

export function useChopRegions(): UseChopRegions {
  const [regions, setRegionsState] = useState<ChopRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const setRegions = useCallback((r: ChopRegion[]) => setRegionsState(r), []);
  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const createDefault = useCallback((atSec: number, durationSec: number, defaultWidthSec: number) => {
    setRegionsState((prev) => {
      const { regions: next, id } = createDefaultRegion(prev, atSec, durationSec, defaultWidthSec);
      if (id) setSelectedId(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setRegionsState((prev) => deleteRegion(prev, id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const setLabel = useCallback((id: string, label: string) => {
    setRegionsState((prev) => opSetLabel(prev, id, label));
  }, []);
  const setStaged = useCallback((id: string, staged: boolean) => {
    setRegionsState((prev) => opSetStaged(prev, id, staged));
  }, []);
  const setExportVideo = useCallback((id: string, v: boolean) => {
    setRegionsState((prev) => opSetExportVideo(prev, id, v));
  }, []);
  const setClip = useCallback((id: string, state: ClipState, path?: string) => {
    setRegionsState((prev) => opSetClip(prev, id, state, path));
  }, []);
  const setVideoClip = useCallback((id: string, state: ClipState, path?: string) => {
    setRegionsState((prev) => opSetVideoClip(prev, id, state, path));
  }, []);

  return {
    regions, selectedId,
    setRegions, select, createDefault, remove,
    setLabel, setStaged, setExportVideo, setClip, setVideoClip,
  };
}
