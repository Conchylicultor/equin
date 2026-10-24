# Bidirectional conflicts for synthetic twmerge groups

## Context

A custom `@utility` in `app.css` declares how `cn()` must treat it with a
co-located `/* twmerge: … */` marker. The `<sg-id>` form points at a group
declared once as `/* @twmerge group <sg-id> conflicts: <builtin…> */`, and the
generator compiles that list to `conflictingClassGroups[builtin].push(group)`.

In tailwind-merge that is a **one-directional** rule: a later class of the
builtin removes an earlier class of the group, never the reverse. There is no
spelling for the other direction, so the builtin-first order is unprotected —
and base-classes-first / caller-`className`-last is how nearly every component
in the repo composes.

The consequence: a synthetic-group utility and a conflicting builtin can both
survive on one element, with the CSS cascade rather than `cn()` deciding which
wins. It bites hardest where a custom utility bundles a declaration with a side
effect: `rail-<step>` applies padding *and* publishes it as `--rail-*` for
descendants to read, so `cn("px-md", "rail-lg")` keeps both — the element
publishes `lg` while actually being padded `md`, and a descendant reading the
published rail is told a number that is not true. That is the precise failure
the rail contract exists to prevent, and `app.css` currently documents it as a
tolerated lie with "the fix is bidirectional conflicts in the codegen".

This is that fix. It applies to every synthetic group (`sg-pad`,
`sg-control-*`, `sg-rail*`, `sg-icon-auto`) and every future one.

## Design

### The relation, and where it comes from

`conflicts:` is replaced by **`excludes:`** — mutual exclusion. Every id listed
is a group the utility must never coexist with, in either order. The old
keyword is removed outright: the generator throws on `conflicts:` naming the
replacement, so no marker silently keeps the one-directional semantics.

Two **closures** over tailwind-merge's own default `conflictingClassGroups`
turn a short authored list into the full relation. Both are monotone and always
sound:

- **forward (dominance)** — if the group beats `px`, it beats everything `px`
  beats (`pr`, `pl`). Emitted as `conflictingClassGroups[sg] += …`.
- **reverse (submission)** — if `px` beats the group, then `p` (which beats
  `px`) beats the group too. Emitted as `conflictingClassGroups[builtin] += sg`.

This matters concretely: the authored `over:`-style lists a human would write
miss `ps`/`pe`/`pbs`/`pbe`, which are real 3.5.0 groups and are not even in the
project's `BuiltinGroupId` allow-list. A computed closure inherits
tailwind-merge's own coverage and moves when they fix it.

Verified 3.5.0 defaults (`node_modules/.bun/tailwind-merge@3.5.0/…/bundle-mjs.mjs:3171`):
`p: [px,py,ps,pe,pbs,pbe,pt,pr,pb,pl]`, `px: [pr,pl]`, `py: [pt,pb]`,
`size: [w,h]`, `gap: [gap-x,gap-y]`; `h`, `w`, `min-h`, `z` have no entry.
`size` does **not** reach `min-w`/`max-w`, so closing over it is safe. The map
contains cycles (`fvn-*`, `touch-*`, `translate-*`) — the closure must be a
worklist with a visited set, not naive recursion.

### The escape hatch

**`under: <ids> -- <reason>`** stays in the grammar as the one named
one-directional relation: the builtin is genuinely broader, so a later builtin
removes the group but a later group member must not remove the builtin. The
reason is **required**, exactly as `standalone -- <reason>` requires one, so the
loophole is always argued for rather than reached for.

Worth stating plainly: **after closure, none of the eight existing groups needs
one.** Every `under:` the migration would have written (`sg-rail-x under: p`,
`sg-control-height under: size`) falls out of the reverse closure for free. The
clause ships documented and unused, for the case where a builtin must dominate a
group the group does not list as mutual. `over:` is not added — every case is a
forward-closure fact, and an unused second escape is worse than none.

### `rail-owe-*`

`rail-owe-*` shares `sg-rail-x` but writes no padding, only the `--rail-*` vars.
Under mutual exclusion a later `rail-owe-lg` now removes an earlier `px-md`.
**Accepted.** An element carrying both is already the double-inset trap
`app.css:551` names: it pays `md` while telling its bands they still owe `lg`,
so they inset twice. Dropping the `px-md` leaves the element matching what it
publishes (0 applied + `lg` owed = `lg` total), and it now fails the same way in
both class orders instead of one. One live call site
(`app-shell-layout.tsx:256`), which passes no padding class.

## The eight groups, restated

The author lists every group the utility must be mutually exclusive with; the
closures do the rest. A *publishing* utility lists the narrower per-edge groups
too — a later `pt-2` beside `rail-lg` would otherwise leave
`--rail-block-start` advertising a number `padding-top` no longer applies.

| group | `excludes:` | what closure adds |
|---|---|---|
| `sg-pad` | `p` | fwd: all ten padding longhands. (A later `px-2` correctly does **not** remove `p-card` — it overrides one axis; `p-card`'s block padding legitimately survives.) |
| `sg-control-height` | `h` | rev: `size` |
| `sg-control-icon` | `size h w` | rev: nothing new |
| `sg-control-min` | `min-h` | — |
| `sg-rail` | `p px py pt pr pb pl` | fwd: `ps pe pbs pbe` |
| `sg-rail-x` | `px pr pl` | rev: `p` |
| `sg-rail-y` | `py pt pb` | rev: `p` |
| `sg-icon-auto` | `size h w` | rev: nothing new |

Result: `cn("px-md","rail-lg")` → `rail-lg`; `cn("rail-lg","px-md")` → `px-md`.
Exactly one class survives, in either order, and what is published is what is
applied.

## Files and order of operations

Steps 3–6 are byte-comparison-coupled (`app-css-utilities-in-sync` re-runs the
generator in memory and compares) and the generator throws on the old spelling,
so they **must land as one commit** — anything else leaves the tree red.

**1. `…/ui-kit/web/lib/utils.ts` — the compiler.**
Add the cycle-safe forward/reverse closure over
`getDefaultConfig().conflictingClassGroups` (`getDefaultConfig` is exported from
`tailwind-merge`, which is declared in this plugin's own `package.json` — keep
the closure here, not in the generator, so it is always computed against the
version that will merge). Compile `excludes:` to both directions and `under:` to
the reverse half only. Support the new `excludes`/`under` shape alongside the
existing `conflictsWith` so this step is green on its own.

Two fixes while here:
- **`classGroups[entry.group] = [...entry.classes]` is an assignment.** The
  generator coalesces only *consecutive* records, so a group whose members
  appear in two non-adjacent runs of `app.css` emits two entries with the same
  id and the second silently overwrites the first — those classes drop out of
  twMerge entirely. Latent today (every group is contiguous), reachable as soon
  as anyone reorders `app.css`. Change to `(classGroups[g] ??= []).push(…)` and
  dedupe the relation pushes.
- **Assert every declared id is a real tailwind-merge group** against
  `getDefaultConfig().classGroups` at module eval. A typo currently only has to
  satisfy a hand-maintained allow-list duplicated across two files
  (`custom-utilities-gen.ts:33` and `custom-utilities-types.ts:31`, coupled by a
  "keep the two in sync" comment). This assertion is what lets the allow-list
  shrink to a validation rather than a curated set, and makes `mx`/`m`/`w`
  spellable for step 6.

**2. `…/ui-kit/web/theme/custom-utilities-types.ts` — the shape.**
The group arm becomes `{ classes, group, excludes: readonly string[], under?: readonly { group: string; reason: string }[] }`.
Rewrite the "twMerge wiring" block (lines 13–25) and the allow-list comment.

**3. `…/codegen/core/custom-utilities-gen.ts` — the grammar.**
Parse `excludes:` and `under: … -- <reason>`; **throw** on `conflicts:` naming
the replacement; throw on a group decl with no recognised clause (a typo'd
keyword must not yield a group with an empty relation set that generates
cleanly and merges nothing); throw on `under:` with no reason. The existing decl
regex (`custom-utilities-gen.ts:123`) terminates on `*/`, newline or EOF — it
must now terminate on the next clause keyword too, or `excludes: px pr pl` will
swallow a following `under:`. Update the header comment (5–22) and every error
string.

**4. `…/ui-kit/web/theme/app.css` — the declarations and the prose.**
Rewrite the eight group decls per the table above (lines 400, 411–412, 424,
517–519, 1053). Then the prose that documents the limitation as tolerated:
- 499–507 — the "published-≠-applied lie … only reason it is tolerated" paragraph. Delete the excuse, state the mutual rule.
- 513–516 — "a LATER `p-*`/`px-*`/`py-*` removes the rail outright" → *in either order*.
- 604–623 — the `rail-bleed` "ATOMIC IN CLASS STRINGS" note, whose whole argument for `extend px` is that `conflicts:` only fixes one order.
- 647–648 — `rail-follow`'s "It is in the `px` group, not a rail group" (this stays true and stays `extend px`: it writes exactly `padding-inline` and nothing else, so the builtin group is the honest classification).

**5. Regenerate and test.**
`./equin build` regenerates `custom-utilities.generated.ts`. Then rewrite
`…/ui-kit/web/lib/utils.test.ts` in two tiers:
- **Table tier, driven from `CUSTOM_UTILITY_REGISTRY`** — for every (group, target) pair in the *closed* relation set, assert both orders. A new group cannot ship untested. Needs a builtin→representative-class map (`p`→`p-2`, `size`→`size-8`, …) that **throws** on an id with no representative, so adding a relation to an unmapped group fails loudly rather than silently skipping. Raw utilities need the `no-adhoc-spacing` / `no-adhoc-typography` disables the file already uses.
- **Composition tier, hand-written** — the table tier proves less than it looks: `icon-auto` reaches real code almost entirely as `[&_svg:not([class*='size-'])]:icon-auto`, and tailwind-merge keys conflicts by `modifierId + group`, so a variant-prefixed class can never conflict with a bare `size-4`. Assert the real shapes: `cn(BASE, callerClassName)` for `OverlayPanel`, `Badge`, `Row`, `Card`, `Button`.

**6. `rail-bleed` gets its own group — DROPPED, and why.**
The idea was that `extend px` was chosen only because same-group membership was
the one symmetric relation available (`app.css:610-618` says so), and that it
leaves a hole: `rail-bleed` writes `margin-inline`, `width` **and**
`padding-inline` (626–628), so a later `w-full` overrides the width term while
the negative margins keep bleeding.

It cannot be done in this change. `rail-bleed` currently earns its mutual
relation with `sg-rail`/`sg-rail-x` *for free*, because it is literally in the
`px` group those two exclude. A `sg-bleed` group would have to re-declare that —
and a synthetic group naming **another synthetic group** is exactly the
expressiveness gap listed under residuals. Moving it without that would trade a
`width` hole for a rail hole, which is worse.

So `rail-bleed` and `rail-follow` both stay `extend px`. The `width` gap is
documented at the utility and in the rail contract ("do not pair `rail-bleed`
with a width utility") and belongs with the sg↔sg follow-up.

**7. Docs, one pass.**
- `…/ui-kit/web/theme/CLAUDE.md`, "Adding a custom `@utility`" — "The listed built-ins **override the group when they appear later**" is the sentence that documents the bug. Rewrite the clause list and the allowed-id list.
- `…/css/rail/CLAUDE.md` — rule 4 in full (33–42), the "a later `p-*` still removes the rail outright" paragraph (110–120), and, if step 6 lands, the `no-panel-bleed` rationale (180–184).
- `…/checks/plugins/app-css-utilities-in-sync/CLAUDE.md:20,28`.
- `…/css/rail/lint/no-panel-bleed.ts:18`, `…/ui-kit/CLAUDE.md` (Dialog section) and `…/ui-kit/web/components/ui/dialog.tsx:103` — all three assert "`rail-bleed` is in the `px` group"; only wrong if step 6 lands.
- Already stale, both pointing at a file that no longer exists (`framework/web-core/web/theme/custom-utilities.ts`): `.claude/skills/theme/SKILL.md:44` and `…/css/icon-auto/CLAUDE.md:14`. Fix while here.

Leave `research/*.md` (historical record) and `docs/plugins-details.md`
(autogenerated) alone.

## Blast radius

Small, for a structural reason worth stating: the newly-fixed direction only
fires when the **custom** class is later in the string, and every custom utility
here lives in a primitive's **base** string, before `className`
(`badge.tsx:73` `p-chip`, `row.tsx:83` `p-row`, `card.tsx:87` `p-card`,
`button.tsx:44` `control-*`, `overlay-panel.tsx:150` `POPOVER_PADDING`). The
common composition already had the protected order.

Checked, all unchanged: `overlay-panel.tsx:140-154` (everything before
`POPOVER_PADDING` is padding-free), `data-card.tsx:75` (ternary, never both),
`button.tsx:44-57` (cva emits one size arm), `section-card.tsx:116`
(`rail-x-lg pb-lg` — `pb` is untouched by `excludes: px pr pl`),
`data-table.tsx:173` (`py-control rail-follow` — different axes),
`detail-sections.tsx:389` (rail class last, `Stack` base is flow only).

If step 5's tests or the visual pass turn up something unexplained, the tool is
a **shadow diff**, not static analysis: build both configs (old one-directional,
new) in `utils.ts`, run both, and log divergences with a stack via
`clientLog`. That reaches the runtime-composed cases (cva, spread props,
`railClass()` returns) no grep can, and gives the call site rather than a class
string. Delete it after one session.

## Verification

1. `./equin check app-css-utilities-in-sync` — marker grammar valid and the generated file in sync.
2. `./equin test plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils.test.ts` — both tiers.
3. `./equin check` — `type-check` covers the `RegistryEntry` shape change across the generator, the generated file and `utils.ts`.
4. `./equin build` (background), then look at, in this order:
   - **Debug → Layout Lab** — the layout-primitive fixture catalog across its width sweep; the broadest single surface for padding regressions.
   - a **popover and a dialog** — `OverlayPanel`'s `rail-*` padding role.
   - **`SectionCard`** — `rail-x-lg pb-lg`, the one literal rail+padding pairing in the repo.
   - the **app-shell sidebar** — the only live `rail-owe-sm` user; its DataView bands must still line up with the nav rail.
   - the **quick-find dialog** — `rail-bleed`, especially if step 6 lands.
   - a **data-table** — `py-control rail-follow` rows.
   `useRailGuard` reports double-insets off the live DOM in dev; a regression here should surface as its console error, not as a squint test.

## Known residuals (not in scope)

- **Synthetic group ↔ synthetic group has no spelling.** `cn("rail-lg","rail-x-sm")` keeps both. It is not a published-≠-applied lie (`rail-x-*` overrides the var and the padding together, so they agree), but the *last class in the string does not win* — stylesheet order decides. Closing it means widening relation targets to accept an sg-id; tailwind-merge itself has no builtin/custom distinction, so the mechanism is ~5 lines plus a type widening. Worth a follow-up task rather than bundling here.
- **`ps-*`/`pe-*` written directly** would not remove a rail class (they have no default array to reverse-close through). Unreachable today — `no-adhoc-spacing` bans raw padding utilities in feature code.
- **`conflictingClassGroupModifiers` is not closed.** A postfix-modified class (`text-lg/7`) takes a different lookup path. No group touches `font-size` today; note it in the grammar doc so the first one that does doesn't discover it in production.
