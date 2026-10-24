# Global action bar: floating-by-default + pin-to-dock, placement control as an action

## Context

The previous change (`research/2026-06-14-global-tab-bar-action-bar.md`) deleted the
global floating bar and moved the shared `ActionBar.Item` set **into the tab bar**
(`Apps.TabBarActions`) as a new `global-action-bar` plugin. Pinned = action row expands
inline (compresses the tab strip); unpinned = hover-expand overlay over the strip. The
surface's 3-way placement control (docked / floating / solo) was **hardcoded** into
`Apps.TabBarActions`.

User feedback (this conversation) — three problems with that result:

1. **Actions disappear in solo (fullscreen) mode.** Solo portals the focused tab to
   `<body>` as `fixed inset-0 z-overlay`, covering the tab bar — and with it the action
   bar, which now lives *in* the tab bar. The old floating bar mounted globally via
   `Core.Root` at `z-popover` (above solo), so it stayed visible. **Restore the floating
   behavior.**
2. **Pinning should be a docked strip, not inline-in-strip.** When pinned, the actions
   should sit as a right-aligned strip in the tab-bar row (≈ today's pinned look), not
   compress the tab strip.
3. **The tab/solo/desktop control should be a floating-action contribution**
   (`ActionBar.Item`), not hardcoded in the tab bar.

This is the design the codebase was already built for: `apps/web/internal/use-tabs.tsx`
exposes a module-level focused-placement store (`useFocusedPlacement()` /
`setFocusedTabPlacement()` / `getFocusedPlacement()`) whose own comments say it
"Backs the **floating-bar placement control** + solo exit" — i.e. a provider-free way
for a globally-mounted bar to read/drive the focused tab's placement. The 2026-06-14
plan diverged from that; this plan returns to it.

### Resolved behavior (confirmed with user)

- **Unpinned → floating overlay.** Global, `fixed top-2 right-3 z-popover`, collapsed to
  the status glyph, hover-expands the action row leftward. Visible in **every** placement
  mode, including solo.
- **Pinned → docked strip in the tab-bar row.** Right-aligned, non-compressing (the tab
  strip scrolls under it). "This should be the current behavior."
- **Solo + pin interaction.** Pinning forces the focused tab out of solo into tab
  (docked) mode, so the pinned strip is visible ("when pinned, switch to tab mode with
  the actions pinned to the top tab bar"). Concretely: pinned ⇒ never solo.

## Design

The `global-action-bar` plugin gains **two mount points**, mutually exclusive on the
shared persisted pin (`useDraft("action-bar-pinned")`, synced across components via the
persistent-draft primitive):

- **`Core.Root` host — the floating overlay.** Renders only when **not** pinned. This is
  the restored floating bar: reuse the old `floating-bar.tsx` body verbatim
  (`FloatingAction` `anchor="top-right"` at `fixed top-2 right-3 z-popover` + status glyph
  + `FloatingActionFadeIn` wrapping `<ActionBar.Item.Render/>` + the pin button). Mounting
  at `Core.Root` (renders in `web-core/App.tsx` at `#root`, no `transform-gpu` ancestor)
  puts it in the body stacking context at `z-popover` (50) — above the solo portal's
  `z-overlay` (40), so it stays visible in solo. Proven by the prior floating bar.
- **`Apps.TabBarActions` host — the docked strip.** Renders only when pinned: a plain
  `flex items-center gap-sm` row (status glyph + `<ActionBar.Item.Render/>` + pin button)
  in the tab bar's trailing zone (where `AppTabBar` already calls
  `<Apps.TabBarActions.Render/>` after a `flex-1` spacer). The tab strip's own
  `overflow-x-auto` lets tabs scroll under it.

Both hosts share one `BarContent` fragment (status glyph + action row + pin toggle) so
the markup never drifts. The pin button lives in `BarContent` and is present in both.

**Pin ↔ solo coupling** (kept inside `global-action-bar`, which owns the pin — the
placement control stays generic and pin-unaware):

- Pin toggle handler, when turning pinned **on**: also call
  `setFocusedTabPlacement("docked")` if `getFocusedPlacement() === "solo"`.
- A guard effect in the host: while `pinned && useFocusedPlacement() === "solo"`, call
  `setFocusedTabPlacement("docked")`. This makes "pinned ⇒ never solo" hold even if solo
  is selected from the placement control afterwards (it snaps back to docked). Both
  helpers are provider-free, imported from `@plugins/apps/web`.

**Placement control → `ActionBar.Item`** (point 3). Rewrite
`surface/web/components/placement-control.tsx` to drop `useTabs()` and instead use
`useFocusedPlacement()` (reactive, provider-free) for the value and
`setFocusedTabPlacement()` for the change. It then renders correctly inside **either**
host — the `Core.Root` floating overlay (outside `TabsProvider`) or the tab-bar docked
host (inside it). Move the contribution from `Apps.TabBarActions` to `ActionBar.Item`.

## Files

### Edit `plugins/shell/plugins/global-action-bar/web/components/global-action-bar.tsx`
- Replace the single `GlobalActionBar` (tab-bar-only, inline-pinned) with:
  - `BarContent({ pinned, onTogglePin, status })` — shared fragment: `StatusGlyph` +
    `<ActionBar.Item.Render/>` + pin `IconButton` (existing `ActionRow`/`StatusGlyph`
    bodies are reusable as-is).
  - `FloatingActionBarHost()` — `useConfig`, `useDraft`, `useActionBarStatus`,
    `useFocusedPlacement`. `if (!enabled || (pinned && placement !== "solo")) return null`
    (so it shows whenever unpinned, **and** as the solo fallback never triggers because
    the guard effect snaps pinned-solo to docked — see note). Simpler final rule:
    `if (!enabled || pinned) return null`. Renders the `FloatingAction` overlay (port the
    old `floating-bar.tsx:72-101` body, `z-popover`).
  - `DockedActionBarHost()` — same hooks; `if (!enabled || !pinned) return null`. Renders
    the `flex items-center gap-sm pl-sm` strip. Includes the guard effect:
    `useEffect(() => { if (pinned && placement === "solo") setFocusedTabPlacement("docked"); }, [pinned, placement])`.
  - `togglePin` (used by both): `setPinned(p => { const next = !p; if (next && getFocusedPlacement() === "solo") setFocusedTabPlacement("docked"); return next; })`.
- Keep `PIN_TTL`, `TONE_CLASS`, `StatusGlyph`, `ActionRow`.

### Edit `plugins/shell/plugins/global-action-bar/web/index.ts`
- Contribute **both**: `Core.Root({ component: FloatingActionBarHost })` (import `Core`
  from `@plugins/framework/plugins/web-sdk/core`) **and**
  `Apps.TabBarActions({ id: "global-action-bar", component: DockedActionBarHost })`.
- Keep `ConfigV2.WebRegister({ descriptor: actionBarConfig })`.

### Edit `plugins/apps/plugins/surface/web/components/placement-control.tsx`
- Drop `useTabs`. Import `useFocusedPlacement, setFocusedTabPlacement, type Placement`
  from `@plugins/apps/web`. The exported `ActionBarPlacementControl` reads
  `useFocusedPlacement()` and calls `setFocusedTabPlacement(p)`. Keep the
  `PlacementSegmented` (the `SegmentedControl` with the 3 icon options) unchanged.
- Remove the now-unused `TabBarPlacementControl`.

### Edit `plugins/apps/plugins/surface/web/index.ts`
- Replace `Apps.TabBarActions({ id: "placement-control", component: TabBarPlacementControl })`
  with `ActionBar.Item({ id: "placement-control", component: ActionBarPlacementControl })`.
- Import `ActionBar` from `@plugins/shell/plugins/action-bar/web`. Keep the
  `Apps.Surface` body contribution and the `surface.exit-solo` Esc shortcut as-is.
- Verify `surface/package.json` lists the `@plugins/shell/plugins/action-bar` workspace
  dep if the boundary/build requires it (mirror how `global-action-bar/package.json`
  references action-bar).

### Build-regenerated / docs
- `web.generated.ts` (new `Core.Root` contributor) — regenerated by `./equin build`.
- `global-action-bar/CLAUDE.md` (two mount points: floating overlay + docked strip; pin
  semantics) and `surface/CLAUDE.md` (placement control now an `ActionBar.Item`,
  provider-free) — keep `plugins-doc-in-sync` green.

## Boundary / cycle check

New cross-plugin edges: `apps/surface → shell/action-bar` (for `ActionBar.Item`) and
`apps/surface → apps` (already present). `shell/action-bar` imports only web-sdk + its own
`slots.ts` (no `apps`, no `surface`), so no cycle. `global-action-bar` already depends on
both `apps` and `action-bar`; adding `Core.Root` (web-sdk) introduces no new edge.
Run `./equin check plugin-boundaries`.

## Verification (Playwright + build)

After `./equin build` (app at `http://att-1781459332-dbtj.localhost:9000`):

1. **Unpinned, any app** (`/home`): trailing edge shows the collapsed status glyph;
   hovering expands the action row leftward as an overlay (tabs don't shift). The
   placement control (docked/floating/solo segmented) appears among the actions.
2. **Solo visibility** (the headline fix): set the focused tab to **solo** (placement
   control → fullscreen icon, or it's covered — use the floating overlay's control). The
   floating bar **remains visible** over the fullscreen app (top-right). Esc still exits
   solo.
3. **Pin → docked strip**: click the pin in the floating overlay. The bar becomes a
   right-aligned strip in the tab-bar row (tabs scroll under it, not compressed). Reload →
   pin persists (localStorage `action-bar-pinned`).
4. **Pin forces tab mode out of solo**: while solo, pin → focused tab snaps to docked and
   the strip shows in the tab bar. While pinned, selecting solo from the control snaps
   back to docked (guard effect).
5. **Agent Manager** (`/agents`): no dedicated top toolbar (already removed); the
   worktree label renders among the actions (it's an `ActionBar.Item`); single mount, no
   duplication between the floating and docked hosts (only one renders per pin state).

Use `e2e/screenshot.mjs --url … --click …` to capture before/after of solo-with-floating,
pin→dock, and the placement control inside the bar.
