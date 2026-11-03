import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  ExcludeFromBackup,
  ExcludeFromFork,
} from "@plugins/database/plugins/admin/server";
import { IdKinds } from "@plugins/ids/server";
import {
  mailAccountIdKind,
  mailAttachmentIdKind,
  mailDraftIdKind,
  mailOutboxIdKind,
} from "../core";
import { mailLabelsServed } from "./internal/labels-resource";
import { mailAccountServed } from "./internal/account-resource";
import {
  _mailMessages,
  _mailThreads,
  _mailMessageLabels,
  _mailAttachments,
  _mailSyncState,
} from "./internal/tables";
import { attachmentLinkContributions } from "./internal/attachment-links";

// Re-export the physical tables, the attachment-link handle, and the token
// helper so phase-2 sync code can import them from this barrel. Re-exporting a
// plugin's OWN internal files is allowed; only proxying another plugin's
// symbols would violate the boundary rules.
export {
  _mailAccounts,
  _mailSyncState,
  _mailLabels,
  _mailThreads,
  _mailMessages,
  _mailMessageLabels,
  _mailAttachments,
} from "./internal/tables";
export { mailDraftAttachments } from "./internal/schema-attachments";
export { resolveMailAccountId } from "./internal/account";
export { requireGmailToken } from "./internal/token";
export type { GmailConnection } from "./internal/token";

export default {
  description:
    "Schema + token wiring for the mail app (accounts, threads, messages, labels, attachments, drafts, sync-state, outbox), plus the shared connected-account and user-labels live values.",
  contributions: [
    ...attachmentLinkContributions,
    IdKinds.Kind({ kind: mailAccountIdKind }),
    IdKinds.Kind({ kind: mailAttachmentIdKind }),
    IdKinds.Kind({ kind: mailDraftIdKind }),
    IdKinds.Kind({ kind: mailOutboxIdKind }),
    ...mailLabelsServed.declare,
    ...mailAccountServed.declare,
    // The mailbox corpus. Gmail sync is main-only, so a forked worktree neither
    // needs these rows nor would ever re-populate them — and at ~845 MB they
    // used to dominate the fork. These four exclusions were previously a
    // hardcoded list of table-name strings inside the fork itself, which the
    // database plugin had no business knowing; they live here now, with the
    // plugin that owns the tables.
    ExcludeFromFork({
      table: _mailMessages,
      reason:
        "Gmail corpus; sync is main-only, so a worktree never reads or re-populates it.",
    }),
    ExcludeFromFork({
      table: _mailThreads,
      reason:
        "Gmail corpus; sync is main-only, so a worktree never reads or re-populates it.",
    }),
    ExcludeFromFork({
      table: _mailMessageLabels,
      reason:
        "Gmail corpus; sync is main-only, so a worktree never reads or re-populates it.",
    }),
    ExcludeFromFork({
      table: _mailAttachments,
      reason:
        "Gmail corpus; sync is main-only, so a worktree never reads or re-populates it.",
    }),
    // Out of backups too — a separate decision from the fork (see
    // `database/admin`'s ExcludeFromBackup). The corpus is a mirror of Gmail
    // that sync refetches, so a restore losing it costs nothing but a backfill.
    //
    // `mail_sync_state` MUST go with it. It is the history watermark, and
    // bootstrap never resets a row that already has one — so a restored
    // watermark over empty corpus tables would leave the mailbox empty forever.
    // Without the row, the next `mail.sync-tick` bootstraps the account again.
    //
    // Kept: accounts, labels, drafts (+ their attachments) and the outbox —
    // local state Gmail cannot give back.
    ExcludeFromBackup({
      table: _mailMessages,
      reason:
        "Gmail mirror; the next sync refetches it (the sync state is left out with it, so the account is re-bootstrapped and the window backfilled again).",
    }),
    ExcludeFromBackup({
      table: _mailThreads,
      reason:
        "Gmail mirror; the next sync refetches it (the sync state is left out with it, so the account is re-bootstrapped and the window backfilled again).",
    }),
    ExcludeFromBackup({
      table: _mailMessageLabels,
      reason:
        "Gmail mirror; the next sync refetches it (the sync state is left out with it, so the account is re-bootstrapped and the window backfilled again).",
    }),
    ExcludeFromBackup({
      table: _mailAttachments,
      reason:
        "Gmail mirror; the next sync refetches it (the sync state is left out with it, so the account is re-bootstrapped and the window backfilled again).",
    }),
    ExcludeFromBackup({
      table: _mailSyncState,
      reason:
        "History watermark of the Gmail mirror, left out with the corpus it describes: a restored watermark over empty tables would never backfill, while no row makes the next sync tick bootstrap and backfill again.",
    }),
  ],
} satisfies ServerPluginDefinition;
