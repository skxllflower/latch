// Confirm / prompt / info dialogs — WAVdesk-style dedicated dialog
// windows (see dialogWindows.ts for the spawn + handshake protocol).
// This module keeps the import surface the ported components were
// written against.

export {
  confirmInWindow,
  askPromptInWindow,
  infoInWindow,
  subscribeOpenDialogs,
  getOpenDialogCount,
  type ConfirmOptions,
  type PromptOptions,
  type InfoOptions,
} from './dialogWindows';
