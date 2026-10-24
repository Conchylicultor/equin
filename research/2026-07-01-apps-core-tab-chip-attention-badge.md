# Per-app attention badge on app tab chips

## Context

The app-rail icon can paint an ambient per-app attention dot via the generic
`badge` field on `Apps.App` (e.g. Mail sync-error dot, Settings config-conflict
dot). Commit `2a5bf93cc` added the Mail rail dot; Settings had the pattern
already. But the **top tab chips** (`plugins/apps-core/plugins/tab-bar`) never
thread that `badge` through, so an unhealthy background state is only visible on
the far-left rail — not on the tab the user is actually looking at. The tab chip
is the more proximate surface and should show the same ambient indicator.

This is a generic primitive gap, not a Mail-specific one. The fix lives at the
`Tab`-primitive / tab-bar layer so **every** app that already supplies a rail
`badge` gets a tab badge for free, across all three tab variants (chip /
underline / connected), with zero per-app code.

## Approach

Mirror the app-rail's exact pattern (`app.badge` component pinned to the icon's
top-right corner via `Pin`), threaded generically through the themable `Tab`
primitive. The badge rides the **icon**, so it survives the collapsed / icon-only
overflow state (where label + close are hidden).

### 1. `TabProps` gains a `badge` field — `plugins/ui/plugins/tab-bar/core/types.ts`

```ts
/** Optional per-app attention overlay (e.g. a sync-error dot), pinned to the
 *  tab icon's top-right corner — mirrors the app-rail icon badge. Renders `null`
 *  when there's nothing to surface. Rides the icon so it survives collapsed mode. */
badge?: ComponentType<{ className?: string }>;
```

### 2. New shared `TabIcon` — `plugins/ui/plugins/tab-bar/web/components/tab-icon.tsx`

A single home for "tab icon + optional pinned attention badge", exactly as
`TabCloseButton` is the shared trailing-close home reused by all three variants.
Keeps the `Pin` positioning in ONE place (no triplication).

```tsx
export function TabIcon({ icon: Icon, badge: Badge }: TabIconProps) {
  if (!Icon) return null;
  if (!Badge) return <Icon className="icon-auto" />;
  return (
    <Center as="span" className="relative">
      <Icon className="icon-auto" />
      {/* outset (vs the rail's inset): the tab icon is a small, padding-less
          anchor, so the dot rides the corner instead of landing on the glyph. */}
      <Pin to="top-right" offset="2xs" outset decorative>
        <Badge />
      </Pin>
    </Center>
  );
}
```

Reuses `Center` (grid box, shrinks to the icon, provides the `relative` context)
and `Pin` (`@plugins/primitives/plugins/css/plugins/pin/web`) — the same
primitive the rail uses. `decorative` → `pointer-events-none` so the badge never
eats the tab click. Export `TabIcon` from the web barrel
(`plugins/ui/plugins/tab-bar/web/index.ts`).

### 3. Each variant renders `<TabIcon>` — chip / underline / connected

In `chip-tab.tsx`, `underline-tab.tsx`, `connected-tab.tsx`: destructure `badge`
out of props (so it never leaks to the DOM via `...rest`) and replace
`{Icon && <Icon className="icon-auto" />}` with
`<TabIcon icon={Icon} badge={badge} />`. The dispatching host (`Tab`) already
forwards all `TabProps` to the active variant — no host change.

### 4. Thread `app.badge` — `plugins/apps-core/plugins/tab-bar/web/components/app-tab-bar.tsx`

`app` is already resolved per tab (`apps.find((a) => a.id === tab.appId)`). Add
`badge` to `TabChipProps` and pass `badge={app.badge}` in the render map; `TabChip`
already spreads its props into `<Tab>`. The hidden `MeasureStrip` is left
unchanged: the badge is absolutely positioned (`Pin`), contributes zero layout
width, so overflow measurement stays correct.

## Files

- `plugins/ui/plugins/tab-bar/core/types.ts` — add `badge` to `TabProps`
- `plugins/ui/plugins/tab-bar/web/components/tab-icon.tsx` — **new** shared component
- `plugins/ui/plugins/tab-bar/web/index.ts` — export `TabIcon`
- `plugins/ui/plugins/tab-bar/plugins/chip/web/components/chip-tab.tsx`
- `plugins/ui/plugins/tab-bar/plugins/underline/web/components/underline-tab.tsx`
- `plugins/ui/plugins/tab-bar/plugins/connected/web/components/connected-tab.tsx`
- `plugins/apps-core/plugins/tab-bar/web/components/app-tab-bar.tsx` — pass `app.badge`

## Verification

1. `./equin build` (regenerates docs/registry, restarts server).
2. Open `http://<worktree>.localhost:9000`. Ensure a Mail account is in an
   unhealthy sync state (or temporarily force `MailSyncDot` to render) and/or a
   Settings config conflict exists — the rail already shows a dot. Confirm the
   corresponding **tab chip** now shows the same dot at its icon's top-right.
3. Switch the tab-bar variant (Settings → Appearance → tab bar: chip / underline /
   connected) and confirm the badge appears in all three.
4. Shrink the window so tabs overflow to icon-only — confirm the badge persists on
   the collapsed icon.
5. Confirm the badge never blocks clicking / closing / dragging the tab.

## Follow-up (out of scope)

The floating-window tab strip (`window-tab-strip.tsx`) and the window dock also
render tabs, but via `WindowMember { tabId, title, icon }` which carries no
`appId`/`badge`. Wiring the same badge there needs `WindowMember` to carry the
app's badge (resolved where members are built). File a follow-up task so the
floating desktop surface stays consistent with the docked tab bar.
