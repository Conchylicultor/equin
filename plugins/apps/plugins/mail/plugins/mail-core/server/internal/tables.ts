import { type AnyPgColumn, index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import {
  mailAccountsEntityRef,
  mailSyncStateEntityRef,
  mailLabelsEntityRef,
  mailThreadsEntityRef,
  mailMessagesEntityRef,
  mailMessageLabelsEntityRef,
  mailAttachmentsEntityRef,
  mailDraftsEntityRef,
  mailOutboxEntityRef,
} from "../../core";

// Physical tables for the mail app's local mirror of a Gmail mailbox, derived
// from the web-safe field records in `core/internal/fields.ts` via the
// `defineEntity` primitive — so `entity.table.$inferSelect` is identical by
// construction to the public `z.infer<...Schema>` (Stage E of the
// fields-unified-entities roadmap). FK / cascade / index / default DDL lives in
// the `meta` below; the field records stay name- and storage-agnostic.
//
// This file is a load-order leaf: it must NOT import another plugin's
// schema/tables file so cross-plugin schemas can depend on it without forming a
// cycle. Every table is re-exported with a leading `_` so drizzle-kit's
// `schema*.ts` glob discovers it while the barrel exposes only the handle.
//
// All address columns use bespoke `*_addr(s)` / `reply_to` DB names (set via
// `columns.<key>.name`) to avoid the SQL reserved words `from`/`to`; the TS
// property keys (`from`, `to`, `cc`, `bcc`, `replyTo`) stay readable.

const mailAccounts = defineEntity(mailAccountsEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Profile columns count; identity does not.
  updatedAt: {
    touchedBy: {
      id: false,
      email: true,
      name: true,
      avatarUrl: true,
      signature: true,
      connectedAt: true,
      createdAt: false,
    },
  },
  columns: {
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
});

const mailSyncState = defineEntity(mailSyncStateEntityRef, {
  primaryKey: "accountId",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). The user-visible sync status counts; the engine's watermarks
  // (history id, last*SyncAt), error timestamp and resync counter are bookkeeping.
  updatedAt: {
    touchedBy: {
      accountId: false,
      historyId: false,
      lastFullSyncAt: false,
      lastDeltaSyncAt: false,
      status: true,
      errorCode: true,
      lastError: true,
      lastErrorAt: false,
      resyncCount: false,
      createdAt: false,
    },
  },
  columns: {
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    status: { default: "idle" },
    resyncCount: { default: 0 },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
});

const mailLabels = defineEntity(mailLabelsEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Every Gmail label attribute counts, so an identical re-upsert
  // on the delta tick moves nothing.
  updatedAt: {
    touchedBy: {
      id: false,
      accountId: false,
      name: true,
      type: true,
      color: true,
      textColor: true,
      parentId: true,
      messageListVisibility: true,
      labelListVisibility: true,
      createdAt: false,
    },
  },
  columns: {
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    parentId: {
      references: {
        column: (): AnyPgColumn => mailLabels.table.id,
        onDelete: "set null",
      },
    },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [index("mail_labels_account_id_idx").on(t.accountId)],
});

const mailThreads = defineEntity(mailThreadsEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Every list-visible column counts — the threads revision tick
  // reads max(updated_at), so it must move on each; the sync `historyId`
  // watermark does not, and an identical recompute moves nothing.
  updatedAt: {
    touchedBy: {
      id: false,
      accountId: false,
      subject: true,
      snippet: true,
      participants: true,
      lastMessageAt: true,
      messageCount: true,
      unread: true,
      starred: true,
      important: true,
      hasAttachments: true,
      labelIds: true,
      historyId: false,
      createdAt: false,
    },
  },
  columns: {
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    participants: { default: [] },
    messageCount: { default: 0 },
    unread: { default: false },
    starred: { default: false },
    important: { default: false },
    hasAttachments: { default: false },
    labelIds: { default: [] },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("mail_threads_account_last_msg_idx").on(t.accountId, t.lastMessageAt),
    // Every mailbox view is a `label_ids @> '["<id>"]'` containment scan, and all
    // mailboxes now share ONE query path — so the containment must be an index
    // scan. `jsonb_path_ops` (rather than the default `jsonb_ops`) indexes only
    // the hashed paths, which is smaller and faster for exactly the `@>` operator
    // this column is queried with — the only jsonb operator any mail predicate
    // uses. Load-bearing: `tags`' containment builders deliberately use the BARE
    // column so this index stays usable.
    index("mail_threads_label_ids_idx").using(
      "gin",
      t.labelIds.op("jsonb_path_ops"),
    ),
  ],
});

const mailMessages = defineEntity(mailMessagesEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Content, envelope and flags count; the `bodyFetchedAt` hydration
  // marker, its `bodyFetchError` and the sync `historyId` watermark are
  // bookkeeping.
  updatedAt: {
    touchedBy: {
      id: false,
      threadId: true,
      accountId: false,
      from: true,
      to: true,
      cc: true,
      bcc: true,
      replyTo: true,
      subject: true,
      snippet: true,
      headers: true,
      bodyText: true,
      bodyHtml: true,
      bodyFetchedAt: false,
      bodyFetchError: false,
      internalDate: true,
      unread: true,
      starred: true,
      isDraft: true,
      isSent: true,
      hasAttachments: true,
      sizeEstimate: true,
      historyId: false,
      createdAt: false,
    },
  },
  columns: {
    threadId: {
      references: { column: () => mailThreads.table.id, onDelete: "cascade" },
    },
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    from: { name: "from_addr" },
    to: { name: "to_addrs", default: [] },
    cc: { name: "cc_addrs", default: [] },
    bcc: { name: "bcc_addrs", default: [] },
    replyTo: { name: "reply_to" },
    headers: { default: {} },
    unread: { default: false },
    starred: { default: false },
    isDraft: { default: false },
    isSent: { default: false },
    hasAttachments: { default: false },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("mail_messages_thread_id_idx").on(t.threadId),
    index("mail_messages_account_id_idx").on(t.accountId),
  ],
});

const mailMessageLabels = defineEntity(mailMessageLabelsEntityRef, {
    primaryKey: ["messageId", "labelId"],
    columns: {
      messageId: {
        references: {
          column: () => mailMessages.table.id,
          onDelete: "cascade",
        },
      },
      labelId: {
        references: { column: () => mailLabels.table.id, onDelete: "cascade" },
      },
      createdAt: { default: defaultNow() },
    },
    indexes: (t) => [index("mail_message_labels_label_id_idx").on(t.labelId)],
  },
);

const mailAttachments = defineEntity(mailAttachmentsEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Every attachment attribute counts, including the local
  // `storedAttachmentId` a first download sets; identity does not.
  updatedAt: {
    touchedBy: {
      id: false,
      messageId: false,
      accountId: false,
      gmailAttachmentId: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      inline: true,
      contentId: true,
      storedAttachmentId: true,
      createdAt: false,
    },
  },
  columns: {
    messageId: {
      references: { column: () => mailMessages.table.id, onDelete: "cascade" },
    },
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    sizeBytes: { default: 0 },
    inline: { default: false },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [index("mail_attachments_message_id_idx").on(t.messageId)],
});

const mailDrafts = defineEntity(mailDraftsEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Every draft field counts; identity does not. (No writers yet.)
  updatedAt: {
    touchedBy: {
      id: false,
      accountId: false,
      threadId: true,
      gmailDraftId: true,
      inReplyToMessageId: true,
      to: true,
      cc: true,
      bcc: true,
      subject: true,
      bodyHtml: true,
      bodyText: true,
      createdAt: false,
    },
  },
  columns: {
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    // `threadId` is Gmail's own thread id, deliberately NOT a foreign key to
    // `mail_threads`. That table is a rebuildable mirror left out of forks and
    // backups, so a link here would make a restore fail when pg_restore re-adds
    // the constraint (and `database/admin` refuses a kept → left-out link). A
    // resync brings the same thread id back, so a draft may briefly name a
    // thread that is not mirrored yet.
    to: { name: "to_addrs", default: [] },
    cc: { name: "cc_addrs", default: [] },
    bcc: { name: "bcc_addrs", default: [] },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
});

const mailOutbox = defineEntity(mailOutboxEntityRef, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). Every op field counts, retries included (the outbox IS the
  // retry record); identity does not. (No writers yet.)
  updatedAt: {
    touchedBy: {
      id: false,
      accountId: false,
      opType: true,
      targetType: true,
      targetId: true,
      payload: true,
      status: true,
      attempts: true,
      lastError: true,
      createdAt: false,
    },
  },
  columns: {
    accountId: {
      references: {
        column: () => mailAccounts.table.id,
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    },
    payload: { default: {} },
    status: { default: "pending" },
    attempts: { default: 0 },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("mail_outbox_account_status_idx").on(t.accountId, t.status),
  ],
});

// drizzle-kit schema-glob discovery. Export names kept (`_mail*`) so the server
// barrel re-exports and `schema-attachments.ts` (`_mailDrafts`) don't churn.
export const _mailAccounts = mailAccounts.table;
export const _mailSyncState = mailSyncState.table;
export const _mailLabels = mailLabels.table;
export const _mailThreads = mailThreads.table;
export const _mailMessages = mailMessages.table;
export const _mailMessageLabels = mailMessageLabels.table;
export const _mailAttachments = mailAttachments.table;
export const _mailDrafts = mailDrafts.table;
export const _mailOutbox = mailOutbox.table;
