# DataView: compact chrome, hover-revealed options, single-line list rows

**Date:** 2026-08-19
**Category:** global (primitive: `primitives/data-view`; first customer: `build`)

## Context

The DataView's default chrome is visually heavy. Every surface that hosts one pays
for a full toolbar row — a search box, three labelled control pills, the view
switcher — even when the surface is a small popover showing ten rows.

There is already a lighter form: the **compact fold**, where search and every
control collapse behind one `MdTune` "View options" trigger. Today it is reached
*only* by accident of measurement — `DataViewToolbar` measures itself and folds
below `COMPACT_BREAKPOINT` (360px). A surface cannot ask for it. That is why the
narrow conversations sidebar gets the light form and a 672px-wide popover cannot.

Three things follow from that, plus one consumer:

1. **A surface must be able to ask for compact chrome**, independent of its width.
2. **The "View options" trigger should be hover-revealed**, so a surface at rest
   shows only its data.
3. **List rows should be one line, not two.** The default list row stacks a title
   line over a subtitle line (`● Success · auto · main`), which reads as twice the
   content it carries.
4. **The Build popover** currently hand-rolls its own ten-row `Row` list
   (`BuildHistoryExcerpt`), a deliberate duplicate of the `/debug/build` DataView
   because "the popover has no room for the view toolbar". Compact chrome removes
   that reason, so the duplicate goes away and both surfaces render the same
   DataView.

### What already synchronizes (do not rebuild)

Two DataViews sharing a `storageKey` **already** share their durable state today,
reactively, through `config_v2`: the view instances (tabs), their names and order,
and each instance's `sort` / `filter` / `groupBy` / `visibleFields`. The Build
popover and the `/debug/build` pane both use `defineDataView("build.history")`, so
rendering the DataView in the popover gets that synchronization for free — no new
code.

**Out of scope by decision:** the *device-local* half — active tab
(`${storageKey}:active-view`), search query, tree expand map, collapsed sections —
does **not** sync between two simultaneously-mounted copies. Each mount holds its
own `useState` copy seeded from Web Storage (`view-switcher/web/internal/use-active-view.ts`,
`data-view/web/internal/use-view-ephemeral.ts`), so a write in one mount does not
reach the other until it remounts. Fixing this needs a shared reactive store per
storage key; the user chose to leave it for now. Concretely: switching tabs in the
Build popover will not move the pane's tab while both are open.

## Design

### 1. `density` — the per-surface prop

Add to `DataViewProps` (`data-view/core/internal/types.ts`):

```ts
/** How much room this surface gives the view. "comfortable" (default) is the
 *  full inline toolbar; "compact" folds every control behind the one options
 *  trigger regardless of measured width, and tightens the row density. A narrow
 *  surface still folds on its own — density only removes the need for room. */
density?: "comfortable" | "compact";
```

It threads through exactly one path, so both hosts (`DataView` and
`MergedDataView`) get it from one place:

```
DataViewProps.density
  → DataViewShellFrame prop
    → DataViewShellChrome.density        (web/internal/body-types.ts)
      → DataViewBody
        ├→ DataViewToolbar               folded = density === "compact" || width < COMPACT_BREAKPOINT
        └→ DataViewRenderProps.density   the view child tightens itself
```

`DataViewRenderProps` gains the same field, so a view child can honour it. The
list child uses it for one thing: `size = options.size ?? (compact ? "sm" : "md")`.
Table and gallery ignore it for now — that is a deliberate no-op, not an omission.

### 2. Single-line list rows — the new default

`ListView` (`data-view/plugins/list/web/components/list-view.tsx`) currently builds
its row body as a `<Stack>` of two `<Text>` blocks. Replace it with one line:

```
[icon]  Title · subtitle · fields                      trailing   [actions]
```

`Row` already composes `Line`, so the row body is already a `region-line`
single-line context with a `SingleLineProvider` — the title and subtitle become
sibling truncating leaves in it, with an empty `<Fill>` absorbing the slack before
the trailing cell (the structural replacement for today's `ml-auto`). The subtitle
keeps its existing `·` join and `text-muted-foreground` caption styling; the
trailing cell (`align: "end"` fields + the `×N` aggregate badge) is unchanged.

Intent for the truncation order: the title identifies the row, so the **subtitle
gives way first** when the line is tight.

The stacked form stays reachable — add to `ListViewOptions`
(`data-view/plugins/list/core/internal/types.ts`):

```ts
/** Rows per item: 1 (default) puts title and subtitle on one line; 2 stacks the
 *  subtitle under the title — for surfaces whose subtitle is prose, not chips. */
lines?: 1 | 2;
```

**Blast radius is small.** Every high-traffic list surface already overrides the
row body wholesale via `viewOptions.list.renderRow` and is therefore untouched:
the conversations sidebar (queue + history), mail threads, the events list, the
events sources list, deploy history, extracted events. What changes is the
field-driven default — build history, reports, slow-ops, workflow executions,
studio compositions, backlinks, config-orphans and similar.

Read the `css` SKILL before writing this row; the layout is exactly the
container-shares-space / leaves-truncate model it documents.

### 3. Hover-revealed "View options"

Use the **CSS-group** half of the `hover-reveal` primitive
(`hoverRevealGroup` / `hoverRevealTarget`), not `useHoverReveal()`. The state hook
would re-render the whole DataView on every pointer enter/leave of the surface;
the class pair is pure CSS and costs nothing on a long list.

- `DataViewShellFrame`'s root `<Stack>` gets `hoverRevealGroup`, so hovering
  **anywhere over the surface** (toolbar or rows) reveals the trigger.
- `CompactControls` wraps its trigger in `hoverRevealTarget` — which already
  couples `opacity` with `pointer-events`, so the hidden trigger is never an
  invisible click-target, and already reveals on its own keyboard focus.

The trigger must **not** hide when it is carrying information:

```ts
const alwaysVisible = open || activeCount > 0;
```

`activeCount > 0` means a filter, sort or query is narrowing the view — hiding the
only indication of that would make a narrowed list read as the whole list. `open`
keeps it painted while its own popover is up (the popover is portaled, so the
pointer leaves the group as soon as it moves into the panel).

This applies to the compact fold wherever it appears, including today's
width-folded narrow surfaces — the conversations sidebar's options button becomes
hover-revealed too. That is intended: one fold, one behaviour.

**The bar stays in flow.** In compact mode it is a thin strip holding the view
tabs (shown when there is more than one instance) with the hidden trigger at its
end. It reserves ~28px even when it looks empty, and never paints over row content.

### 4. First customer: the Build popover

In `plugins/build/web/components/build-popover-content.tsx`:

- **Delete `BuildHistoryExcerpt`** entirely, along with its
  `data-view/no-adhoc-row-list` lint suppression — the suppression's stated reason
  ("no room for the view toolbar") no longer holds.
- The `"popover"` branch of `BuildPopoverContentInner` renders `BuildLogView` then
  `BuildHistoryDataView` with `density="compact"`.
- `BuildHistoryDataView` takes a `density` prop and gains
  `viewOptions={{ list: { leading: (r) => <BuildStatusDot run={r} /> } }}` — the
  status dot as the row's leading slot, matching the target design. `BuildStatusDot`
  is already exported from `@plugins/build/plugins/build-status/web` and is what
  the excerpt used.
- **The popover must supply the scroll.** A DataView is always natural-height and
  never owns a scroller. `OverlayPanel` is itself `overflow-y-auto`, so the
  single-scroll dev guard is satisfied either way — but without a cap the fifty-run
  slice scrolls the *whole* popover (controls and log view included) instead of the
  history region. So the history gets an explicit `<Scroll axis="y">` capped at
  `max-h-64`, matching the log view's `h-48` above it.
- **The chrome-mask guard needs nothing.** (Corrected during implementation — the
  plan originally called for a `<Surface level="overlay">` wrapper here.) The
  popover chain already co-publishes: `InlinePopover` → `PopoverContent` →
  `OverlayPanel`, whose root applies `SURFACE_LEVELS.overlay` — one bundle carrying
  both `bg-popover` and `[--chrome-mask:var(--popover)]`, on the same element. A
  `Surface` inside it would paint a second inset panel (`rounded-lg`, `shadow-md`,
  `ring-1`) that then had to be cancelled class by class.

Rows render as `● 27m ago · auto    20m 15s` — one line, status as the leading dot,
duration right-aligned.

Optionally trim the authored `"Recent"` view in `config/build/build.history.jsonc`
to `"visibleFields": ["startedAt", "trigger", "duration"]`, so the status is told
once (the dot) rather than twice. This is shared config: it applies to the pane as
well, which is the point of the shared `storageKey`.

## Files

**Primitive — `plugins/primitives/plugins/data-view/`**

| File | Change |
| --- | --- |
| `core/internal/types.ts` | `density` on `DataViewProps` and `DataViewRenderProps` |
| `web/internal/body-types.ts` | `density` on `DataViewShellChrome` |
| `web/components/data-view.tsx` | accept + thread `density`; `hoverRevealGroup` on the shell root |
| `web/components/merged-data-view.tsx` | accept + forward `density` |
| `web/components/data-view-body.tsx` | `chrome.density` → toolbar + `renderProps.density` |
| `web/components/toolbar/data-view-toolbar.tsx` | `folded = density === "compact" \|\| width < COMPACT_BREAKPOINT` |
| `web/components/toolbar/compact-controls.tsx` | `hoverRevealTarget` on the trigger, `alwaysVisible = open \|\| activeCount > 0` |
| `plugins/list/core/internal/types.ts` | `lines?: 1 \| 2` |
| `plugins/list/web/components/list-view.tsx` | single-line row body; `size` default from density |
| `CLAUDE.md` | document `density`, the fold rule, the hover-reveal, and `lines` |

**Consumer — `plugins/build/`**

| File | Change |
| --- | --- |
| `web/components/build-popover-content.tsx` | delete `BuildHistoryExcerpt`; popover renders the compact DataView inside `<Surface level="overlay">` + `<Scroll axis="y">` |
| `config/build/build.history.jsonc` | (optional) trim `"Recent"`'s `visibleFields` |

Reused, not rebuilt: `hoverRevealGroup`/`hoverRevealTarget`
(`primitives/hover-reveal/web`), `Line`/`Fill`/`Clip`/`Text`
(`primitives/css/plugins/*`), `Row` (`primitives/css/plugins/row/web`),
`Surface`, `Scroll`, `BuildStatusDot`.

## Verification

1. `./equin build` (background — median ~10 min), then confirm
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
2. `./equin check` — `plugins-doc-in-sync` and the `data-view`/`hover-reveal`
   lint rules are the ones this touches.
3. `./equin test plugins/primitives/plugins/data-view` — the existing
   `list/web/__tests__/inline-edit.test.tsx` covers the row body being reshaped.
4. In the app at `http://<worktree>.localhost:9000`:
   - **Build popover** — click the toolbar **Build** button. History renders as the
     DataView: single-line rows, status dot leading, duration right. The options
     trigger is invisible at rest and appears on hover over the popover. Apply a
     filter, move the pointer away — the trigger stays visible with its count badge.
   - **`/debug/build` pane** — rows are single-line; the toolbar is the full inline
     form (comfortable). Add a filter in the pane, reopen the popover: the filter is
     there (config sync). Note the known gap: switching *tabs* in one does not move
     the other while both are open.
   - **Conversations sidebar** — unchanged rows (it uses `renderRow`), but its
     options button is now hover-revealed.
   - **A field-driven list that is not build** — e.g. Debug → Reports — to confirm
     the single-line default reads well where the subtitle carries several fields.
5. Screenshot the popover for a before/after against the target design:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/debug/build --click "Builds" --out /tmp/build-popover
   ```
