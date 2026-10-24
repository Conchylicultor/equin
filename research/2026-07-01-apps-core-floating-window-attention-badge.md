# Floating-window surface: per-app attention badge on tab strip + dock

## Context

App tab chips in the **docked** (top) tab bar recently gained a per-app ambient
*attention badge* — the generic `badge?: ComponentType<{ className?: string }>`
declared on the `Apps.App` contribution (`plugins/apps-core/web/slots.ts:33-36`),
e.g. Mail's sync-error dot (`MailRailBadge`) or Settings' config-conflict dot
(`SettingsRailBadge`). It rides the tab icon's top-right corner via the themable
`Tab` primitive's `badge` prop, rendered by the shared `TabIcon`
(`plugins/ui/plugins/tab-bar/web/components/tab-icon.tsx`).

The **floating-desktop** surface is inconsistent: it renders the same `Tab`
primitive in its window tab strip but never passes a `badge`, and its window-dock
chips have no equivalent. So a Mail window with a sync error shows the attention
dot on the app-rail and on the docked tab, but not on its floating window's tab
strip or dock chip. This closes that gap so the floating surface matches the
app-rail and docked tab bar.

The badge mechanism is fully generic and already end-to-end on the `Tab`
primitive — no new attention logic, no per-app coupling. We only thread the
existing `app.badge` component through two floating-surface render paths.

## Changes

### 1. `WindowMember` carries the badge

`plugins/apps-core/plugins/surface/plugins/floating/web/components/window-tab-strip.tsx`

- Import `type ComponentType` from React.
- Extend the `WindowMember` interface (currently `{ tabId, title, icon }`) with:
  ```ts
  /** Per-app attention overlay (e.g. Mail sync-error), pinned to the tab
   *  icon — mirrors the docked tab bar / app-rail. Renders `null` when idle. */
  badge?: ComponentType<{ className?: string }>;
  ```
- In the render loop (the `<Tab .../>` per member, ~line 220), forward
  `badge={member.badge}`. `Tab` already accepts `badge` and pipes it to
  `TabIcon` — no primitive change needed.

### 2. Resolve `app.badge` where members are built

`plugins/apps-core/plugins/surface/plugins/floating/web/floating-placement.tsx`

In the `memberRows` `useMemo` (~line 167) that maps each member id to its app,
add `badge: app?.badge` alongside the existing `title` / `icon`:
```ts
return {
  tabId: memberId,
  title: titles[memberId] ?? app?.tooltip ?? "Window",
  icon: app?.icon,
  badge: app?.badge,
};
```
`app` is already resolved here via `apps.find((a) => a.id === appId)`.

### 3. Window-dock chip shows the active member's app badge

`plugins/apps-core/plugins/surface/plugins/floating/web/components/window-dock.tsx`

The dock renders one `ToggleChip` per window, its icon/title resolved from the
window's **active** member (`win.activeTabId`). Reuse the shared `TabIcon` (which
owns the icon+badge geometry — `Pin to="top-right" offset="2xs" outset
decorative`) so the dock's badge is pixel-identical to the tab strip's:

- Import `TabIcon` from `@plugins/ui/plugins/tab-bar/web` and `appIconComponent`
  from `@plugins/apps-core/plugins/app-icon/web`.
- Replace the `ToggleChip` `icon` prop:
  ```tsx
  icon={
    app?.icon ? (
      <TabIcon icon={appIconComponent(app.icon)} badge={app.badge} />
    ) : undefined
  }
  ```
- Drop the now-unused `AppIconView` import (used only at that one call site).

**Scoping decision (deliberate):** the dock chip badge reflects the window's
*active member's* app — the same member whose icon and title the chip already
shows. A window whose only attention-flagged tab is a background member won't show
the dot; that matches the chip's identity (it renders the active member) and
avoids the incoherent "which app's badge do we show for a multi-app window" merge.
This is consistent with the docked tab bar, where each tab is a single app.

## Why reuse `TabIcon` in the dock (vs. inline Pin+badge)

`TabIcon` is the single sanctioned home for the icon+badge overlay geometry,
already used by all three tab variants and (via `Tab`) by the floating tab strip.
Reusing it keeps the dock's dot identical to the tab strip's and avoids
duplicating the `Center` + `Pin` composition. `icon-auto` sizing is em-based, so
the icon scales to the chip's font — the same as the tab chips. If the dock icon
size visibly regresses vs. the old `AppIconView` default, fall back to composing
`AppIconView` + `Pin` inline (Approach B), but reuse is the default.

## Files

- `plugins/apps-core/plugins/surface/plugins/floating/web/components/window-tab-strip.tsx` (WindowMember + Tab badge prop)
- `plugins/apps-core/plugins/surface/plugins/floating/web/floating-placement.tsx` (memberRows badge)
- `plugins/apps-core/plugins/surface/plugins/floating/web/components/window-dock.tsx` (dock chip badge)

No schema, server, or slot changes. No new plugin. The `Apps.App.badge` contract,
the `Tab.badge` prop, and `TabIcon` all already exist.

## Verification

1. `./equin build` — must succeed (types + checks).
2. In the app, open **Mail** (or Settings) and put it in a state that triggers its
   attention badge (Mail sync-error / Settings config-conflict). The dot shows on
   the app-rail + docked tab today.
3. Switch that app's tab to the **floating** placement (placement control /
   surface control). Confirm the attention dot now appears:
   - on the window's **tab-strip** chip (top-right of the tab icon), and
   - on the window's **dock** chip (bottom taskbar), matching the app-rail dot.
4. Group two apps into one floating window; confirm each tab-strip chip shows its
   own app's badge, and the dock chip shows the active member's badge.
5. Screenshot before/after with `e2e/screenshot.mjs` to confirm the dock icon size
   didn't regress from the `TabIcon` swap.

## Follow-ups

None required. If a future need arises to surface attention from a *background*
member on the dock chip, that is a separate design (badge aggregation across a
window's members) and intentionally out of scope here.
