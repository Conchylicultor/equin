# PaneToolbar primitive + raw-bar enforcement

## Context

The Sonata player's top toolbar (`← Library` · song title · `Display` picker · zoom% · BPM · transport)
is a **hand-rolled `<div className="… border-b … pr-floating-bar …">`** inside `SonataPlayerSurface`
(`plugins/apps/plugins/sonata/plugins/library/web/panes.tsx:171–207`). Only the right group routes
through a real slot (`Sonata.Toolbar`, a `defineRenderSlot`); the left group (back / title / picker) is
hardcoded JSX. And even the slot half was created with `reorder: false`, so the reorder plugin can't
see it — which is why dragging the transport items did nothing despite "it's a slot."

Two problems, one root cause: **full-surface (`chrome: false`) panes have no sanctioned toolbar host**,
so agents hand-roll a bar. `story-detail` (`StoryEditor`) does the exact same thing. Nothing — no type,
no check, no lint — stops it.

**Goal:** (1) give full-surface panes a reusable render-slot toolbar host and migrate Sonata onto it
(all bar items become contributions; toolbar becomes reorderable), and (2) add an ESLint rule so a
hand-rolled toolbar bar fails lint going forward.

Decisions locked with the user:
- **Host design:** new reusable `PaneToolbar` primitive.
- **Enforcement:** ESLint lint rule (modeled on `no-adhoc-pane-title` / `no-adhoc-spacing`).
- **reorder:** drop `reorder: false` on the Sonata toolbar only; leave `reorder: false` usable elsewhere.

---

## Part 1 — New `pane-toolbar` primitive

New pure-library primitive at `plugins/primitives/plugins/pane-toolbar/`. A **factory** (same pattern as
`defineVariantRegion`, `tabbed-view`, `detail-sections`) so each app gets its own independently-reorderable
toolbar zones, while the sanctioned `<header>` chrome lives in one place.

**Files**
- `plugins/primitives/plugins/pane-toolbar/package.json` — workspace scaffold.
- `plugins/primitives/plugins/pane-toolbar/web/index.ts` — barrel: re-export `definePaneToolbar` + `PaneToolbarItem`, single `export default definePlugin(...)` (no contributions — pure library, **not** registered in `web/src/plugins.ts`, like `tree`/`rank`).
- `plugins/primitives/plugins/pane-toolbar/web/components/pane-toolbar.tsx` — the factory + host.

**API** (mirrors `AppShellToolbarItem` from `app-shell/web/components/app-shell-layout.tsx:16–43`):

```ts
export type PaneToolbarItem = {
  label?: string;
  icon?: ComponentType<{ className?: string }>;
  onClick?: () => void;
  component?: ComponentType;   // zero-prop; reads its data from app context
};

export function definePaneToolbar(idBase: string): {
  Start: RenderSlot<PaneToolbarItem>;   // slotId `${idBase}.start`, reorder default (true)
  End: RenderSlot<PaneToolbarItem>;     // slotId `${idBase}.end`,   reorder default (true)
  Host: ComponentType<{ className?: string }>;
};
```

Two zones (not one slot with an `align` field) so `ml-auto` stays robust under reorder — each zone
reorders independently. `Host` renders the **one sanctioned toolbar `<header>`**, copying AppShellLayout's
class list verbatim (`flex items-center border-b pl-chrome pr-floating-bar h-chrome-bar gap-sm bg-background overflow-hidden`):

```tsx
function Host({ className }) {
  return (
    <header className={cn("flex items-center border-b pl-chrome pr-floating-bar h-chrome-bar gap-sm bg-background overflow-hidden", className)}>
      <Start.Render>{(it) => <ToolbarItem {...it} />}</Start.Render>
      <div className="ml-auto flex items-center gap-sm">
        <End.Render>{(it) => <ToolbarItem {...it} />}</End.Render>
      </div>
    </header>
  );
}
```

`ToolbarItem` = the same component/button switch as `app-shell-layout.tsx:24–43` (renders `item.component`
or a ghost `Button` from `item.label/icon/onClick`).

> Note current Sonata padding is `pl-xl py-md` (taller, wrap-friendly) vs AppShellLayout's `pl-chrome h-chrome-bar`.
> Use the AppShellLayout values for consistency across the app surface; the bar gets slightly tighter. Confirm
> visually in the screenshot step — if the picker overflows, the host can accept `className` overrides per consumer.

---

## Part 2 — Migrate Sonata onto PaneToolbar

**`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts`** — replace the `Sonata.Toolbar` `defineRenderSlot`
(lines ~143–146, the `reorder: false` one) with:

```ts
import { definePaneToolbar } from "@plugins/primitives/plugins/pane-toolbar/web";
// …
Toolbar: definePaneToolbar("sonata.toolbar"),   // → { Start, End, Host }, both reorderable
```

Consumers now use `Sonata.Toolbar.Start` / `.End` / `.Host`.

**`plugins/apps/plugins/sonata/plugins/transport-bar/web/index.ts`** — change the existing
`Sonata.Toolbar({ id: "playback", component: PlaybackControls })` → `Sonata.Toolbar.End({ component: PlaybackControls })`.

**`plugins/apps/plugins/sonata/plugins/library/web/panes.tsx`** (`SonataPlayerSurface`) — delete the
hand-rolled `<div className="… border-b …">` header (lines ~173–207) and render `<Sonata.Toolbar.Host />`
at the top of the surface. Remove the inline back button, title `<Text>`, and `<Picker>` (they become
contributions below). Keep `<Sonata.Display.Dispatch>` in the body as-is.

**New Start contributions** — three zero-prop components reading from `useSonata()` /
`Sonata.Display.useContributions()` (both available because the host mounts inside `SonataProvider`):
- `BackToLibrary` — `<Button>← Library</Button>`, `onClick = clearRoute` (same hook the surface uses today).
- `SongTitle` — `<Text>{currentSongTitle ?? "Untitled"}</Text>`.
- `DisplayPicker` — wraps the existing dumb `Picker` (`library/web/components/display-picker.tsx`), feeding it
  `Sonata.Display.useContributions()` + `useSonata()` active id / `setActiveDisplay` internally.

Register them in `plugins/apps/plugins/sonata/plugins/library/web/index.ts`:
```ts
Sonata.Toolbar.Start({ component: BackToLibrary }),
Sonata.Toolbar.Start({ component: SongTitle }),
Sonata.Toolbar.Start({ component: DisplayPicker }),
```
(Library plugin already owns `SonataPlayerSurface` + `Picker`, so this is the natural home. Optional
modularity follow-up: split into a `player-toolbar` sub-plugin — not required for this change.)

Net result: the whole bar is slot-driven, both zones reorderable (reorder plugin now manages them), and the
only raw markup is the sanctioned `PaneToolbar.Host` header.

---

## Part 3 — ESLint rule: no hand-rolled toolbar bars

Owned by the new primitive (the rule points at it as the fix):
- `plugins/primitives/plugins/pane-toolbar/lint/no-adhoc-pane-toolbar.ts`
- `plugins/primitives/plugins/pane-toolbar/lint/index.ts` — `default { name: "pane-toolbar", rules: { "no-adhoc-pane-toolbar": rule }, ignores: { "no-adhoc-pane-toolbar": [<allowlist>] } }`
- `plugins/primitives/plugins/pane-toolbar/lint/no-adhoc-pane-toolbar.test.ts` — bun:test (model existing no-adhoc-* tests).

**Detection** (model: `no-adhoc-spacing.ts` token walk). Fire on `JSXAttribute` `className`/`class`; collect
class tokens; flag when the set contains **both `border-b` and `pr-floating-bar`** — the unique signature of a
top toolbar bar (`pr-floating-bar` = "leave room for the floating action bar at top-right"; only top toolbars
use it). Message: *"Toolbar bars must route through a render-slot host — use `definePaneToolbar` (PaneToolbar)
or `AppShellLayout`'s `toolbarSlot` instead of hand-rolling a header bar."*

**Why this signature:** `border-b` alone is everywhere; `pr-floating-bar` is the discriminator. It catches
both real offenders (`sonata-player`, `story-editor`), skips `story-gallery` (no `border-b`), and is the same
heuristic-token approach the existing `no-adhoc-*` family uses. It's a convention nudge, not a proof — the
point is to make the sanctioned host the path of least resistance.

**Allowlist (`ignores` globs)** — the sanctioned hosts legitimately use this signature:
- `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` (renders `toolbarSlot.Render`)
- `plugins/primitives/plugins/pane-toolbar/web/components/pane-toolbar.tsx` (the new host)
- `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx` — **legacy debt**, allowlisted to
  keep the repo-wide lint green; tracked by a follow-up task to migrate it onto `PaneToolbar`.

`sonata-player` is **not** allowlisted — it's fixed in Part 2, so the rule guards it going forward.

---

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/pane-toolbar/{package.json,web/index.ts,web/components/pane-toolbar.tsx}` | new primitive |
| `plugins/primitives/plugins/pane-toolbar/lint/{index.ts,no-adhoc-pane-toolbar.ts,*.test.ts}` | new lint rule |
| `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` | `Toolbar` → `definePaneToolbar` |
| `plugins/apps/plugins/sonata/plugins/transport-bar/web/index.ts` | `Sonata.Toolbar` → `.End` |
| `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx` | drop hand-rolled header, render `Host` |
| `plugins/apps/plugins/sonata/plugins/library/web/{index.ts,components/*}` | Start contributions (back/title/picker) |

Reused: `defineRenderSlot` (`primitives/slot-render`), `cn`/`Button`/`Text` (`ui-kit`/`text`),
`Picker` (`library/web/components/display-picker.tsx`), `useSonata`, `Sonata.Display.useContributions`,
`grepCode`-free AST token-walk from `no-adhoc-spacing.ts`.

## Verification

1. `./equin build` (regens reorder manifest + lint config; runs checks).
2. Screenshot the player and confirm the bar looks the same:
   `bun e2e/screenshot.mjs --url http://att-1781302814-fnxc.localhost:9000/sonata/song/<id> --out /tmp/sonata`
   — verify back / title / picker / transport all present; check the tighter padding doesn't clip the picker.
3. Reorder works: enter global edit mode (reorder edit-mode pen) and drag a toolbar item; confirm it persists.
4. Lint: `./equin check eslint` passes (allowlists in place). Add a fixture in
   `no-adhoc-pane-toolbar.test.ts` proving a `border-b … pr-floating-bar` `<div>` errors and a
   `PaneToolbar.Host`-style host passes. Run `bun test plugins/primitives/plugins/pane-toolbar/lint`.
5. `add_task` (MCP): "Migrate story-detail (StoryEditor) toolbar onto the PaneToolbar primitive and remove its
   no-adhoc-pane-toolbar allowlist entry."

## Out of scope / follow-ups
- Migrating `story-editor` (allowlisted + tracked).
- Gating `reorder: false` repo-wide as a silent escape hatch (user chose to leave it).
- Refactoring `AppShellLayout` to reuse `PaneToolbarItem` (could dedupe later; not now).
