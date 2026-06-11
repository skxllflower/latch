import React from 'react';
import { Copy, FileAudio, Folder, ListPlus, MoveRight, type LucideIcon } from 'lucide-react';

// Visual chip body — the pill that follows the cursor during a drag.
// No positioning logic here: the chip lives inside the drag-overlay
// window which is itself positioned by Rust at the cursor each frame,
// so the chip just renders at (0,0) of its parent container.
//
// Two modes:
//   - Plain (default): "filename (+N)" — used during the in-flight
//     phase before the cursor is over a recognized drop target.
//   - Verb-aware: "<verb> filename + N more to <label>" — used when
//     the cursor is over a folder / collection / tab / pinned, with
//     verb derived from target kind + Ctrl/Cmd modifier state. The
//     verb-and-target form is driven by main's onDragDropEvent
//     `over` hit-test plus a keyboard listener for live Ctrl/Cmd
//     toggling — see Home.tsx setupOsDragChipFeedback.
//
// All visual values pull from theme CSS variables so the chip adopts
// whichever theme main is using without the overlay window having to
// subscribe to ThemeContext.

export type DragChipVerb = 'Move' | 'Copy' | 'Add' | null;

export interface DragChipProps {
  fileName:    string;
  isDirectory: boolean;
  count:       number;
  /// When set, render the verb-aware "<verb> name + N more to label"
  /// form. When null/undefined, render the plain filename + count.
  verb?:       DragChipVerb;
  /// The destination label shown in italic quotes (folder name,
  /// collection name, tab title). Required when `verb` is set.
  targetLabel?: string | null;
  /// Optional waveform image data URL. When present, the chip
  /// renders the WAVEFORM VARIANT — a thumbnail of the waveform
  /// above a label strip with the file name. Used by VisualizerPane
  /// drag-out so the floating chip is a recognizable preview of
  /// the audio being dragged. Verb/targetLabel still apply on top
  /// (the label strip becomes "Move filename to FolderName" etc.).
  waveformDataUrl?: string | null;
  /// Background color sampled from the waveform — used as the
  /// label strip's bg so the chip reads as one continuous block
  /// instead of a thumbnail-on-frame composition. Falls back to
  /// theme bg-surface when missing.
  bgColor?:         string | null;
}

export const DragChip: React.FC<DragChipProps> = ({
  fileName, isDirectory, count, verb, targetLabel, waveformDataUrl, bgColor,
}) => {
  // Waveform variant — a thumbnail-with-label-strip card. Supports
  // verb-aware text in the label strip too (e.g. "Move filename to
  // FolderName"). Falls through to the standard pill below if no
  // waveform image is provided.
  if (waveformDataUrl) {
    const moreSuffix = count > 1 ? ` + ${count - 1} more` : '';
    const label = targetLabel ?? null;
    const stripBg = bgColor ?? 'var(--theme-bg-surface, #18181b)';
    return (
      <div style={{
        display: 'inline-block',
        background: stripBg,
        border: '1px solid var(--theme-border-hover, #3f3f46)',
        borderRadius: 'var(--theme-radius, 2px)',
        boxShadow: 'var(--theme-shadow, 0 4px 12px rgba(0,0,0,0.4))',
        overflow: 'hidden',
        lineHeight: 0,
      }}>
        {/* Fixed image stage: a blurred cover-scaled copy fills the box
            behind a sharp aspect-fit foreground, so any source aspect
            (16:9 frame, wide waveform crop) fills the chip with no
            letterbox deadspace. */}
        <div style={{ position: 'relative', width: 320, height: 140, overflow: 'hidden', background: stripBg }}>
          <img
            src={waveformDataUrl}
            alt=""
            aria-hidden
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'cover',
              filter: 'blur(10px) brightness(0.55)',
              transform: 'scale(1.2)',
            }}
          />
          <img
            src={waveformDataUrl}
            alt=""
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'contain',
            }}
          />
        </div>
        <div style={{
          padding: '3px 8px',
          fontSize: '0.625rem',
          lineHeight: 1,
          color: 'var(--theme-text-secondary, #a1a1aa)',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 320,
        }}>
          {verb && label ? (
            <>
              <span style={{ fontWeight: 700, color: 'var(--theme-text-primary, #f4f4f5)' }}>{verb}</span>
              {' '}{fileName}{moreSuffix}{' to '}
              <span style={{ fontStyle: 'italic' }}>"{label}"</span>
            </>
          ) : (
            fileName
          )}
        </div>
      </div>
    );
  }

  // Pick the icon based on the current action: collection-add gets
  // ListPlus, copy gets Copy, move gets MoveRight, plain (no target)
  // gets the file/folder icon.
  let Icon: LucideIcon = isDirectory ? Folder : FileAudio;
  if (verb === 'Add')        Icon = ListPlus;
  else if (verb === 'Copy')  Icon = Copy;
  else if (verb === 'Move')  Icon = MoveRight;

  const moreSuffix = count > 1 ? ` + ${count - 1} more` : '';
  const label = targetLabel ?? 'destination';

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '3px 8px',
      whiteSpace: 'nowrap',
      fontSize: '0.625rem',
      lineHeight: 1,
      fontFamily: 'inherit',
      background: 'var(--theme-bg-surface, #18181b)',
      border: '1px solid var(--theme-border-hover, #3f3f46)',
      color: 'var(--theme-text-secondary, #a1a1aa)',
      borderRadius: 'var(--theme-radius, 2px)',
      boxShadow: 'var(--theme-shadow, 0 4px 12px rgba(0,0,0,0.4))',
    }}>
      <Icon size={10} style={{ flexShrink: 0 }} />
      {verb ? (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 320 }}>
          <span style={{ fontWeight: 700, color: 'var(--theme-text-primary, #f4f4f5)' }}>{verb}</span>
          {' '}
          {fileName}{moreSuffix}
          {' to '}
          <span style={{ fontStyle: 'italic' }}>"{label}"</span>
        </span>
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }}>
          {fileName}
        </span>
      )}
      {!verb && count > 1 && (
        <span style={{
          padding: '1px 5px',
          background: 'var(--theme-bg-hover, #27272a)',
          color: 'var(--theme-text-primary, #f4f4f5)',
          fontSize: '0.5625rem',
          borderRadius: 'var(--theme-radius, 2px)',
        }}>
          +{count - 1}
        </span>
      )}
    </div>
  );
};
