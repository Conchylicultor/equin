import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  textField,
  enumTextField,
  parsedTextField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { externalIdField, idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  mailAccountIdKind,
  mailAttachmentIdKind,
  mailDraftIdKind,
  mailOutboxIdKind,
} from "./id-kinds";
import { tolerantEnum } from "@plugins/primitives/plugins/live-state/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  MAIL_LABEL_TYPES,
  MAIL_OUTBOX_OP_TYPES,
  MAIL_OUTBOX_STATUSES,
  MAIL_SYNC_ERROR_CODES,
  MAIL_SYNC_STATUSES,
} from "./enums";

// Web-safe field records for the mail app's local Gmail-mirror cluster — one
// `FieldsRecord` per persisted table, the single source of truth for both the
// Drizzle pgTable (derived in `server/internal/tables.ts` via `defineEntity`)
// and the public wire schema (`fieldsToZodObject` below). A column/schema drift
// is therefore unrepresentable: `entity.table.$inferSelect ≡ z.infer<Schema>`.
//
// Each record's keys are the JS property names (camelCase) IN COLUMN ORDER. The
// DB column name is `snakeCase(key)` unless overridden in the `defineEntity`
// meta — the address columns use bespoke `*_addr(s)` / `reply_to` names there to
// avoid the SQL reserved words `from`/`to` (see `tables.ts`). FK / cascade /
// index / default DDL is also expressed in the `defineEntity` meta, NOT here —
// this file is name- and storage-agnostic (web-safe).

/** An email participant — display name optional, address required. */
export const MailAddressSchema = z.object({
  name: z.string().optional(),
  email: z.string(),
});

export const mailAccountFields = {
  id: idKindField(mailAccountIdKind),
  email: textField(),
  name: nullable(textField()),
  avatarUrl: nullable(textField()),
  signature: nullable(textField()),
  connectedAt: nullable(dateField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const mailSyncStateFields = {
  accountId: idKindField(mailAccountIdKind),
  historyId: nullable(textField()),
  lastFullSyncAt: nullable(dateField()),
  lastDeltaSyncAt: nullable(dateField()),
  status: enumTextField(MAIL_SYNC_STATUSES),
  errorCode: nullable(enumTextField(MAIL_SYNC_ERROR_CODES)),
  lastError: nullable(textField()),
  lastErrorAt: nullable(dateField()),
  resyncCount: intField(),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

// Distinct unknown label types already surfaced this session, so a mailbox full
// of a new Gmail type doesn't repeat the same line on every push.
const reportedLabelTypes = new Set<string>();

/**
 * TOLERANT, unlike its `mail_outbox` / `mail_sync_state` siblings — whose sets
 * are this engine's own and where an outsider really is a bug.
 *
 * A label's `type` comes from Gmail's REST response through an unchecked cast
 * (`gmail-api/server/internal/request.ts` returns `(await res.json()) as T`), so
 * nothing has ever validated it, and the sync writer already encodes the intent
 * as `label.type ?? "user"`. The set has an upstream we do not control; a value
 * we have not seen is Google adding one, not corruption. So it normalizes to
 * `"user"` — the safe reading, since a label we cannot classify is one the user
 * may manage — and says so once, instead of throwing on read.
 *
 * Putting it on the COLUMN is what makes that `?? "user"` reach every reader
 * rather than only the one writer that spelled it.
 */
const MailLabelTypeSchema = tolerantEnum(
  z.enum(MAIL_LABEL_TYPES),
  () => "user" as const,
  (raw) => {
    const s = String(raw);
    if (reportedLabelTypes.has(s)) return;
    reportedLabelTypes.add(s);
    console.error(
      `[mail] unknown Gmail label type ${JSON.stringify(raw)} — treated as "user". ` +
        `Gmail added a label type, or a row was written by incompatible code.`,
    );
  },
);

export const mailLabelFields = {
  id: externalIdField({
    reason:
      "Gmail's own label id — the local mirror is keyed by the id the Gmail API returns.",
  }),
  accountId: idKindField(mailAccountIdKind),
  name: textField(),
  // `default` is the field's wire/backfill default and stays what it was (the
  // first of MAIL_LABEL_TYPES). It is NOT the same thing as the schema's
  // normalize target above: `"user"` is where an UNKNOWN Gmail value lands,
  // `"system"` is what an ABSENT value backfills to. Collapsing the two would
  // silently change which labels a missing key produces.
  type: parsedTextField(MailLabelTypeSchema, { default: "system" }),
  color: nullable(textField()),
  textColor: nullable(textField()),
  parentId: nullable(textField()),
  messageListVisibility: nullable(textField()),
  labelListVisibility: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

// A thread's labels are the ones every list of threads names it by (the
// threads DataView's fields derive from them, `mailThreadsEntityRef`).
export const mailThreadFields = {
  id: externalIdField({
    reason:
      "Gmail's own thread id — the local mirror is keyed by the id the Gmail API returns.",
  }),
  accountId: idKindField(mailAccountIdKind, { label: "Account" }),
  subject: nullable(textField({ label: "Subject", primary: true })),
  snippet: nullable(textField({ label: "Snippet" })),
  participants: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  lastMessageAt: nullable(dateField({ label: "Date" })),
  messageCount: intField({ label: "Messages" }),
  unread: boolField({ label: "Unread" }),
  starred: boolField({ label: "Starred" }),
  important: boolField({ label: "Important" }),
  hasAttachments: boolField({ label: "Attachment" }),
  labelIds: jsonField<string[]>({ schema: z.array(z.string()), default: [] }),
  historyId: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const mailMessageFields = {
  id: externalIdField({
    reason:
      "Gmail's own message id — the local mirror is keyed by the id the Gmail API returns.",
  }),
  threadId: textField({ label: "Thread" }),
  accountId: idKindField(mailAccountIdKind),
  from: jsonField<z.infer<typeof MailAddressSchema>>({
    schema: MailAddressSchema,
    default: { email: "" },
  }),
  to: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  cc: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  bcc: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  replyTo: nullable(
    jsonField<z.infer<typeof MailAddressSchema>[]>({
      schema: z.array(MailAddressSchema),
      default: [],
    }),
  ),
  subject: nullable(textField()),
  snippet: nullable(textField()),
  headers: jsonField<Record<string, string>>({
    schema: z.record(z.string(), z.string()),
    default: {},
  }),
  bodyText: nullable(textField()),
  bodyHtml: nullable(textField()),
  // On-demand hydration marker. Null = envelope-only stub (synced via Gmail
  // `format=metadata` during the bounded backfill/delta — no body fetched yet);
  // set = the full MIME body + attachments were fetched on first open and cached.
  // Legacy rows from the pre-on-demand full backfill carry a body but a null
  // marker; `isMessageHydrated` treats a present body as hydrated too.
  bodyFetchedAt: nullable(dateField()),
  internalDate: nullable(dateField()),
  unread: boolField(),
  starred: boolField(),
  isDraft: boolField(),
  isSent: boolField(),
  hasAttachments: boolField(),
  sizeEstimate: nullable(intField()),
  historyId: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const mailMessageLabelFields = {
  messageId: textField(),
  labelId: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

export const mailAttachmentFields = {
  id: idKindField(mailAttachmentIdKind),
  messageId: textField(),
  accountId: idKindField(mailAccountIdKind),
  gmailAttachmentId: textField(),
  filename: textField(),
  mimeType: textField(),
  sizeBytes: intField(),
  inline: boolField(),
  contentId: nullable(textField()),
  storedAttachmentId: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const mailDraftFields = {
  id: idKindField(mailDraftIdKind),
  accountId: idKindField(mailAccountIdKind),
  threadId: nullable(textField()),
  gmailDraftId: nullable(textField()),
  inReplyToMessageId: nullable(textField()),
  to: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  cc: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  bcc: jsonField<z.infer<typeof MailAddressSchema>[]>({
    schema: z.array(MailAddressSchema),
    default: [],
  }),
  subject: nullable(textField()),
  bodyHtml: nullable(textField()),
  bodyText: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const mailOutboxFields = {
  id: idKindField(mailOutboxIdKind),
  accountId: idKindField(mailAccountIdKind),
  opType: enumTextField(MAIL_OUTBOX_OP_TYPES),
  targetType: textField(),
  targetId: textField(),
  payload: jsonField<Record<string, unknown>>({
    schema: z.record(z.string(), z.unknown()),
    default: {},
  }),
  status: enumTextField(MAIL_OUTBOX_STATUSES),
  attempts: intField(),
  lastError: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

// Public wire schemas, derived from the field records. `entity.table.$inferSelect`
// is identical by construction to `z.infer` of these (Stage E invariant).
export const MailAccountSchema = fieldsToZodObject(mailAccountFields);
export const MailSyncStateSchema = fieldsToZodObject(mailSyncStateFields);
export const MailLabelSchema = fieldsToZodObject(mailLabelFields);
export const MailThreadSchema = fieldsToZodObject(mailThreadFields);

/** The `mail_threads` entity, as browser code names it (`defineEntity(mailThreadsEntityRef, …)`). */
export const mailThreadsEntityRef = entityRef("mail_threads", mailThreadFields);
export const MailMessageSchema = fieldsToZodObject(mailMessageFields);
export const MailMessageLabelSchema = fieldsToZodObject(mailMessageLabelFields);
export const MailAttachmentSchema = fieldsToZodObject(mailAttachmentFields);
export const MailDraftSchema = fieldsToZodObject(mailDraftFields);
export const MailOutboxItemSchema = fieldsToZodObject(mailOutboxFields);

// A lean label projection for chips: id + display name + Gmail colors (the
// subset a label chip renders), so search/list rows never ship the full label
// row. `color`/`textColor` are Gmail's own hex values, applied inline on the
// chip; both null → a neutral chip.
export const MailLabelRefSchema = MailLabelSchema.pick({
  id: true,
  name: true,
  color: true,
  textColor: true,
});
export type MailLabelRef = z.infer<typeof MailLabelRefSchema>;

/** The `mail_accounts` entity. */
export const mailAccountsEntityRef = entityRef(
  "mail_accounts",
  mailAccountFields,
);

/** The `mail_sync_state` entity. */
export const mailSyncStateEntityRef = entityRef(
  "mail_sync_state",
  mailSyncStateFields,
);

/** The `mail_labels` entity. */
export const mailLabelsEntityRef = entityRef("mail_labels", mailLabelFields);

/** The `mail_messages` entity. */
export const mailMessagesEntityRef = entityRef(
  "mail_messages",
  mailMessageFields,
);

/** The `mail_message_labels` entity. */
export const mailMessageLabelsEntityRef = entityRef(
  "mail_message_labels",
  mailMessageLabelFields,
);

/** The `mail_attachments` entity. */
export const mailAttachmentsEntityRef = entityRef(
  "mail_attachments",
  mailAttachmentFields,
);

/** The `mail_drafts` entity. */
export const mailDraftsEntityRef = entityRef("mail_drafts", mailDraftFields);

/** The `mail_outbox` entity. */
export const mailOutboxEntityRef = entityRef("mail_outbox", mailOutboxFields);
