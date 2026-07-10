// Platform detection, computed once at module load. navigator is always
// present in the Tauri webview (WKWebView on macOS, WebView2 on Windows) and
// the platform can't change at runtime. This centralizes the regex the
// canvas wheel handlers (Waveform / useCanvasViewport) each used to compute
// inline, and is the single gate for the Mac input semantics (Cmd+wheel zoom,
// Option fine-adjust, Cmd accelerator display).
export const isMac: boolean =
  typeof navigator !== 'undefined'
  && /Mac|iPad|iPhone/.test(navigator.platform || navigator.userAgent || '');
