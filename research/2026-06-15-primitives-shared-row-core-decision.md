# Shared row-core for CollapsibleTrigger & CollapsibleCard — decision

## Context

`Row` (`plugins/primitives/plugins/row`) is a sound, lint-enforced interactive-row
primitive (`no-adhoc-row`). Two escape-hatch consumers re-roll its single-line core
(`flex w-full items-center whitespace-nowrap`) instead of composing it:

- **`CollapsibleTrigger`** — `plugins/primitives/plugins/collapsible/web/internal/collapsible.tsx:85`
  `cn("flex w-full items-center whitespace-nowrap text-left", className)`. A bare
  chrome-less `<button>` compound-component trigger; callers style it externally.
- **`CollapsibleCard` header** — `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx:62`
  `HEADER = "relative flex w-full items-center gap-sm whitespace-nowrap text-2xs text-muted-foreground hover:text-foreground"`.
  An overlay-button architecture: a `<div>` header over a full-bleed `absolute inset-0`
  toggle `<button>`, with `pointer-events-none` content falling through to it.

The task asks: now that the `region-line` `@utility` exists, is sharing the single-line
invariant through it **sufficient**, or is a deeper headless **row-core** (a row container
without the interactive chrome) worth extracting so these two stop duplicating the shape?

**Note on framing:** the task describes `region-line` as "planned", but it has **already
landed**. It is defined in `plugins/primitives/plugins/ui-kit/web/theme/app.css:164`
(`@utility region-line { @apply items-center whitespace-nowrap; }`) and is already consumed
by both `Row` (`row.tsx:59`) and `Bar` (`bar.tsx:63`). So the real question is the second
one only.

## Decision

**Do NOT extract a shared headless row-core.** `region-line` is the correct and sufficient
sharing seam. The concrete action is a two-line migration: route both sites' raw
`items-center whitespace-nowrap` through `region-line`, matching the seam `Row`/`Bar`
already use and the intent documented in `truncating-text/CLAUDE.md`.

This is the **cleanest long-term state**, not a minimal-diff compromise. There are three
genuinely distinct archetypes here, not three copies of one shape:

- **`Row`** — the *fused-button* row: the strip itself is the `<button>`; its actions slot
  `stopPropagation`s and sits `ml-auto`. Owns chrome (rounded/padding/hover).
- **`CollapsibleTrigger`** — the *chrome-less compound trigger*: deliberately unstyled, aria-
  wired to collapsible context, and the floor of the dependency graph (`Row` depends on *it*).
- **`CollapsibleCard` header** — the *click-through overlay* row: a full-bleed `absolute
  inset-0` toggle `<button>` *behind* `pointer-events-none` content, where named islands
  (`CardHeaderAction`) opt *back in* with `pointer-events-auto`.

A headless container that could be all three would need conflicting actions semantics
(stopPropagation vs. pointer-events opt-in) and conflicting DOM (strip-is-button vs.
button-is-overlay-sibling) — a **collapse**, not a factor. The residual `flex w-full`
duplication is irreducible *without* collapsing those archetypes, and it carries no bug
surface; the bug-prone part (single-line wrap) is exactly what `region-line` owns. So the
end state is: one shared invariant (`region-line`) + three distinct archetypes, each owning
its own shape. Migrating to `region-line` *is* that end state — each archetype carrying the
single shared invariant explicitly — not a step toward a future row-core.

### The one archetype to watch (do not build yet)

The click-through overlay ("whole strip is one click target, but named islands keep their own
clicks") is a *latent* reusable archetype. The clean future move — **only if a second
consumer appears** — is to promote it to its own primitive that is a **sibling** of `Row`
(e.g. an `OverlayRow`), never a shared base both inherit from. Today it has exactly one
consumer (`CollapsibleCard`) and `CardHeaderAction` is already its sanctioned escape, so
extracting now would be speculative. This is a trigger to watch, not work to do.

### Why a row-core is not warranted

1. **The only load-bearing invariant is already shared.** The single-line wrap bug — the
   property that is actually bug-prone and is the subject of the recent commits (`region-line`
   utility + `no-clip-without-nowrap`) — is exactly what `region-line` factors. What remains
   duplicated between the two sites is `flex w-full` (+ `text-left`): trivial, non-bug-prone
   layout glue. Factoring it into a primitive buys no correctness.

2. **A row-core plugin would create a dependency cycle, or demand a whole new leaf plugin.**
   `Row` already depends on `collapsible` — `SectionHeaderRow` imports `CollapsibleChevron`
   and `useCollapsibleContext` (`section-header-row.tsx:3-6`). `CollapsibleTrigger` lives
   *inside* the `collapsible` plugin, so having it import a core from the `row` plugin is a
   `collapsible ⇄ row` cycle (banned by the DAG boundary rule). Avoiding the cycle means
   creating a third, lower leaf plugin that both depend on — significant machinery (barrel,
   package.json, registry, docs) to share three utility classes.

3. **The two consumers diverge architecturally, not incidentally.** They are different
   archetypes that merely overlap on a 3-class single-line core:
   - `CollapsibleTrigger` is *deliberately* chrome-less (no rounded/padding/hover; callers
     style it) — a compound-component primitive, a different role from `Row`, which owns chrome.
   - `CollapsibleCard` uses the overlay-button architecture *on purpose*: the comment at
     `collapsible-card.tsx:85-90` documents that fusing the click target and the layout onto
     one `<button>` pulled in opposite directions, so the toggle was split out as an
     `absolute inset-0` overlay behind `pointer-events-none` content. `Row` *is* that fused
     button. A button-shaped row-core would re-introduce exactly the problem the card solved.
     Its actions slot is also the inverse of Row's: `CardHeaderAction` is
     `pointer-events-auto relative` (opt back *in* above the overlay), whereas Row's actions
     slot is `ml-auto` + `stopPropagation` + hover-reveal (`row.tsx:73-83`). A shared core
     could not host both.

4. **It violates the project's own factor-not-collapse boundary.** `bar.tsx:44-49` states the
   rule explicitly: "a bar, a row, and a chip stay distinct primitives; only the single-line
   region invariant (`region-line`) is shared between them." The project already chose
   `region-line` as the seam and deliberately declined to share more. A headless row-core
   spanning trigger/card/row would collapse distinct archetypes onto one container — the exact
   move that boundary forbids.

## Implementation

A minimal, mechanical migration — replace the raw `items-center whitespace-nowrap` pair with
`region-line` at both sites. No new primitive, no API change, no new plugin.

### 1. `CollapsibleTrigger`
`plugins/primitives/plugins/collapsible/web/internal/collapsible.tsx:85`

```diff
-      className={cn("flex w-full items-center whitespace-nowrap text-left", className)}
+      className={cn("flex w-full region-line text-left", className)}
```

### 2. `CollapsibleCard` header
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx:62`

```diff
-const HEADER =
-  "relative flex w-full items-center gap-sm whitespace-nowrap text-2xs text-muted-foreground hover:text-foreground";
+const HEADER =
+  "relative flex w-full region-line gap-sm text-2xs text-muted-foreground hover:text-foreground";
```

Behaviour is identical: `region-line` is `items-center whitespace-nowrap`. Both sites keep
their own `flex w-full` (and the card keeps `relative`/`gap-sm`/text chrome) — those are not
shared and stay local.

### 3. (Optional) Documentation touch-up
`plugins/primitives/plugins/truncating-text/CLAUDE.md` already lists `CollapsibleTrigger`
among components that "carry the same guarantee", but via the raw class. No change is
required; if desired, note that `CollapsibleTrigger` and the `CollapsibleCard` header now
carry the guarantee through `region-line` directly. This is cosmetic and can be skipped.

## Files

- `plugins/primitives/plugins/collapsible/web/internal/collapsible.tsx` — migrate `CollapsibleTrigger` className.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx` — migrate `HEADER` constant.
- (read-only reference) `plugins/primitives/plugins/ui-kit/web/theme/app.css:164` — `region-line` definition.
- (read-only reference) `plugins/primitives/plugins/row/web/internal/row.tsx`, `plugins/primitives/plugins/bar/web/internal/bar.tsx` — the seam precedent.

## Verification

1. `./equin build` — type-check + ESLint pass (`no-clip-without-nowrap` already treats
   `region-line` as nowrap-safe, so both sites remain compliant; `no-adhoc-row` is unaffected
   since neither site adds rounded+padding chrome).
2. Visual spot-check in the running app at `http://<worktree>.localhost:9000`:
   - A transcript with collapsible tool-call cards (the `CollapsibleCard` header) — header row
     stays single-line, chevron + label + file path + RowActions laid out as before, toggle
     click still falls through the `pointer-events-none` content.
   - Any `CollapsibleTrigger` consumer (e.g. token-group sections under Settings → Appearance)
     — trigger still full-width, single-line, left-aligned.
   Use `bun e2e/screenshot.mjs` to capture before/after if a regression is suspected.

## Outcome

The residual duplication is reduced to trivial, intentional layout glue; the one bug-prone
invariant (single-line) is shared through `region-line` at every site; and the distinct
trigger / card / row archetypes stay separate, consistent with the established
factor-not-collapse boundary. No new abstraction is introduced where the existing seam already
suffices.
