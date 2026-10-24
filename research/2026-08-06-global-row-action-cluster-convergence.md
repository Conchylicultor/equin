# Row-action clusters: one implementation, and a guardrail that removes duplicates instead of blessing them

## Context

"Hover-revealed trailing actions on a row" is implemented independently in **five** places, so
one contributed `itemActions` behaves differently depending on which view renders it. A
`RowActionButton` contributed to `QueueItemActions`
(`conversations/conversations-view/data-view/queue`) is revealed by JS state in the list view, by
a shared CSS group in the table and gallery, and by the primitive's own private group in the
tree — and only the last one stays visible while its own dropdown is open.

The census, as it stands today:

| # | Implementation | Placement | Reveal | Popup-hold | Guards | Gap / size |
|---|---|---|---|---|---|---|
| 1 | `primitives/row-actions` `RowActions` | `Pin` + `mask` (`right`) or inline | CSS `group/row-actions` (private) | ✅ `PopupOpenScope` | click **+ pointerdown** | `none` / `xs` |
| 2 | `primitives/css/row` `Row`'s `actions` prop | `Pin` + `mask` (`right`), or in-flow when always-visible | JS `useHoverReveal()` | ❌ | click only | `2xs` / ambient |
| 3 | `data-view/gallery` `DataCard` | `Pin` + `mask` (`top-right`) | CSS `group/hover-reveal` (shared) | ❌ | click only | `xs` / ambient |
| 4 | `primitives/data-table` | reserved `auto` grid track (in flow) | CSS `group/hover-reveal` (shared) | ❌ | click only | `xs` / `xs` |
| 5 | `conversation-view/jsonl-viewer/plugins/row-actions` | in-flow in each renderer's header row | CSS `group/hover-reveal` (shared) | ❌ | none | `xs` / ambient |

**#5 was not in the brief.** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web/internal/event-action-context.tsx`
exports a component *also named* `RowActions`, in a plugin *also named* `row-actions`, hand-rolled
on `hoverRevealTarget`. The brief's claim that the primitive is "used by the jsonl-viewer rows" is
not accurate — jsonl-viewer imports `hover-reveal`, never `primitives/row-actions`. Two plugins
called `row-actions` exporting a component called `RowActions` is the sharpest possible statement
of the problem.

Observable consequences today, all of them one-way — a divergence can only be discovered, never
prevented:

- an open dropdown fades its own trigger out when the pointer leaves the row, in list / table /
  gallery / jsonl rows (only the tree holds it);
- pressing an action in a list/table/gallery row arms the row's drag source, because only #1
  stops `pointerdown`;
- the same button renders at a different size and gap per view.

### The failure mode any guardrail must beat

`ee2dfe424` ("drain no-uncoupled-hover-reveal allowlist (34 sites)") is the precedent. The tree
carried a **sixth** implementation whose reveal changed *layout* (`Clip` `w-0` → `w-auto`), which
moved the anchor of any menu opened inside it — the bug in
`research/2026-08-06-global-row-action-anchor-stability.md`. The lint rule
`no-uncoupled-hover-reveal` asks *"are `opacity` and `pointer-events` coupled?"*. The `w-0` cluster
answered by adding coupling ("Approach D … tree-row-chrome … w-0 actions cluster") and **survived
hardened in place**, and the same commit introduced a dead Radix-era `data-[state=open]` selector
that provably never matched.

So the test for any rule proposed here is: **is it satisfiable by editing the duplicate, or only by
deleting it?** A rule that asks about a *class string's shape* is always satisfiable in place — it
describes today's mechanism, and the next duplicate uses tomorrow's.

### Intended outcome

1. One component renders every row-action cluster. Per-view divergence becomes structurally
   impossible rather than periodically re-fixed.
2. The guardrail is a **dataflow** rule, not a shape rule: an `actions`-shaped prop must *reach*
   the primitive. The `w-0` cluster fails it, and the only way to pass is to render through
   `RowActions`.
3. The runtime keeps proving the two behaviours (stable anchor, cluster held open) that no static
   rule can.

## Design

### One component, three placement axes

`RowActions` already carries the two axes that separate #1–#4 (`pin?: PinAnchor | null`,
`alwaysVisible?: boolean`). One is added for #5:

```tsx
<RowActions
  pin={"right" | "top-right" | null}   // null ⇒ in flow, no Pin, no mask
  alwaysVisible={false}
  surface={false}                       // NEW: paint the cluster on its own raised Surface
/>
```

`surface` covers jsonl-viewer's `floating` variant (headerless text/image renderers, where the
cluster floats over prose and needs its own chrome to stay legible). It must live **inside** the
primitive for the same reason the scrim does — the reveal rides the outermost node, so chrome
applied by a wrapper would leave an empty pill fading in.

**`pin={null}` is a legitimate placement, not a fourth implementation.** data-table reserving a real
`auto` grid track is *correct* for a table: columns align structurally, and an overlaying cluster
would cover the last column's data. Its anchor is already stable (the track is content-sized and
the cluster is always rendered, only its opacity changes). Keep it — express it as `pin={null}`.

**The scrim contract only bites when pinned.** A pinned cluster overlays row content, so its host
must co-publish `--scrim` alongside every tint it paints (`Row` and `Card` already do; the tree
gained it in `862de5c72`). An unpinned cluster paints no mask, so `data-table` and `EventRow` need
nothing.

### Reveal: the primitive's own named CSS group

Adopt `rowActionsAnchor` (`group/row-actions relative`) as the single mechanism, retiring
`useHoverReveal` (#2) and `hoverRevealGroup`/`hoverRevealTarget` (#3, #4, #5) **from row clusters
only**.

- **Perf.** `useHoverReveal` re-renders the whole `Row` on every `pointerenter`/`pointerleave`.
  The list view and data-table both window 100+ rows; CSS costs zero renders.
- **Scoping.** `group/hover-reveal` is *shared*, so a nested hover-reveal consumer inside a row
  cross-fires. `group/row-actions` is private to this primitive.
- **Semantics are equivalent.** JS `onFocus`/`onBlur` spread on the row (React focus bubbles, with
  a `contains(relatedTarget)` guard) is exactly `group-focus-within/row-actions`.

**Nesting was the reason `useHoverReveal` exists, and it does not apply here.** Verified: tree rows
are flattened before render (`tree-list.tsx` `walk()` emits a flat `{node, depth}[]`), so rows are
DOM siblings at every depth; data-view rows and table rows likewise. The one genuinely nested case
— `FilterGroupEditor` → `NestedGroupRow`, a group's own control wrapped around per-rule controls —
is **not** a row-action cluster and keeps `useHoverReveal`.

`hover-reveal` therefore survives unchanged as the general primitive (page blocks, tab closes,
miller resize handle, sonata bands, nested filter groups). The boundary to record in its
`CLAUDE.md`: *if it is a trailing action cluster on a row, card or table row, it is `row-actions`,
not this.*

### Per-host migration

Each host keeps **placement and anchoring**, and owns no reveal:

| Host | Change |
|---|---|
| `primitives/css/row/web/internal/row.tsx` | Add `rowActionsAnchor` to `chromeClass`. Replace both `actionsSpan` branches with `<RowActions pin={actionsAlwaysVisible ? null : "right"} alwaysVisible={actionsAlwaysVisible}>{actions}</RowActions>`. Delete `useHoverReveal`, `revealHandlers`, the pointer/focus prop-splitting block, and the `hover-reveal` import. Consumer-supplied `onPointerEnter`/`onFocus` stop being intercepted — they pass straight through in `rest`. |
| `data-view/plugins/gallery/…/data-card.tsx` | Swap `hoverRevealGroup` → `rowActionsAnchor` on the `Card`; replace the `Pin`+`Stack` block with `<RowActions pin="top-right">{actions}</RowActions>`. |
| `primitives/data-table/web/internal/data-table.tsx` | Swap `hoverRevealGroup` → `rowActionsAnchor` on the row `div`; the actions cell becomes `<RowActions pin={null}>{rowActions(row, index)}</RowActions>`. Keep the trailing `auto` track. |
| `conversation-view/jsonl-viewer/plugins/row-actions/…/event-action-context.tsx` | `EventRow` swaps `hoverRevealGroup` → `rowActionsAnchor`; its local `RowActions` becomes a thin wrapper rendering `<RowActions pin={null} surface={floating}>` around the `JsonlRowActions.Item.Render` — keeping the contribution slot, deleting the reveal. |
| `primitives/tree/web/internal/tree-row-chrome.tsx` | Already correct (`862de5c72`). Unchanged. |
| `primitives/breadcrumb/web/internal/breadcrumb.tsx` | `{actions}` → `<RowActions pin={null} alwaysVisible>{actions}</RowActions>` (see guardrail). |

`SectionCard`, `SectionHeaderRow` and `detail-sections` need **no change** — they already forward
their `actions` into `Row`'s `actions` prop, so they inherit the convergence for free.

### Accepted deltas

State these up front; they are the price of one look, and each was already accepted once for the
tree in `862de5c72`:

- **Gap** `2xs`/`xs` → `none` in list, table, gallery, jsonl and breadcrumb clusters.
- **Control size** `xs` everywhere (`ControlSizeProvider` inside `RowActions`). data-table already
  defaults to `xs`; list/gallery/jsonl/breadcrumb buttons shrink to match.
- **`pointerdown` is now stopped** on every cluster. This is the point (a press on an action must
  not arm the row's drag source) but it must be checked against data-view table drag-reorder,
  where the row *is* a drag source via `useRowDecoration` + `useRankReorderItem`.
- **`rowActionsAnchor` bundles `relative`**, which is redundant for `pin={null}` hosts. Kept as one
  class deliberately — splitting it into two would recreate the wire-up-half-of-it footgun. Verify
  it is inert on the data-table row (which already conditionally sets `relative` for decoration).
- **One `PopupOpenScope` per cluster.** No DOM, and its state only changes when a popup opens;
  negligible even at 100 windowed rows.

## Guardrail

### Static — `row-actions/no-raw-actions-slot`

A new per-plugin lint contribution at `plugins/primitives/plugins/row-actions/lint/{index.ts,no-raw-actions-slot.ts}`,
mirroring the sibling `plugins/primitives/plugins/data-table/lint/index.ts` barrel byte-for-byte
(auto-discovered by the root `eslint.config.ts`; no registration edit). Self-contained AST rule —
no cross-plugin import, per the jiti constraint that already shapes every rule file here.

**The rule.** In any component that destructures a prop named `actions`, `rowActions` or
`itemActions`, that binding must **reach** the primitive: rendered as a child of `<RowActions>`, or
forwarded as an `actions=` / `rowActions=` JSX attribute to another component. Rendering it raw —
inside a `<Clip>`, `<Stack>`, `<Pin>`, `<span>`, or bare in JSX — is the error.

```tsx
<Clip className={w0}>{actions}</Clip>            // ✗ raw render
<RowActions pin={null}>{actions}</RowActions>    // ✓ reaches the primitive
<Row actions={actions} />                        // ✓ forwarded to another host
```

**Checked against the `ee2dfe424` failure mode.** The tree's `w-0` cluster rendered `{actions}`
inside a `<Clip>`: **flagged**, and unsatisfiable in place — no class edit, no `pointer-events`
addition, no allowlist entry makes it pass. The only fix is to render through the primitive, which
is deletion of the duplicate. This is the property `no-uncoupled-hover-reveal` lacks.

**Blast radius today is one file.** `SectionCard`, `SectionHeaderRow` and `detail-sections` pass by
forwarding; every `actions={…}` *consumer* passes trivially. Only `primitives/breadcrumb` renders
`{actions}` raw, and it migrates to `<RowActions pin={null} alwaysVisible>` — which is what an
always-visible trailing cluster is.

**Its honest limits, stated rather than oversold:**

- It is **name-based**. A host that calls its slot `trailing` escapes. Accepted: row containers are
  few, all in `primitives/`, and adding one is a reviewed act — not incidental code.
- It proves *composition*, never *behaviour*. That is the runtime guard's job below.
- **Rejected alternative, recorded so it is not re-derived:** a rule banning `Pin` + a hover-reveal
  class. It fails twice — it flags ~12 legitimate media overlays (page image/video/audio/file/
  bookmark/code-block, page-cover, song-card, attachment-thumbnail…), and it would **not** have
  caught the `w-0` duplicate, which used `Clip` and no opacity at all. A rule that misses the one
  case in the history is not a guardrail.

### Runtime — the two behaviours, per view

`plugins/primitives/plugins/row-actions/e2e/cluster-parity.ts` (new), built on the shared
`e2e-harness` (`argv`, `withBrowser`, `report()`), parameterized over `--url` + `--view`. For each
surface it asserts, per view:

1. **Anchor stability** — open a row's `⋯`, move the pointer off the row, assert the trigger's own
   `x` is unchanged (and that the row's `:hover` really dropped, else the check is vacuous the
   other way).
2. **Held visibility** — with the pointer *away from the row in both cases*, the cluster reads
   `opacity: 0` with the menu closed and `opacity: 1` with it open. Same element, same hover state;
   the only difference is the popup-open signal, which is what makes the assertion non-vacuous
   without a sabotage build (the isolation technique verified in the prior doc).

Coverage with today's real surfaces:

- **tree + list** — Pages sidebar (`views={["tree","list"]}`, `PageTree.RowActions`).
- **table** — Events sources (`views={["list","table"]}`, `SourceItemActions`).
- **gallery** — no `defineItemActions` consumer ships a gallery view today. Cover it with a
  vitest DOM test asserting `DataCard` renders its `actions` through `RowActions`, and say so
  plainly rather than pretending the browser proved it.

The existing `plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts` stays as
is — it is the tree's regression guard and is already verified discriminating.

> After convergence, per-view *parity* is structural: the four views render the same component, so
> they cannot diverge. The e2e's job narrows to proving that component's two invariants hold in a
> real browser. The extra views are cheap insurance against a host re-acquiring its own reveal.

## Files

| Path | Change |
|---|---|
| `plugins/primitives/plugins/row-actions/web/internal/row-actions.tsx` | add `surface?: boolean` (composes `css/surface` `level="overlay"`, inside the reveal node) |
| `plugins/primitives/plugins/row-actions/lint/{index.ts,no-raw-actions-slot.ts}` | **new** lint contribution |
| `plugins/primitives/plugins/row-actions/e2e/cluster-parity.ts` | **new** parameterized e2e |
| `plugins/primitives/plugins/css/plugins/row/web/internal/row.tsx` | drop `useHoverReveal` + both action branches; `rowActionsAnchor` + `RowActions` |
| `plugins/primitives/plugins/data-view/plugins/gallery/web/components/data-card.tsx` | `rowActionsAnchor` + `<RowActions pin="top-right">` |
| `plugins/primitives/plugins/data-table/web/internal/data-table.tsx` | `rowActionsAnchor` + `<RowActions pin={null}>`; keep the `auto` track |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web/internal/event-action-context.tsx` + `…/jsonl-viewer/web/components/event-row.tsx` | wrap the contribution slot in the primitive; `rowActionsAnchor` on the row |
| `plugins/primitives/plugins/breadcrumb/web/internal/breadcrumb.tsx` | `<RowActions pin={null} alwaysVisible>` |
| `plugins/primitives/plugins/data-view/plugins/gallery/web/__tests__/` | **new** DOM test: `DataCard` actions route through `RowActions` |
| `plugins/primitives/plugins/{row-actions,hover-reveal,data-table}/CLAUDE.md` | record the one-implementation rule + the `hover-reveal` boundary; **fix data-table's stale claim** that its cluster reveals on `group-hover/dt-row` (the live mechanism is `group/hover-reveal`, and becomes `group/row-actions`) |

## Verification

1. `./equin build`; confirm `status: ok` in
   `~/.singularity/worktrees/att-1786028049-9vzb/build-status.json` (never infer from a `build-*.log`).
2. **Prove the lint rule red first.** Temporarily restore the `w-0` `Clip` render in
   `tree-row-chrome.tsx` and confirm `./equin check eslint` reports it. A rule never observed
   failing is not evidence — this is the exact check `no-uncoupled-hover-reveal` never survived.
3. `bun plugins/primitives/plugins/row-actions/e2e/cluster-parity.ts` for each
   `--url`/`--view` pair (Pages sidebar tree + list, Events sources table). Prove each red by
   temporarily reverting that host to its old reveal.
4. `bun plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts` — unchanged,
   still green.
5. `./equin test plugins/primitives/plugins/row-actions plugins/primitives/plugins/data-view/plugins/gallery plugins/primitives/plugins/css/plugins/row`
   (both buckets).
6. `./equin check` — `eslint`, `plugin-boundaries`, `plugins-doc-in-sync`,
   `tailwind-scan-covers-classes`, `layout-geometry`.
7. **Manual pass on the drag-reorder surfaces**, where the new `pointerdown` guard bites: the
   data-view table with manual order (`useRowDecoration` + `useRankReorderItem`), the Pages sidebar
   tree, and reorder edit mode. Dragging by the row must still work; dragging by an action button
   must not.
8. Manual look-pass on the changed gaps/sizes: conversations queue + history lists, events sources
   table, event-list gallery, a jsonl transcript (both header and headerless/`floating` renderers),
   and any breadcrumb with a copy button.
9. In each of list / table / gallery / jsonl: open a row's `⋯`, move the pointer away — the menu
   must be stationary and the `⋯` must stay visible. That is the behaviour this whole change
   exists for, and today it holds only in the tree.
