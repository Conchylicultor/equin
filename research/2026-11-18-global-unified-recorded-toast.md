# One toast primitive, always recorded in the notification history

## Context

The Release button's toast ("Released" / "Not released") never appears in the
bell. It is raised by `showToast` (`shell/toast`), a sonner text toast written
nowhere. Its sibling `useToast` (`shell/notifications`) shows the same toast AND
writes a notification row. Both are public, so 47 files / 68 calls picked the
unrecorded one — failures included (worktree delete, composition build, close
conversation, optimistic-write rejections, file errors, storage failures…).

Goal (user's mental model): **one toast primitive every caller is forced to use,
and it always records the toast in the notification history.** Small
acknowledgements ("Block ID copied") are recorded too, under their own category
so the bell and Debug → Notifications can filter them out.

## Design

### 1. `useToast` (`shell/notifications/web`) is the one API

It already renders the toast as `NotificationView` (toast and bell are mirrors)
and persists it through `POST /api/notifications`. It stays the one entry point;
`showToast` disappears from `shell/toast`'s public barrel (rung 1: the
unrecorded toast has no spelling outside the toast plugin).

`ToastArgs` (`shell/notifications/web/internal/toast.ts`) gains what text-toast
callers use today:

- `kind?: "reply" | "announcement"` — default `reply`; an announcement
  (reconnect-watcher, update-policy-root) goes through `toastNotification(n,
  "announcement")` (on-screen only, 4 s). It is still recorded.
- `liveAction?: { label; onClick } | { label; link: LinkTarget }` — a closure
  action (Undo, Open…) drawn on the live toast only; the recorded row has no
  action (a closure can't be stored). `NotificationContent` gets an optional
  live-only action that `NotificationView` draws on the `toast` surface in
  place of a registry action; the bell never sees it. Mutually exclusive with
  `action` (union, tsc).
- `type` and `category` stay required — each migrated call names its own
  (`"release-cut"`, …) and picks a category.

The demo scope stays the one non-recording case (existing `needsMachine` D4
rule) — unchanged.

### 2. A `confirmations` category for acknowledgements

Add `confirmations` ("Confirmations") to `NOTIFICATION_CATEGORIES`
(`shell/notifications/core/entity.ts`, closed list + labels + the
`enumTextField` options). Like Reports / Other, its bell chip shows only while
non-empty. Info rows never count toward the unread badge (only errors/warnings
do), so recording them adds no alert noise. Used for: copied, tips back on,
preset deleted (Undo), page moved to trash, prototype restored/deleted, saved
place, download done, test run started, "Opens outside this embed", etc.
Migration rule: an error/warning never goes under `confirmations`.

### 3. Break the one import cycle: move Debug → Notifications pane out

`primitives/data-view` raises toasts (preset delete Undo, view reset) and
`shell/notifications` imports data-view — only through the Debug →
Notifications pane (`web/components/notifications-view.tsx`, `web/panes.tsx`;
verified: no other path from notifications reaches data-view). Move that pane
into a child plugin `shell/notifications/plugins/pane` (pane, DebugApp.Sidebar
entry, `NotificationItemActions` slot + open/dismiss item actions, its
`__tests__`). `notificationsRoute` stays in notifications `core/` (the bell's
"View all" links to it). Then data-view → notifications is a legal edge.

### 4. Only notifications draws a toast

`shell/toast` keeps the host and the custom-toast layer (`useShowCustomToast`,
`isInToast`, `useSuppressToasts`, `ToasterHost`) and drops the text path
(`showToast`, the text `ToastArgs`/`ToastVariant` core types) once nothing uses
it. A lint rule `shell-toast/no-direct-custom-toast` (in `shell/toast/lint/`)
forbids importing `useShowCustomToast`; `shell/notifications` declares a
`sanctioned` exemption in its `exempt/index.ts` (no path allowlist in the rule).
Feature code can therefore only raise a toast through `useToast`.

### 5. The non-React caller

`reports/optimistic-rejection`'s collector runs as a module-level sink drain, no
hook available. Split it: the collector keeps the report and emits the
rejection into a plugin-local module emitter; a `Core.Root` (scope `page`)
component `OptimisticRejectionToasts` subscribes with `useToast` and raises
`{ category: "other", variant: "error", type: "optimistic-rejection" }`.
Rejections emitted before the root mounts are buffered (bounded) and flushed on
mount — nothing dropped.

### 6. Migrate the 68 calls

Mechanical, per call: `showToast({title?, description, variant, action})` →
`const toast = useToast()` at the component/hook top, then
`toast({ type, title, description, variant, category, liveAction? })`.

- A description-only toast moves its text to `title` (the headline) and passes
  `description: ""`.
- `variant` maps 1:1 (NotificationVariant has error/warning/info/success);
  the text toast's `"default"` → `"info"`.
- Helper functions returning text `ToastArgs` (`describeRefreshAll`,
  `submitFailed`, `dropped-notification`, `push-and-exit`) return
  notifications' `ToastArgs`.
- Category per site: release cut / builds / composition / update policy →
  `updates`; conversation/agent-thread/hibernation/pending-turn → `conversations`;
  test runs, worktree cleanup, profiling ops → `other` (developer audience where
  the surface is Debug); acknowledgements → `confirmations`; everything else →
  `other`.

Representative files: `upstream/web/components/releases-row.tsx`,
`primitives/data-view/web/components/filter/presets.tsx`,
`infra/health/web/components/reconnect-watcher.tsx`,
`apps/file-explorer/plugins/browser/web/components/row-actions.tsx`,
`page/plugins/url-paste/web/components/url-paste-plugin.tsx`.

### 7. Docs

`shell/toast/CLAUDE.md`: the plugin is the stack only; feature code toasts via
`useToast`. `shell/notifications/CLAUDE.md`: replace "Toasts persist only where
there is a bell" with "Every toast is a notification" (+ `liveAction`, `kind`,
`confirmations`).

## Verification

- `./equin check` (boundaries/cycle, type-check, the new lint rule, docs in sync).
- `./equin test plugins/shell` (toast ledger, notification view/panel tests;
  add a test that a `liveAction` draws on the toast surface and not in the bell,
  and that `useToast` posts for every kind).
- `./equin build`, then in my build: click Release (or trigger a cheaper site,
  e.g. Copy block ID) → toast shows → bell lists it under the right chip;
  Confirmations chip filters it; register a before/after of the bell.
