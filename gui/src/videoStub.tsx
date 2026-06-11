// Video preview stub. The ported Chop window keeps its video code paths
// (so it stays diff-able against WAVdesk's), but standalone Latch has no
// native video engine yet — videoPath is never set, every branch is
// dead, and this stub only exists to satisfy the imports. The real port
// (WAVdesk's decode-server player) is the video phase of the roadmap.

import React, { forwardRef } from 'react';

export interface VideoViewHandle {
  togglePlay(): void;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  setLoop(startSec: number, endSec: number): void;
  clearLoop(): void;
  shuttle(dir: number): void;
  stepFrame(dir: number): void;
  getCurrentTime(): number | null;
  captureFrame(): HTMLCanvasElement | null;
}

interface VideoPreviewProps {
  src: string;
  path: string;
  suppressChip?: boolean;
  disableKeyboard?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  onReady?: () => void;
}

export const VideoPreview = forwardRef<VideoViewHandle, VideoPreviewProps>(
  function VideoPreview() {
    return null;
  },
);
