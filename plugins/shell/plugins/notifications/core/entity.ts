import { z } from "zod";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";
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
import { AUDIENCES } from "@plugins/audience/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { symbol, type SymbolRef } from "@plugins/ui/plugins/icons/core";
import { notificationIdKind } from "./id-kind";

/** A notification's severity — its colour, and whether it counts as an error. */
export const NOTIFICATION_VARIANTS = [
  "error",
  "warning",
  "info",
  "success",
] as const;

/**
 * What a notification is about, in the user's words — the bell's chips. A
 * closed list both runtimes read (the column's values, the chip labels).
 */
export const NOTIFICATION_CATEGORIES = [
  "conversations",
  "updates",
  "automations",
  "reports",
  "other",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Each category's chip label. */
export const NOTIFICATION_CATEGORY_LABELS = {
  conversations: "Conversations",
  updates: "Updates",
  automations: "Automations",
  reports: "Reports",
  other: "Other",
} as const satisfies Record<NotificationCategory, string>;

/**
 * The one thing a notification offers to do: a `kind` resolved in the browser
 * through the `Notifications.Action` registry (`open`, `reload`, …), and that
 * kind's own payload (`open`: `{ to }`). An unknown kind is an error where it
 * renders, never a silently missing button.
 */
export const NotificationActionSchema = z.object({
  kind: z.string().min(1),
  payload: wholeRecord(z.unknown(), {
    reason: "the few named values one action kind reads",
  }),
});
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

/**
 * A notification's own glyph, set by its producer: the `SymbolRef` it wrote
 * with `symbol("…")` — a tsc-checked literal the icon manifest collected, so
 * the sprites carry it. The check here is the shape; the name was checked
 * where it was written.
 */
export const NotificationIconSchema: ZodParser<SymbolRef> = z.custom<SymbolRef>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "symbol" &&
    typeof (v as { name?: unknown }).name === "string",
  "expected a symbol icon ref",
);

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
  /**
   * Who the notification is for, declared by its producer (the reports engine
   * writes `developer`; everything else is for everyone). The bell shows a
   * user only what reaches them (`shared/audience-scope.ts`).
   */
  audience: enumTextField(AUDIENCES, { label: "Audience" }),
  linkTo: nullable(textField({ label: "Link" })),
  /**
   * What it is about (a `conv-…` / `task-…` id) and that subject's name AS
   * SHOWN WHEN SENT — a snapshot, so the bell shows exactly what the toast
   * showed. The name is the view's second line.
   */
  subjectId: nullable(textField({ label: "Subject" })),
  subjectName: nullable(textField({ label: "Subject name" })),
  /**
   * Developer-only internals (build id, exit code, HTTP status, raw error):
   * rendered only for a reader in Developer mode.
   */
  detail: nullable(textField({ label: "Detail" })),
  /**
   * The event's own glyph (`symbol("forum")`), set by its producer; without
   * one the view draws the variant's (error / warning) or the category's.
   * An error or warning keeps its red / amber tint either way.
   */
  icon: nullable(
    jsonField<SymbolRef>({
      schema: NotificationIconSchema,
      default: symbol("notifications"),
    }),
  ),
  /** The one action, resolved through the `Notifications.Action` registry. */
  action: nullable(
    jsonField({
      schema: NotificationActionSchema,
      default: { kind: "open", payload: {} },
    }),
  ),
  /** What it is about, in the user's words — the bell's chips. */
  category: enumTextField(NOTIFICATION_CATEGORIES, {
    label: "Category",
    default: "other",
    options: {
      conversations: { label: NOTIFICATION_CATEGORY_LABELS.conversations },
      updates: { label: NOTIFICATION_CATEGORY_LABELS.updates },
      automations: { label: NOTIFICATION_CATEGORY_LABELS.automations },
      reports: { label: NOTIFICATION_CATEGORY_LABELS.reports },
      other: { label: NOTIFICATION_CATEGORY_LABELS.other },
    },
  }),
  /**
   * A free-form bag every producer stamps its own keys into (the reports
   * engine writes `reportId`, `source`, `fingerprint`, …; most callers write
   * nothing). `z.record` is the honest schema for that: it verifies the value
   * really IS a non-null object and keeps every key, so no producer's keys are
   * normalized away.
   */
  metadata: nullable(
    jsonField({
      schema: wholeRecord(z.unknown(), {
        reason: "the few named values its writer attached to one notification",
      }),
      default: {},
    }),
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
