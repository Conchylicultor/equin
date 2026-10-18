import { z } from "zod";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { notificationIdKind } from "./id-kind";

/** A notification's severity — its colour, and whether it counts as an error. */
export const NOTIFICATION_VARIANTS = [
  "error",
  "warning",
  "info",
  "success",
] as const;

/**
 * A notification's fields, in column order — the `notifications` table is
 * built from them (`server/internal/tables.ts`), plus `dedupKey`, its server
 * field (never on the wire).
 */
export const notificationFields = {
  id: idKindField(notificationIdKind),
  type: textField({ label: "Type" }),
  title: textField({ label: "Title", primary: true }),
  description: textField({ label: "Description" }),
  variant: enumTextField(NOTIFICATION_VARIANTS, { label: "Variant" }),
  dismissed: boolField({ label: "Dismissed" }),
  // The pane's sections read Unread first, not the bool's Yes / No.
  read: boolField({
    label: "Read",
    optionMeta: { false: { label: "Unread" }, true: { label: "Read" } },
  }),
  muted: boolField({ label: "Muted" }),
  linkTo: nullable(textField({ label: "Link" })),
  /**
   * A free-form bag every producer stamps its own keys into (the reports
   * engine writes `reportId`, `source`, `fingerprint`, …; most callers write
   * nothing). `z.record` is the honest schema for that: it verifies the value
   * really IS a non-null object and keeps every key, so no producer's keys are
   * normalized away.
   */
  metadata: nullable(
    jsonField({ schema: z.record(z.string(), z.unknown()), default: {} }),
  ),
  /**
   * Occurrences collapsed onto this row via the dedup key (1 on first insert,
   * bumped on every dedup hit). Lets a deduped/re-surfacing notification read
   * as "happened N times" instead of spawning N rows. See record-notification.
   */
  count: intField({ label: "Count" }),
  /**
   * Wall-clock of the most recent occurrence (every dedup hit refreshes it),
   * distinct from createdAt which marks when the row last *surfaced*. Drives
   * the "last seen 2m ago" display and the quiet-notification TTL sweep.
   */
  lastSeenAt: dateField({ label: "Last seen" }),
  // The pane sorts by it, newest first, but never filters by it.
  createdAt: dateField({ label: "Surfaced", filterable: false }),
} satisfies FieldsRecord;

/** The `notifications` entity — every notification the bell has raised. */
export const notificationsEntityRef = entityRef(
  "notifications",
  notificationFields,
);
