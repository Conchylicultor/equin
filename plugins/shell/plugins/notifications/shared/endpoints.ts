import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { NotificationVariantSchema } from "./schema";
import { notificationIdKind } from "../core";

export const createNotification = defineEndpoint({
  route: "POST /api/notifications",
  body: z.object({
    id: notificationIdKind.schema,
    type: z.string(),
    title: z.string(),
    description: z.string(),
    variant: NotificationVariantSchema,
    linkTo: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    dedupeKey: z.string().nullable().optional(),
  }),
  response: z.object({ id: z.string() }),
  // Persisting a browser toast is the desktop's bell (D4,
  // research/2026-10-22-global-demo-scope-sealed.md): on a host without the
  // computer (the demo) `useToast` keeps the toast ephemeral.
  needsMachine: { feature: "Saving notifications" },
});

export const dismissAllNotifications = defineEndpoint({
  route: "POST /api/notifications/dismiss-all",
});

export const markAllNotificationsRead = defineEndpoint({
  route: "POST /api/notifications/mark-all-read",
});

export const dismissNotification = defineEndpoint({
  route: "POST /api/notifications/:id/dismiss",
});
