# App tab bar: overflow handling + meaningful per-tab titles

## Context

The top app tab bar (`AppTabBar`) renders one chip per open tab in a plain flex
row with **no overflow handling** — with many tabs the strip runs off-screen and
the trailing `+` new-tab button scrolls out of reach. Separately, tabs are
multi-instance (you can open several of the same app), but a tab at its app
*index* shows only the bare app name, so multiple same-app index tabs look
identical and can't be told apart.

Per-tab titles already exist for *deep* panes: `TabTitleReporter` →
`LeafTitleReporter` → `usePaneTitle` publishes the leaf pane's title into the
`titles` record, and the bar shows `titles[tab.tabId] ?? app.tooltip`. The gap is
that when the route is empty (index tab), `useRoute()` returns `null`, there is no
leaf, and the title is cleared — falling back to the app name. The fix extends the
existing machinery to resolve the **index pane**, plus adds overflow handling.

Outcome: the bar gracefully handles many tabs by collapsing inactive tabs to
icon-only when crowded, and every tab derives its label from its active
pane/route (including the index pane).

### Decisions (confirmed with user)
- **Overflow:** Shrink to icon. When tabs don't all fit at full width, inactive
  tabs collapse to icon-only; the active tab keeps its label. No visible
  scrollbar.
- **Same-title tabs:** Leave identical — no ordinal `(2)` suffix. Distinct routes
  already get distinct titles via the index-pane fix; genuinely identical views
  stay identical (they are the same thing).
- **Label:** Content only (app icon already signals the app). Index tabs now show
  the index-pane title instead of the bare app name.

## Fix 1 — Overflow: shrink inactive tabs to icon-only

**File:** `plugins/apps/web/components/app-tab-bar.tsx`

Reuse the existing measurement primitive
`useResponsiveOverflow` (`plugins/primitives/plugins/responsive-overflow/web`)
rather than hand-rolling a ResizeObserver. It renders a hidden, fixed-position
measure strip and returns `visibleCount` = how many of the measured (full-width)
children fit the container. Because the measure strip is independent of the
visible render, there is **no collapse/expand hysteresis**.

Derivation:
```
const { containerRef, measureRef, visibleCount } = useResponsiveOverflow({
  count: tabs.length,
  gap: /* px gap matching the chip gap */,
});
const collapsed = visibleCount < tabs.length;
```

- `measureRef` strip: render a **full-label** chip for every tab (icon + label).
  This measures the width needed to show all labels.
- `containerRef` strip: the actual visible chips. When `collapsed`, inactive
  chips render icon-only (drop the `TruncatingText` label); the active chip always
  keeps its label.
- `collapsed` flips to `true` exactly when full labels no longer fit.

Layout structure (two flex siblings so `+` is always visible):
```
<div className="flex shrink-0 items-center border-b bg-background px-xs py-2xs">
  <div ref={containerRef}
       className="flex min-w-0 flex-1 items-center gap-2xs overflow-x-auto [&::-webkit-scrollbar]:hidden">
    {tabs.map(tab => <TabChip ... collapsed={collapsed && !active} />)}
  </div>
  {/* measure strip from useResponsiveOverflow (portalled, hidden) */}
  <IconButton icon={MdAdd} label="New tab" size="icon-sm" onClick={() => openTab("home")} />
</div>
```

Notes:
- `overflow-x-auto [&::-webkit-scrollbar]:hidden` on the strip is a **safety net**
  for the pathological case where even icon-only tabs overflow — it keeps the bar
  from pushing `+` off-screen while honoring "no visible scrollbar" (matches the
  existing pattern in `community-browser-section.tsx:126`). Normal flow never
  shows a scrollbar.
- The `Stack` wrapper is replaced with a plain `<div>` because the scroll strip
  and `+` must be separate flex siblings (Stack's gap would otherwise apply
  between them). `overflow-x-auto` is **not** banned by `no-adhoc-spacing` (that
  rule only covers gap/padding/margin/space utilities); `rounded-md`/`rounded-sm`
  on chips are token-driven and allowed.
- Each tab chip carries a `ref`; on the active chip, a `useEffect` keyed on
  `focusedTabId` calls `ref.current?.scrollIntoView({ inline: "nearest", block: "nearest" })`
  so focusing a tab that scrolled off (safety-net case) brings it into view.
  Mirrors the existing pattern at `use-tree-row.tsx:128` and
  `command-palette-dialog.tsx:131`.
- Wrap each chip's button in `WithTooltip` (already used by `app-rail.tsx`; root
  `TooltipProvider` is already mounted in `apps-layout.tsx`) showing the full
  label — essential for icon-only collapsed tabs.

### Why not `ResponsiveOverflow` directly / scroll / chevrons
`ResponsiveOverflow` *hides* overflowing children — wrong for tabs (you must be
able to reach every tab). We reuse only its `useResponsiveOverflow` measurement
hook to drive a binary collapse, which matches the chosen "shrink to icon" UX.

## Fix 2 — Index-pane title resolution

**File:** `plugins/apps/web/components/apps-layout.tsx`

When `useRoute()` is `null` (index tab), resolve the app's index pane via the
already-exported `useIndexMatch(basePath)` (`pane.ts:1289`) and feed it through the
existing `LeafTitleReporter` (which calls `usePaneTitle`). The base path is read
from `PaneBasePathContext` (`pane.ts:809`), which `PaneSurfaceProvider` already
provides for each tab. Both symbols are exported from
`@plugins/primitives/plugins/pane/web` (verified in `pane/web/index.ts`).

Change `TabTitleReporter`'s empty-route branch from `<TitleClear>` to a new
`IndexTitleReporter`:
```
function TabTitleReporter({ tabId }) {
  const route = useRoute();
  const leaf = route?.panes.at(-1) ?? null;
  return leaf
    ? <LeafTitleReporter key={leaf.pane.id} tabId={tabId} pane={leaf.pane} params={leaf.fullParams} input={leaf.input} />
    : <IndexTitleReporter key="index" tabId={tabId} />;
}

function IndexTitleReporter({ tabId }) {
  const basePath = useContext(PaneBasePathContext);
  const entry = useIndexMatch(basePath)?.panes[0] ?? null;
  return entry
    ? <LeafTitleReporter key={entry.pane.id} tabId={tabId} pane={entry.pane} params={entry.fullParams} input={entry.input} />
    : <TitleClear tabId={tabId} />;
}
```

This adds **no new title-resolution logic** — it routes the index pane through the
same `usePaneTitle` path, keyed by pane id to keep `useTitle` hook order stable.
Index panes that define `chrome.title`/`useTitle` now surface it; those that don't
(e.g. `chrome: false`) still fall back to `app.tooltip` (correct — those tabs are
genuinely the same view). Per the decision, no ordinal disambiguation and the
label stays content-only, so no further changes.

New imports in `apps-layout.tsx`: `useContext` (react), `PaneBasePathContext` and
`useIndexMatch` (pane web barrel).

Out of scope (deliberately): editing individual pane definitions across plugins,
and a generic "humanize pane id/segment" fallback (low-trust heuristic). Panes
that want a better index label should add `chrome.title` at their definition.

## Files to modify
- `plugins/apps/web/components/app-tab-bar.tsx` — overflow/collapse layout,
  per-chip ref + scroll-into-view, tooltips, icon-only collapsed rendering.
- `plugins/apps/web/components/apps-layout.tsx` — `IndexTitleReporter` + reroute
  the empty-route branch.

Reused (unchanged): `useResponsiveOverflow`
(`primitives/responsive-overflow/web`), `useIndexMatch` / `usePaneTitle` /
`PaneBasePathContext` (`primitives/pane/web`), `WithTooltip`
(`primitives/tooltip/web`), `IconButton`, `TruncatingText`.

## Verification
1. `./equin build`, open `http://<worktree>.localhost:9000`.
2. **Overflow:** Open many tabs via `+` (mix of apps). Confirm inactive tabs
   collapse to icon-only when the row is full while the active tab keeps its
   label, and `+` stays visible. Narrow the window → more tabs collapse; widen →
   labels return. Hover an icon-only tab → tooltip shows its title. Focus a tab;
   if it was off-screen (extreme count) it scrolls into view.
3. **Index titles:** Open two tabs of the same app at its index (e.g. two Pages
   tabs). Confirm each shows the index pane's title (not bare app name) where the
   index pane defines one. Open distinct deep routes (two different conversations)
   → distinct titles, as before.
4. Browser document title (`DocumentTitleSync`) still reads correctly for the
   focused tab.
5. Use `e2e/screenshot.mjs` to capture the crowded bar before/after for a visual
   check. Run `./equin check` (type-check + lint + boundaries).
```
bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/home --out /tmp/tabs
```
