import { forwardRef, useEffect, useMemo, useState } from 'react';
import { VideoView, type VideoViewHandle, type VideoViewProps } from './VideoView';
import { isVideoPath, isChromiumPlayableVideo } from './formats';
import { latheStatus } from './latheStatus';
import { isMac } from './platform';

// The largest pixel dimension we'll hand WebView2's <video> in the FALLBACK
// path. Chromium decodes 1080p-and-under H.264 reliably; a 4K stream (even a
// Chromium-safe .mp4) hard-aborts the whole host process in the GPU decoder —
// an unhandled 0xE0000008 with no JS-catchable error.
const DIRECT_PLAY_MAX_DIM = 1920;

// Native frame engine preview params: stream at this capped height (the
// preview pane is small; 4K decodes once and scales in-process). fps is only
// the raw-dialect fallback's pacing — the persistent decoder delivers every
// frame at its true PTS.
// 720p preview output (matches WAVdesk). Now that we no longer swap the preview
// to the full-res file, the source is a cheap capped download (PREVIEW_MAX_HEIGHT)
// and real-time decode stays comfortably 1x at 720p. 720p RGBA is ~3.7MB/frame —
// heavier on the localhost pipe than 480p during reverse GOP-bursts, which
// BUFFER_AHEAD_REVERSE_SEC in nativeVideoStream covers.
const NATIVE_PREVIEW_HEIGHT = 720;
const NATIVE_PREVIEW_FPS = 30;

// Router around VideoView: EVERY video previews through the native frame
// engine (video_stream_server + `lathe decode-server` — frames stream to the
// canvas, audio through the audio daemon as the sync master). WebView2's
// crash-prone <video> media stack is never involved; the old transcode-to-
// cached-MP4 path is retired entirely.
//
// The ONLY time <video> is used is graceful degradation when Lathe is missing:
// small Chromium-safe files direct-play, everything else shows the Lathe
// notice. Every video-preview surface (VisualizerPane, the Latch chop window)
// renders this instead of VideoView, so the routing lives in exactly one
// place. The imperative handle (seek/play/etc.) forwards through to the inner
// VideoView.
export const VideoPreview = forwardRef<VideoViewHandle, VideoViewProps>(
  function VideoPreview(props, ref) {
    const { src, path, maxDim, nativeAutoplay } = props;
    const [latheResolved, setLatheResolved] = useState(() => latheStatus.get().resolved);
    useEffect(() => latheStatus.subscribe((s) => setLatheResolved(s.resolved)), []);

    const isVideo = !!path && isVideoPath(path);

    // Stable config identity — VideoView keys effects on it, and a fresh
    // object every render re-fired its media-reset (nulling loop points).
    const nativeStream = useMemo(
      () => (isVideo
        ? { path: path as string, height: NATIVE_PREVIEW_HEIGHT, fps: NATIVE_PREVIEW_FPS, autoplay: nativeAutoplay }
        : null),
      [isVideo, path, nativeAutoplay],
    );

    const directMacPreview = isMac && !!props.macDirectPlayback && isVideo &&
      isChromiumPlayableVideo(path as string);

    if (directMacPreview) {
      return <VideoView ref={ref} {...props} nativeStream={null} />;
    }

    if (isVideo && latheResolved) {
      return (
        <VideoView
          ref={ref}
          {...props}
          nativeStream={nativeStream}
        />
      );
    }

    // Lathe missing. A confirmed-small Chromium-safe file can still direct-play
    // (unknown size is treated as oversized so a not-yet-probed 4K can't slip
    // through and crash the host); everything else says what's needed.
    const directPlayable =
      isVideo &&
      isChromiumPlayableVideo(path as string) &&
      typeof maxDim === 'number' &&
      maxDim > 0 &&
      maxDim <= DIRECT_PLAY_MAX_DIM;
    if (isVideo && !directPlayable) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-4 text-center select-none">
          <div className="text-zinc-400 text-xs">Lathe is required to preview this video.</div>
          <div className="text-zinc-500 text-[11px]">
            Install Lathe to enable video preview.
          </div>
        </div>
      );
    }

    return <VideoView ref={ref} {...props} src={src} />;
  },
);
