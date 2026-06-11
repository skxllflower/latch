// Settings-modal dropdown with mac-style press-drag selection. Same UX
// as the menubar dropdowns (mousedown opens, drag-to-item, mouseup
// selects), without the satellite-window plumbing — these popups live
// in the same WebView2 as their owner so document-level mousemove +
// mouseup track the press session directly.
//
// Falls back to plain click-to-open / click-to-select when the user
// just clicks the trigger and releases on it. Click outside closes.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

interface WdSelectValueOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
  section?: false;
}

interface WdSelectSectionOption {
  label: string;
  section: true;
}

export type WdSelectOption<V extends string = string> =
  | WdSelectValueOption<V>
  | WdSelectSectionOption;

function isValueOption<V extends string>(opt: WdSelectOption<V>): opt is WdSelectValueOption<V> {
  return !opt.section;
}

interface WdSelectProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  options: WdSelectOption<V>[];
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  // Position of the disclosure chevron inside the trigger button.
  // 'right' (default) puts label-left / chevron-right via flex-between
  // — the convention for standalone form selects. 'left' renders the
  // chevron BEFORE the label and packs both to the right, matching
  // InfoPanel-style metadata rows where the value reads as a right-
  // aligned scalar with a tiny chevron lead-in.
  chevronPosition?: 'left' | 'right';
}

interface PanelPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export function WdSelect<V extends string = string>({
  value, onChange, options, className, disabled, ariaLabel,
  chevronPosition = 'right',
}: WdSelectProps<V>): React.ReactElement {
  const [open, setOpen]       = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef   = useRef<HTMLDivElement   | null>(null);
  // pressing flag distinguishes the press-drag session (started by
  // mousedown on the trigger) from a regular click-to-open + click-on-
  // option flow. While pressing we listen at document level for
  // mousemove/mouseup; outside it we fall back to per-row click.
  const pressingRef = useRef(false);

  const selected = options.find((o) => isValueOption(o) && o.value === value);
  const selectedLabel = selected?.label ?? String(value);

  const close = useCallback(() => {
    pressingRef.current = false;
    setOpen(false);
    setHoverIdx(null);
  }, []);

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 4;
    const gap = 2;
    const width = Math.max(rect.width, 120);
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const openUp = below < 140 && above > below;
    const space = Math.max(48, openUp ? above : below);
    const maxHeight = Math.min(256, Math.max(48, space - gap));
    setPanelPosition(openUp
      ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + gap }
      : { left, width, maxHeight, top: rect.bottom + gap });
  }, []);

  // Hit-test: which option index sits under the given clientX/Y?
  // Returns null if outside any option (or option is disabled — drag
  // through doesn't preview a disabled row).
  const hitTest = useCallback((x: number, y: number): number | null => {
    const panel = panelRef.current;
    if (!panel) return null;
    const opts = panel.querySelectorAll<HTMLElement>('[data-wd-select-option]');
    for (let i = 0; i < opts.length; i++) {
      const el = opts[i];
      if (el.dataset.disabled === 'true') continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const idx = Number(el.dataset.wdSelectIndex);
        return Number.isFinite(idx) ? idx : null;
      }
    }
    return null;
  }, []);

  // Press-drag session — installed lazily on first mousedown inside
  // the trigger. Drives the hover highlight and the on-release commit.
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      if (!pressingRef.current) return;
      setHoverIdx(hitTest(e.clientX, e.clientY));
    };
    const onUp = (e: MouseEvent) => {
      if (!pressingRef.current) return;
      pressingRef.current = false;
      const idx = hitTest(e.clientX, e.clientY);
      if (idx !== null) {
        const opt = options[idx];
        if (opt && isValueOption(opt) && !opt.disabled) {
          onChange(opt.value);
          close();
          return;
        }
      }
      // Released outside any option (or on the trigger itself, if the
      // user just clicked without dragging). Drop the press session
      // but keep the panel open so the user can click a row instead.
      setHoverIdx(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
  }, [open, options, onChange, hitTest, close]);

  // Click-outside to dismiss. Capture phase keeps titlebar drag natural:
  // the dropdown closes before Tauri sees the drag-region mousedown, but
  // we never prevent/stop the event, so the window move still starts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (pressingRef.current) return;
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t))   return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
  }, [open, options, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;
    const onLayoutChange = () => updatePanelPosition();
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('scroll', onLayoutChange, true);
    return () => {
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('scroll', onLayoutChange, true);
    };
  }, [open, updatePanelPosition]);

  // Keyboard: Esc closes. Enter on trigger opens (regular button
  // semantics still fire onClick for keyboard/space).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const triggerClasses = className
    ?? 'w-full bg-zinc-950 border border-zinc-800 text-[0.625rem] text-zinc-300 px-2 py-1 focus:outline-none focus:border-zinc-700 hover:border-zinc-700 transition-none';

  return (
    <div className="relative inline-block" style={{ width: className?.includes('w-full') !== false ? '100%' : undefined }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onMouseDown={(e) => {
          if (disabled) return;
          if (e.button !== 0) return;
          // Suppress the synthetic click that would otherwise fire on
          // mouseup-over-trigger (we own the click semantics).
          e.preventDefault();
          // Second mousedown on the trigger while the panel is open
          // toggles it closed — mirrors how native <select> + macOS
          // pickers feel. The click-outside handler doesn't fire here
          // because triggerRef.contains(target) returns true.
          if (open) {
            close();
            return;
          }
          pressingRef.current = true;
          updatePanelPosition();
          setOpen(true);
        }}
        // Keyboard / a11y open path only — onMouseDown above owns the
        // mouse flow. preventDefault() on mousedown does NOT cancel the
        // synthetic click in Chromium, so this handler used to fire
        // right after mouseup and toggle the freshly-opened panel shut.
        // Gate on detail===0 (keyboard/programmatic clicks) so real
        // mouse interactions skip this branch entirely.
        onClick={(e) => {
          if (e.detail !== 0) return;
          e.preventDefault();
          if (disabled) return;
          if (open) close();
          else setOpen(true);
        }}
        className={`${triggerClasses} flex items-center ${
          chevronPosition === 'left'
            // Tighter gap (2px) for the compact info-row form so the
            // chevron sits flush next to the value text instead of
            // floating with a 4px buffer.
            ? 'gap-0.5 justify-end'
            : 'gap-1 justify-between'
        }`}
      >
        {chevronPosition === 'left' && (
          <ChevronDown size={10} className="text-zinc-500 shrink-0" />
        )}
        <span className={chevronPosition === 'left' ? 'truncate text-right' : 'truncate'}>
          {selectedLabel}
        </span>
        {chevronPosition === 'right' && (
          <ChevronDown size={10} className="text-zinc-500 shrink-0" />
        )}
      </button>
      {open && panelPosition && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={{
            position: 'fixed',
            left: panelPosition.left,
            top: panelPosition.top,
            bottom: panelPosition.bottom,
            width: panelPosition.width,
            maxHeight: panelPosition.maxHeight,
          }}
          className="bg-zinc-950 border border-zinc-700 shadow-lg overflow-y-auto z-[10000]"
        >
          {options.map((opt, i) => {
            if (!isValueOption(opt)) {
              return (
                <div
                  key={`section-${i}-${opt.label}`}
                  role="presentation"
                  className="wd-select-section-row"
                >
                  {opt.label}
                </div>
              );
            }
            const isSel    = opt.value === value;
            const isHover  = hoverIdx === i;
            const isDis    = !!opt.disabled;
            // Hover/selected/disabled tones mirror the menubar context
            // menu rows (zinc-800 bg + zinc-100 text on hover/focus).
            const tone = isDis
              ? 'text-zinc-600 cursor-not-allowed'
              : isHover
                ? 'bg-zinc-800 text-zinc-100'
                : isSel
                  ? 'bg-zinc-900 text-zinc-100'
                  : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100';
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSel}
                aria-disabled={isDis}
                data-wd-select-option
                data-wd-select-index={i}
                data-disabled={isDis ? 'true' : 'false'}
                disabled={isDis}
                onMouseEnter={() => { if (!pressingRef.current && !isDis) setHoverIdx(i); }}
                onMouseLeave={() => { if (!pressingRef.current) setHoverIdx(null); }}
                onClick={() => {
                  if (isDis) return;
                  onChange(opt.value);
                  close();
                }}
                className={`w-full flex items-center justify-start text-left text-[0.625rem] px-2 py-1 transition-none ${tone}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
