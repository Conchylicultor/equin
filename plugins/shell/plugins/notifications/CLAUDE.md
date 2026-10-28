# notifications

## One notification, two surfaces

A notification is **icon · one-line headline · line 2 · at most one action**
(`research/2026-10-25-global-notifications-in-user-terms.md`). Its fields
(`core/entity.ts`):

- `title` — the headline (the event, sentence case).
- `subjectId` / `subjectName` — what it is about (a `conv-…` / `task-…` id) and
  its name **as shown when sent** (a snapshot). Line 2.
- `description` — line 2 only when there is no subject.
- `detail` — developer-only internals (build id, exit code, HTTP status, raw
  error), drawn only for a reader in Developer mode, beside the
  `DeveloperMark`.
- `action` — `{ kind, payload }`, resolved through the action registry below.
- `category` — `conversations | updates | automations | reports | other`
  (`NOTIFICATION_CATEGORIES`, a closed list in `core/`; default `other`). The
  bell's chips.
- `variant` — `error` ⇒ the toast stays until dismissed or acted on.
- `icon` — the event's own glyph, the `SymbolRef` its producer wrote with
  `symbol("…")` (so the icon manifest ships it); without one the view draws
  the variant's (error / warning) else the category's. An error / warning is
  tinted red / amber whichever glyph it draws.

**What the view draws** (`NotificationView`): the glyph · the headline · line 2
— the subject's name on a quiet chip (its tooltip the subject id's kind label,
from the ids registry), else the description · a faint meta line, only when it
has something: the recurrence `×N` (`99+` cap), the kind (`type`) on a
developer row, and "this tab" / "another tab" for a failure a browser tab
raised (`metadata.clientId`, stamped by `useToast`). A **developer row**
(audience `developer`, e.g. reports) puts its description under the headline in
line 2's font, wrapped to two lines. `detail` (developer readers only) is in the
same caption font — nothing in a notification is monospace. The glyph, the
unread dot and the developer mark are inline `align-middle` boxes in the
headline's own line box, so they centre on its x-height (baseline + ½ex), not on
the line box.

**Toast and bell are mirrors**: both draw `NotificationView`
(`web/components/notification-view.tsx`). An arriving notification
(`useNotificationArrivals`, in the bell) and a toast this page raises itself
(`useToast`, which requires a `category`) are shown through
`toastNotification` — `showToast({ render, duration })`, the toast plugin's
custom-content path: the view on the overlay surface, 4s, `Infinity` for an
error. The popover's row is the same view with its time and an unread dot.
`NotificationBody` (the old type / tab / count body) is Debug → Notifications'
row only.

**Actions are a registry**: `Notifications.Action({ kind, label, useLink |
useRun | Control })` (web slot). The view resolves `action.kind` through it and
**throws on an unknown kind**. A kind is one of three shapes — two hooks called
once per drawn notification, or a component: `useLink` (the action GOES somewhere — it builds a
`LinkTarget`; in the bell the whole row opens it too — a real `<button>`
beside the action, never around it, with ⌘ / middle-click gestures), `useRun` (the action DOES something — only its button
runs it) or `Control` (the action needs its own UI first — build-fix's Fix opens
its investigate popover: the kind draws its control from the payload, at the
compact size, labelled with its `label`). This plugin contributes `open` (`payload.to`, an in-app route, via
`useAppLink`; a link) and `reload` (a run); a row written before actions
existed with an in-app `linkTo` gets an implicit `open`. Opening or acting
closes the popover / dismisses the toast; a toast with no action shows a quiet
× instead. A kind's owner contributes its own (never a `switch` here): `resume`
(Retry — `conversation-view/resume`), `fix-build` (Fix — `build/build-fix`),
`review-automation` (Review — `tasks/automations`).

**What a click does depends on the surface** (`NotificationView`'s required
`surface: "bell" | "toast"`): in the **bell**, clicking a linked row opens its
target and closes the popover; in a **toast**, the body never opens anything —
a click anywhere but its controls only dismisses it (the toast host's
click-to-dismiss, which leaves clicks on controls to the controls), and its
action button is the only way to act on it.

**Alignment**: the glyph, the unread dot and the developer mark centre on the
headline's x-height (see *What the view draws*); every other rigid cell beside
the text (time, the
toast's lone button) is exactly one headline line tall (`h-lh text-body`), so
it centres on the headline's first line in every row.

## The bell

- **The list** reads the `notifications` collection (`shared/resources.ts`): the
  undismissed rows (`dismissed = false` is the served base `where`), a bounded
  window of the newest 200, preloaded at boot. It drives the toasts and the
  popover's `empty`; the chips are `:groups` groupings and a picked chip reads a
  server-filtered window. The popover: header (title · Mark all read · View
  all), chips All · Errors · Conversations · Updates · Automations (Reports /
  Other only while non-empty; counts over the whole collection, Errors' in
  red), then Today / Earlier by `createdAt`. The popover's infinite scroll pages it (`loadMore`
  splits off the next key-range page, never reloads), and stops at 400 — the
  last step that fits under `maxLimit` 500; "View all" is the way past it.
- **The unread badge** reads the `notifications.unread` VALUE (`liveValue`,
  `preload: "boot"`): `{ errors, warnings }` per audience (see *Audience*),
  counted over the WHOLE undismissed
  table, not over the loaded window — so an unread error older than the newest
  200 still turns the badge red. One `count(*) FILTER (…)` query
  (`countUnreadNotifications` in `server/internal/resources.ts`), recomputed and
  pushed whole after writes to the table (`throttleMs: 250`, so a burst is
  one count per window); the partial index
  `notifications_unread_badge_idx` holds exactly the rows it counts. The
  button's label carries the exact count (`"Notifications, 253 unread"`) since
  the visible badge caps at `9+`; closing the popover after it opened with
  unread items marks all read.
- **"Counted unread" is declared once**, in the filter language
  (`shared/unread.ts`: `countedUnread` over `countedUnreadFilterable` — not
  read, not muted, error or warning). The panel tests it in memory
  (`matchesFilter`), the badge's loader compiles it to SQL (`filterSql`); both
  go through the one op table the filter plugin's parity suite pins.
- `e2e/bell-filter.ts` drives all of it on a deployed build, "View all" included.

## Audience: what a user outside Developer mode sees

Every notification carries an `audience` (`audience/core`'s `user | developer`),
declared by its producer: `recordNotification({ audience })` / the default
`user` (for everyone). The reports engine stamps `developer` on every report
and crash — equin's own telemetry.

- **The bell reads only what reaches the reader** — the list, the chips, the
  filtered windows and the arrivals (toasts, native notifications) all go
  through `useReachingNotifications` / `useReachingNotificationGroups`
  (`web/internal/use-reaching-notifications.ts`), which AND in
  `audienceScope(audience)` (`shared/audience-scope.ts`): declared for an
  audience that `reachesAudience` the reader, and not muted unless the reader
  is a developer. A developer's scope is empty, so their bell reads the
  boot-preloaded default window; a user's is its own tuple.
- **The badge counts per audience**: `notifications.unread` is `{ user,
  developer }`, each `{ errors, warnings }` — one grouped count folded through
  the same `reachesAudience` — and the bell picks its reader's.
- **Debug → Notifications is unscoped**: Debug is a developer app, and its pane
  is the whole record.

## Toasts persist only where there is a bell (`useToast`)

`useToast()` shows the toast at once, then persists it as a notification over
the subtree's transport (`POST /api/notifications`, served by the machine
half). That endpoint is `needsMachine` (D4,
`research/2026-10-22-global-demo-scope-sealed.md`): under a transport with no
computer behind it (the demo) the toast stays ephemeral — shown, written
nowhere, no request made.

## The pane: Debug → Notifications

The popover's **"View all"** (its header) opens `notificationsPane`
(`web/panes.tsx`, route `notificationsRoute` in `core/`, app `debugApp`, with a
`DebugApp.Sidebar` entry) — every undismissed notification, unbounded, as a
DataView (`web/components/notifications-view.tsx`):

- **Source**: `liveDataSource(notifications, { searchable: ["title"], facets:
  ["type", "variant"] })` — the bell's own collection, read as live key-range
  pages. Its filterable columns are `countedUnreadFilterable` (`read`, `muted`,
  `variant`) plus `type`, `title` and `category` (its options declared by the
  entity field — a closed list — so it is not a facet).
- **View** (`config/shell/notifications/shell.notifications.jsonc`, the
  authored override): one `list`, grouped on the raw `read` column (`bool`,
  grouping `value` → server sections, unread first, exact counts), newest
  `createdAt` first. `read` is NOT the badge's "counted unread" (which also
  requires an unmuted error or warning): an unread info row is unread here.
- **Rows** are the popover's own body (`NotificationBody`,
  `web/components/notification-body.tsx`) via `viewOptions.list.renderRow`, a
  variant dot in the leading slot, plus the `detail` line; a row with an
  in-app `linkTo` activates as `appLink(linkTo)`.
- **Item actions** (`NotificationItemActions`): Open (a linked row) and Dismiss.
  **Toolbar**: Mark all read and Clear all (the existing endpoints). There is no
  per-row mark-read.
- **Leaving the popover through "View all" marks nothing read.** It closes
  through `onClose` (like a row's link), and the bell's mark-all-read runs only
  in the popover's own `onOpenChange`; the pane has "Mark all read" for that.
  `web/__tests__/bell-button.test.tsx` pins both exits.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Persistent bell-button notifications backed by the DB, and Debug → Notifications: every undismissed notification as a DataView (the bell popover's View all). Persistent bell-button notifications backed by the DB (the fork exclusion of its table is the machine half's).
- Web:
  - Slots:
    - `notifications.actions`
    - `notification-actions`
    - `Notifications.Action`
  - Slot contributors:
    - `notifications.actions` ← `primitives.pane`
    - `notification-actions` ← `shell.notifications`
    - `Notifications.Action` ← `build.build-fix`
    - `Notifications.Action` ← `conversations.conversation-view.resume`
    - `Notifications.Action` ← `shell.notifications`
    - `Notifications.Action` ← `tasks.automations`
  - Contributes:
    - `IdKinds.Kind` "notif"
    - `ActionBar.Item` → `BellButton`
    - `Pane.Register` "notifications"
    - `DebugApp.Sidebar` "Notifications"
    - `notification-actions` "open" → `OpenNotificationAction`
    - `notification-actions` "dismiss" → `DismissNotificationAction`
    - `Notifications.Action` "open"
    - `Notifications.Action` "reload"
  - Uses: 52 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×5
    - `infra/endpoints` ×3
    - `primitives/css/ui-kit` ×3
    - `ids` ×2
    - `primitives/css/coords` ×2
    - `primitives/css/fill` ×2
    - `primitives/css/spacing` ×2
    - `primitives/cursor-pagination` ×2
    - `primitives/live-state` ×2
    - `primitives/pane` ×2
    - `apps-core/tabs.useAppLink`
    - `apps/debug/shell.DebugApp`
    - `audience/developer-mark.DeveloperMark`
    - `audience.useAudience`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/inline.Inline`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.ToggleChip`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/link-gesture.activationProps`
    - `primitives/loading.Loading`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/relative-time.RelativeTime`
    - `primitives/scope/tab-id.getTabId`
    - `shell/action-bar.ActionBar`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (types):
    - `Notification`
    - `NotificationActionControlProps`
    - `NotificationActionKind`
    - `Toast`
    - `ToastArgs`
  - Exports (values):
    - `Notifications`
    - `useNotificationArrivals`
    - `useToast`
- Server:
  - Contributes:
    - `ids.kind` "notif"
    - `resource.declare` "notifications"
    - `resource.declare` "notifications.unread"
    - `resource.declare` "notifications:groups"
    - `resource.declare` "notifications:rows"
    - `fork-data-exclusion` "notifications"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/jobs.defineJob`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `network/live/filter.filterSql`
  - DB schema: `plugins/shell/plugins/notifications/server/internal/tables.ts`
  - Exports (types): `RecordNotificationInput`
  - Exports (values):
    - `_notifications`
    - `recordNotification`
    - `setMutedByMetadata`
  - Register: `defineJob('notifications.ttl-cleanup')`
  - Resources:
    - `notifications` (keyed, window)
    - `notifications:groups` (push)
    - `notifications:rows` (keyed, point)
    - `notifications.unread` (push)
  - Routes:
    - `POST /api/notifications/dismiss-all`
    - `POST /api/notifications/mark-all-read`
    - `POST /api/notifications/:id/dismiss`
- Machine:
  - Uses: `infra/endpoints.implementMachine`
  - Routes: `POST /api/notifications`
- Core:
  - Uses:
    - `audience.AUDIENCES`
    - `fields.FieldsRecord`
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/entities.entityRef`
    - `packages/list-bound.wholeRecord`
    - `primitives/pane.defineRoute`
    - `ui/icons.symbol`
    - `ui/icons.SymbolRef`
  - Exports (types):
    - `NotificationAction`
    - `NotificationCategory`
    - `NotificationId`
  - Exports (values):
    - `NOTIFICATION_CATEGORIES`
    - `NOTIFICATION_CATEGORY_LABELS`
    - `NOTIFICATION_VARIANTS`
    - `NotificationActionSchema`
    - `notificationFields`
    - `NotificationIconSchema`
    - `notificationIdKind`
    - `notificationsEntityRef`
    - `notificationsRoute`
- Cross-plugin:
  - Uses tokens: 30 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×13
    - `ui/tokens/type-scale` ×10
    - `ui/tokens/density` ×5
    - `ui/tokens/shape` ×2
  - Imported by: 32 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×12
    - `tasks` ×5
    - `build` ×3
    - `apps` ×2
    - `reports` ×2
    - `screenshot` ×2
    - `auth`
    - `debug/boot-profile`
    - `history/dialog`
    - `infra/events-test`
    - `page/inline-date`
    - `shell/notifications/native`
- Exemptions:
  - Exempts itself from:
    - `endpoints/no-void-fetch-endpoint` — `web/components/bell-button.tsx` (sanctioned)
    - `endpoints/no-void-fetch-endpoint` — `web/internal/toast.ts` (sanctioned)
- Shared:
  - Exports (values):
    - `createNotification`
    - `dismissAllNotifications`
    - `dismissNotification`
    - `markAllNotificationsRead`
- Sub-plugins:
  - **`native`** — Native OS notifications from the menu-bar panel: the Notifications switch (MenuBar.Section 'notifications', a config_v2 bool, off by default), shown only when the helper can notify, and a…

<!-- AUTOGENERATED:END -->
