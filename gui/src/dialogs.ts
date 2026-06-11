// Confirm dialogs for the standalone app. WAVdesk spawns dedicated
// WebviewWindows for these; standalone Lathe uses the OS-native ask()
// from the dialog plugin — still never an in-app modal.

import { ask } from '@tauri-apps/plugin-dialog';

export interface ConfirmOpts {
  title:         string;
  message:       string;
  confirmLabel?: string;
  cancelLabel?:  string;
}

export async function confirmInWindow(opts: ConfirmOpts): Promise<boolean> {
  try {
    return await ask(opts.message, {
      title:       opts.title,
      kind:        'warning',
      okLabel:     opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
    });
  } catch {
    return false;
  }
}
