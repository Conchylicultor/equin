# Inset ownership v2: one rail contract, and the bespoke mechanisms deleted

Supersedes [v1](./2026-08-17-global-inset-ownership-rail-contract.md), which
scoped to "contract + generic gate" and left the existing negotiations in place.
v2 keeps the same model and gate, and adds the migration: the bespoke mechanisms
are **deleted**, not left alongside. Read v1's Context and "The mental model"
sections first — they are unchanged and not repeated in full here.

## The model, in one paragraph

Applying inline padding is the act of **opening a region**, not decorating a box.
A box either opens a region — declares where its contents' left edge is — or lives
in one and does nothing. There is no third thing, so "both applied it" is what
*opened a region without meaning to* looks like from outside. The edge owner owns
the rail; you inherit alignment by doing nothing; the only escape is
cancel-and-reapply as one indivisible act; a region publishes what descendants
must adapt to; nesting is shadowing, not accumulation. The enforcement corollary:
**a rail is proven by the child that knows nothing about it**, which is why the
gate's child set must not be authorable.

## First, a correction to the premise

The five recurring negotiations are not five instances of one thing. Three are the
same inset mechanism and genuinely collapse; two are the same *pattern* on a
different property and would be a category error to fuse:

| Instance | Verdict |
| --- | --- |
| `--pane-gutter` + `pane-gutter-flush` + `PANE_GUTTER_VAR` + `DataTable.gutter` | **Collapses** — deleted, becomes the shared rail |
| `OverlayPanel.padding` / `DialogContent.padded` / `SelectContent.padding` | **Collapses** — `padded` deleted, panel always opens the region |
| `POPOVER_PADDING` co-publishing `--scroll-pad` | **Collapses** — becomes `--rail-block-*`, published by the same utility |
| `--cp-inset-start/-end` (control-panel, the sixth) | **Collapses** — the model's own prototype |
| `--chrome-mask` / `--hover-fill` | **Stays** — same publish-your-role contract, but a *color* role. Fusing it into a geometry var would be wrong. Gets a shared name and doc home only. |
| `css/text`'s "three orthogonal axes" | **Not this problem** — three disjoint sizing axes (padding vs font-size vs role selection), no container/child race, nothing to escape. Its doc wording should stop implying kinship. |

So the collapse is four mechanisms into one, and one convention named.

## The contract

Three concepts and one ramp, in `app.css`.

```css
/* OPEN A REGION — publish and apply in the same breath, so the number exists
   once. `rail-<step>` covers all four sides; `rail-x-`/`rail-y-` are the
   single-axis members, mirroring the p/px/py ramp exactly. */
@utility rail-lg {
  --rail-start: var(--space-lg);       --rail-end: var(--space-lg);
  --rail-block-start: var(--space-lg); --rail-block-end: var(--space-lg);
  padding: var(--rail-block-start) var(--rail-end) var(--rail-block-end) var(--rail-start);
}

/* THE ESCAPE — cancel and re-apply are ONE class, so you cannot write half of
   it. The width term pays back what the negative margins gave away: a <button>
   host sizes to its content, so `width: auto` would shrink it. */
@utility rail-bleed {
  margin-inline: calc(-1 * var(--rail-start)) calc(-1 * var(--rail-end));
  width: calc(100% + var(--rail-start) + var(--rail-end));
  padding-inline: var(--rail-start) var(--rail-end);
}

/* FOLLOW — apply the ambient rail without publishing one. For a band inside a
   region whose container deliberately does not pad (see "the one inverted
   topology"). The chrome fallback is what `px-pane-gutter` resolves today. */
@utility rail-follow {
  padding-inline: var(--rail-owed-start, var(--rail-start, var(--chrome-pad-x)))
                  var(--rail-owed-end,   var(--rail-end,   var(--chrome-pad-x)));
}
```

### Correction: applied vs owed (found during implementation)

The contract above shipped with **two** var pairs, not one. The first draft of this
plan said a host could open a region and "the bands follow it automatically",
which is arithmetically wrong: in the follow topology a published non-zero rail is
an instruction to apply it *again*, so `rail-lg` above a DataView produced 24 + 24.

The fix splits what `--rail-start` was conflating:

- `--rail-start` / `--rail-end` — the inset that **has been applied**, wherever it
  was applied. `rail-bleed` cancels exactly this, which is why it works identically
  in both topologies.
- `--rail-owed-start` / `--rail-owed-end` — the inset a **follower must still apply
  itself**. `rail-<step>` sets it to `0px` (the owner paid); `rail-owe-<step>`
  publishes the rail and defers payment, applying no padding of its own.

Two consequences worth keeping:

- **A follower cannot clear the debt for its descendants.** Reading
  `--rail-owed-start` while declaring it on the same element resolves against that
  element's own declaration, so `rail-follow` would pay zero everywhere. Nested
  followers therefore each pay — unchanged from nested `px-pane-gutter`, and
  audited clean across data-view's 20 sites, but a real limit.
- **The escape is atomic in CSS and must also be atomic in class strings.** Left
  `standalone`, a stray `px-md` beside `rail-bleed` overrides the re-apply half
  while margin and width still bleed: cancel-without-reapply, reachable through a
  sibling class. The fix is **`extend px`** — do not "correct" it back to
  `standalone`, and do not replace it with a synthetic group. A synthetic
  `conflicts: p px` was tried and rejected: `conflicts:` compiles to
  `conflictingClassGroups[builtin].push(group)`, which is **one-directional** (a
  later builtin removes an earlier group member), so it fixes
  `cn("rail-bleed", "px-md")` and leaves `cn("px-md", "rail-bleed")` emitting both
  — and that second order, base classes first and caller `className` last, is how
  nearly every component in this repo composes. Same-group membership is the one
  relation tailwind-merge treats symmetrically. The marker does not claim
  `rail-bleed` *is* an inline-padding utility; it claims the two are mutually
  exclusive, which is the only thing tailwind-merge can be told. Verified against
  the real `cn()` config, including that `py-*` survives in both orders.
  Consequence, by design: `rail-lg rail-bleed` on one element resolves to the
  bleed alone — escaping a region and opening one are two jobs, so two elements.

- **The same hole remains open in the ramp, and is not closable here.**
  `cn("px-md", "rail-lg")` keeps both: `rail-lg` still publishes `lg` while `px-md`
  wins the inline axis — published ≠ applied, the exact lie this contract exists to
  forbid. `extend px` is unavailable to the ramp (`rail-<step>` spans both axes,
  and `rail-owe-<step>` applies no padding at all, so joining `px` would let it
  delete a neighbour's real padding). Closing it needs bidirectional conflicts in
  the twmerge codegen, which would fix `sg-pad`, `sg-control-*` and every future
  synthetic group at once. Filed separately; the ramp's comment states the
  limitation in the meantime.

**Why a parallel ramp rather than folding publication into `p-*`/`Inset`.** Folding
in is tempting — every padded box would become a region for free and the drift
hole would close with no lint rule. It is wrong for a concrete reason: `p-md` and
`px-lg` legitimately coexist on one element (tailwind-merge keeps both, `px` wins
by CSS order), so `--rail-start` would resolve by *stylesheet declaration order*
rather than the intended cascade. With a separate ramp under one synthetic
tailwind-merge group, two rail classes conflict and exactly one survives, so an
element has exactly one rail declaration by construction.

**Why one shared var pair rather than per-region names.** Nesting becomes plain CSS
inheritance — an inner region shadows the outer value, nothing needs wiring — and
the escape becomes portable. `cp-row` today hardcodes `--cp-inset-start`, so it
only bleeds correctly inside a control panel; a `rail-bleed` child reads whatever
region it actually landed in. Custom-property inheritance also passes through
`display: contents` wrappers, which is what `renderIsolated` wraps every
contributed panel in.

## Migration

### A. `control-panel` — `--cp-inset-*` → the shared rail

`cp-panel` sets `--rail-start: var(--cp-rail-text); --rail-end: var(--cp-row-pad-x)`
(the asymmetric values it already computes) and pads from them. `cp-row`,
`cp-rule`, `cp-band` and `cp-rail-icon` read `--rail-start`/`--rail-end` in place of
`--cp-inset-start`/`--cp-inset-end`; `cp-row`/`cp-rule`'s hand-written
cancel-and-reapply becomes `rail-bleed` plus their own grid tracks. Drop the two
`--cp-inset-*` tokens from the theme-scope block and the token table.

Immediate payoff beyond tidiness: `ControlPanel.Row` becomes droppable outside a
control panel, because its bleed no longer names one.

### B. `data-view` — the `--pane-gutter` family, deleted

- `px-pane-gutter` → `rail-follow`, mechanically, at ~20 sites across 9 files
  (`data-view.tsx`, `data-view-toolbar.tsx`, `grouped-sections.tsx`, list/tree/
  gallery views, `data-table.tsx`, `loading.tsx`).
- **`pane-gutter-flush` deletes itself.** A host that already supplies its own
  inset now *opens a region*, which publishes the rail **and** declares the debt
  paid (`--rail-owed-*: 0px`), so the bands apply nothing. (The first draft said
  "the bands follow it automatically" — see the Correction above; that sentence was
  the mechanism error, and it is what made the flush marker look redundant when it
  was not.) The 4 sites — `task-detail/web/panes.tsx:63`,
  `define-detail-sections.tsx:264` and `:382`, workflows `definition-detail.tsx` —
  become `rail-lg` (or the step they already used) with the flush class gone.
- **`PANE_GUTTER_VAR` deleted** (`data-view/core/internal/header-offset.ts`).
  app-shell's sidebar, its only non-zero setter (`app-shell-layout.tsx:241`,
  publishing `--space-sm`), becomes `rail-sm`.
- **`DataTable`'s `gutter` prop deleted** — rows use `rail-follow` unconditionally.
  Column alignment is preserved by the same property that makes today's
  `p-control` work: identical inline padding on every subgrid row.

**The one inverted topology, stated rather than hidden.** In data-view the bands
apply the inset and the container does not — the opposite of the model, and the
reason `rail-follow` exists. Flipping it (pane pads, bands inherit, painting bands
bleed) means `PaneChrome` becoming a region owner, which insets *every* pane in the
app including the deliberately full-bleed ones (diff view, browser webview,
canvases). That is a separate change with its own risk budget, so it is deliberately
not bundled here. What matters is that the gate does not care: `railAlignment`
measures each child's **content** left edge against the published rail, so it
catches "forgot to apply" in this topology and "applied twice" in the other. The
gate checks the outcome, not the mechanism.

### C. `ui-kit` panels — `padded` deleted

`OverlayPanel`'s `padding` role maps to `rail-<step>` (so `POPOVER_PADDING`'s
`p-<step>` + `[--scroll-pad:…]` pair becomes one class). `DialogContent.padded` is
**removed from the type** — the same move `ControlPanelPopover` already makes with
`width`: the escape is absent, not defaulted. The dialog always opens the region at
`lg`; its three flush callers put `rail-bleed` on their rows instead:

- `search/quick-find/…/quick-find-dialog.tsx:56`
- `primitives/command-palette/…/command-palette-dialog.tsx:85`
- `history/dialog/…/version-history-dialog.tsx:138`

`imperative-dialog`'s `openDialog(render, { padded })` option (`store.ts:6`) goes
with it. `SelectContent`'s `padding="none"` default plus `SelectGroup`'s own
`px-xs py-xs` is the same inversion — the panel opens the region and items bleed.
`components/ui/*` is shadcn-generated, so keep these edits minimal and re-check
after any future `shadcn add`.

### D. `--scroll-pad` → `--rail-block-*`

`rail-<step>` and `rail-y-<step>` publish `--rail-block-start`/`--rail-block-end`, so
the padding role's block value is readable without a second co-published var.
`scroll-fade` in `app.css` (~L297–371) reads them per edge — strictly better than
today, where one `--scroll-pad` serves both edges and asymmetric block padding
would be silently wrong. Update `ui-kit/e2e/scroll-fade-verify.ts:195`, which reads
the var by name.

### E. `--chrome-mask` / `--hover-fill` — named, not moved

No mechanism change. `theme/CLAUDE.md`'s table gains the rail rows beside them,
under one heading that names the contract once: *a container publishes as a CSS
variable any private decision a descendant must adapt to* — colour roles
(`--chrome-mask`, `--hover-fill`) and geometry roles (`--rail-*`) are its two
families. Fix `css/text/CLAUDE.md`'s "no double-apply" wording so it stops reading
as a member of this family.

## The gate (unchanged from v1)

The structural fix is a fixture kind that hands the harness a *hole* instead of a
child list. It expands into the existing `LayoutFixture`, so all three consumers
(bun:test, check, Layout Lab gallery) are untouched.

- `layout-harness/core/types.ts` — `RegionFixture { kind: "region"; render: (children: ReactNode) => ReactElement }`,
  `isRegionFixture`, the union `HarnessFixture`, a `railAlignment` invariant, and a
  `railOverride` mutation. `MeasuredFixture` grows `slots[k].contentLeft`
  (`rect.left + parseFloat(paddingLeft)` — the idiom the callout/context e2e scripts
  already use) and `railStart`/`railEnd` read off the container's computed style.
- `core/oracle.ts` — `checkRailAlignment`: at every width, every measured slot's
  `contentLeft` ≈ `container.left + railStart`. A region publishing no rail fails
  with a named message, which is what makes publishing load-bearing.
- `web/internal/region-children.tsx` — the one kit (`web/` because it imports ui-kit
  components and `core/` may not cross runtimes): a bare `Input`, a `Button`, a
  `Text`, a `display:contents`-wrapped child, and a `rail-bleed` row.
- `web/internal/expand-region-fixtures.ts` — renders the whole kit in one region,
  with `railAlignment` + `noClip` + a `railOverride → railAlignment VIOLATED`
  falsification.
- `web/internal/entry.tsx` — `applyMutation` handles `railOverride`; `__measure`
  fills the new fields.
- `check/classify.ts` — add `railAlignment` to `ORACLE_INVARIANT_KINDS`, or a real
  regression is misclassified as an environmental timeout and passes non-fatally.

**Region fixtures to contribute:** `control-panel` (at both width roles, 262/524),
`data-view` (new `fixtures/` contributor), and `ui-kit`'s `OverlayPanel`.

## The dev guard

`plugins/primitives/plugins/css/plugins/rail/web/internal/use-rail-guard.ts` —
mirror `data-view/web/internal/use-dev-guards.ts` in shape: `import.meta.env.DEV`
early return, one `requestAnimationFrame`, `console.error` (loud, never throws),
returns the ref to attach, own hook so the ref read stays out of the host's React
Compiler analysis. It skips children generating no boxes (`getClientRects().length === 0`,
the same non-participant rule `__measure` applies) and children whose own computed
`--rail-start` differs from the root's (they opened a nested region). Attach in
`ControlPanel`, `DataView` (beside the existing guard), and `OverlayPanel`.

## Deleted by the end of this

`--pane-gutter` · `px-pane-gutter` · `pane-gutter-flush` · `PANE_GUTTER_VAR` ·
`DataTable.gutter` · `DialogContent.padded` · `openDialog`'s `padded` ·
`--scroll-pad` · `--cp-inset-start` · `--cp-inset-end` · and
`control-panel/CLAUDE.md`'s "Any new fixture must render something other than a
`Row`", now mechanized.

## Still out of scope

- **No lint rule, no static check.** `rail-follow` and plain `px-*` can still drift
  from the published rail; the gate catches it only for registered regions. The
  "a box owning an inline inset must publish it" check is the next rung, and the
  contract is shaped so it has something to read.
- **`PaneChrome` does not become a region owner** — see B.
- **Inline axis for the *rail*; block axis for publication only.** `--rail-block-*`
  is published so `scroll-fade` can read it, but `railAlignment` asserts the inline
  rail only. That is where the bug class lives.

## Verification

1. `./equin build`, then `./equin check` — `app-css-utilities-in-sync`
   (the new ramp + its `sg-rail` group header), `css-vars-supplied` (the four new
   vars, and no dangling `--scroll-pad`/`--cp-inset-*` references), `type-check`,
   `plugin-boundaries`, `collected-dir-tsconfig-coverage`, `plugins-doc-in-sync`.
2. `bun test …/layout-harness/core/oracle.test.ts` — `checkRailAlignment` on
   synthetic boxes.
3. `./equin check layout-geometry` — green, **and the falsification must
   bite**: `railOverride` has to report `railAlignment` VIOLATED or the suite throws
   `falsification did not bite`. Run twice; the second must short-circuit on the
   sidecar marker with no Chromium launch.
4. **The negative that matters.** Revert `cp-panel` to insetting via the row tracks
   only and confirm `control-panel/region` goes red naming `bare-input` and
   `bare-button`. This is the case that passed green three times.
5. Re-run the three existing e2e verifiers, which cover exactly what the
   width-only oracle cannot see: `control-panel/e2e/hairline-verify.ts` (the band
   rules still bleed the panel's whole inset), `ui-kit/e2e/scroll-fade-verify.ts`
   (the block padding still reaches the padded edge after the `--scroll-pad`
   rename), `data-view/e2e/control-panels.ts`.
6. Screenshot sweep at `http://<worktree>.localhost:9000`, since B and C are
   visible everywhere: `/tasks` (tree + list + the Filter/Sort panels), `/sonata`
   (gallery **and table** — column alignment is the #1 confirm), `/settings` config
   tree, `/pages` sidebar, Studio release history and Workflows definition detail
   (DataView inside a detail section — must align to the section inset, not 12px
   deeper), plus the three ex-`padded={false}` dialogs (quick-find, command
   palette, version history). **Corrected acceptance criterion:** their *bands*
   (search header, hint footer, title rule) must span the panel edge-to-edge,
   and their *rows* must sit inset on the panel's rail. The original wording —
   "whose rows must still reach the panel edge" — is unmeetable and must not be
   read as a regression: all three put their list inside a `ScrollArea`, whose
   base-ui Viewport sets `overflow: scroll` on both axes, and a negative end
   margin does not shrink scrollable overflow. Bleeding a row there adds sideways
   scroll instead of widening its fill. A bleed is only free directly under a box
   that hides `overflow-x`, which `OverlayPanel` does and a nested `ScrollArea`
   does not.
7. Dev guard: with devtools open, visit the above with no `[rail]` errors; then
   wrap a panel child in `<div className="px-xl">` and confirm it names the
   offender and the delta.

## Critical files

- `…/css/plugins/ui-kit/web/theme/app.css` — the ramp + `rail-bleed` + `rail-follow`,
  the `sg-rail` twmerge group header, `cp-*` rewrites, `scroll-fade`'s var rename,
  and the theme-scope token block.
- `…/css/plugins/ui-kit/web/theme/popover-width.ts` — `POPOVER_PADDING` → `rail-<step>`.
- `…/css/plugins/ui-kit/web/components/ui/{dialog,select}.tsx` + `overlay-panel.tsx` —
  the `padded` removal.
- `…/data-view/core/internal/header-offset.ts` — `PANE_GUTTER_VAR` deletion.
- `…/data-table/web/internal/{data-table,types}.ts` — `gutter` prop deletion.
- `…/layout-harness/{core/types.ts,core/oracle.ts,web/internal/*,check/classify.ts}` — the gate.
- `…/data-view/web/internal/use-dev-guards.ts` — the shape `useRailGuard` copies.
- `plugins/primitives/plugins/css/plugins/rail/` — new plugin: constants, guard, CLAUDE.md.
