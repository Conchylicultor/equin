# Global floating action bar

## Context

The agent-manager (main) app at `/` is the only surface that renders the global
`Shell.Toolbar` — the row of cross-app actions (Improve, Build, Screenshot,
Draw, Notifications, Theme, reorder pen, …). Every other app (Forge, Sonata,
File Explorer, Deploy, Workflows, …) instantiates its own isolated toolbar and
therefore loses access to those actions. The most painful consequence: you
cannot fire an **Improve** request — the core "fix this app" loop — while inside
any app other than the agent manager.

We want a **floating action bar** anchored top-right, present in every app
*except* the agent manager (whose real toolbar already shows these actions).
Collapsed, it is a single small icon with a status dot that aggregates "needs
attention" signals (server down, server rebuilt / stale tab, unread
error-or-warning notifications). On hover it morphs open into the row of action
buttons — letting you act (especially Improve) from anywhere.

It is opt-in but **on by default**, toggled by a single global setting. (A richer
per-app config — where each app overrides theme / floating-bar / etc. — is a
desirable but separate follow-up; see *Follow-up* below.)

## Design overview

### 1. Extract the action set into its own slot (`action-bar`)

Today the cross-app action buttons contribute directly to `Shell.Toolbar`.
Instead, a new self-contained plugin owns a dedicated render slot,
`ActionBar.Item`, which becomes the **single source of truth** for those
buttons. Two surfaces render this one slot — so they can never drift:

- **Main toolbar reuses it.** The `action-bar` plugin contributes a *single*
  entry to `Shell.Toolbar` (`group: "actions"`, `excludeFromReorder: true`)
  whose component renders `<ActionBar.Item.Render />`. That is how
  `Shell.Toolbar` "reuses" the new slot — with zero changes to `shell` or
  `app-shell`.
- **Floating bar renders it directly.** The floating-bar component renders the
  same `<ActionBar.Item.Render />`.

Curation is therefore expressed by **slot membership**, not by tagging items or
filtering — no `surfaces` field, no enumerating plugin ids (so the
collection-consumer separation rule holds: the floating bar names no individual
contributor).

**Migration:** these plugins move their contribution from `Shell.Toolbar` →
`ActionBar.Item` (each a one-line barrel change):
`build`, `improve`, `screenshot`, `draw-on-app`, `notifications` (bell),
`theme`, and `reorder/edit-mode` (the pen — reorder is a cross-app action, so it
belongs in the shared set).

**Stays on `Shell.Toolbar` directly** (not part of the floating action set):
`worktree-switcher` (namespace dropdown) and `health` (`HealthDot`) — the latter
is folded into the floating bar's collapsed status dot, so it isn't repeated as
an expanded button.

`excludeFromReorder: true` on the single Shell.Toolbar reuse entry keeps the
strip from being a drag target at the Shell.Toolbar level, avoiding nested-DnD
issues; the buttons remain reorderable *within* `ActionBar.Item`.

### 2. Floating bar (`floating-bar` plugin)

A new top-level plugin contributes one global component via `Core.Root` (the
mount mechanism `apps` and `health`'s `ReconnectWatcher` already use — renders
inside `PluginProvider`, so all slots/hooks work). The component:

1. Reads its `enabled` config (default `true`); renders nothing when disabled.
   **Note:** the config must be registered on BOTH web (`ConfigV2.WebRegister`)
   AND server (`ConfigV2.Register`) — `useConfig` only merges field defaults
   into the value once the server-side registry knows the descriptor; web-only
   registration returns raw stored data (`{}`) after load, so `enabled` reads
   back `undefined`.
2. Hides on the app that hosts the global toolbar (the agent manager): renders
   nothing when `useActiveApp()?.hostsToolbar` is true. This avoids
   double-mounting the action buttons — singleton components like the Improve
   command handler (`Improve.OpenWithText.useHandler`) throw a duplicate-handler
   error when mounted in two live surfaces at once.
3. Otherwise renders a `FloatingAction` (hover-intent morphing panel, anchored
   top-right): collapsed = base icon + `StatusDot`; expanded = a horizontal
   `<ActionBar.Item.Render />` button row inside a `FloatingActionFadeIn`.

**Active-app detection.** `hostsToolbar?: boolean` is added to the `Apps.App`
slot (agent-manager sets it `true`), and the longest-path matching in
`apps-layout.tsx` is extracted into a shared `useActiveApp()` hook exported from
`@plugins/apps/web` (consumed by both `AppsLayout` and the floating bar — no app
id is ever named).

Shape is mirrored byte-for-byte from
`plugins/.../message-toc/web/components/message-toc.tsx` (collapsed compact
header + faded-in expanded panel).

**Collapsed status dot.** A small `useFloatingBarStatus()` hook aggregates
existing signals into one tone + tooltip (priority high→low):

| Tone | Condition | Source |
|---|---|---|
| `destructive` (red) | server/central WS `closed` | `useNotificationsChannelStatuses()` (`live-state/web`) |
| `warning` (amber, pulse) | WS `reconnecting`/`connecting` | same |
| `warning` (amber) | stale tab — frontend rebuilt since load | `frontendHashResource` + initial-hash-ref pattern (copied from `build-button.tsx`) |
| `warning` (amber) | unread error/warning notifications | `useResource(notificationsResource)`, filter `!read && (error\|warning)` |
| `success`/muted | all clear | — |

Collapsed trigger: a neutral base icon (`MdAutoAwesome`, easily swapped) with a
`<StatusDot>` overlay (mirrors `HealthDot`/`Avatar` status-dot positioning). The
tooltip concatenates the active reasons.

**Toggle.** `floatingBarConfig = defineConfig({ fields: { enabled: boolField({
default: true, … }) } })`, registered via `ConfigV2.WebRegister`. It
auto-appears in the Settings pane (same as `build` / `model-provider` configs);
read in the component via `useConfig(floatingBarConfig)`.

## Files

### New — `plugins/shell/plugins/action-bar/` (the shared action slot)

- `web/slots.ts` — `export const ActionBar = { Item: defineRenderSlot<{ component:
  ComponentType }>("action-bar.item", …) }`. (Reorderable by default — the
  buttons reorder within it.)
- `web/components/action-bar-strip.tsx` — `ActionBarStrip` renders
  `<div className="flex items-center gap-2"><ActionBar.Item.Render /></div>`
  (own flex gap so it lays out flat inside the header).
- `web/index.ts` — barrel: export `ActionBar`; contribute
  `Shell.Toolbar({ id: "action-bar", component: ActionBarStrip, group: "actions",
  excludeFromReorder: true })`. Default-export `definePlugin`.
- `CLAUDE.md`, `package.json`.

### New — `plugins/floating-bar/` (the floating surface)

- `shared/config.ts` — `floatingBarConfig` (`defineConfig` + `boolField`
  `enabled`, default `true`). Mirror `plugins/build/shared/config.ts`.
- `web/index.ts` — barrel: `Core.Root({ component: FloatingBar })` +
  `ConfigV2.WebRegister({ descriptor: floatingBarConfig })`.
- `server/index.ts` — barrel: `ConfigV2.Register({ descriptor: floatingBarConfig })`
  (required for default-merging — see Design note above). Mirror
  `plugins/conversations/plugins/model-provider/server/index.ts`.
- `web/components/floating-bar.tsx` — the `FloatingAction` (collapsed icon + dot;
  expanded `<ActionBar.Item.Render />`). Renders null when `!enabled` or on the
  toolbar-hosting app.
- `web/internal/use-floating-bar-status.ts` — aggregates the three signals into `{ tone, tooltip }`.
- `package.json` (nested name rule: top-level plugin → `@singularity/plugin-floating-bar`).

### Modify — `plugins/apps/` (active-app hook + flag)

- `web/slots.ts` — add `hostsToolbar?: boolean` to the `Apps.App` item type.
- `web/internal/use-active-app.ts` — new shared `useActiveApp()` hook (extracted
  longest-path matching from `apps-layout.tsx`).
- `web/components/apps-layout.tsx` — consume `useActiveApp()`.
- `web/index.ts` — export `useActiveApp` / `ActiveApp`.
- `plugins/apps/plugins/agent-manager/plugins/shell/web/index.ts` — add `hostsToolbar: true`.

### Modify — migrate action buttons to the new slot

Each: swap the `Shell.Toolbar({...})` contribution for
`ActionBar.Item({ id, component })`, updating the import to
`@plugins/shell/plugins/action-bar/web`:

- `plugins/build/web/index.ts`
- `plugins/improve/web/index.ts`
- `plugins/screenshot/web/index.ts`
- `plugins/screenshot/plugins/draw-on-app/web/index.ts`
- `plugins/notifications/web/index.ts`
- `plugins/theme/web/index.ts`
- `plugins/reorder/plugins/edit-mode/web/index.ts` (keep `excludeFromReorder: true`)

*(Unchanged: `worktree-switcher` and `health` keep their direct `Shell.Toolbar`
contributions.)*

### Register the new plugins

- `web/src/plugins.ts` — import + register `actionBarPlugin` and
  `floatingBarPlugin` (the only place default-export plugin imports are allowed).

## Reused building blocks (do not re-implement)

- `FloatingAction`, `FloatingActionFadeIn` — `@plugins/primitives/plugins/floating-action/web`
  (shape reference: `…/message-toc/web/components/message-toc.tsx`).
- `StatusDot` — `@plugins/primitives/plugins/status-dot/web`.
- `useNotificationsChannelStatuses` — `@plugins/primitives/plugins/live-state/web` (server-down/reconnect).
- `frontendHashResource` + initial-hash-ref pattern — `@plugins/build/core` (stale-tab); copy from `build-button.tsx`.
- `notificationsResource` — `@plugins/notifications/shared` (`useResource` + unread error/warning filter from `bell-button.tsx`).
- `useConfig` / `ConfigV2.WebRegister` / `defineConfig` / `boolField` — config_v2.
- `Shell.Toolbar` — `@plugins/shell/web` (action-bar contributes the reuse entry).
- `defineRenderSlot` — `@plugins/primitives/plugins/slot-render/web`.
- `Core.Root` — `@plugins/framework/plugins/web-sdk/core`.

## Verification

1. `./equin build` from the worktree; load `http://<worktree>.localhost:9000`.
2. **Main app unchanged:** on `/` the top toolbar still shows worktree dropdown,
   the action buttons (now via the action-bar strip), and the health dot, in the
   same visual layout. The floating bar is *also* present top-right (expected for
   now — per-app hiding is the follow-up).
3. **Present elsewhere:** navigate to `/forge` and `/sonata`; confirm the
   collapsed icon + status dot appears top-right. Hover → expands to the action
   buttons (Improve, Build, Screenshot, Draw, Notifications, Theme, reorder pen).
   Confirm worktree dropdown and a standalone health dot are absent from it.
4. **Improve from another app:** in `/forge`, hover the bar, click **Improve**;
   confirm the task-draft popover opens with url/screenshot capture and submits a
   conversation (same as in the main app).
5. **Reorder pen:** click the pen in the floating bar → global edit mode toggles
   and the main toolbar's reorderable slots show drag handles.
6. **Status dot:** trigger `./equin build` in another tab → dot turns amber,
   tooltip says the tab is stale. Stop the server → dot red (disconnected).
   Generate an error/warning notification → amber with attention tooltip.
7. **Toggle:** Settings → Floating Bar → turn `enabled` off; confirm the bar
   disappears in all apps; turn back on.
8. Use `e2e/screenshot.mjs` to capture collapsed vs hovered states in a non-main app.
9. `./equin check` passes (plugin boundaries, migrations/doc sync, eslint).

## Notes / decisions

- **Reorder ranks reset.** Moving the seven buttons from `Shell.Toolbar` to
  `ActionBar.Item` is a slot change, so any custom user ordering of those items
  resets to default. Acceptable (minor, one-time).
- **Flat layout.** `ActionBarStrip` supplies its own `flex items-center gap-2` so
  the buttons render flat inside the header (the single reuse entry would
  otherwise collapse the parent's gap).
- **Nested DnD avoided.** The reuse entry is `excludeFromReorder: true` at the
  `Shell.Toolbar` level; reorder happens only within `ActionBar.Item`.

## Follow-up (separate task)

Generic **per-app config**: each app (Forge, Sonata, …) gets its own overridable
options (theme, floating-bar on/off, …) layered over global defaults. This needs
a per-app config scope primitive in `config_v2` keyed by app id, plus per-app
Settings UI. The global `enabled` toggle introduced here becomes the default that
per-app overrides fall back to — including the natural rule "hide the floating bar
on the agent manager, whose real toolbar already shows these actions." Tracked
separately.
