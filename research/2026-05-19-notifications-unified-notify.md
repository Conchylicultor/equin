# Unified Notification System

## Context

Two independent systems surface messages to the user:

1. **Shell.Toast** — client-only ephemeral toasts via sonner (82 call sites, 25 plugins). Fire-and-forget, no persistence, no history.
2. **recordNotification** — server-only DB-backed notifications (1 consumer: crashes). Pushes to the bell button via live-state. The bell already auto-toasts new notifications via `ShellCommands.Toast`.

The goal is to **unify them**: every user-facing message persists as a notification AND shows a toast. The bell UI gets filtering to handle increased volume. `toast()` becomes the single public API.

## Design

### Core: `toast()` — a plain function

A new `toast()` function in `@plugins/notifications/web` replaces `Shell.Toast` as the public API. It is a **plain function** (not a hook), callable from any context — components, callbacks, module-level helpers.

```ts
function toast(args: ToastArgs): void {
  // 1. Show sonner toast immediately (via Shell.Toast internally)
  // 2. POST to /api/notifications to persist (fire-and-forget)
}
```

This gives instant visual feedback + async persistence in one call.

### Dedup: no double-toast

When `toast()` fires client-side, it shows a toast AND persists. The bell receives the push and would normally auto-toast — causing a double-toast. Fix: `toast()` generates the notification ID client-side and adds it to a module-level `Set<string>`. The bell checks this set before auto-toasting. IDs auto-expire after 30s (just need to survive the round-trip).

Server-originated notifications (crashes) are NOT in the set, so the bell still auto-toasts those.

### Implicit error paths also migrate

The toaster's two catch-all paths — `unhandledrejection` and React Query mutation cache errors — also use `toast()` instead of calling sonner directly. This means even unexpected errors get persisted, giving the user a full history.

### Shell.Toast becomes internal

`Shell.Toast` continues to exist but is no longer the public API. Used internally by:
- `toast()` for instant toast display
- The bell's auto-toast for server-originated notifications

### The `type` field

Every notification requires a `type` string for bell filtering. Types derived from the 82 call sites:

| Type | Examples |
|---|---|
| `build` | Build succeeded/failed, auto-build triggered |
| `clipboard` | Copied to clipboard |
| `conversation` | Closed, resumed, branched, pushed, forked |
| `task` | Created, dropped, held, auto-started |
| `summary` | Summary ready, timed out |
| `crash` | Crash recorded (existing) |
| `db` | DB fork failed |
| `auth` | Connected, disconnected, failed |
| `screenshot` | Capture failed |
| `settings` | Settings errors |
| `debug` | Debug tool operations |
| `health` | Server reconnected |
| `error` | Unhandled rejections, mutation errors (toaster catch-all) |

## `ToastArgs` interface

```ts
interface ToastArgs {
  type: string;                              // required — bell filter key
  description: string;                       // required — main text
  title?: string;                            // optional header
  variant?: "error" | "warning" | "info" | "success"; // default "info"
  linkTo?: string;                           // optional SPA route
  metadata?: Record<string, unknown>;        // optional extra context
}
```

## Implementation

### Phase 1 — Server: `createNotification` endpoint

Expose `recordNotification` to the client via a typed endpoint.

**`plugins/notifications/shared/endpoints.ts`** — Add:
```ts
export const createNotification = defineEndpoint({
  route: "POST /api/notifications",
  body: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    description: z.string(),
    variant: NotificationVariantSchema,
    linkTo: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  }),
  response: z.object({ id: z.string() }),
});
```

**`plugins/notifications/server/internal/handle-create.ts`** — New handler: inserts with client-provided ID, calls `notificationsResource.notify()`, returns `{ id }`.

**`plugins/notifications/server/index.ts`** — Register route: `[createNotification.route]: handleCreate`.

### Phase 2 — Client: `toast()` function

**`plugins/notifications/web/internal/toast.ts`** — New file:
```ts
import { ShellCommands } from "@plugins/shell/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { createNotification } from "../../shared/endpoints";

export const recentClientIds = new Set<string>();

export function toast(args: ToastArgs): void {
  const variant = args.variant ?? "info";

  // Instant visual feedback
  ShellCommands.Toast({ title: args.title, description: args.description, variant });

  // Persist (fire-and-forget — rejection surfaces via global unhandledrejection handler)
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  recentClientIds.add(id);
  setTimeout(() => recentClientIds.delete(id), 30_000);

  void fetchEndpoint(createNotification, {}, {
    body: {
      id,
      type: args.type,
      title: args.title ?? args.description,
      description: args.description,
      variant,
      linkTo: args.linkTo ?? null,
      metadata: args.metadata ?? null,
    },
  });
}
```

**`plugins/notifications/web/index.ts`** — Add named exports:
```ts
export { toast, type ToastArgs } from "./internal/toast";
```

### Phase 3 — Bell dedup

**`plugins/notifications/web/components/bell-button.tsx`** — In the auto-toast `useEffect`, skip IDs in `recentClientIds`:

```ts
import { recentClientIds } from "../internal/toast";

// In the useEffect:
for (const n of data) {
  if (!prevIdsRef.current.has(n.id) && !recentClientIds.has(n.id)) {
    ShellCommands.Toast({ title: n.title, description: n.description, variant: n.variant });
  }
}
```

### Phase 4 — Bell UI: type filtering

**`plugins/notifications/web/components/bell-button.tsx`** — Enhance the popover:

1. Add filter state: `const [typeFilter, setTypeFilter] = useState<string>("all")`
2. Add a chip row at top of popover using `FilterChip` from `@plugins/primitives/plugins/filter-chips/web`:
   - Dynamic chips: "All", "Errors" (cross-type, `variant === "error"`), then one chip per `type` present in the list
   - Only show chips for types that have at least one notification
3. Filter: `list.filter(n => typeFilter === "all" || (typeFilter === "errors" ? n.variant === "error" : n.type === typeFilter))`
4. Add a type label on each notification item (small muted text showing `n.type`)
5. Badge count stays on ALL unread (unfiltered)

### Phase 5 — TTL cleanup

**`plugins/notifications/server/internal/ttl-cleanup.ts`** — New job via `defineJob`:
- Hard-delete dismissed notifications older than 7 days
- Auto-dismiss `info`/`success` notifications older than 24 hours
- Call `notificationsResource.notify()` after cleanup

**`plugins/notifications/server/index.ts`** — Register and schedule the job on server start.

### Phase 6 — Migrate ALL call sites

82 calls across ~32 files. Every single `Shell.Toast` call migrates — no exceptions.

For each:
1. Replace `import { ShellCommands as Shell } from "@plugins/shell/web"` with `import { toast } from "@plugins/notifications/web"`
2. Replace `Shell.Toast({ description, variant, title })` with `toast({ type, description, variant, title })`
3. Add `linkTo` where a natural navigation target exists

**Migration by plugin group:**

| Group | Files | Calls | Type |
|---|---|---|---|
| `build/` | 3 files | ~6 | `build`, `clipboard` |
| `conversations/.../push-and-exit` | 1 file | ~9 | `conversation` |
| `conversations/.../exit,hold,drop,resume,branch` | 5 files | ~9 | `conversation` |
| `conversations/.../prompt-input,templates,launch` | 4 files | ~5 | `conversation` |
| `conversations/.../fork-error-watcher` | 1 file | 1 | `db` |
| `conversations/.../auto-launch-watcher` | 1 file | 1 | `task` |
| `conversations/.../summary-pane` | 1 file | 3 | `summary` |
| `conversations/.../category,dependencies` | 2 files | 4 | `category`, `dependency` |
| `tasks/.../task-draft-popover` | 1 file | 3 | `task` |
| `tasks/.../task-attachments` | 1 file | 1 | `task` |
| `auth/web/` | 2 files | ~8 | `auth` |
| `screenshot/` | 2 files | ~5 | `screenshot` |
| `review/` + settings helpers | 3 files | 3 | `settings` |
| `health/web/reconnect-watcher` | 1 file | 1 | `health` |
| `events-test/web/` | 1 file | ~11 | `debug` |
| `debug/plugins/queue/web/` | 1 file | ~4 | `debug` |

**Edge cases:**
- Files with a local `toastError(title, err)` helper (3 files: `launch-prompts-settings.tsx`, `prompt-templates-settings.tsx`, `review-sections-settings.tsx`): replace the helper body to call `toast()`.
- Files that import `Shell`/`ShellCommands` for both Toast and slots: keep the slot import, remove the Toast usage.
- `push-and-exit-button.tsx` (9 Toast calls): all get `type: "conversation"`.

### Phase 6b — Migrate toaster implicit paths

**`plugins/shell/plugins/toaster/web/components/toaster-root.tsx`** — The two catch-all paths switch from calling sonner directly to calling `toast()`:

- `unhandledrejection` handler: `toast({ type: "error", description: message, variant: "error" })` instead of `toast.error(message)`
- React Query mutation cache subscriber: `toast({ type: "error", description: getEndpointErrorMessage(error), variant: "error" })` instead of `toast.error(...)`

This means the toaster imports `toast` from `@plugins/notifications/web`.

## Key files

| File | Change |
|---|---|
| `plugins/notifications/shared/endpoints.ts` | Add `createNotification` endpoint |
| `plugins/notifications/server/internal/handle-create.ts` | New: endpoint handler |
| `plugins/notifications/server/index.ts` | Register route + TTL job |
| `plugins/notifications/web/internal/toast.ts` | New: `toast()` function |
| `plugins/notifications/web/index.ts` | Export `toast`, `ToastArgs` |
| `plugins/notifications/web/components/bell-button.tsx` | Dedup + filter UI |
| `plugins/notifications/server/internal/ttl-cleanup.ts` | New: TTL cleanup job |
| `plugins/shell/plugins/toaster/web/components/toaster-root.tsx` | Migrate implicit paths to `toast()` |
| ~35 plugin files | Migrate `Shell.Toast` → `toast()` |

## Verification

1. `./equin build` — no TS errors, no import cycles
2. Trigger a toast (e.g. copy logs) — verify toast appears immediately AND notification appears in bell (no double-toast)
3. Trigger a server-originated notification (crash) — verify toast appears via bell auto-toast AND appears in bell list
4. Open bell with mixed types — verify filter chips work, counts are correct
5. `./equin check` — plugin boundaries, eslint pass
6. Screenshot the bell popover with multiple notification types
