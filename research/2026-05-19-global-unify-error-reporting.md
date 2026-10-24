# Unify error reporting and fix bell counter

## Context

The toaster plugin (`plugins/shell/plugins/toaster/`) accumulated two error-catching responsibilities that don't belong there: an `unhandledrejection` listener and a TanStack Query mutation cache subscription. Both were originally ephemeral sonner toasts, but the "unified notification" commit (0066c18e) mechanically migrated them to `notifyToast()` — which now persists to the DB.

**Problem 1 — duplicate notifications.** A single browser unhandled rejection fires two separate listeners: the crashes plugin's `CrashReporter` (which POSTs to `/api/crashes` → `recordCrash()` → `recordNotification({ type: "crash" })`) and the toaster's `onRejection` (which calls `notifyToast({ type: "error" })`). Result: two persistent notifications for one event.

**Problem 2 — noisy bell counter.** The counter is `list.filter(n => !n.read).length` — every toast (conversation launched, build started, screenshot taken) bumps it. Only errors/warnings should.

**Goal:** The toaster becomes a pure `Shell.Toast` renderer. The crashes plugin owns all error catching. The bell counter reflects actionable problems only.

## Plan

### 1. Create `plugins/crashes/plugins/mutation-errors/` sub-plugin

New sub-plugin that absorbs the mutation cache watcher from the toaster. Follows the `launch-fix` pattern — a `Core.Root` contribution that renders null and installs a side effect.

**Files:**

- `plugins/crashes/plugins/mutation-errors/package.json`
- `plugins/crashes/plugins/mutation-errors/web/index.ts` — plugin definition, id `"crashes-mutation-errors"`, contributes `Core.Root → MutationErrorWatcher`
- `plugins/crashes/plugins/mutation-errors/web/components/mutation-error-watcher.tsx`

**`MutationErrorWatcher`** component:
- Subscribes to `queryClient.getMutationCache()` in a `useEffect`
- Skips events where `meta?.suppressError` is true (same check as today)
- Calls `toast({ type: "mutation-error", description: getEndpointErrorMessage(error), variant: "warning" })`
- `variant: "warning"` (not `"error"`) — mutation failures are expected operational errors, not crashes
- `type: "mutation-error"` — gives the bell popover filter chips a meaningful label

**Why a sub-plugin rather than adding to `crash-reporter.tsx`:**
- Mutation errors are categorically different from crashes — no fingerprint, no task creation, no crash record
- Keeps `@tanstack/react-query` import out of the core crash-reporter tree
- Mirrors the `launch-fix` precedent for crash sub-plugins that compose new behavior

### 2. Simplify `plugins/shell/plugins/toaster/web/components/toaster-root.tsx`

Remove both `useEffect` blocks and three imports (`useEffect`, `useQueryClient`, `getEndpointErrorMessage`, `notifyToast`). The file becomes:

```tsx
import { Toaster as Sonner, toast as sonnerToast } from "sonner";
import { ShellCommands, type ToastArgs } from "@plugins/shell/web";

export function ToasterRoot() {
  ShellCommands.Toast.useHandler(({ title, description, variant }: ToastArgs) => {
    const opts = { description: title ? description : undefined };
    const message = title ?? description;
    const fn = variant && variant !== "default" ? sonnerToast[variant] : sonnerToast;
    fn(message, opts);
  });

  return <Sonner ... />;
}
```

### 3. Fix bell counter in `plugins/notifications/web/components/bell-button.tsx`

Change line 36:

```ts
// Before
const unreadCount = list.filter((n) => !n.read).length;
// After
const unreadCount = list.filter((n) => !n.read && (n.variant === "error" || n.variant === "warning")).length;
```

Info/success notifications still appear in the popover list and filter chips — they just don't bump the badge.

## Toast dedup correctness after the change

**Before (broken):** An `unhandledrejection` creates:
1. Crashes plugin → server `recordNotification` → WS push → BellButton fires `Shell.Toast` (toast #1)
2. Toaster → client `notifyToast()` → fires `Shell.Toast` directly (toast #2) + persists (but BellButton skips re-toast via `recentClientIds`)

**After (correct):** Only path 1 remains. One notification, one toast.

## Verification

1. `./equin build` — confirms the new sub-plugin is discovered and the registry regenerates
2. `./equin check` — passes (boundaries, lint, migrations)
3. Open the app, trigger an unhandled rejection (e.g. `void Promise.reject(new Error("test"))` in console) → exactly one notification in the bell with type "crash"
4. Trigger a mutation error (e.g. hit a 500 endpoint) → one notification with type "mutation-error", variant "warning"
5. Trigger info/success toasts (launch a conversation, build) → toast appears but bell badge does NOT increment
6. Open bell popover → "mutation-error" and "crash" filter chips appear, "error" chip no longer appears as a separate category
