# Surface placement → composable sub-plugins

## Context

The per-tab "surface placement" system (docked / floating / solo) is a monolith. A
closed union `Placement = "docked" | "floating" | "solo"` lives in `plugins/apps/core/types.ts`,
and `plugins/apps/plugins/surface/` hardcodes ~11 `switch`/`if` sites that branch on it
(container CSS, geometry box, content inset, window chrome, solo portal, desktop
wallpaper, Esc-to-exit, the 3-way control's options, tear-off target, new-tab target,
theme-scope). Adding or removing a placement means editing all of them — and the closed
union means a placement *can't* be added by a plugin at all.

This violates the project's composability goal: each surface should be its own
removable/addable sub-plugin under `plugins/apps/plugins/surface/plugins/<name>/`, with the
`surface` plugin reduced to a generic registry + dispatcher that never names a specific
placement (collection-consumer separation).

The refactor also folds in the **coupled correctness fix** for the bug that started this
thread: in desktop mode, picking an app from Home opens it "in the background" because
`replaceTabAppWithRoute` resets placement to docked and the launcher targets the global
focused tab instead of its own.

Intended outcome: `docked`, `floating`, `solo` each become a self-contained sub-plugin;
deleting one cleanly drops its segment/behavior with zero edits elsewhere; a new placement
can be added by dropping a sub-plugin.

## Design

### The single new abstraction: `Surface.Placement` slot

`surface` owns a slot whose contributions are **placement descriptors** — mostly data plus
an optional chrome component. The descriptor approach (vs. one wrapping component per
placement) is mandatory to preserve **keep-alive**: today there is exactly one
`<TabSurface>` per tab whose React parent chain is identical across every placement, so a
dock↔float↔solo transition never remounts it (preserves scroll/editor/playing state,
`surface-body.tsx:95-100`). A per-placement *wrapping* component would change the parent
chain and remount `TabSurface`. The descriptor keeps one stable container per tab and only
varies data (class/style/portal/chrome).

```ts
// plugins/apps/plugins/surface/web/slots.ts  [NEW]
export interface PlacementChromeProps {
  tabId: string; appId: string; title: string | undefined; focused: boolean;
  onClose: () => void;
  onExitToDefault: () => void;   // switch this tab to the registry default placement
}

export interface PlacementDef {
  id: string;                    // also the value stored on tab.placement
  label: string;                 // control tooltip
  icon: ComponentType<{ className?: string }>;
  order: number;                 // control order + default resolution
  default?: boolean;             // exactly one; the registry's default placement

  containerClassName: string;            // static class on the stable container
  portalToBody?: boolean;                // escape the transform-gpu backdrop (solo)
  visibleWhenUnfocused?: boolean;        // floating windows stay visible unfocused

  // Optional sibling overlay (NEVER a parent of TabSurface). May also push dynamic
  // inline container/inset style to the host via usePlacementStyle() — this is how
  // floating's geometry box lives in the floating plugin, not the shared host.
  Chrome?: ComponentType<PlacementChromeProps>;
  Backdrop?: ComponentType;              // rendered once when >=1 tab uses this placement

  // Capabilities consumed generically by apps-side chrome (no string compares):
  themeScope?: "app";                    // focused tab => chrome wears the app theme
  tearOffTarget?: boolean;               // dragging a chip out of the strip => this placement
  newTabFollows?: boolean;               // `+` opens new tab in this placement when focused tab uses it
}

export const Surface = { Placement: defineSlot<PlacementDef>("apps.surface.placement") };
```

### Keep-alive + dynamic style: the context-setter mechanism

The crux is floating's geometry-derived box: it must live in the `floating` plugin, yet it
styles the host-owned container `<div>`. We **cannot** have the host call a per-placement
style *hook* (calling hooks in a `.map()` over defs trips `react-hooks/rules-of-hooks`,
enforced repo-wide), and we **cannot** use a portal-frame (stale-target flash on frame
swap). Instead:

- The host (`TabContainer`) owns one stable container per tab and a small
  `useState` for an **override style + inset** (initially null).
- The active placement's optional `Chrome` sibling computes dynamic style from its own
  hooks and pushes it up via a host-provided context (`usePlacementStyleSetter()`),
  **clearing it on unmount** (effect cleanup). Floating's `Chrome` calls
  `useWindowGeometry(tabId)`, pushes the box + titlebar inset, and renders `WindowChrome`.
  Docked/solo have static class only (no dynamic style); solo's `Chrome` is just the exit
  button.
- Host container style = `{ display: visible ? "block" : "none", ...override }`, where
  `visible = def.visibleWhenUnfocused || focused`. When floating's Chrome unmounts
  (placement→docked), its cleanup resets override → the default visibility gate applies.
- `def.portalToBody ? createPortal(container, document.body) : container` — identical to
  today's solo path, just renamed from a `=== "solo"` check.

`Chrome` mounts/unmounts freely on placement change (it is a sibling, not a parent of
`TabSurface`), so keep-alive is preserved. Hook order is stable: the host always calls the
same hooks; each `Chrome` always calls its own fixed hooks.

Focus + raise-to-front (today floating-only `onPointerDownCapture`) is plumbed through the
same context: floating's `Chrome` registers an `onContainerPointerDownCapture` that the
host wires onto the container; it calls the host-provided `onFocus` + floating's
`bringToFront`.

### `SurfaceBody` becomes a generic dispatcher

- `const defs = Surface.Placement.useContributions()` → memo sort by `order`; build `byId`;
  `defaultId = defs.find(d => d.default)?.id ?? defs[0]?.id`.
- Per tab: `<TabContainer key={tab.tabId} def={byId.get(tab.placement) ?? byId.get(defaultId)} .../>`.
  `key` is `tabId` only — never placement — so changing placement re-renders the same
  instance.
- Backdrops: for each def with a `Backdrop`, render it once iff
  `tabs.some(t => resolve(t.placement).id === def.id)` (replaces `desktopMode` wallpaper).
- Empty-registry fallback: if `defs.length === 0`, render each tab with a built-in
  `"absolute inset-0 bg-background"` + visibility gate (mirrors the existing
  `FramedSurface` "no Surface contributor → AppTabsBody" degradation). Control renders
  nothing.
- Self-heal: if `!byId.has(tab.placement)` (placement plugin removed), one-shot effect
  `setPlacement(tabId, defaultId)`.

### The placement control derives from contributions

`placement-control.tsx`: drop the hardcoded `OPTIONS` + icon imports. Map
`Surface.Placement.useContributions()` (sorted by `order`) to `SegmentedControl<string>`
options `{ id, icon: <d.icon/>, title: d.label }`. `value={useFocusedPlacement()}`,
`onChange={setFocusedTabPlacement}` (both still from `@plugins/apps/web`). Render nothing if
no defs.

### `apps`-owned capability registry (so `apps` never imports `surface`)

`apps` cannot import `surface` (would cycle — `surface` imports `apps`). The apps-side
chrome (`app-tab-bar`, `use-chrome-theme-scope`, `use-tabs` default) needs: default id,
tear-off target, new-tab-follows set, theme-scope-app set. Add a tiny registry **owned by
apps, written by surface**:

```ts
// plugins/apps/web/internal/placement-registry.ts  [NEW] (re-exported from apps/web barrel)
registerPlacementCapabilities(caps: { defaultId; tearOffId?; newTabFollows: Set<string>; appThemeScope: Set<string> })
getDefaultPlacement(): string                 // "" until registered
useDefaultPlacement(): string
tearOffPlacement(): string | undefined
placementIsNewTabFollows(id: string): boolean
placementHasAppThemeScope(id: string): boolean
```

`SurfaceBody` calls `registerPlacementCapabilities(derive(defs))` in a `useMemo` keyed on
`defs`. Dependency direction stays `surface → apps`. Accepted seam: on the very first
commit the tab bar may read defaults before surface registers (no user interaction happens
in frame 0; self-corrects immediately).

### How each hardcoded site becomes generic

| Site (file) | Today | After |
|---|---|---|
| `surface-body` containerClass/placementStyle/contentInset | `switch(placement)` | `def.containerClassName` + context-pushed override |
| `surface-body` floating chrome / solo button | inline `floating`/`solo` checks | `def.Chrome` |
| `surface-body` solo portal | `placement==="solo"` | `def.portalToBody` |
| `surface-body` desktop wallpaper | `tabs.some(==="floating")` | per-def `Backdrop` presence rule |
| `placement-control` OPTIONS | hardcoded array | `Surface.Placement.useContributions()` |
| `surface/index` Esc shortcut | here, `==="solo"`→`"docked"` | moves into `solo` plugin (self-reference allowed) |
| `app-tab-bar` `+` target | `desktopMode?"floating":"docked"` | `placementIsNewTabFollows(focused)?focused:getDefaultPlacement()` |
| `app-tab-bar` drag-out | `setPlacement(id,"floating")` | `setPlacement(id, tearOffPlacement())` |
| `use-chrome-theme-scope` | `placement==="docked"` | `placementHasAppThemeScope(focused.placement)` |
| `use-tabs` DEFAULT_PLACEMENT | constant | `getDefaultPlacement()` |
| `replaceTabAppWithRoute` placement | `DEFAULT_PLACEMENT` (**bug**) | preserve existing tab's placement |

### `apps/core` Placement change

- `apps/core/types.ts`: remove `DEFAULT_PLACEMENT`; change `Placement` to an opaque
  `type Placement = string` (kept as a named alias for intent at call sites). Rewrite the
  doc comment: placement is an opaque id owned by the `surface` registry; `apps` stores and
  routes it but never enumerates the set or the default. Update `apps/core/index.ts` barrel
  (drop the `DEFAULT_PLACEMENT` re-export). No branding — ids are already persisted as plain
  strings; branding adds ceremony for no safety.

## Files

**New**
- `plugins/apps/plugins/surface/web/slots.ts` — `Surface.Placement` slot + `PlacementDef` + chrome props + the `usePlacementStyle` context.
- `plugins/apps/web/internal/placement-registry.ts` — apps-owned capability registry (re-exported from `apps/web`).
- `plugins/apps/plugins/surface/plugins/docked/{package.json, web/index.ts, web/docked-placement.tsx}` — `default:true`, `themeScope:"app"`, `containerClassName:"absolute inset-0 bg-background"`.
- `plugins/apps/plugins/surface/plugins/floating/{package.json, web/index.ts, web/floating-placement.tsx}` plus **moved** `web/hooks/use-window-geometry.ts`, `web/components/{window-chrome,window-resize-handles,desktop-wallpaper}.tsx`. Def: `visibleWhenUnfocused`, `tearOffTarget`, `newTabFollows`, `Backdrop=DesktopWallpaper`, `Chrome` owns geometry + pushes box/inset style + raise-on-pointerdown.
- `plugins/apps/plugins/surface/plugins/solo/{package.json, web/index.ts, web/solo-placement.tsx}` — `portalToBody`, `containerClassName:"fixed inset-0 z-overlay bg-background"`, `Chrome`=hover exit button → `onExitToDefault`; `web/index.ts` also contributes the Esc shortcut (`when` may name `"solo"` — self-reference).

**Edited**
- `plugins/apps/plugins/surface/web/components/surface-body.tsx` — generic dispatcher + context-setter `TabContainer`; delete the three `*Style` fns, the `floating`/`solo` literals, the geometry import.
- `plugins/apps/plugins/surface/web/components/placement-control.tsx` — options from contributions.
- `plugins/apps/plugins/surface/web/index.ts` — keep `Apps.Surface` + `ActionBar.Item`; remove the Esc shortcut + geometry/chrome/wallpaper imports.
- `plugins/apps/core/types.ts`, `plugins/apps/core/index.ts` — opaque `Placement`, drop `DEFAULT_PLACEMENT`.
- `plugins/apps/web/internal/use-tabs.tsx` — `getDefaultPlacement()` at every former `DEFAULT_PLACEMENT` site; **fix `replaceTabAppWithRoute` (line ~360) to preserve the tab's existing placement**.
- `plugins/apps/web/components/app-tab-bar.tsx` — `+` and drag-out via capability registry.
- `plugins/apps/web/internal/use-chrome-theme-scope.ts` — `placementHasAppThemeScope`.
- `plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx` — **coupled fix**: target own tab via `useSurfaceTabId()` (`@plugins/primitives/plugins/surface-id/web`), falling back to `focusedTabId`. (The rail showed no `replaceTabApp` usage — no edit needed.)

## Reused existing pieces
- `defineSlot` / `useContributions` (`framework/web-sdk`) — the slot mechanism.
- `createPortal` keep-alive trick — already proven by today's solo path.
- `useWindowGeometry`, `WindowChrome`, `DesktopWallpaper` — moved verbatim into `floating`.
- `useFocusedPlacement` / `setFocusedTabPlacement` / `getFocusedPlacement` (`apps/web`) — unchanged.
- `useSurfaceTabId` (`primitives/surface-id`) — for the launcher own-tab fix.
- `SegmentedControl` (`primitives/toggle-chip`) — control rendering.

## Risks / edge cases
- **Unknown persisted placement** (plugin removed): renders under default; self-heal effect rewrites `tab.placement`.
- **Hook order**: host hooks are fixed; each `Chrome` calls only its own hooks; no hooks-in-loops (the rules-of-hooks trap the descriptor avoids).
- **Portal flash (solo)**: unchanged from today — same `createPortal` re-parent, no extra commit.
- **Capability registration seam**: one-frame default before surface registers; invisible (no frame-0 interaction). Fallbacks are sane.
- **Empty registry / theme scope pre-registration**: built-in docked-like fallback; neutral chrome for one frame.
- **Cycle check**: placements import `@plugins/apps/plugins/surface/web` (child→parent) + `apps`; `surface`→`apps`; `apps`↛`surface`. Acyclic.

## Verification

Build/static:
1. `./equin build` — discovers the 3 sub-plugins, regenerates registry + docs; must pass `plugins-registry-in-sync`, boundaries, `type-check`.
2. `grep -n 'docked\|floating\|solo' surface-body.tsx placement-control.tsx use-tabs.tsx app-tab-bar.tsx use-chrome-theme-scope.ts` → **zero** placement string literals in consumers.
3. `grep -rn DEFAULT_PLACEMENT plugins/` → zero hits.

Behavior (Playwright, via `e2e/screenshot.mjs` against `http://att-1781532797-oj0x.localhost:9000`):
4. **Keep-alive**: type unsaved text into an editor / set a scroll offset; cycle docked→floating→solo→docked via the control; assert the value/offset survives each transition (no remount).
5. **Floating**: drag titlebar, min/max/close; reload → geometry persists (`app-windows:<tabId>`).
6. **Solo**: Esc and the hover exit button both return to docked (default).
7. **`+`**: focused floating → "New window" (floating); focused docked → "New tab" (docked). Drag a chip out → it floats.
8. **Theme scope**: focused docked → chrome wears app theme; focus floating → neutral.
9. **Original bug**: float a tab, pick an app from Home in it → stays floating (not reset to docked, not opened in background). With two tabs, activating a card in the Home tab swaps the Home tab, not another focused tab.

Removability (the payoff):
10. Delete `.../surface/plugins/floating/`, `./equin build`, reload: control shows only Docked + Solo; drag-out no-ops cleanly; a persisted floating tab renders docked + self-heals; `apps` untouched; no build/boundary errors. Restore after.
11. Delete `.../solo/`: Esc shortcut and third segment gone, zero edits elsewhere.
