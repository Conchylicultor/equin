# An occupant that renders nothing at a rung: making the flip unrepresentable

## Context

Two different absences meet in `plugins/primitives/plugins/adaptive-bar/`, and
one is readable as the other.

`assign` (`core/fit.ts`) omits an item flagged `absent` from the placement it
returns — "there is nothing to place". `rungOf`
(`web/internal/adaptive-bar.tsx`) reads an id **missing** from the placement as
rung 0, which is right for an item that has never been placed.

So an occupant that renders content at its full rung and nothing at its compact
rung cycles:

| round | placement | what the widget renders | what the bar concludes |
|---|---|---|---|
| 1 | `{}` | `rungOf` → 0 → full form → content | measures it, demotes it to rung 1 |
| 2 | `{w: 1}` | compact form → nothing | container empty ⇒ `absent` ⇒ dropped from the placement |
| 3 | `{}` | `rungOf` → 0 → full form → content | … and round 1 again |

`samePlacement` sees a change every round. No widget in the repo renders nothing
at `compact` today, and the round budget added on 2026-08-17
([convergence-premise-scope](./2026-08-17-global-adaptive-bar-convergence-premise-scope.md))
terminates the cycle with a `no-convergence` fault rather than a render loop — so
this is about making the cycle **unrepresentable**, not about a live crash. That
doc filed it as a follow-up in exactly those words.

The file already documents the same class of confusion one level up (the
`null`-versus-missing distinction `rungOf` exists to make). This is its second
instance, which is the argument for fixing the representation rather than the
symptom.

## The root cause, in one sentence

**Absence is a property of an occupant *and a rung*, and the bar records it as a
property of the occupant.**

`entry.container.hidden` is computed from `childElementCount === 0` at whatever
rung the occupant happens to be rendering at, handed to `assign` as
`FitItem.absent`, and from there means "this occupant is nothing, at every form".
It is not: it means "this occupant renders nothing at *the rung it is currently
at*". Every step of the cycle above follows from reading the narrower fact as the
wider one.

## Approach

### A. A per-(occupant, rung) ledger — `core/absent-rungs.ts` (new)

Shaped like `core/blocked-rungs.ts`, which is the established precedent in this
plugin for a per-(item, rung) fact that is not a width, with its own invalidation
rules:

```ts
export type AbsentRungs = ReadonlyMap<string, ReadonlySet<number>>;
export const noAbsentRungs: AbsentRungs;
export function markAbsentRung(a: AbsentRungs, id: string, rung: number): AbsentRungs;
export function isAbsentRung(a: AbsentRungs, id: string, rung: number): boolean;
/** The occupant's content or ladder moved: everything recorded about it is hearsay. */
export function clearAbsentRungs(a: AbsentRungs, id: string): AbsentRungs;
/** The declared ladder, cut short at the first rung the occupant renders nothing at. */
export function offeredRungCount(a: AbsentRungs, id: string, declared: number): number;
```

Not in `core/width-cache.ts`: that ledger's every entry is a number the fit adds
up, and `write` already refuses a 0 outright on the grounds that "absence is
decided from the DOM, never from a 0 in this ledger". Keeping that refusal and
putting the DOM's own answer in its own ledger preserves the distinction instead
of blurring it, and it costs no churn to `estimate` / `inlineWidthsFor` or their
tests.

### B. The bar never offers a rung it has learned is blank

In `reconcile`'s `FitItem` construction, the rung count becomes
`offeredRungCount(absentRef.current, id, inlineRungsOf(entry.ladder).length)`, so
`inlineWidths` is cut short. A cut to **zero** — blank at its widest form — is an
occupant that renders nothing at all; see C for what happens to it.

That is the whole fix. The bar cannot put a widget somewhere it renders nothing,
so it cannot un-place it for having rendered nothing, so there is no flip.

The remedy the fit then reaches for is the honest one: an occupant that cannot
shrink is asked to *leave the row* (or the row runs out of room and takes its
floor) — relocation, which is what this primitive is for, rather than the
vanishing that is the worst transformation there is.

### C. `FitItem.absent` is deleted, and the placement becomes total

An occupant with **no offered rung** is not an occupant, and the driver is the
one place that says so: `reconcile`'s item construction already computes the cut,
so it `continue`s past a cut-to-nothing occupant and `assign` never sees one.
Everything downstream — the fit, `passBudget`, `commitFloor` — takes occupants as
given and repeats the rule nowhere, and `assign`'s placement is **total over its
input**, so a caller reading it back has one meaning for a missing id.

This is the rung-1 half of the fix (make the wrong thing unspellable): `absent`
and the ladder can no longer disagree, because there is only one of them left.
"Renders nothing" and "has a rung 0 that renders content" cannot both be true of
one item, which is precisely the state the cycle needs.

`FitItem` gains one field on the way, `declaredRungs`, read by `passBudget`
alone. A cut ladder means the search spent a round *discovering* something, and a
budget derived from the offered ladder would shrink by exactly the rounds it is
meant to be paying for.

### D. Learning and invalidation, in the measure loop

The loop today `continue`s past a hidden container — it learns nothing from the
one state that carries the fact. Instead, for an occupant docked inline:

- **hidden** (renders nothing at this rung) → `markAbsentRung`, plus `unbarItem`:
  an H2 bar says "this rung did not fit", which was a claim about content the
  occupant is evidently no longer rendering.
- **measured, where a blank was recorded, or measured differently at a rung it
  was already on** → one clause, because it is one conclusion ("what this
  occupant renders has changed"): `staleOthers` + `unbarItem` +
  `clearAbsentRungs`.

Two things here are counter-intuitive enough to have been got wrong in the first
draft, and both are now pinned by tests:

- **The blank branch must NOT invalidate widths.** The symmetry is a trap: the
  ladder has just been cut to that rung, so downgrading rung 0 leaves it with no
  wider rung to bound it, `resolveWidth` reports `unbounded`, `doesFit` is false
  at *every* width, and the search walks every other occupant out of the row to
  pay for one widget's blank form. On a row within `HYSTERESIS_PX` of the ideal
  that round also latches: H1 refuses to promote them back, "everything evicted"
  is a stable placement the fit agrees fits, and the bar converges silently on an
  empty row. Nothing is lost by leaving the widths alone — the pass measured
  nothing, and anything below the cut is unreachable until the mark is cleared.
- **A blank rung above 0 is never sat on again**, so "it renders there after all"
  is unobservable and a guard looking for it is dead code. The only evidence that
  can discharge the mark is gathered elsewhere — the occupant measuring
  differently at the rung it *is* on — which is why the clearing lives in that
  clause and not in a symmetric branch.

`clearAbsentRungs` also runs where `unbarItem` already runs in the registry: on
unregister, and on a ladder whose rung set changed — a rung index means nothing
against a different ladder. The two ledgers share a key space and are cleared at
the same four sites; both module docs say so.

The premise's `shape` deliberately keeps recording the **declared** ladder. A cut
is self-inflicted — the bar found the blank rung by putting the widget there —
and a premise is what a decision reads that the decision itself does not cause.
Counting it would reset `rounds` on the bar's own chain, blame the shift on "the
widths underneath this bar", and clear `episode.promoted`, throwing away H2's
evidence for every other occupant in the row.

A committed rung outside the declared ladder records nothing: that is stale
bookkeeping the next pass clamps, so there is no form to name and nothing true to
say about the rung.

The residual ignorance is stated rather than papered over: an occupant whose
compact form comes back while its full form's width does not move is never
re-offered the compact rung. The bar cannot observe that, so the recovery is the
widget's to declare — a widget that cannot render a form right now should stop
declaring it, which `registry.declare` already invalidates on. That sentence is
now in `useActionForm`'s docs, where an author reads the promise they are
making.

### E. `rungOf`'s default becomes justified rather than incidental

After B and C, an id missing from the placement is either an occupant that
mounted since the last decision or one that renders nothing at every form it was
offered. Both want rung 0, and for the same reason: nothing has been decided
about this occupant, so it renders as itself and its own output decides what
happens next — and an occupant that renders nothing at rung 0 keeps rendering
nothing there, so the default cannot start a flip. Written down at `rungOf`,
because the safety is a property of B and would be lost by anyone who undid it.

### F. A new fault kind, `empty-rung`

A widget that declares `shrinksTo: ["compact"]` and then renders nothing as
compact has declared a form it does not render. The bar now recovers silently and
correctly, which means nobody would ever find out — so learning a blank rung
**above rung 0** files a report naming the occupant and the form.

Through `reportFault`, never `failLoudly`: no dev throw. A widget rendering
nothing for one frame while its data loads is plausible, and taking a pane down
over it would be worse than the fault. Rung 0 being blank is the supported "the
contribution rendered nothing" case and reports nothing at all.

The occupant is a **typed field** (`item: { id, rung, form }`), not only a phrase
in the message, and `item.id` joins the fingerprint. This is the one fault kind
whose subject is a specific contributor, so one bar holding three vanishing
widgets is three findings with three different owners — collapsing them onto one
row would hide two behind the first one's count.

## Files

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/core/absent-rungs.ts` (new) | the ledger above, pure |
| `plugins/primitives/plugins/adaptive-bar/core/absent-rungs.test.ts` (new) | its rules |
| `plugins/primitives/plugins/adaptive-bar/core/fit.ts` | `FitItem.absent` deleted; zero rungs ⇒ not an occupant, in `assign` and `passBudget` |
| `plugins/primitives/plugins/adaptive-bar/core/width-cache.ts` | `staleOthers` gains the "there is deliberately no keep-nothing spelling" note, and why |
| `plugins/primitives/plugins/action-presentation/web/internal/action-form.tsx` | the other half of the promise: declaring a form commits you to rendering something as it, and a form you cannot render right now should not be declared right now |
| `plugins/primitives/plugins/adaptive-bar/core/index.ts` | barrel |
| `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` | `absentRef`, the measure loop's blank branch, the offered rung count, `commitFloor`, `rungOf`'s prose, registry invalidation |
| `plugins/primitives/plugins/adaptive-bar/web/internal/diagnostics.ts` | the `empty-rung` fault kind |
| `plugins/reports/plugins/adaptive-bar/{core,server,web}` | payload enum + the typed `item`, the fingerprint, the collector's `satisfies` pin, the task body, the Debug → Reports line |
| `plugins/primitives/plugins/adaptive-bar/web/__tests__/absent-rung.test.tsx` (new) | the regression, in jsdom |
| `plugins/primitives/plugins/adaptive-bar/core/fit.test.ts` | the `absent` cases restated as zero-rung ones |
| both `CLAUDE.md`s | the third absence, and the new `core/` module |

## Verification

1. `./equin test plugins/primitives/plugins/adaptive-bar`
   - `core/absent-rungs.test.ts` — a blank rung truncates the offered ladder;
     blank at rung 0 ⇒ no rungs; clearing is per item.
   - `core/fit.test.ts` — an item with no rungs costs no width, no gap, never
     evicts, and has no entry in the placement.
   - `web/__tests__/absent-rung.test.tsx` — a widget that renders nothing as
     `compact` settles (no `no-convergence`), goes to the panel where it renders
     as itself, and files exactly one `empty-rung` naming it; the other occupants
     never leave the row on ANY round of the episode, including on a row too
     tight to take them back at full width; a widget that renders nothing at
     every form files nothing and settles.

     The two "never leave the row" assertions are mutation-verified: re-adding
     the width invalidation to the blank branch turns both red, with the row
     holding only the vanishing widget on one round and latching empty on the
     tight one.

   Result: 101 bun tests across 6 core files and 35 jsdom tests across 7 web
   files, all passing.
2. `./equin check` — type-check, boundaries, doc/registry sync.
3. `./equin build`, then the Layout Lab (Debug → Layout Lab) and
   `bun plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-churn.ts --url http://<worktree>.localhost:9000/agents/c/<id>`:
   a healthy sweep still files nothing.
