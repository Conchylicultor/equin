import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";

export const NotificationVariantSchema = z.enum([
  "error",
  "warning",
  "info",
  "success",
]);
export type NotificationVariant = z.infer<typeof NotificationVariantSchema>;

// The fields a notification list filters, groups or searches by (see
// `countedUnreadFilterable` for the unread predicate's three); the rest ride the
// row.
export const NOTIFICATION_LISTED = {
  type: textField({ label: "Type" }),
  title: textField({ label: "Title" }),
  variant: enumTextField(NotificationVariantSchema.options, {
    label: "Variant",
  }),
  read: boolField({ label: "Read" }),
  muted: boolField({ label: "Muted" }),
};
export const NOTIFICATION_CARRIED = {
  id: textField(),
  description: textField(),
  dismissed: boolField(),
  linkTo: nullable(textField()),
  metadata: nullable(jsonField({ schema: z.record(z.unknown()), default: {} })),
  count: floatField(),
  lastSeenAt: dateField(),
  createdAt: dateField(),
};
export const NotificationSchema = fieldsToZodObject({
  ...NOTIFICATION_CARRIED,
  ...NOTIFICATION_LISTED,
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * The bell's badge: how many undismissed notifications count as unread
 * (`countedUnread`), split by variant because the badge is red only while an
 * error is among them.
 */
export const NotificationsUnreadSchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});
export type NotificationsUnread = z.infer<typeof NotificationsUnreadSchema>;
