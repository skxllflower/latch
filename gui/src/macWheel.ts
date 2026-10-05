import { invoke } from '@tauri-apps/api/core';
import { isMac } from './platform';
import { logToFile } from './frontendLog';
import {
  classifyWheel, createReceiptGate, formatReceipt, parseNativeScrollTag, receiptKey,
  type NativeScrollTag, type WheelClass,
} from './wheelSource';

type TagWindow = Window & { __wdScrollSource?: unknown };

// The host pushes the tag only when the device changes, so a webview opened
// after the last change asks once for the current one.
if (isMac && typeof window !== 'undefined') {
  invoke<string | null>('mac_scroll_source')
    .then((src) => {
      const w = window as TagWindow;
      if (src && !parseNativeScrollTag(w.__wdScrollSource)) w.__wdScrollSource = { src };
    })
    .catch(() => {});
}

const gate = createReceiptGate();

function nativeTag(): NativeScrollTag | null {
  return typeof window === 'undefined' ? null : parseNativeScrollTag((window as TagWindow).__wdScrollSource);
}

/** Classify a visualizer wheel event (see wheelSource.ts). On macOS it also
 *  leaves a budgeted receipt in latch.log, so a real device's numbers can be
 *  read back. Lockstep copy of WAVdesk's utils/macWheel.ts. */
export function classifyVizWheel(e: WheelEvent, view: string): WheelClass {
  const native = isMac ? nativeTag() : null;
  const c = classifyWheel(e, isMac, native);
  if (isMac && gate(receiptKey(view, c, native), performance.now())) {
    logToFile('warn', 'wheel-source', formatReceipt(view, c, native, e as WheelEvent & { wheelDeltaY?: number }));
  }
  return c;
}
