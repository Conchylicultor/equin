import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchRow, patchWhere } from "@plugins/network/plugins/live/core";
import { and } from "@plugins/network/plugins/live/plugins/filter/core";
import { AUDIENCES } from "@plugins/audience/core";
import { NotificationVariantSchema } from "./schema";
import {
  NOTIFICATION_CATEGORIES,
  NotificationActionSchema,
  NotificationIconSchema,
  notificationIdKind,
  notificationsEntityRef,
} from "../core";

export const createNotification = defineEndpoint({
  route: "POST /api/notifications",
  unpredicted: {
    reason: "server-decided",
    why: "The toast is already on screen; the server collapses a repeat of its dedupeKey onto the existing row (bumping count) and stamps the times, so whether a row is added is not the request's to decide.",
  },
  body: z.object({
    id: notificationIdKind.schema,
    type: z.string(),
    title: z.string(),
    description: z.string(),
    variant: NotificationVariantSchema,
    linkTo: z.string().nullable().optional(),
    category: z.enum(NOTIFICATION_CATEGORIES),
    subjectId: z.string().nullable().optional(),
    subjectName: z.string().nullable().optional(),
    detail: z.string().nullable().optional(),
    action: NotificationActionSchema.nullable().optional(),
    icon: NotificationIconSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    dedupeKey: z.string().nullable().optional(),
    audience: z.enum(AUDIENCES).optional(),
  }),
  response: z.object({ id: z.string() }),
  // Persisting a browser toast is the desktop's bell (D4,
  // research/2026-10-22-global-demo-scope-sealed.md): on a host without the
  // computer (the demo) `useToast` keeps the toast ephemeral.
  needsMachine: { feature: "Saving notifications" },
});

/** Dismiss every undismissed notification: every held row reads dismissed at once. */
export const dismissAllNotifications = defineEndpoint({
  route: "POST /api/notifications/dismiss-all",
  effect: (on) =>
    patchWhere(
      on,
      notificationsEntityRef,
      () => ({ column: "dismissed", op: "eq", operand: false }),
      () => ({ dismissed: true }),
    ),
});

/** Mark every undismissed, unread notification read; the unread count arrives by push. */
export const markAllNotificationsRead = defineEndpoint({
  route: "POST /api/notifications/mark-all-read",
  effect: (on) =>
    patchWhere(
      on,
      notificationsEntityRef,
      () =>
        and(
          { column: "dismissed", op: "eq", operand: false },
          { column: "read", op: "eq", operand: false },
        ),
      () => ({ read: true }),
    ),
});

/**
 * Dismiss one notification. Predicted: the row reads dismissed at once, which
 * is a membership exit of the bell and the pane (`dismissed = false`); the
 * unread count arrives by push.
 */
export const dismissNotification = defineEndpoint({
  route: "POST /api/notifications/:id/dismiss",
  effect: (on) =>
    patchRow(
      on,
      notificationsEntityRef,
      ({ params }) => params.id,
      () => ({ set: { dismissed: true } }),
    ),
});
