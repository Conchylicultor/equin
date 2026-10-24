# Persistent Notifications Plugin

## Context

Crashes and errors currently surface as ephemeral sonner toasts that vanish after a few seconds — no history, no persistence, nothing when the browser was closed. Server-side crashes (process hooks, background jobs) may not surface at all if no frontend is connected. The goal is a DB-backed notification store with a bell button in the toolbar, so notifications persist until explicitly dismissed and background events are visible when the user returns. This unlocks production-grade monitoring: toast history, persistent crash alerts, and a unified notification surface for future producers (build failures, deploy events, etc.).

## Design

New top-level plugin `plugins/notifications/` with server (DB table + resource + HTTP endpoints) and web (bell toolbar button with popover). Any server-side plugin can call `recordNotification()` to create a persistent notification. The web component detects new arrivals via the live-state WS push and auto-fires a sonner toast, so the user still gets the ephemeral pop in addition to the persistent record.

### Folder Structure

```
plugins/notifications/
├── package.json
├── shared/
│   ├── schema.ts        # Zod schema + Notification type (shared by server + web)
│   └── resources.ts     # resourceDescriptor for useResource on the web
├── server/
│   ├── index.ts          # ServerPluginDefinition + public barrel
│   └── internal/
│       ├── tables.ts            # pgTable("notifications", ...)
│       ├── resources.ts         # defineResource (push mode)
│       ├── record-notification.ts  # insert + notify
│       ├── handle-dismiss.ts       # POST /api/notifications/:id/dismiss
│       ├── handle-dismiss-all.ts   # POST /api/notifications/dismiss-all
│       └── handle-mark-read.ts     # POST /api/notifications/mark-all-read
└── web/
    ├── index.ts              # PluginDefinition + Shell.Toolbar contribution
    └── components/
        └── bell-button.tsx   # Popover with notification list + toast bridging
```

## Implementation Steps

### 1. `plugins/notifications/package.json`

```json
{ "name": "@singularity/plugin-notifications", "private": true, "version": "0.0.1" }
```

### 2. `plugins/notifications/shared/schema.ts`

Zod schema defined in shared so both server and web can import it. Follows the `conversation-progress/shared/schemas.ts` pattern.

```ts
import { z } from "zod";

export const NotificationVariantSchema = z.enum(["error", "warning", "info", "success"]);
export type NotificationVariant = z.infer<typeof NotificationVariantSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  variant: NotificationVariantSchema,
  dismissed: z.boolean(),
  read: z.boolean(),
  linkTo: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
});
export type Notification = z.infer<typeof NotificationSchema>;
```

### 3. `plugins/notifications/shared/resources.ts`

```ts
import { z } from "zod";
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/shared";
import { NotificationSchema } from "./schema";

export const notificationsResource = resourceDescriptor<...>("notifications", z.array(NotificationSchema));
```

### 4. `plugins/notifications/server/internal/tables.ts`

Drizzle pgTable. Discovered automatically by `drizzle.config.ts` glob.

```ts
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const _notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  variant: text("variant").notNull(),
  dismissed: boolean("dismissed").notNull().default(false),
  read: boolean("read").notNull().default(false),
  linkTo: text("link_to"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("notifications_dismissed_idx").on(t.dismissed),
  index("notifications_created_at_idx").on(t.createdAt),
]);
```

### 5. `plugins/notifications/server/internal/resources.ts`

Push-mode resource. Loader returns non-dismissed notifications, newest first.

```ts
export const notificationsResource = defineResource({
  key: "notifications",
  mode: "push",
  schema: z.array(NotificationSchema),
  loader: async () =>
    db.select().from(_notifications)
      .where(eq(_notifications.dismissed, false))
      .orderBy(desc(_notifications.createdAt)),
});
```

### 6. `plugins/notifications/server/internal/record-notification.ts`

Public API for producers. Insert row + notify resource.

```ts
export interface RecordNotificationInput {
  type: string;
  title: string;
  description: string;
  variant: "error" | "warning" | "info" | "success";
  linkTo?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordNotification(input: RecordNotificationInput): Promise<string> {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(_notifications).values({ id, ...input, linkTo: input.linkTo ?? null, metadata: input.metadata ?? null });
  notificationsResource.notify();
  return id;
}
```

### 7. HTTP handlers

Three handlers following the `crashes/handle-report.ts` pattern (`HttpHandler` = `(req, params) => Response`):

- **`handle-dismiss.ts`**: `POST /api/notifications/:id/dismiss` — sets `dismissed = true` on the row, calls `notify()`
- **`handle-dismiss-all.ts`**: `POST /api/notifications/dismiss-all` — sets `dismissed = true` on all non-dismissed rows, calls `notify()`
- **`handle-mark-read.ts`**: `POST /api/notifications/mark-all-read` — sets `read = true` on all non-dismissed, non-read rows, calls `notify()`

### 8. `plugins/notifications/server/index.ts`

Server barrel: default export is `ServerPluginDefinition`, named exports are the public API.

```ts
export { _notifications } from "./internal/tables";
export { notificationsResource } from "./internal/resources";
export { recordNotification } from "./internal/record-notification";
export type { RecordNotificationInput } from "./internal/record-notification";

export default {
  id: "notifications",
  name: "Notifications",
  description: "Persistent bell-button notifications backed by the DB.",
  resources: [notificationsResource],
  httpRoutes: {
    "POST /api/notifications/dismiss-all": handleDismissAll,
    "POST /api/notifications/mark-all-read": handleMarkAllRead,
    "POST /api/notifications/:id/dismiss": handleDismiss,
  },
} satisfies ServerPluginDefinition;
```

### 9. `plugins/notifications/web/components/bell-button.tsx`

Toolbar component with:
- `useResource(notificationsResource)` for live data
- Unread badge count (non-read items)
- Popover with notification list: each row shows variant-colored left border, title, description (line-clamped), `<RelativeTime>`, dismiss × button
- Header with "Mark all read" and "Clear all" actions
- **Toast bridging**: a `useRef<Set<string> | null>(null)` tracks known IDs. On first data arrival, initializes without firing toasts (avoids spamming on page load). On subsequent updates, new IDs fire `ShellCommands.Toast`. Mark all as read when the popover opens.

Key imports:
- `Popover, PopoverTrigger, PopoverContent` from `@/components/ui/popover`
- `MdNotifications, MdNotificationsNone` from `react-icons/md`
- `RelativeTime` from `@plugins/primitives/plugins/relative-time/web`
- `useResource` from `@plugins/primitives/plugins/live-state/web`
- `ShellCommands` from `@plugins/shell/web`

### 10. `plugins/notifications/web/index.ts`

```ts
export default {
  id: "notifications",
  name: "Notifications",
  description: "Persistent bell-button notifications backed by the DB.",
  contributions: [
    Shell.Toolbar({ id: "notifications", component: BellButton, group: "actions" }),
  ],
} satisfies PluginDefinition;
```

### 11. Crash integration — modify `plugins/crashes/server/internal/record-crash.ts`

Add import at top:
```ts
import { recordNotification } from "@plugins/notifications/server";
```

After `crashesResource.notify()` in the non-crash-loop path (~line 69), add:
```ts
void recordNotification({
  type: "crash",
  title: "Crash recorded",
  description: row.errorType ? `${row.errorType}: ${row.message}` : row.message,
  variant: "error",
  linkTo: outcome.taskId,
  metadata: { crashId: row.id, taskId: outcome.taskId, source: row.source, fingerprint: row.fingerprint },
}).catch(() => {});
```

Fire-and-forget (`void` + `.catch`): notification failure must never break crash recording.

### 12. Remove crash toast from `plugins/crashes/web/components/crash-reporter.tsx`

Remove the `ShellCommands.Toast(...)` call from the `announce` callback. The notification system's toast bridging in `BellButton` now handles this — otherwise the user gets a double toast for every crash.

## Critical Files

**Create:**
- `plugins/notifications/package.json`
- `plugins/notifications/shared/schema.ts`
- `plugins/notifications/shared/resources.ts`
- `plugins/notifications/server/internal/tables.ts`
- `plugins/notifications/server/internal/resources.ts`
- `plugins/notifications/server/internal/record-notification.ts`
- `plugins/notifications/server/internal/handle-dismiss.ts`
- `plugins/notifications/server/internal/handle-dismiss-all.ts`
- `plugins/notifications/server/internal/handle-mark-read.ts`
- `plugins/notifications/server/index.ts`
- `plugins/notifications/web/components/bell-button.tsx`
- `plugins/notifications/web/index.ts`

**Modify:**
- `plugins/crashes/server/internal/record-crash.ts` — add `recordNotification` call
- `plugins/crashes/web/components/crash-reporter.tsx` — remove direct toast call

## Reuse

- `defineResource` from `@server/resources` — same push-mode pattern as `crashesResource`
- `resourceDescriptor` from `@plugins/primitives/plugins/live-state/shared` — client-side resource descriptor
- `useResource` from `@plugins/primitives/plugins/live-state/web` — live-state hook
- `ShellCommands.Toast` from `@plugins/shell/web` — toast bridging dispatch
- `RelativeTime` from `@plugins/primitives/plugins/relative-time/web` — time display
- `Popover*` from `@/components/ui/popover` — popover primitives
- `Shell.Toolbar` from `@plugins/shell/web` — toolbar slot contribution

## Verification

1. `./equin build` succeeds (generates migration, registers plugin)
2. App loads at `http://<worktree>.localhost:9000` — bell icon visible in toolbar
3. Bell popover opens — shows "No notifications" on fresh DB
4. Trigger a crash (e.g. throw in a plugin render) — bell badge shows 1, popover lists it, sonner toast fires once (not twice)
5. Click dismiss on the notification — badge disappears, popover shows empty
6. Trigger two crashes — "Clear all" dismisses both
7. `./equin check` passes (no plugin boundary violations, no cycles)
