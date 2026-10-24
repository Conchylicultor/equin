# Floating action bar — visual refresh (proto-1791322499-99av)

## Context

In fullscreen (solo) mode the global floating action bar (`shell/global-action-bar`) looks cluttered. The Build trigger and its Reload segment are a framed `ButtonGroup` pill, and Improve is another one, so there are pills inside pills. Controls are 26px inside a card that only appears when the bar is open. The badge sits outset over the bell. Reload is a framed text segment when the bar is open but a filled chip when collapsed.

The agreed target is the prototype `proto-1791322499-99av` at its defaults: look classic, blue `#113b7b`, red `#72151b`. The change is **appearance only**. Items, order, states, collapse/expand behaviour, tooltips and aria-labels stay as they are.

## What exists today (the pieces we restyle)

| Piece | Where | Today |
|---|---|---|
| Floating panel | `global-action-bar.tsx` → `FloatingAction variant="ghost"` (`primitives/overlay/floating-action/web/internal/floating-action.tsx:216`) | No card when collapsed. When open: `rounded-md`, `bg-background/90`, `shadow-md`. |
| Control height | `ActionBar.Item` / `Glance` declare `controlSize:"sm"` (`shell/action-bar/web/slots.ts`) | The chrome's sm is 26px. |
| Build + Reload | `build/web/components/build-button.tsx:131-203`, `reload-segment.tsx`, `reload-chip.tsx` | Built as `ButtonGroup shape="pill"` holding [frame trigger \| frame Reload with `text-info`]. The collapsed chip is a separate `bg-info` filled pill. |
| Improve | `improve/web/components/improve-button.tsx:36` + `element-picker-button.tsx:15` | `ButtonGroup shape="pill"` with `variant="frame"` segments. |
| Badge | `notifications/web/components/bell-button.tsx:137-150` | 16px, `Pin` top-right outset −2px, `bg-destructive` (errors) or `bg-warning`. |
| Separators | `config/shell/action-bar/item.jsonc` | None. There is a `spacer` between the gear and Build, which does nothing here because the bar has no slack. |
| Broken ring | `primitives/css/activity-ring/.../activity-ring.tsx:92` | `stroke-destructive`. |

## Where the deep colours go — decision

**I won't repaint the chrome's `info` / `destructive`.** About 20 call sites inside chrome surfaces use them as text, icon, border or stroke on the graphite panel. A colour as deep as `#72151b` or `#113b7b` (about 1.5:1 against the bar) would make all of them unreadable:
- the notifications panel's severity borders and text
- the build popover's error lines
- the Improve popover's "Experimental" label
- the gear popover's danger rows
- the crash chip
- `Button variant="destructive"` and `Badge` tones

These tokens are single-valued. There is no separate fill token alongside a text token.

**I'll add a "solid" fill role to `colorPaletteGroup`** (`ui/tokens/color-palette/core/group.ts`): the fill a small saturated status control wears at rest, with light text on it.
- New tokens: `infoSolid`, `infoSolidForeground`, `destructiveSolid`, `destructiveSolidForeground`.
- Defaults are `var(--info)`, `var(--info-foreground)`, `var(--destructive)`, `var(--destructive-foreground)`. Var references already work as defaults (see density's `panelRowH`), so **every existing theme renders exactly as today**.
- Map them in `ui-kit/web/theme/app.css` (`--color-info-solid` etc.) so `bg-info-solid`, `text-info-solid-foreground` and similar classes exist. Register any new utility with tailwind-merge, per the theme SKILL.
- The **chrome theme** sets them (`chrome-theme.ts`): `INFO_SOLID = #113b7b`, `DESTRUCTIVE_SOLID = #72151b`, and both foregrounds light (white).

The chrome theme is the right home: the bar wears it, the colours stay themable, and nothing outside the chrome changes. Only these call sites switch to the solid tokens, which are exactly the ones the brief names:
- the Reload pill: stale → `info-solid`, failing → `destructive-solid`
- the bell badge in its error state (the warning state is unchanged)
- the failed build: its dot and its 1px frame
- the activity ring's broken stroke

Everything else keeps the bright `info` / `destructive`, including the health dot's critical tint.

**Contrast check (computed):**

| Pair | Contrast |
|---|---|
| White on `#72151b` | ≈ 11.4:1 |
| White on `#113b7b` | ≈ 10.6:1 |
| Either fill against the bar ground (oklch 0.23) | ≈ 1.5:1 |

So the badge and Reload read through their light text, not their shape. The badge keeps the prototype's 2px ring in the bar's ground colour, which cuts it out from the bell. The weak point is the broken ring: a thin dashed `#72151b` stroke at 1.5:1. I'll keep it as specified and judge it on a screenshot. If it disappears, I'll report back rather than silently lightening it.

## Changes

### 1. The capsule — `FloatingAction`
- Add a `shape: "rounded" | "pill"` prop (default `"rounded"`, so the other callers are unchanged).
- The floating bar uses `variant="outlined"` + `shape="pill"` + `pad="2xs"` (4px). The card is then always present, collapsed or open, as in the prototype: hairline ring, blurred translucent ground, soft shadow.
- If outlined's `bg-background/80` + `shadow-sm` don't match the prototype's 72% glass (`blur 18px saturate 1.6`, deeper shadow) on screenshot, I'll add a `"glass"` variant instead of hand-styling at the call site.
- The hitbox already measures the panel chrome, so the padding is accounted for. I'll verify this with `collapsed-mark.ts` and `solo-safe-area.ts`.

### 2. One control height — the host picks the slot's density
- `defineRenderSlot`'s `controlSize` is the slot's default. `.Render` gets an optional `controlSize` prop so a host can choose the density for the **whole** slot. Every item still shares one height, so the enforcement stays intact.
- The floating host renders `ActionBar.Item.Render controlSize="md"` and `ActionBar.Glance.Render controlSize="md"`. `HealthItem` takes the same size. The chrome's md is the default 2rem = 32px, which inside a 40px capsule is exactly the prototype.
- The docked strip stays sm (26px in the 36px tab bar).
- Row gap goes from `gap-sm` to `2xs` (the prototype uses 2px); drop the `pr-sm` tail.

### 3. Separators — divider nodes in the order config, made orientation-aware
- `config/shell/action-bar/item.jsonc` becomes: bell, `divider`, (hidden screenshot / draw), theme, gear, build, `divider`, improve. The no-op `spacer` is removed, so there is no separator or extra gap between the gear and Build. The bar still names no contributor.
- `DividerReorderItem` (`reorder/plugins/editor/web/internal/items.tsx:349`) only draws a horizontal `border-t` today. It will read `ReorderAreaContext.orientation`, which the DnD middleware already measures from the host's flex direction. In a horizontal area it draws a vertical 1px hairline: 18px tall (about 0.56 × control height), `border-border`, with xs inline margin.
- Update the divider legend line in `REORDER_NODE_LEGEND` ("between the items either side of it").

### 4. Build + Reload as one control — `build/web`
- Replace the frame `ButtonGroup` with a **tray**: a pill with a faint fill (`bg-hover-fill`, the prototype's 5% white), 32px tall (control height), holding:
  - the status as a ghost text button: spinner, "Building" plus elapsed time in `text-muted-foreground`, "Server restarting…", "Server updated", or "Build failed" with a `destructive-solid` dot;
  - then the Reload pill nested at its end.
- When the build failed, the tray gets an inset 1px `destructive-solid/45` ring.
- The idle and quiet state stays the bare ghost wrench.
- **Merge `ReloadSegment` and `ReloadChip` into one `ReloadButton`**: a same-height filled pill (`bg-info-solid` or `bg-destructive-solid`, light foreground, semibold, 14px refresh icon, subtle inset highlight, hover lightens). The collapsed glance renders the same tray holding only `ReloadButton`, so it is literally the same control in both states.
- The tray is one internal component reused by `BuildButton` and the glance.
- Copy and logic (`reload-copy.ts`, `useReloadAdvice`) are untouched.

### 5. Improve as a quiet bar button — `improve`, `element-picker`
- Both segments switch from `variant="frame"` to `ghost` inside the same `ButtonGroup shape="pill"`, which still gives the split rounding.
- The label is in `text-foreground` and the icons dim, brightening on hover. There is no fill and no outline.

### 6. Badge — `bell-button.tsx`
- Follow the prototype's placement: the badge's top-left sits at about (top 2px, left 17px) of the 32px button, so it hangs off the glyph's top-right corner instead of covering it.
- It gets a 2px ring in the bar ground, 9.5px tabular figures, and `bg-destructive-solid text-destructive-solid-foreground` in the error state.

### 7. Docs
- `chrome-theme/CLAUDE.md`: remove the "framed pills (Improve, Build) are `variant=frame`" paragraph and document the solid fills (navy and oxblood, light text, where they are used, and why `info` / `destructive` stay bright).
- `global-action-bar/CLAUDE.md`: describe the capsule, md density and dividers.
- `build`'s docs: describe the tray.

**Scope note:** Build, Reload, Improve, the badge and the dividers are shared `ActionBar.Item`s, so the docked tab-bar strip picks up the same look at its sm height. One design for both hosts is intended; the capsule and md height are floating-only.

## Tests to update
- `build/web/__tests__/reload-chip.test.tsx`: assert `bg-info-solid` / `bg-destructive-solid`, against the merged `ReloadButton`.
- `notifications/web/__tests__/bell-button.test.tsx`: assert `bg-destructive-solid`; `bg-warning` is unchanged.
- New: a slot-render test that `Render controlSize` overrides the declared size for every item. Optionally, a divider render test for each orientation.

## Verification
1. `./equin build` (runs checks: type-check, eslint including `no-adhoc-layout` / `no-button-shadow`, token-group sync, plugins-doc-in-sync).
2. `./equin test plugins/build plugins/shell/plugins/notifications plugins/primitives/plugins/slot-render plugins/reorder`.
3. `./equin run plugins/shell/plugins/global-action-bar/e2e/collapsed-mark.ts`, `solo-safe-area.ts` and `focus-restore.ts`. These cover behaviour, the stable `data-health` / aria-labels / ring svg, and the safe area.
4. Screenshots in solo mode with `screenshot.ts --viewport 1280x900` (collapsed and hovered), in each state I can produce: idle, building, Server updated + stale Reload, and failed if available. Compare them against the prototype's state gallery, and specifically judge (a) the dark badge against the bar and (b) the broken ring's visibility.
5. Spot-check the docked strip in desktop mode, and confirm no other chrome surface changed (notification panel, build popover and crash chip still use the bright tokens).
