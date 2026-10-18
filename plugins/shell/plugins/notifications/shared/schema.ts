import { z } from "zod";
import { NOTIFICATION_VARIANTS } from "../core";

export const NotificationVariantSchema = z.enum(NOTIFICATION_VARIANTS);
export type NotificationVariant = z.infer<typeof NotificationVariantSchema>;

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
