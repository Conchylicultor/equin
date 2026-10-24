# Region primitives own control density (Phase 3)

## Context

This is **Phase 3** of the arc started in
[`research/2026-06-20-global-chip-size-derive-from-control-density.md`](./2026-06-20-global-chip-size-derive-from-control-density.md):
*size stops being a per-element property and becomes a property of the region.*

- **Phase 1** (landed) made the chip family (`Badge`, `ToggleChip`,
  `SegmentedControl`) derive size from ambient `ControlSize` — no per-instance
  `size` prop. Dense panes' chips **normalized** to the default (`text-caption`).
- **Phase 2** (landed — commit `68bbeff`) removed `Button`'s `size` prop; it now
  derives height from ambient `ControlSize`, with `aspect` owning shape.

After Phases 1–2, every leaf control (button, icon-button, chip, badge) reads its
size from the ambient `ControlSize` context. **But the region primitives that
should *declare* that context don't.** A `<Bar>` toolbar, a `<DataTable>`, and a
`<Card>` carry no intrinsic density, so consumers still hand-wrap
`ControlSizeProvider` to get consistent sizing, and the dense debug/status panes
that normalized in Phase 1 now render their badges one notch too large.

**Goal:** a toolbar *is* `sm` and a table *is* compact **by construction**, with
density declared at the region, not sprinkled by each consumer. Concretely:

1. `Bar` bakes a default `sm` density (the single seam for all chrome:
   app-shell toolbar, pane headers, pane-toolbar host, browser chrome).
2. `DataTable` bakes a default compact (`xs`) density.
3. `Card` gains an **opt-in** `controlSize` prop (default = inherit; no global
   change) so dense surfaces can declare their own density precisely.
4. Restore compact density on the dense debug/status panes that normalized in
   Phase 1 (Debug → Reports / Queue, jsonl-viewer tool-call cards).

**Out of scope (deferred):** flowing density into the `Text` primitive.
Typography already scales via the independent `tokens/density` preset
(Comfortable / Cozy / Compact); a second density axis on `Text` risks conflicting
behavior. Filed as a follow-up.

## Two density axes — keep them distinct

| Axis | Token | Controls | Set by |
|---|---|---|---|
| **Density preset** | `tokens/density` (`p-card`, gaps…) | padding / spacing | global preset |
| **ControlSize** | `xs`/`sm`/`md`/`lg` (default `md`) | height/size of **controls, chips, badges, icons** | `ControlSizeProvider` / region |

Phase 3 is entirely about the **ControlSize** axis. Baking a ControlSize into a
region resizes only the *controls inside it* — **not** card padding and **not**
plain `<Text>` (which doesn't read density this phase).

### Chip/control density mapping (from Phases 1–2, for picking values)

- `Badge`: density `xs` → `text-3xs`; `sm`/`md`/`lg` → `text-caption`.
- `ToggleChip`/`SegmentedControl` (`chipSizeForDensity`): `xs` → `control-xs p-chip text-2xs`; `sm`/`md`/`lg` → `control-sm p-control text-caption`.
- `Button`/`IconButton`: height + icon derive directly (`xs`→`icon-xs`, `sm`→`icon-sm`, …).

So **`sm`** = the toolbar tier (chips at `text-caption`, sm buttons); **`xs`** =
compact/dense (chips at `text-3xs`).

## Existing mechanism to reuse

- `ControlSizeProvider` / `useControlSize` / `ControlSize`
  (`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx`).
  It's a context provider with **no DOM element**, so wrapping a region's
  `children` in it does not affect layout or the slot-render flex sentinel.
- `defineRenderSlot(id, { controlSize })` already wraps a slot's contributions in
  a `ControlSizeProvider` (`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx:218`).
  Used as the override hatch for slot-bearing regions; **no slot currently sets
  it** — Bar is the simpler single seam for chrome (below).

## Changes

### 1. `Bar` — bake the `sm` chrome density

`plugins/primitives/plugins/bar/web/internal/bar.tsx`

- Add `controlSize?: ControlSize` to `BarProps`, **default `"sm"`**.
- Wrap `children` in `<ControlSizeProvider size={controlSize}>`. The provider
  sits *inside* the `<As>` flex element, so the slot-render sentinel still reads
  the Bar's flex container as its `parentElement` (no min-w-0 regression).
- Import `ControlSizeProvider` + `ControlSize` from the ui-kit barrel.

Effect — every `<Bar>`-based chrome strip becomes `sm` by construction:
- **app-shell toolbar** (`app-shell-layout.tsx:164`, slot renders inside the
  `<Bar tier="chrome">`) — today renders contributions at default `md`; becomes
  `sm`. **This is the main visible normalization** (every app's top toolbar).
- **pane headers** (`pane-chrome.tsx:76`, `<Bar tier="pane">`) — header actions
  become `sm`.
- **pane-toolbar Host** (`definePaneToolbar`) — its `<Bar>` now provides `sm`;
  sonata/story toolbars normalize to `sm`.
- **browser chrome** (`tab-strip.tsx`, `bookmarks-bar.tsx`) — already use
  `<Bar tier="pane">` with intentional inner `size="sm"` + nested
  `ControlSizeProvider size="xs"` overrides; those keep working (innermost wins).

`definePaneToolbar`'s existing `controlSize` option
(`define-pane-toolbar.tsx:38`) stays as an **override** on top of Bar's `sm`
(slot provider is innermost). No caller passes it today; leave the default
`undefined` and update its doc comment to say Bar supplies the `sm` baseline.

### 2. `DataTable` — bake compact (`xs`) density

`plugins/primitives/plugins/data-table/web/internal/data-table.tsx`
(+ `web/internal/types.ts` for the prop)

- Add `controlSize?: ControlSize` to `DataTableProps`, **default `"xs"`**.
- Wrap the component's returned JSX (both the empty-state `Center` branch and the
  grid branch) in `<ControlSizeProvider size={controlSize}>`. Cleanest: assign the
  body to a `const` and wrap once at the single `return`.

Effect: badges in table cells render `text-3xs` (matching the table's existing
`text-3xs` header / `text-caption` row scale); `rowActions` icon buttons render
`icon-xs`. All current consumers (studio contributions tables, heap-snapshot,
profiling/boot, data-view/table) inherit compact automatically — none wrap a
provider today, so no conflict.

### 3. `Card` — opt-in `controlSize` prop (no default change)

`plugins/primitives/plugins/css/plugins/card/web/internal/card.tsx`

- Add `controlSize?: ControlSize` to `CardProps` (already has a permissive
  `[key: string]: unknown` passthrough — declare the named prop so it's typed and
  **not** spread onto the host element).
- When provided, wrap `children` in `<ControlSizeProvider size={controlSize}>`;
  when omitted, render children unchanged (inherit ambient). **Zero change to any
  existing card.**

This gives dense surfaces a precise dial without forcing a global card change.

### 4. Restore compact density on the dense panes

These are bespoke markup (not `Card`/`DataTable`), so they declare density at
their own root — the sanctioned "declare where you are" usage:

- **Debug → Reports** (`plugins/debug/plugins/reports/web/components/reports-view.tsx`):
  wrap the returned `<Stack>` in `<ControlSizeProvider size="xs">` → the kind/
  source/noise/etc. badges return to `text-3xs`.
- **Debug → Queue** (`plugins/debug/plugins/queue/web/components/queue-view.tsx`):
  wrap the root `<Stack>` in `<ControlSizeProvider size="xs">` → row badges +
  the `SegmentedControl` tab switcher render compact.
- **jsonl-viewer tool-call cards**: set `controlSize="xs"` on the shared card
  shell in
  `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx`
  (the chokepoint for tool-call card chrome — now that `Card` accepts the prop).
  During execution, verify every tool-call card type routes through this shell;
  if any bypass it, wrap their host instead.

> `xs` is the target for "compact"; if `text-3xs` reads too small on any pane in
> verification, fall back to `sm` for that pane. Decide by screenshot, not guess.

### 5. Hand-wrapped `ControlSizeProvider` cleanup — conservative

Do **not** rip out the ~20 existing hand-wrap sites. Most declare density for
**bespoke regions** that are not primitives (the floating action bar in
`shell/global-action-bar`, the app tab bar in `apps/web/components/app-tab-bar.tsx`,
data-view filter/sort rows, studio bands) — those remain legitimate region
declarations. Only remove a wrap that becomes **strictly redundant** with Bar's
new `sm` default (i.e. a `ControlSizeProvider size="sm"` whose sole job was to
size a `<Bar>`'s children). The browser bars' inner `xs` overrides are
intentional and stay. Net: this phase adds region defaults; it does not chase a
zero-hand-wrap end state.

### 6. Docs

- `plugins/primitives/plugins/bar/CLAUDE.md` — note Bar declares a default `sm`
  control density (the chrome tier), overridable via `controlSize`.
- `plugins/primitives/plugins/data-table/CLAUDE.md` — note the table declares
  compact (`xs`) density by default, overridable.
- `plugins/primitives/plugins/css/plugins/card/CLAUDE.md` — document the opt-in
  `controlSize` prop (inherit by default).
- `.claude/skills/theme/SKILL.md` (§ control size) + `control-size/CLAUDE.md` —
  update the model: region primitives (`Bar`, `DataTable`) now declare intrinsic
  density; `Card` opts in; consumers stop hand-wrapping for chrome/tables.
- Autogen reference blocks (Uses/Exports) regenerate via `./equin build` —
  do not hand-edit.

### 7. Enforcement

No new lint rule. The `controlSize` props are tsc-typed; the region defaults are
plain code. (A future lint could flag a `ControlSizeProvider` that merely
re-declares a region primitive's own default, but that's premature here.)

## Follow-ups to file (via `add_task` MCP, during execution)

- **Flow density into `Text`** (deferred from this phase): make `<Text>` read
  `useControlSize()` and pick a tighter size at compact densities, so labels
  scale with the region. Reconcile against the `tokens/density` preset axis first
  so the two don't double-apply.

## Verification

1. `./equin build` (regenerates autogen docs + runs `type-check`).
2. `./equin check type-check` — must be clean (new optional props, no
   removals → no call-site churn expected).
3. Screenshots (use `bun e2e/screenshot.mjs --url … --out /tmp/density`):
   - **Any app toolbar** (e.g. `http://<wt>.localhost:9000/agents`) — toolbar
     buttons/chips now sit at `sm`, height-matching each other.
   - **Studio → Contributions table** (a `DataTable`) — badges in cells render
     compact (`text-3xs`).
   - **Debug → Reports** and **Debug → Queue** — status badges back to compact.
   - A **jsonl-viewer** conversation with tool-call cards — card badges compact.
4. Confirm no card outside the dense panes changed (Card default is inherit):
   spot-check Home launcher / Pages welcome.

## Critical files

- `plugins/primitives/plugins/bar/web/internal/bar.tsx`
- `plugins/primitives/plugins/data-table/web/internal/{data-table.tsx,types.ts}`
- `plugins/primitives/plugins/css/plugins/card/web/internal/card.tsx`
- `plugins/primitives/plugins/pane-toolbar/web/internal/define-pane-toolbar.tsx` (doc only)
- `plugins/debug/plugins/reports/web/components/reports-view.tsx`
- `plugins/debug/plugins/queue/web/components/queue-view.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx`
- Docs: `bar/CLAUDE.md`, `data-table/CLAUDE.md`, `card/CLAUDE.md`,
  `.claude/skills/theme/SKILL.md`, `css/plugins/control-size/CLAUDE.md`
