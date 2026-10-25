import { z } from "zod";
import { AUDIENCES, type Audience } from "@plugins/audience/core";
import { NOTIFICATION_VARIANTS } from "../core";

export const NotificationVariantSchema = z.enum(NOTIFICATION_VARIANTS);
export type NotificationVariant = z.infer<typeof NotificationVariantSchema>;

/**
 * How many undismissed notifications count as unread (`countedUnread`), split
 * by variant because the badge is red only while an error is among them.
 */
export const UnreadCountsSchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});
export type UnreadCounts = z.infer<typeof UnreadCountsSchema>;

/**
 * The bell's badge: the unread counts of what reaches each audience, so the
 * badge never counts a notification the bell hides (`audience-scope.ts`).
 * Keyed by every {@link Audience}: one value, picked by the reader's audience.
 */
export const NotificationsUnreadSchema = z.object(
  Object.fromEntries(AUDIENCES.map((a) => [a, UnreadCountsSchema])) as Record<
    Audience,
    typeof UnreadCountsSchema
  >,
);
export type NotificationsUnread = z.infer<typeof NotificationsUnreadSchema>;
