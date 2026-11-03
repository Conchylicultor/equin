import type { FieldsRecord } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";

// An attachment row's fields, in column order — the `attachments` table is
// built from them (`server/internal/tables.ts`). `diskPath` is where the
// bytes live on this machine: on the ref because the one read that hands it
// out (`attachments.file`) follows a collection over it; every listing
// (`AttachmentSchema`) leaves it out.
export const attachmentFields = {
  id: textField(),
  filename: textField(),
  mime: textField(),
  size: intField(),
  diskPath: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The `attachments` entity. */
export const attachmentsEntityRef = entityRef("attachments", attachmentFields);

/**
 * An attachment link's fields — one row per (owner, attachment) pair of a
 * `<owner>_attachments` table. Each owner declares its link entity with them
 * in its own `core/` (`entityRef("tasks_attachments", attachmentLinkFields)`)
 * and hands the ref to `Attachments.defineLink`, which builds the table.
 */
export const attachmentLinkFields = {
  ownerId: textField(),
  attachmentId: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;
