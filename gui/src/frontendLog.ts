import { invoke } from '@tauri-apps/api/core';

// Route a frontend log line into latch.log (the always-on file log the About
// window's "Open Log File" opens), so a field failure in the webview engine
// (the native-video mac stall-watchdog / loop-overdue / EOF-replay warns) has
// receipts after the fact instead of only reaching the webview console. Best-
// effort and never throws: a failed invoke is swallowed WITHOUT touching
// console.* (which the caller also writes, so a tee would double-count).
// Circuit breaker: cap per rolling second so a runaway can't flood the IPC —
// the first MAX_LOGS_PER_SEC of any burst still reach the log.
const MAX_LOGS_PER_SEC = 200;
let rateWindowStart = 0;
let rateWindowCount = 0;

export function logToFile(
  level: 'error' | 'warn' | 'info',
  source: string,
  message: string,
): void {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (now - rateWindowStart > 1000) { rateWindowStart = now; rateWindowCount = 0; }
  if (++rateWindowCount > MAX_LOGS_PER_SEC) return;
  try {
    void invoke('log_frontend', { level, source, message }).catch(() => {});
  } catch {
    /* invoke unavailable (pre-init / non-Tauri) — drop silently */
  }
}
