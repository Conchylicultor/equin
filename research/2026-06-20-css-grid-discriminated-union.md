# Grid: make `cols` and `minCellWidth` a discriminated union

**Date:** 2026-06-20
**Plugin:** `plugins/primitives/plugins/css/plugins/grid`
**Source:** [css-primitives-audit](./2026-06-20-css-primitives-audit.md) §8 item 4

## Context

The `<Grid>` layout primitive has two mutually-exclusive geometry paths:

- **Responsive** — `minCellWidth` (+ optional `mode: fill|fit`) → `repeat(auto-fill|auto-fit, minmax(<minCellWidth>, 1fr))`
- **Fixed** — `cols` → `repeat(<cols>, minmax(0, 1fr))`, and `cols` *wins* when both are passed.

But `minCellWidth` is typed **required** for both paths. So every fixed-`cols` caller must pass a dead `minCellWidth` purely to satisfy the type — and they do: nine sites pass the junk value `minCellWidth="0"`, and `health-monitor` passes a *misleading* `minCellWidth="20rem"` that reads as meaningful but is silently ignored. The prop surface lets you write a contradictory call (`cols` + a `minCellWidth` that does nothing), and the dead value invites confusion and copy-paste drift.

**Goal:** make the contradiction unrepresentable. The prop type becomes a discriminated union — `{cols}` **xor** `{minCellWidth, mode?}` — so a fixed-column grid cannot accept (and need not invent) a `minCellWidth`, and a responsive grid cannot accept `cols`. This is the same "prefer the mode where the bug is unrepresentable" principle the audit's §1.4 states for layout itself, applied to the API.

## Design

### Prop type → discriminated union

In `plugins/primitives/plugins/css/plugins/grid/web/internal/grid.tsx`, replace the single `GridProps` interface with a shared base + two variants. Use `?: never` on the absent discriminants (rather than omitting them) so the component body can destructure all keys uniformly without per-member narrowing gymnastics:

```ts
interface GridBaseProps extends React.HTMLAttributes<HTMLElement> {
  /** Gap between cells, from the spacing ramp. Defaults to `md`. */
  gap?: SpaceStep;
  /** Cross-axis alignment within each cell (`align-items`). */
  align?: StackAlign;
  /** Main-axis distribution of the tracks (`justify-content`). */
  justify?: StackJustify;
  /** Host element/component. Defaults to a `div`. */
  as?: React.ElementType;
  /** Forwarded to the rendered element (mirrors Surface/Card/Row). */
  ref?: React.Ref<HTMLElement>;
}

/** Responsive path: browser packs as many `minCellWidth`-wide tracks as fit. */
interface ResponsiveGridProps extends GridBaseProps {
  minCellWidth: string;
  mode?: "fill" | "fit";
  cols?: never;
}

/** Fixed path: exactly `cols` equal `minmax(0,1fr)` columns. */
interface FixedGridProps extends GridBaseProps {
  cols: number;
  minCellWidth?: never;
  mode?: never;
}

export type GridProps = ResponsiveGridProps | FixedGridProps;
```

(`GridProps` stays the exported public name — it's re-exported from the barrel and imported as a type by callers; keeping the name avoids touching import sites.)

### `gridTemplateColumns` (the single source of truth)

Tighten the pure track function's parameter to the same union so the "cols wins over minCellWidth" runtime fallback (now impossible to trigger) is replaced by a clean branch. Narrow on `"cols" in opts` / `opts.cols != null`:

```ts
export function gridTemplateColumns(
  opts:
    | { cols: number; minCellWidth?: never; mode?: never }
    | { minCellWidth: string; mode: "fill" | "fit"; cols?: never },
): string {
  if (opts.cols != null) return `repeat(${opts.cols}, minmax(0, 1fr))`;
  return `repeat(${opts.mode === "fit" ? "auto-fit" : "auto-fill"}, minmax(${opts.minCellWidth}, 1fr))`;
}
```

### Component body

```ts
export function Grid({
  cols,
  minCellWidth,
  mode = "fill",
  gap = "md",
  align,
  justify,
  as: As = "div",
  ref,
  className,
  children,
  ...rest
}: GridProps) {
  // `cols` and `minCellWidth` are xor by the union; destructuring from the
  // union erases that correlation, so re-narrow on `cols` before delegating.
  const gridTemplateColumns_ =
    cols != null
      ? gridTemplateColumns({ cols })
      : gridTemplateColumns({ minCellWidth: minCellWidth as string, mode });

  return (
    <As
      ref={ref}
      className={cn("grid", GAP_CLASS[gap], align && ALIGN_CLASS[align], justify && JUSTIFY_CLASS[justify], className)}
      style={{ gridTemplateColumns: gridTemplateColumns_ }}
      {...rest}
    >
      {children}
    </As>
  );
}
```

The one `as string` is the standard TS-limitation cast (destructuring-from-union drops the discriminant↔field correlation); a comment explains it. `...rest` already excludes `cols`/`minCellWidth`/`mode` because they're named in the destructure, so none leak to the DOM.

## Call sites to update

Type-check will flag every fixed-`cols` caller that still passes `minCellWidth` (now `?: never`). Drop the dead `minCellWidth="…"` (and there is no `mode` on any fixed caller) from each:

| File | Current | Fix |
|---|---|---|
| `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx` (×2) | `cols={2} minCellWidth="20rem"` | drop `minCellWidth` |
| `plugins/stats/plugins/cost/web/components/cost-section.tsx` | `cols={2} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/screenshot/web/components/tools-pane.tsx` | `cols={3} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/primitives/plugins/icon-picker/web/components/icon-picker.tsx` (×2) | `cols={9} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx` | `cols={TOKEN_MODES.length} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/page/plugins/formatting/plugins/color/web/components/color-button.tsx` | `cols={5} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/apps/plugins/agent-manager/plugins/welcome/web/components/welcome-view.tsx` | `cols={3} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/ui/plugins/tweakcn/plugins/community-browser/web/components/community-theme-card.tsx` | `cols={COLOR_BARS.length} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/ui/plugins/segmented-progress-bar/plugins/segmented/web/components/segmented-renderer.tsx` | `cols={steps.length} minCellWidth="0"` | drop `minCellWidth` |
| `plugins/primitives/plugins/data-view/plugins/gallery/web/components/gallery-view.tsx` (windowed row, ~L326) | `cols={columns} minCellWidth={`${minCardWidth}px`}` | drop `minCellWidth` (the comment's "pixel-identical" intent holds — `cols` already drives geometry; the `minCellWidth` was dead) |

**Responsive callers — no change** (pass only `minCellWidth`): `start-page/bookmarks-section`, `start-page/quick-links`, `jsonl-viewer/.../workflow/workflow-graph`, `primitives/loading`, `gallery-view` responsive grid (~L286) and probe grid (~L312).

## Test

Update `plugins/primitives/plugins/css/plugins/grid/web/internal/grid-template.test.ts`:

- The "fixed cols **wins** over minCellWidth/mode" case (`gridTemplateColumns({ minCellWidth: "12rem", mode: "fit", cols: 3 })`) is now a *type error* (can't pass both). Replace it with a "fixed cols path" case: `gridTemplateColumns({ cols: 3 })` → `"repeat(3, minmax(0, 1fr))"`.
- Keep the three responsive cases (fill default, fit, rem interpolation) unchanged.

## Docs to sync

- `plugins/primitives/plugins/css/plugins/grid/CLAUDE.md` — the "Props" list and the track-function table say `cols` "**wins** over `minCellWidth`". Reword to: the two paths are an **xor** discriminated union — a fixed grid takes `cols` (no `minCellWidth`/`mode`), a responsive grid takes `minCellWidth` (+ optional `mode`); passing both is a type error. Update the autogen "Plugin reference" block via `./equin build` if it drifts.
- `research/2026-06-20-css-primitives-audit.md` §8 item 4 — mark resolved (the union landed); the §2 taxonomy row and §3 decision-tree mention of "Grid (minCellWidth + mode)" can note the `cols` alternative. Low priority; the audit is a dated snapshot.

## Verification

1. `./equin build` — regenerates nothing schema-wise; compiles frontend. The `type-check` check fails loudly on any fixed-`cols` caller still passing `minCellWidth` (this is the safety net that proves all call sites were migrated).
2. `bun test plugins/primitives/plugins/css/plugins/grid/web/internal/grid-template.test.ts` — pure track-function assertions pass.
3. `./equin check` — `type-check` + `eslint` + `plugins-doc-in-sync` green.
4. Visual smoke (optional): load a fixed-grid surface (e.g. `http://<worktree>.localhost:9000` → Settings → Appearance theme customizer mode tabs, or the icon picker) and confirm columns render identically — geometry is unchanged, only the dead prop is gone.

## Out of scope

The other §8 audit items (Clip axis-aware fill, z-layer shared barrel, Card padding ramp, gap-default JSDoc) are separate fixes.
