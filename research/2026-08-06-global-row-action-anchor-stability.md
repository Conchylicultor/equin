# Row-action anchor stability: make hover-reveal layout-neutral, and the popup-open signal typed

## Context

Opening a Pages sidebar row's `⋯` menu and then moving the pointer off the row makes the
open menu jump ~52px right. Measured before the first attempt: menu `x` 111 → 163 while the
row's action cluster collapsed to width 0 and the `⋯` trigger slid 226 → 278. The cluster is
the menu's anchor, so the anchor moves and base-ui's positioner follows it.

`TreeRowChrome` reveals its action cluster by changing **layout**: a `Clip`
(`overflow-hidden`) that goes `w-0` → `w-auto` on `group-hover/tree-row`
(`tree-row-chrome.tsx:243-250`). Off-hover it collapses, which shoves the still-mounted
trigger to the collapsed edge. A `has-…` rule was added to hold the cluster expanded while a
descendant popup is open — first spelled `has-data-[state=open]` (Radix's contract, which
base-ui never sets, so it provably never fired), then corrected to `has-[[data-popup-open]]`
in `c181ec8c1`. The jump was reported as still reproducing after that correction.

> **Measured verdict (2026-08-06) — the reported bug is already fixed; this is hardening, not a
> bug fix.** On a fresh deploy of `c181ec8c1` the anchor holds at `x=226` with the cluster
> pinned at `76px` while the row's `:hover` flips to `false`, for both gestures (pointer off the
> tree, and the reporter's own path of moving onto the first row). Restoring the dead Radix
> selector reproduces the report exactly — trigger `226 → 278`, cluster `76px → 0`, menu
> `111 → 163` — so the probe is sensitive to the defect; it simply is not present.
> `row-actions-overflow.ts` is **not** vacuous either: it fails on that broken build with
> `x:163` vs `111`. The vacuity theory assumed base-ui's overlay drops the row's hover before
> the baseline is taken; measurement says `rowHovered=true` at that instant, because the pointer
> rests on the `⋯`, a *descendant* of the row. The original report was almost certainly made
> against a deploy predating the fix.
>
> The work below is therefore justified on its own terms — one row-action implementation instead
> of two, and an anchor that is stable by construction rather than by a selector naming another
> library's attribute contract — and **not** as a fix for a live defect. Step 5 (the lint rule)
> is cut per the user's decision.

**Exploration ruled the selector out as the remaining cause.** base-ui 1.3.0's
`CommonTriggerDataAttributes.popupOpen = "data-popup-open"` is set on `Menu.Trigger`, and the
compiled CSS in the shared artifact cache
(`~/.singularity/web-artifacts/css/css.dc326c154f1ae138/style-B430yVTF.css`) contains the
emitted rules verbatim:

```css
.has-\[\[data-popup-open\]\]\:w-auto:has([data-popup-open]){width:auto}
.has-\[\[data-popup-open\]\]\:opacity-100:has([data-popup-open]){opacity:1}
.has-\[\[data-popup-open\]\]\:pointer-events-auto:has([data-popup-open]){pointer-events:auto}
```

So the current selector is live. Either the reported repro ran against a stale deploy, or a
second thing moves the anchor. Step 1 below settles that by measurement rather than by
guessing — but the fix does not depend on the answer, because it removes the mechanism
instead of patching the condition.

The intended outcome, in order of what actually matters:

1. **The anchor cannot move.** Hover-reveal stops changing layout, so no rule is load-bearing
   for correctness. This is a shared-primitive fix — the same cluster backs the agents list,
   the task list and the Studio explorer, not just Pages.
2. **The popup-open dependency stops being a string.** A CSS selector naming another
   library's attribute contract is unverifiable by any type system, which is exactly how the
   Radix spelling rotted unnoticed. Replace it with a typed React signal published by ui-kit.
3. **The rot cannot recur silently.** A lint rule confines popup-library attribute spellings
   to ui-kit, and the e2e assertion that was supposed to catch this becomes non-vacuous.

## Root cause, stated structurally

`row-actions` — the primitive built for exactly this job — reveals with **opacity only**
behind an absolute `Pin to="right" mask` (`row-actions.tsx:36-39, 116-124`), so its cluster
occupies no flow width and its geometry is identical hovered or not. `TreeRowChrome` hand-rolls
a second, layout-changing implementation of the same affordance. Two implementations of "hover-
revealed trailing row actions" exist; the one whose reveal reflows the row is the one with the
bug. Converging on the primitive is the fix.

## Step 1 — Measure what still moves (before changing anything)

Non-negotiable first step: the selector is provably live, so "it still jumps" is currently an
unexplained observation. Build, then drive the Pages sidebar and capture, at the hover-out
instant: the cluster's `getComputedStyle().width`, `clip.matches(':has([data-popup-open])')`,
and the `⋯` trigger + menu rects before and after. Walk the trigger's ancestors comparing
`getBoundingClientRect()` across the transition to name the element that actually moved.

Fold the numbers into the e2e as `r.note()` lines (Step 6) so a future failure explains
itself instead of restarting this investigation. If the measurement shows the cluster already
holds at `w-auto` and something else moves, say so plainly and re-scope before proceeding —
the steps below still stand, but the claimed cure needs re-confirming against the real cause.

## Step 2 — New leaf primitive: `primitives/popup-open`

`plugins/primitives/plugins/popup-open/` — a typed "is a popup open inside me" signal.
Scaffold it byte-for-byte off a sibling leaf primitive (`primitives/latest-ref` or
`primitives/overlay-boundary`); `overlay-boundary`'s own CLAUDE.md states the precedent for
sitting *below* ui-kit so ui-kit can consume it without a cycle. This plugin must import
nothing — not even `cn` — so the ui-kit → popup-open edge stays acyclic.

```tsx
/** Aggregates every popup registered inside it. No DOM, no provider required. */
export function PopupOpenScope({ children }: { children: (open: boolean) => ReactNode }): ReactNode

/** Called by a popup wrapper. No-ops outside a scope (tolerates no Provider, like sync-status). */
export function useReportPopupOpen(open: boolean): void
```

Internals: a context carrying stable `register`/`unregister` callbacks over an open-count;
`useReportPopupOpen` registers on the `true` edge and unregisters on `false` and on unmount.
The render-prop child is deliberate — it makes "provide the scope" and "read the aggregate"
one component, so a consumer cannot wire half of it.

Cover it with a vitest suite in `web/__tests__/` (jsdom, per the runner split): open → held,
close → released, two popups → held until both close, unmount-while-open → released, and no
Provider → no throw.

## Step 3 — ui-kit publishes the signal

`plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/{dropdown-menu,popover,select}.tsx`:
each `Root` wrapper mirrors base-ui's open state and calls `useReportPopupOpen(open)`, passing
`onOpenChange` through untouched (base-ui's signature is `(open, eventDetails)` — forward with
a spread, don't retype it). Respect a controlled `open` prop when present, fall back to the
mirrored uncontrolled state otherwise.

Tooltip is deliberately excluded: a tooltip holding a row's cluster open is noise, not intent.

This is the only place in the repo that names base-ui's contract, which is what makes Step 5
enforceable with zero exemptions.

## Step 4 — Layout-neutral cluster

**`primitives/row-actions`** (`web/internal/row-actions.tsx`) — wrap the cluster in
`PopupOpenScope` and OR the held state into the reveal:

```tsx
<PopupOpenScope>
  {(popupOpen) => (
    <Stack … className={alwaysVisible ? undefined
      : cn(revealClasses, popupOpen && "opacity-100 pointer-events-auto")}>
```

Switch the class string to `cn()` (already imported via ui-kit) so tailwind-merge resolves
`opacity-0` ↔ `opacity-100` in favour of the held state. This also fixes every *existing*
`RowActions` consumer — deploy, events, studio and conversations list rows today fade their
cluster out while its own dropdown is still open.

**`primitives/tree`** — `TreeRowChrome` (`web/internal/tree-row-chrome.tsx:223-256`) drops the
bespoke reveal and renders `<RowActions>{actions}</RowActions>`. Delete the `Clip` block, the
`w-0`/`w-auto`/`has-[[data-popup-open]]` classes, the now-obsolete load-bearing comment, and
the `Clip` import if it falls unused. The row `<Stack>` (`:165-171`) gains `rowActionsAnchor`
(`group/row-actions relative`) and co-publishes `--scrim` alongside each tint so the pinned
mask paints the colour actually on screen — mirror `css/row/web/internal/row.tsx:129`
byte-for-byte:

```
"hover:bg-accent hover:[--scrim:var(--accent)]",
selected && "bg-accent [--scrim:var(--accent)]",
```

`RowChrome` (`web/internal/row-chrome.tsx`) needs the same `--scrim` on its `isOverChild`
tint (`:bg-accent ring-primary/40`), and its `addChild` `ControlSizeProvider size="xs"`
wrapper becomes redundant — `RowActions` already provides it. Two accepted deltas, both
converging on the primitive: cluster gap goes `2xs` → `none` (what every other row in the app
uses), and long labels now dissolve under the scrim instead of re-truncating to an ellipsis.

**`row-chrome.tsx:99-109`** — the legacy `rowMenu` trigger hand-writes
`data-popup-open:bg-background/60`, a popup-library contract spelled outside ui-kit and the
second instance the report named. Convert it to `render={<Button variant="ghost" aspect="icon"/>}`
(mirroring `reorder/node-types/overflow`'s `OverflowBox`), and put the open-state tint **once**
inside ui-kit's trigger styling so every dropdown trigger reads as pressed while open. Note
this is a deliberate small app-wide visual addition — it is the behaviour both sites were
already trying to express, and it is why the older `⋯` never showed an open-state background.

## Step 5 — Lint rule: `no-adhoc-popup-state` — **CUT**

Dropped by decision. Recorded here only so the reasoning is not re-derived: it would have
confined popup-library attribute spellings to ui-kit, but it could never have caught the
original bug (our own `Collapsible` legitimately sets `data-state="open"`, so no static scan
distinguishes a live selector from a dead one). Runtime proof is what actually guards this, and
`row-actions-overflow.ts` already provides it — verified failing against the broken selector.

<details><summary>Original text</summary>

New lint-only plugin
`plugins/framework/plugins/tooling/plugins/lint/plugins/popup-state-safety/lint/{index.ts,no-adhoc-popup-state.ts}`,
mirroring the sibling `hover-reveal-safety` barrel exactly (auto-discovered by the root
`eslint.config.ts`; no registration edit). AST-based via `ESLintUtils.RuleCreator` +
a `JSXAttribute` visitor, reusing the `>>> shared:class-token-walk <<<` block **byte-for-byte**
— `class-token-walk-in-sync` enforces that and will fail on any drift.

Report any `className` token whose variant names a popup open-state contract: base-ui's
`data-popup-open` / `data-open` / `data-closed` / `data-pressed`, and the Radix-era
`data-[state=open|closed]` in every wrapper form (`group-data-`, `has-data-`, `has-[[…]]`,
`group-has-[…]`). Exempt exactly one path — `plugins/primitives/plugins/css/plugins/ui-kit/`,
which owns the contract. No other allowlist.

Banning `data-[state=open|closed]` outright is free today (zero live occurrences repo-wide;
both remaining hits are comments) and stays honest: our own `Collapsible` does set
`data-state="open"|"closed"`, so the message should route a Collapsible consumer to the
primitive's own API rather than to a selector.

State the limit rather than overselling it: **no static rule can prove a selector matches at
runtime.** A "is this attribute produced anywhere in-repo?" scan would not have caught the
original bug, because `Collapsible` does produce `data-state="open"`. What this rule buys is
that the contract is spelled in exactly one file, so a library change is a one-line edit
instead of a silent repo-wide rot. Runtime proof is Step 6's job.

</details>

## Step 6 — Keep the e2e aimed at the invariant

The assertion is **already discriminating** (verified failing at `x:163` vs `111` against the
broken selector), so the planned rewrite-for-vacuity is unnecessary. What it needs instead is to
keep testing the invariant *after the mechanism changes*: the `has-[…]` rule disappears in
Step 4, replaced by the React signal, and this test becomes that mechanism's only regression
guard. Add one direct assertion on the `⋯` trigger's own `x` (the anchor is the thing under
test; the menu box is downstream of it) and keep the existing menu-box check. Do not weaken it.

<details><summary>Original text (premised on vacuity — superseded)</summary>

`plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts:75-91`. Today's
baseline `atOpen` is captured **after** the click that opens the menu, by which point base-ui's
overlay has likely already dropped the row's `:hover` — so it compares two identical post-jump
positions. Rewrite it to:

- capture the `⋯` trigger's box while the row is hovered and the menu is **closed** — that is
  the geometry the open menu must preserve;
- open the menu, move the pointer off the row, and assert the **trigger's own `x` is
  unchanged** (the anchor is the thing under test; the menu box is downstream of it);
- assert the hover really dropped (`row.evaluate(el => el.matches(':hover'))` is false),
  otherwise the comparison is vacuous for the opposite reason;
- keep a menu-vs-anchor position assertion, and `r.note()` the Step 1 diagnostics.

**Gate: prove it red.** Temporarily restore the `w-0` collapse and confirm the new assertion
fails by ~52px before accepting the fix. An assertion never observed failing is not evidence.

</details>

**Already done for the pre-refactor code**: the red gate was run on 2026-08-06 (broken selector →
`FAILURES: 1/15`, `x:163` vs `111`; restored → `ALL CHECKS PASSED (15)`). Re-run it after Step 4
against the *new* mechanism — the point is that the signal, not the selector, is now what holds.

## Files

| Path | Change |
|---|---|
| `plugins/primitives/plugins/popup-open/**` | **new** leaf primitive + vitest suite + CLAUDE.md |
| `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/{dropdown-menu,popover,select}.tsx` | publish open state; trigger open-state tint |
| `plugins/primitives/plugins/row-actions/web/internal/row-actions.tsx` | consume `PopupOpenScope`; `cn()` merge |
| `plugins/primitives/plugins/tree/web/internal/tree-row-chrome.tsx` | drop `Clip`/`w-0`/`has-[…]`; render `RowActions`; anchor + `--scrim` |
| `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx` | `--scrim` on drop tint; shared `Button` trigger; drop redundant `ControlSizeProvider` |
| `plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts` | add a direct `⋯`-trigger-x assertion; keep the existing menu-box check |
| `plugins/primitives/plugins/{tree,row-actions}/CLAUDE.md` | record the one-implementation rule |

## Verification — results (2026-08-06)

All green on the deployed build (`status: ok`):

- `row-actions-overflow.ts` — **18/18**, including the two new assertions
  (`⋯ anchor is where it was before its menu opened`, `⋯ stays visible while its own menu is open`).
- `container-members.ts` **6/6**; `grouped-reorder.ts` **4/4** (see caveat below).
- `popup-open` vitest **5/5**; ui-kit vitest **7/7**.
- Build's own check suite passed (eslint, boundaries, doc/registry sync, layout-geometry, …).

**The visibility assertion is provably non-vacuous.** Rather than a sabotage build, the signal was
isolated directly: with the pointer AWAY from the row in both cases (`rowHovered=false` in each),
the cluster reads `opacity=0` with the menu closed and `opacity=1` with it open. Same element,
same hover state — the only difference is the popup-open signal, so that is what the assertion
tests. (A first attempt to sabotage `RowActions` instead was rejected by eslint's
`no-constant-binary-expression`, and `--skip-checks` does not skip that gate.)

**Caveat — `grouped-reorder.ts` fails on its default arguments**, and did so before this work:
it hardcodes two root pages, `Website` and `Todos`, and this worktree's DB fork has no root page
named `Todos` (the tree holds Daily / Website / Roadmap / Story / App / Jobs). Run it as
`--second Roadmap`. Not a regression — the fixture titles are simply not in this database.

## Verification (procedure)

1. `./equin build`, then confirm `status: ok` in
   `~/.singularity/worktrees/att-1785971660-qd3z/build-status.json` (never infer from a
   `build-*.log`).
2. `bun plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts` — the
   anchor assertion passes, and passes only *after* it has been observed failing against the
   restored `w-0` collapse.
3. Neighbouring e2e that touch the same rows:
   `plugins/apps/plugins/pages/plugins/page-tree/e2e/grouped-reorder.ts` and
   `plugins/reorder/plugins/node-types/e2e/container-members.ts`.
4. `./equin test plugins/primitives/plugins/popup-open` — both buckets.
5. `./equin check` — `eslint` (the new rule runs repo-wide),
   `class-token-walk-in-sync`, `plugin-boundaries` (ui-kit → popup-open must not cycle),
   `plugins-doc-in-sync`, `tailwind-scan-covers-classes`.
6. Manual hover pass on all four tree surfaces — Pages sidebar, agents list, task list,
   Studio explorer — plus reorder edit mode, where the overflow bucket renders a wide inline
   box that the pinned cluster will overlay. If edit mode reads badly, render the cluster
   unpinned in that mode only; no popup is anchored there, so it costs nothing.
7. Open a row menu, move the pointer away, and confirm the menu is stationary and the `⋯`
   stays visible while open — the two behaviours this whole change exists for.
