// Dialog windows — async helpers that spawn a separate WebviewWindow and
// resolve a Promise when the user picks an action. Lean fork of WAVdesk's
// dialogWindow.ts: same protocol (wd-dialog-ready handshake → config push
// → wd-dialog-result), same physical-position centering (logical x/y is
// unreliable across mixed-DPI monitors — the scaleFactor multiply matters
// and is silent on 1.0x displays), same destroyed-window safety net.
// Kinds trimmed to what the standalone apps use: confirm / prompt / info.

import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const THEME_BG = '#09090b';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
  maxLength?: number;
}

export interface InfoOptions {
  title: string;
  message: string;
  okLabel?: string;
}

// Open-dialog count — drives the input-lock overlay over the parent
// window while a dialog is up (the dialog is alwaysOnTop + owned, but
// the parent's controls must not react underneath it).
let openCount = 0;
const subscribers = new Set<(count: number) => void>();
const notify = () => { for (const s of subscribers) s(openCount); };

export function subscribeOpenDialogs(cb: (count: number) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
export function getOpenDialogCount(): number {
  return openCount;
}

// Center on the spawning window, in PHYSICAL pixels. Logical positions
// drift on multi-monitor / mixed-DPI setups; position post-creation and
// ship the window hidden until it has moved.
async function computeCenterOnParent(W: number, H: number): Promise<PhysicalPosition | null> {
  try {
    const me = getCurrentWindow();
    const [pos, size, mon] = await Promise.all([
      me.outerPosition(),
      me.outerSize(),
      currentMonitor(),
    ]);
    const s = mon?.scaleFactor ?? 1;
    return new PhysicalPosition(
      Math.round(pos.x + (size.width - W * s) / 2),
      Math.round(pos.y + (size.height - H * s) / 2),
    );
  } catch { return null; }
}

type SpawnOutcome<R> = { ok: true; value: R } | { ok: false };

async function spawnDialog<R>(args: {
  kind: 'confirm' | 'prompt' | 'info';
  width: number;
  height: number;
  config: Record<string, unknown>;
}): Promise<SpawnOutcome<R>> {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const label = `dialog-${id}`;
  const targetPos = await computeCenterOnParent(args.width, args.height);

  openCount += 1;
  notify();

  let resolveOutcome!: (r: SpawnOutcome<R>) => void;
  const outcomePromise = new Promise<SpawnOutcome<R>>((resolve) => {
    resolveOutcome = resolve;
  });

  const unlistenResult = await listen<{ result: R }>(
    `wd-dialog-result-${id}`,
    (e) => { resolveOutcome({ ok: true, value: e.payload.result }); },
  );
  // Push config the moment the child reports ready; filter on id since
  // wd-dialog-ready is global and dialogs can be in flight concurrently.
  const unlistenReady = await listen<{ id: string }>('wd-dialog-ready', (e) => {
    if (e.payload?.id !== id) return;
    void emit(`wd-dialog-config-${id}`, args.config);
  });

  const win = new WebviewWindow(label, {
    url: `/?wd=dialog&id=${id}&kind=${args.kind}`,
    title: 'Dialog',
    width: args.width,
    height: args.height,
    minWidth: args.width,
    maxWidth: args.width,
    backgroundColor: THEME_BG,
    resizable: false,
    decorations: false,
    alwaysOnTop: true,
    parent: getCurrentWindow().label,
    visible: false,
  });

  win.once('tauri://created', () => {
    void (async () => {
      if (targetPos) {
        try { await win.setPosition(targetPos); } catch { /* center below */ }
      } else {
        try { await win.center(); } catch { /* best effort */ }
      }
      try { await win.show(); } catch { /* ignore */ }
      try { await win.setFocus(); } catch { /* ignore */ }
    })();
  });
  win.once('tauri://error', (e) => console.error('Dialog window error:', e));
  // OS-shell close → the result event never fires; resolve as no-result
  // so the wrappers can pick a kind-appropriate default.
  win.once('tauri://destroyed', () => resolveOutcome({ ok: false }));

  try {
    return await outcomePromise;
  } finally {
    unlistenResult();
    unlistenReady();
    openCount = Math.max(0, openCount - 1);
    notify();
    try { await win.close(); } catch { /* already gone */ }
  }
}

export async function confirmInWindow(opts: ConfirmOptions): Promise<boolean> {
  const r = await spawnDialog<boolean>({
    kind: 'confirm',
    width: 360,
    height: 170,
    config: { ...opts },
  });
  return r.ok ? r.value : false;
}

export async function askPromptInWindow(opts: PromptOptions): Promise<string | null> {
  const r = await spawnDialog<string | null>({
    kind: 'prompt',
    width: 360,
    height: 190,
    config: { ...opts },
  });
  return r.ok ? r.value : null;
}

export async function infoInWindow(opts: InfoOptions): Promise<void> {
  await spawnDialog<boolean>({
    kind: 'info',
    width: 360,
    height: 160,
    config: { ...opts },
  });
}
