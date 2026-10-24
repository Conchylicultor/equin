# Themable tab-bar primitive (chip / underline / connected variants)

## Context

The app has several tab bars, and the prominent ones — the global `AppTabBar`
(strip above all app content) and the floating-window `WindowTabStrip` — render
tabs as **chips** with *different* bespoke styling each. There is no single
"tab" look, and no way for a user to choose one.

We want a **unified tab-bar look that is a user-switchable theme variant**:
`chip` (today's pill look), `underline` (flat, GitHub/Linear — active tab
underlined flush with the content border), and `connected` (skeuomorphic
folder tab merging into the content surface). The selected style applies
app-wide and is picked from the theme customizer, exactly like the existing
`segmented-progress-bar` (`dots` / `segmented`) and `sidebar-framing`
(`flush`/`floating`/`inset`) variant components.

**Scope (this iteration):** migrate only `AppTabBar` and `WindowTabStrip`.
The 16 view-switcher UIs (already unified via `SegmentedControl`) and the other
two document strips (`FileTabs`, `SourceTabs`) are explicitly out of scope.

## Key design decision: variant owns the *item*, not the *strip*

`AppTabBar` and `WindowTabStrip` share almost nothing behaviorally:

| | `AppTabBar` | `WindowTabStrip` |
|---|---|---|
| Reorder | dnd-kit `SortableList` | bespoke pointer drag |
| Cross-target | tear-off to floating window | reorder / merge / split |
| Overflow | icon-only collapse via `useResponsiveOverflow` | none |
| Extras | `+` button, trailing actions, hidden measure strip | per-window, in titlebar |

What they **do** share is the visual chrome of a single tab: icon + label +
active state + a trailing close `×`, with optional icon-only collapse. So the
themable unit is **one tab item**, and the variant swaps only that chrome. All
behavior (drag, overflow, tear-off, the `+`) stays in each consumer, which keeps
the two complex strips intact and makes the variant trivially small.

The "merge with content" looks (`underline`, `connected`) are achievable purely
at the item level **provided the strip container carries a bottom border** the
active item can sit on / overlap:
- `underline` active item: `border-b-2 border-primary` over the strip's
  `border-b border-border`.
- `connected` active item: `border border-b-0 bg-background -mb-px` so it eats
  the strip's bottom border and reads continuous with the content below.
- `chip`: no strip-border interaction; accent-filled pill (today's behavior).

Both consumers already render the strip in a horizontal container; `AppTabBar`
has `border-b` today. `WindowTabStrip` (in the window titlebar) must add a
`border-b` to its row so the merge variants render correctly there too.

### Why the `segmented-progress-bar` pattern, not `defineVariantRegion`

`defineVariantRegion` (`plugins/ui/plugins/variant-region/`) is for **chrome
regions** mounted at a fixed `AppShell` slot, and it forces `scope: "app"`. A tab
item is a **component rendered at a call site**, and the look is a **global**
aesthetic preference. `segmented-progress-bar` is exactly that shape (global
config, `<SegmentedProgressBar .../>` rendered inline) — copy it.

## New plugin: `plugins/ui/plugins/tab-bar/`

Mirror `plugins/ui/plugins/segmented-progress-bar/` byte-for-byte in structure.

### `core/config.ts`
```ts
import { defineConfig } from "@plugins/config_v2/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";

export const tabBarConfig = defineConfig({
  fields: {
    variant: dynamicEnumField({ default: "chip", label: "Tab bar variant" }),
  },
});
```
Global (no `name`/`scope`). Default `"chip"` ⇒ zero visual regression by default.

### `core/types.ts` — the variant contract
```ts
import type { ComponentType, ReactNode, Ref } from "react";

export interface TabProps {
  icon?: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  /** Icon-only (overflow collapse). Variants hide the label + close when true. */
  collapsed?: boolean;
  onActivate?: () => void;
  /** When provided, the variant renders a trailing close button (TabCloseButton). */
  onClose?: () => void;
  /** Root-element ref so a tooltip trigger / scroll-into-view can attach. */
  ref?: Ref<HTMLElement>;
  /** Passthrough for drag handlers + data-* attrs the consumer puts on the root. */
  [key: string]: unknown;
}
```

### `web/slots.ts`
```ts
export interface TabVariantContribution {
  id: string;
  label: string;
  match: string;            // === id
  component: ComponentType<TabProps>;
}
export const TabBar = {
  Variant: defineSlot<TabVariantContribution>("ui.tab-bar.variant", {
    docLabel: (p) => p.label,
  }),
};
```

### `web/components/tab.tsx` — the dispatching host
Same `useContributions()` + `useConfig(tabBarConfig)` + find-by-`match` dispatch
as `SegmentedProgressBar`, **but render the variant component directly with ref
forwarding** instead of `renderIsolated`:
```ts
const active = contributions.find((c) => c.match === activeId) ?? contributions[0];
if (!active) return null;
const Variant = active.component;
return <Variant {...props} ref={ref} />;
```
*Named deviation from the segmented-progress-bar pattern:* per-tab error
isolation is low value (trivial presentational markup, already inside app-level
boundaries) and `renderIsolated` cannot forward the root ref that `WithTooltip`'s
`asChild` trigger and `AppTabBar`'s `scrollIntoView` require. Document this in a
comment.

### `web/components/tab-close-button.tsx` — shared `×`
Extract the close-button markup (today duplicated in `ChipShell` and
`WindowTabStrip`) so all three variants compose one `TabCloseButton`
(`aria-label`, `MdClose`, hover-reveal coupling via the established
opacity↔pointer-events pattern). Keeps the variants tiny and the hover behavior
consistent.

### `web/components/variant-picker.tsx`
Copy `segmented-progress-bar/web/components/variant-picker.tsx` verbatim, swap
the config import.

### `web/index.ts`
```ts
export { Tab } from "./components/tab";
export { TabCloseButton } from "./components/tab-close-button";
export { TabBar as TabBarSlots } from "./slots";
export type { TabProps, TabVariantContribution } from ...;

export default {
  description: "Themable tab bar: chip / underline / connected variants.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: tabBarConfig }),
    DynamicEnum.Options({
      field: tabBarConfig.fields.variant,
      useOptions: () => TabBar.Variant.useContributions().map(v => ({ value: v.id, label: v.label })),
    }),
    ThemeEngine.VariantGroup({ id: "tab-bar", componentLabel: "Tab bar", component: VariantPicker }),
  ],
} satisfies PluginDefinition;
```

### `server/index.ts`
```ts
contributions: [ConfigV2.Register({ descriptor: tabBarConfig })]
```

### Variant sub-plugins — each implements `TabProps`
- `plugins/ui/plugins/tab-bar/plugins/chip/web/` — id `chip`, **canonical**
  accent-filled pill: `rounded-md`, active `bg-accent text-accent-foreground`,
  inactive `text-muted-foreground hover:bg-accent/50`. (This is the unified chip
  look; see "Intended visual changes" below.)
- `plugins/ui/plugins/tab-bar/plugins/underline/web/` — id `underline`, flat;
  active adds `border-b-2 border-primary text-foreground`, inactive
  `text-muted-foreground hover:text-foreground`, no fill.
- `plugins/ui/plugins/tab-bar/plugins/connected/web/` — id `connected`, folder;
  active `border border-b-0 bg-background -mb-px rounded-t-md`, inactive flat
  muted. Reads continuous with the content panel below.

Each composes `Badge`/`Line` for the chip shell + `TabCloseButton`, hiding label
and close when `collapsed`. Reuse `icon-auto` sizing; obey
`no-adhoc-*` lint (rounded-md, `p-*` steps, `<Text>`, z-layer utilities).

## Consumer migrations

### `plugins/apps/web/components/app-tab-bar.tsx`
- Replace `ChipShell` / `TabChip`'s bespoke markup with `<Tab .../>` from the new
  primitive. `TabChip` keeps the `scrollIntoView` ref + `WithTooltip` wrapper,
  now passing `ref` through to `<Tab>`.
- The hidden measure strip renders `<Tab collapsed={false} active={false}/>` so
  measured width tracks the active variant.
- Keep `SortableList`/`SortableItem`, `useResponsiveOverflow`, the `+` button,
  `Apps.TabBarActions`, and the `border-b` on the outer `Stack` unchanged.
- Spread the sortable drag props + `data-app-tab` onto `<Tab>` via its
  passthrough.

### `plugins/apps/plugins/surface/plugins/floating/web/components/window-tab-strip.tsx`
- Replace the inline `<Badge>` chip with `<Tab .../>`, passing `onPointerDown`,
  `onClick`, `data-floating-tab-id`, and `onClose` through the passthrough.
- Add `border-b` to the strip's `Stack` row so `underline`/`connected` merge
  correctly inside the titlebar.
- Keep the entire `use-tab-drag` pointer state machine and `resolveDrop` as-is.

## Intended visual changes (not regressions)

- Default variant `chip` unifies both strips onto **one** accent-pill look. Today
  `AppTabBar` active = `bg-sidebar-accent` (sidebar token) and `WindowTabStrip`
  active = `border + bg-background`. After: both use the canonical accent chip.
  This *is* the requested consistency; call it out for review.

## Build / registration

No manual registry edits. Create each `web/index.ts` + `server/index.ts` +
`package.json` (`@singularity/plugin-ui-tab-bar[...]`, `private`, `version`,
`description`) and run `./equin build`; codegen discovers the plugins,
regenerates registries + the `ui/tab-bar` `CLAUDE.md`. `./equin check`
must pass (`plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`,
`eslint`, boundary checker).

## Critical files

- Template: `plugins/ui/plugins/segmented-progress-bar/{core,web,server,plugins}/**`
- Picker host slot: `plugins/ui/plugins/theme-engine/web/slots.ts` (`ThemeEngine.VariantGroup`)
- Config field: `plugins/fields/plugins/dynamic-enum/plugins/config/{core,web}`
- Dispatch idiom: `plugins/primitives/plugins/slot-render/web` (we render directly for ref; reference only)
- Consumer 1: `plugins/apps/web/components/app-tab-bar.tsx`
- Consumer 2: `plugins/apps/plugins/surface/plugins/floating/web/components/window-tab-strip.tsx`
- Chip shell to reuse: `plugins/primitives/plugins/css/plugins/badge/web`, `.../line/web`

## Verification

1. `./equin build` then `./equin check` — all green.
2. `http://<worktree>.localhost:9000` — open ≥3 app tabs. Default looks like
   today (chip). Settings → Appearance (theme customizer) shows a **Tab bar**
   row with `chip` / `underline` / `connected`.
3. Switch each variant; confirm `AppTabBar` updates live: underline sits on the
   bar's bottom border; connected merges into the content pane.
4. Verify behavior intact per variant: click-to-focus, hover `×` closes one tab,
   drag-reorder, drag-out tear-off to floating window, overflow icon-collapse,
   `+` new tab.
5. Floating mode: open a window with ≥2 members; confirm `WindowTabStrip` adopts
   the same variant and reorder/merge/split + per-member `×` still work.
6. Scripted check (state + screenshots):
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents --out /tmp/tabs
   ```
