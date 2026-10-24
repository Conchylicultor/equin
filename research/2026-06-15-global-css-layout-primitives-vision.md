# CSS Mental Model & Composable Layout Primitives — Vision

> **Status:** Vision only. This doc defines the mental model, the principles to
> enforce, and the *sequence of steps*. Each step becomes its own task and does
> its own detailed planning. Do **not** treat the step list as an implementation
> plan — it is a map of the work, not the work.

## Context

Layout components in the transcript surface (`CollapsibleCard` and friends) churn
endlessly: every "fix" trades one visual symptom for another (chips wrapping →
path overflowing → path misaligned → chips clipped → **badge overlapping path**,
the bug that prompted this). The root is not any single component — it is that
**layout is the one design dimension with no semantic primitive and no
enforcement.** Raw flex/grid/positioning utilities (`flex`, `flex-1`, `min-w-0`,
`shrink-0`, `items-*`, `justify-*`, `grid`, `absolute`, `inset-0`, `overflow-*`)
appear ~1,640 times across ~430 files, each call site re-deriving a global
space-sharing negotiation by hand. There is no `<Stack>`-equivalent for the hard
cases and no `no-adhoc-layout` lint rule.

Meanwhile the codebase already proves the cure works: **9 `no-adhoc-*` lint rules**
(spacing, radius, typography, surface, z-index, control, icon, chip, row) redirect
raw utilities to closed semantic primitives, auto-discovered from
`plugins/<name>/lint/`, applied repo-wide as errors. The spacing burndown
allowlist already went **389 → 0 files**. We extend that exact, proven model to
the last unguarded dimension — and make the whole set discoverable.

Intended outcome: the `CollapsibleCard` class of bug becomes *structurally
unrepresentable*, raw layout CSS becomes a gated exception (not the default), and
agents discover the right primitive via a `css` skill instead of hand-rolling flex.

---

## Part 1 — The clean CSS mental model

The principle behind every existing primitive (spacing, type, surface) generalized
to layout: **write the role, not the mechanics; let the container own the policy.**

1. **Every box has exactly one job.** It is either a **container** that arranges
   children (declares direction + how slack is shared) *or* a **content leaf** that
   sizes to itself (and declares whether it is rigid, flexible, or truncating).
   Raw Tailwind encourages fusing both jobs onto one `<div className="flex … min-w-0 truncate">`
   — that fusion is the source of the whole bug class.

2. **Space-sharing is a property of the container, declared once — never
   negotiated per child.** The container names its tracks ("leading is rigid,
   content absorbs slack and truncates, trailing is rigid-right"). Children do not
   each sprinkle `min-w-0`/`shrink-0`/`flex-1` hoping the negotiation converges.

3. **The shrink hierarchy must be explicit and total.** For any row that can
   overflow you must be able to answer "what gives first?" — and the answer lives
   in *one* place. Default order: rigid identity (chips/icons) never shrinks →
   secondary metadata truncates first → primary content truncates last.

4. **Prefer the layout mode where the bug is unrepresentable.** "rigid | flexible
   | rigid" is canonical CSS Grid: `grid-template-columns: auto minmax(0,1fr) auto`.
   An `auto` track cannot be shrunk below its rigid content, so "container collapsed
   under its own chip" *cannot happen*. Flex requires a min-content-floor discipline
   that is easy to violate. Choose the mode that forbids the bug over the mode that
   merely lets you avoid it.

5. **`min-width: 0` is a deliberate leaf-level decision, never a reflexive
   container default.** The entire churn is `min-w-0` applied at the wrong altitude.
   In the clean model exactly one primitive (the truncation leaf) owns it; it is
   never sprinkled onto containers.

6. **Semantic intent over visual mechanics.** You write `leading` / `content` /
   `meta` / a `gallery` grid / `stack with sm rhythm`. The mechanics
   (`flex items-center gap-2 min-w-0 …`) are an implementation detail the primitive
   owns — and can therefore fix once, globally, for every call site.

This is "CSS-in-semantics": the same philosophy `spacing`/`text`/`surface` already
embody, finally extended to structure and layout.

---

## Part 2 — Principles to enforce globally

1. **No raw layout utilities in feature code.** `flex*`, `grid*`, `min-w-0`,
   `shrink-*`, `grow-*`, `items-*`, `justify-*`, `place-*`, `absolute`, `fixed`,
   `sticky`, `inset-*`, `overflow-*` are banned outside the layout primitives
   themselves and `app.css`. Enforced by a new `no-adhoc-layout` rule family,
   contributed via `plugins/<…>/lint/`, exactly like `no-adhoc-spacing`.

2. **One escape valve, always with a reason.** The genuine long tail is handled by
   `// eslint-disable-next-line layout/no-adhoc-layout -- <reason>` — never silent.
   This is the answer to *"can agents never write CSS?"* below.

3. **Containers own space-sharing; leaves own truncation.** Encoded structurally:
   the role slots that matter expose closed props, not a layout `className`
   passthrough that lets a caller reintroduce `min-w-0` at the wrong level.

4. **Minimal, orthogonal, composable set.** A primitive per *layout concern*, not
   per screen. They compose; we resist a bespoke component for every one-off.

5. **Discoverable.** A `css` skill (mirroring `theme`) + a self-contained `css/`
   umbrella directory, so the set is findable and the mental model is one read away.

6. **Tested by a state matrix.** Each layout primitive ships a fixtures/story
   matrix plus geometry/overlap assertions (the bounding-box check that caught the
   original overlap), so regressions fail CI instead of waiting for an eyeball.

### Is "agents never write raw CSS" realistic?

**No — and that's the wrong target.** 100% elimination is both unattainable (a
genuine bespoke-layout long tail exists) and undesirable (a primitive per one-off
becomes its own complexity). The realistic, enforceable invariant is:

> **Never write raw layout CSS *without a named reason*.**

A hard lint gate makes the primitive the path of least resistance; the
`eslint-disable … -- <reason>` escape valve absorbs the long tail; the mandatory
reason keeps exceptions rare and reviewable. This is precisely how `no-adhoc-spacing`
reached 389 → 0 — not by being unbreakable, but by making every break visible and
justified. We adopt the same bar.

---

## Part 3 — Target shape (vision-level; APIs designed per sub-task)

### A minimal composable layout primitive set

Built on the existing `Stack` (flex + gap + align + justify + wrap) and `Row`,
adding the hard cases that have no home today:

- **`Stack`** *(exists, `plugins/primitives/plugins/spacing`)* — 1-D flow. Keep.
- **`Frame`** *(new)* — the named-slot row that generalizes the `CollapsibleCard`
  header: `leading` (rigid cluster) · `content` (primary, truncates) · `meta`
  (secondary, truncates first) · `trailing` (rigid-right). **Owns the shrink
  hierarchy in one place.** This is the original bug's structural fix.
- **`Grid`** *(new)* — explicit tracks (`auto minmax(0,1fr) auto`, responsive card
  grids). The mode where the overlap bug is unrepresentable.
- **`Cluster`** *(new)* — wrap-friendly group of chips/tags.
- **`Center`** *(new)* — centering, the other ubiquitous one-liner.
- **`Overlay` / `Layer`** *(new)* — sanctioned positioning (`absolute inset-0`,
  z-layer-aware), folding in the click-through-toggle overlay pattern
  `CollapsibleCard` hand-rolls today. Pairs with existing `viewport-overlay`.
- **`Truncate`** = existing `truncating-text` (already owns `min-w-0 truncate`) —
  promoted to the *mandatory* truncation leaf.

The exact prop surface of each is a per-primitive sub-task, not decided here.

### Self-contained directory

New umbrella **`plugins/primitives/plugins/css/`** grouping all styling-concerned
plugins (plugin IDs + registries auto-regenerate from path; boundary config uses
`plugin.**` and needs no change — the real cost is import-string rewrites):

- **Layout (new + moved):** frame, grid, cluster, center, overlay; move `spacing`(99).
- **Standards (moved, low/zero risk):** radius, z-layers, control-size, icon-auto
  (0 TS importers — near-free), then surface(8).
- **Chrome (moved):** badge(55), row(43), card(14), truncating-text(6),
  status-dot(20), section-label(19), selection-indicator(2), placeholder(28),
  spinner(10), link-chip, toggle-chip, color-picker(9), viewport-overlay(9).
- **Anchors — phased LAST, each its own isolated task:** `text`(225 importers),
  `ui-kit`(233 importers; also owns `app.css`, the single global stylesheet, and
  `cn()`). A mixed mid-state on these would break the build, so they move alone.

### New `css` skill

`.claude/skills/css/SKILL.md`, mirroring `theme`:
- frontmatter `name: css`, description ending "Read BEFORE any layout/structure/CSS work";
- "High-level map" intro;
- **the Part-1 mental model as the prose core** (the footgun-prevention section);
- `## Layout primitives` — enumerated `Frame/Stack/Grid/Cluster/Overlay/Truncate → use X for Y`;
- `## Design-standard enforcement` — the `no-adhoc-layout` rule, **cross-linking**
  `theme`'s existing enforcement list rather than duplicating it (split: `css` owns
  *how to compose boxes*, `theme` owns *tokens/color/preset*);
- self-improvement footer; registered in root `CLAUDE.md` alongside `theme`/`debug`.

---

## Part 4 — Steps (each becomes a separate task; this is the map, not the plan)

**Phase 0 — Spec & discovery surface**
- Task: write the `css` skill from the Part-1 mental model + register in `CLAUDE.md`.
- Task: design the minimal primitive set's APIs (one design sub-task; may split per primitive).

**Phase 1 — Layout primitives (value first, no enforcement yet)**
- Task: build `Frame` (+ fixtures matrix + geometry/overlap test).
- Task: build `Grid`, `Cluster`, `Center`, `Overlay`.
- Task: migrate `CollapsibleCard` → `Frame` as the proof case (closes the original bug).

**Phase 2 — Enforcement (hard gate from the start, with allowlist)**
- Task: add `no-adhoc-layout` lint rule(s) via `plugins/<…>/lint/`, landed as
  `error` with a **full burndown allowlist** (every current offender grandfathered),
  so new code is gated immediately and existing code is untouched.

**Phase 3 — Directory extraction (separate tasks, low-risk → anchors last)**
- Task: create `css/` umbrella; move the 4 lint-only plugins (near-free).
- Task: move low-importer presentational plugins.
- Task: move `spacing` / `badge` / `row`.
- Task: move `text` (isolated). Task: move `ui-kit` (isolated, last).

**Phase 4 — Burndown migration (follow-up, agent-assisted batches)**
- Task(s): drain the `no-adhoc-layout` allowlist file-by-file → 0, converting raw
  flex/grid to primitives (the spacing playbook).

**Phase 5 — Test infrastructure**
- Task: standardize the fixtures-matrix + visual/geometry regression harness across
  all layout primitives.

---

## Verification (per phase)

- **Primitives:** a geometry/bounding-box test asserting no two tracks overlap
  across the state matrix `{short, long} content × {with, without} meta × {narrow,
  wide} width` — the same Playwright bounding-box technique that diagnosed the
  original 11.3px overlap. `bun run test:dom` for jsdom render tests.
- **Lint:** `./equin check` (the contributed rule auto-registers; new raw
  layout fails, allowlisted files pass).
- **Extraction:** `./equin build` regenerates `*.generated.ts`, CLAUDE.md
  AUTOGEN blocks, and `docs/plugins-*.md`; `plugins-registry-in-sync` and
  `plugins-doc-in-sync` must pass; `./equin check plugin-boundaries` clean.

## Critical files / references

- Original bug + mechanism: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx` (header row, lines 91–122).
- Enforcement model to mirror: `plugins/primitives/plugins/spacing/lint/no-adhoc-spacing.ts` and its `lint/index.ts` (`ignores` burndown allowlist).
- Lint discovery chain: `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` + `lint.generated.ts`; root `eslint.config.ts`.
- Existing layout-adjacent primitives: `plugins/primitives/plugins/spacing` (`Stack`/`Inset`), `plugins/primitives/plugins/truncating-text`, `plugins/primitives/plugins/row`.
- Skill template: `.claude/skills/theme/SKILL.md` (esp. its `## Design-standard enforcement` section).
- Umbrella + move mechanics: plugin id derives from path (`framework/.../plugin-tree.ts` `computeIds`); boundary config `plugin.** -> plugin.**` needs no change.
- `ui-kit` anchor: `plugins/primitives/plugins/ui-kit/web/theme/app.css` (single global stylesheet, imported once in `framework/plugins/web-core/web/main.tsx`).
