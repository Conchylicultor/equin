# mail-core

The mail app's persisted data model, the shared user-labels resource, and the
Gmail token-wiring helper. Server + core only — no web runtime. It imports no
other mail plugin, which is what lets every mail surface depend on it without a
cycle.

## No mailbox view vocabulary — a mailbox is a config row

There used to be a `MailViewFilter` / `resolveMailView` / `mailViewFilterSql`
vocabulary here, encoding the 8 system mailboxes as TypeScript and compiling each
to an enforced SQL scope. **It is gone, deliberately.** A mailbox is now an
authored view instance of the `threads` DataView
(`config/apps/mail/threads/mail-threads.jsonc`), and its scope is that view's
ordinary, user-editable `filter` — plain `FilterGroup` JSON lowered into the
`mail.threads` live window like any other filter. "Inbox" is definitionally the tab whose filter is
`labels contains INBOX`; if the user edits it, that is the answer. There is no
invariant left to enforce, so there is nothing here to enforce it with.

Do not re-introduce a mailbox vocabulary in code. If a mailbox needs to change,
edit the config row. Design:
`research/2026-08-03-global-mail-mailbox-as-dataview-views-v2.md`.

Three live values are declared here (`core/internal/resources.ts`), in the leaf
every mail plugin imports, so no consumer has to import another to read them:

- `mailAccount` (`liveValue("mail-account")`, `{ id, email } | null`) is THE
  account the mail surfaces show: the earliest connected (`connected_at`, then
  `id`), served here as `mailAccountServed`. The served loader and
  `resolveMailAccountId()` both call `readMailAccount(executor)`
  (`server/internal/account.ts`), so "the account" has one definition —
  deterministic when a second Google account has connected (sync keys accounts
  by email and deletes none); `account.test.ts` pins the choice against a real
  database. `threads` scopes its live window to its id.

- `mailLabels` (`liveValue("mail-labels")`, the account's `type="user"` labels
  ordered by name) is also served here, as `mailLabelsServed` — a `source: "db"`
  `serveValue` with `unbounded: { reason }` (Gmail caps an account's labels in
  the thousands, so the whole list is the working set). `threads` reads it with
  `useLive` for the id→name map that keeps "Label_12" off the screen in its
  `labels` field options and filter chips.
- `mailSyncState` (`liveValue("mail-sync-state")`, one row per connected
  account) is only declared here; `sync`, which owns the writes, serves it
  (`mailSyncStateServed`). `sync-status` reads it for the banner and rail dot.

All three recompute and push on every write to a table their loader reads
(`mailLabels` also reads `mail_accounts`, to resolve the account) through the
DB change-feed — no manual notify.

## Data model (`defineEntity` over field records)

The cluster is defined via the `defineEntity` primitive
(`@plugins/infra/plugins/entities/server`), mirroring `debug/slow-ops` and
`debug/boot-profile`: one web-safe `FieldsRecord` per table lives in
`core/internal/fields.ts`, and `server/internal/tables.ts` calls
`defineEntity(name, fields, meta)` (FK / cascade / index / default / bespoke
column-name DDL in the `meta`) to derive each Drizzle pgTable. The public wire
schemas (`Mail*Schema`) come from `fieldsToZodObject(fields)` in core, so
`entity.table.$inferSelect` is identical **by construction** to
`z.infer<Mail*Schema>` and a column/schema drift is a `tsc` error rather than a
silently diverging hand-authored interface. `core/internal/types.ts` is now a
thin `z.infer<…>` alias file over those schemas (same exported type names).

A local mirror of a Gmail mailbox, one FK cluster rooted at `mail_accounts`:

- `mail_accounts` — connected Google/Gmail account (id, email, signature, …).
- `mail_sync_state` — per-account sync engine watermark (historyId, status).
- `mail_labels` — Gmail labels (system/user), self-referential `parent_id`.
- `mail_threads` — conversation threads with denormalized rollups (counts,
  flags, `label_ids`).
- `mail_messages` — individual messages; address columns are stored as
  `from_addr`/`to_addrs`/`cc_addrs`/`bcc_addrs`/`reply_to` (DB names avoid the
  SQL reserved words `from`/`to`) with readable TS keys `from`/`to`/`cc`/`bcc`/
  `replyTo`. `body_text`/`body_html` are null on an **envelope-only stub** (the
  on-demand sync mirrors envelopes via Gmail `format=metadata`); they + the
  `body_fetched_at` hydration marker are filled the first time the message is
  opened (see `sync`'s `POST /api/mail/hydrate`). A message-level `has_attachments`
  flag drives the paperclip: pre-populated WITHOUT a body fetch by the sync's
  `has:attachment` scan (or corrected exactly on hydration), and the
  `mail_threads` attachment rollup derives from it.
- `mail_message_labels` — message↔label join (composite PK).
- `mail_attachments` — attachment metadata; `stored_attachment_id` links to a
  downloaded blob.
- `mail_drafts` — local compose drafts (also owns a draft↔attachment link via
  `Attachments.defineLink`).
- `mail_outbox` — durable pending-mutation queue replayed against Gmail.

Every owned FK uses `ON DELETE CASCADE` from its account/thread/message parent
(except `mail_labels.parent_id`, which is `ON DELETE SET NULL`).
`mail_drafts.thread_id` is a plain Gmail thread id with **no** FK: the corpus
tables are left out of forks and backups, and `database/admin` refuses a kept
table linking to a left-out one (pg_restore would fail re-adding it).

**Backups.** `mail_threads`, `mail_messages`, `mail_message_labels`,
`mail_attachments` and `mail_sync_state` are `ExcludeFromBackup`: the corpus is
refetched by sync, and the watermark goes with it — a restored account with no
sync-state row is re-bootstrapped by the next `mail.sync-tick`, which backfills
the window again. Accounts, labels, drafts (+ their attachments) and the outbox
stay in backups. Web-safe field records + derived types live in
`core/internal/{fields,types}.ts`; closed-list enums in
`core/internal/enums.ts` (fed into `enumTextField` for the union-branded `text`
columns: `type`, `op_type`, the two `status` columns).

## Gmail tokens

`requireGmailToken()` is the single entry point for Gmail auth in the mail data
layer. It calls `getGmailToken()` from the Gmail integration and throws loudly
when no usable token is available. On success it returns a `GmailConnection`
(`{ accessToken, email }`) — the `email` (connected Google account, from the
OAuth identity, known without a Gmail API call) lets `sync` bootstrap create the
account row *before* its first Gmail API call, so a bootstrap-time API failure
has a real `mail_sync_state` row to record its error on. This plugin never
imports `@plugins/auth/*` directly — all Gmail auth flows through
`@plugins/integrations/plugins/gmail/server`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Registers the mail app's own id kinds (mailacct, mailatt, maildraft, mailout) with the web id registry — the server barrel registers the same kinds. Schema + token wiring for the mail app (accounts, threads, messages, labels, attachments, drafts, sync-state, outbox), plus the shared connected-account and user-labels live values.
- Web:
  - Contributes:
    - `IdKinds.Kind` "mailacct"
    - `IdKinds.Kind` "mailatt"
    - `IdKinds.Kind` "maildraft"
    - `IdKinds.Kind` "mailout"
  - Uses: `ids.IdKinds`
- Server:
  - Contributes:
    - `ids.kind` "mailacct"
    - `ids.kind` "mailatt"
    - `ids.kind` "maildraft"
    - `ids.kind` "mailout"
    - `resource.declare` "mail-account"
    - `resource.declare` "mail-labels"
    - `fork-data-exclusion` "mail_attachments"
    - `fork-data-exclusion` "mail_message_labels"
    - `fork-data-exclusion` "mail_messages"
    - `fork-data-exclusion` "mail_threads"
    - `backup-data-exclusion` "mail_attachments"
    - `backup-data-exclusion` "mail_message_labels"
    - `backup-data-exclusion` "mail_messages"
    - `backup-data-exclusion` "mail_sync_state"
    - `backup-data-exclusion` "mail_threads"
  - Uses:
    - `database.db`
    - `database/admin.ExcludeFromBackup`
    - `database/admin.ExcludeFromFork`
    - `ids.IdKinds`
    - `infra/attachments.Attachments`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `integrations/gmail.getGmailToken`
    - `network/live.serveValue`
  - DB schema:
    - `plugins/apps/plugins/mail/plugins/mail-core/server/internal/schema-attachments.ts`
    - `plugins/apps/plugins/mail/plugins/mail-core/server/internal/tables.ts`
  - Exports (types): `GmailConnection`
  - Exports (values):
    - `_mailAccounts`
    - `_mailAttachments`
    - `_mailLabels`
    - `_mailMessageLabels`
    - `_mailMessages`
    - `_mailSyncState`
    - `_mailThreads`
    - `mailDraftAttachments`
    - `requireGmailToken`
    - `resolveMailAccountId`
  - Resources:
    - `mail-account` (push)
    - `mail-labels` (push, unbounded: the connected account's user labels — Gmail caps an account's labels in the thousands, so the whole list is the working set)
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.externalIdField`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/entities.entityRef`
    - `network/live.liveValue`
    - `primitives/live-state.tolerantEnum`
  - Exports (types):
    - `MailAccount`
    - `MailAccountId`
    - `MailAddress`
    - `MailAttachment`
    - `MailAttachmentId`
    - `MailDraft`
    - `MailDraftId`
    - `MailLabel`
    - `MailLabelRef`
    - `MailLabelType`
    - `MailMessage`
    - `MailMessageLabel`
    - `MailOutboxId`
    - `MailOutboxItem`
    - `MailOutboxOpType`
    - `MailOutboxStatus`
    - `MailSyncErrorCode`
    - `MailSyncPhase`
    - `MailSyncState`
    - `MailSyncStatus`
    - `MailSyncView`
    - `MailThread`
  - Exports (values):
    - `deriveMailSyncView`
    - `MAIL_LABEL_TYPES`
    - `MAIL_OUTBOX_OP_TYPES`
    - `MAIL_OUTBOX_STATUSES`
    - `MAIL_SYNC_ERROR_CODES`
    - `MAIL_SYNC_REMEDIATION`
    - `MAIL_SYNC_STATUSES`
    - `mailAccount`
    - `mailAccountFields`
    - `mailAccountIdKind`
    - `MailAccountSchema`
    - `mailAccountsEntityRef`
    - `MailAddressSchema`
    - `mailAttachmentFields`
    - `mailAttachmentIdKind`
    - `MailAttachmentSchema`
    - `mailAttachmentsEntityRef`
    - `mailDraftFields`
    - `mailDraftIdKind`
    - `MailDraftSchema`
    - `mailDraftsEntityRef`
    - `mailLabelFields`
    - `MailLabelRefSchema`
    - `mailLabels`
    - `MailLabelSchema`
    - `mailLabelsEntityRef`
    - `mailMessageFields`
    - `mailMessageLabelFields`
    - `MailMessageLabelSchema`
    - `mailMessageLabelsEntityRef`
    - `MailMessageSchema`
    - `mailMessagesEntityRef`
    - `mailOutboxEntityRef`
    - `mailOutboxFields`
    - `mailOutboxIdKind`
    - `MailOutboxItemSchema`
    - `mailSyncState`
    - `mailSyncStateEntityRef`
    - `mailSyncStateFields`
    - `MailSyncStateSchema`
    - `mailThreadFields`
    - `MailThreadSchema`
    - `mailThreadsEntityRef`
    - `MAX_CONSECUTIVE_RESYNCS`
- Cross-plugin:
  - Imported by:
    - `apps/mail/attachments`
    - `apps/mail/reading-pane`
    - `apps/mail/sync`
    - `apps/mail/threads`

<!-- AUTOGENERATED:END -->
