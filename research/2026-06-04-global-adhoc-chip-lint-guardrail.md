# Ad-hoc chip/badge lint guardrail

**Date:** 2026-06-04
**Category:** global (tooling/lint + primitives + repo-wide migration)
**Status:** Plan — awaiting approval

## Context

The token system's "consume tokens, never hardcode" rule is advisory: nothing
mechanically stops an agent from reintroducing raw `text-[Npx]` font sizes or
inline `rounded-*/px-*/py-*` chip markup, so the inconsistency the token system
exists to close keeps regrowing after every cleanup. We want a **lint guardrail**
that makes the consistency self-sustaining — the same `plugins/<name>/lint/`
mechanism that enforces `--plugin-boundaries`.

Two findings shaped this plan:

1. **The font-size half already exists.** `no-arbitrary-font-size`
   (`plugins/ui/plugins/tokens/plugins/typography/lint/`) already bans
   `text-[Npx]` repo-wide as `error`. It only misses **rem**-unit arbitrary
   sizes (`text-[0.8rem]`, `text-[0.65rem]`) — exactly 2 sites. This plan folds
   those into the existing rule (Part A) and does **not** re-build font-size
   enforcement.

2. **No central allowlist.** A file-path allowlist (as the font-size rule used
   for its legacy burn-down) rots the moment code moves and reads as "covered"
   when it isn't. Instead the rule is made **precise enough to fire only on
   genuine chips** (all of which have a sanctioned primitive home), the chip
   sites are **migrated in this same change**, and the few irreducible non-chips
   escape via a **per-site marker** that travels with the code, not a remote
   list. Result: `ignores` is empty.

### Why a marker beats an allowlist (the load-bearing idea)

The rule fingerprint is **raw** `px-N` + `py-N` on an **intrinsic**
`<span>/<div>/<button>`. That gives three self-documenting escape hatches, in
order of preference, none of which is a central list:

- **Render through a component.** Capitalized host tags (`<Popover.Content>`, a
  container primitive, the already-componentized shadcn `dropdown-menu.tsx`) are
  skipped by construction — the rule only visits intrinsic elements.
- **Use a named padding token.** This is exactly how `Badge`/`LinkChip`/
  `ToggleChip` already escape: they use `p-chip` (a density token), not raw
  `px-/py-`, so they don't match. Any raw container that adopts a token
  (`p-chip`/`p-control`) disappears from the rule and self-documents intent.
- **Inline disable with a reason** (last resort): `// eslint-disable-next-line
  badge/no-adhoc-chip -- positioned overlay, not a chip`.

## What this plan does / does not cover

- **In scope:** (A) rem extension to `no-arbitrary-font-size`; (B) new
  `no-adhoc-chip` rule; (C) migrate the ~55 chip-shaped files to the sanctioned
  primitives so the rule lands green with an **empty** `ignores`.
- **Out of scope (documented follow-up):** a generic `Row`/`ListItem` primitive.
  ~28 interactive-row files (`page-link-block`, `backlinks`, token-section
  collapsible headers, …) share the rounded+padding shape but have **no**
  primitive home — the tree plugin's `RowChrome` is tree-coupled. The
  `no-adhoc-chip` rule **structurally excludes** these (via the row-signal
  exclusions below) so they don't block this change. Building the `Row`
  primitive and migrating those rows is a separate plan.

---

## Part A — Extend `no-arbitrary-font-size` to rem units

File: `plugins/ui/plugins/tokens/plugins/typography/lint/no-arbitrary-font-size.ts`

- Widen `BANNED` to also match `text-[<N>rem]`. Keep px and rem as separate
  capture branches so the existing px fixer is untouched. Suggested:
  `/(?:^|\s)(text-\[(?:(\d+)px|([\d.]+)rem)\])/g`.
- Add a rem→token fix map alongside `FIX_PX`: `0.625rem → text-3xs`,
  `0.6875rem → text-2xs`, `0.75rem → text-xs`. The two real sites use `0.8rem`
  and `0.65rem` (no exact step) → report-only (no auto-fix), same as off-scale
  px values today.
- Update the message to mention rem.
- **Migrate the 2 sites** so the widened rule stays green:
  - `plugins/framework/plugins/web-core/web/components/ui/button.tsx:26`
    (`text-[0.8rem]`, small-button) → nearest named step (`text-xs`) or add a
    token if 12.8px must be preserved; reviewer's call.
  - `plugins/primitives/plugins/tooltip/web/components/kbd.tsx:14`
    (`text-[0.65rem]`) → `text-2xs` (11px) or `text-3xs` (10px).

These two files are **not** in the font-size `ignores` allowlist, so no allowlist
edit is needed.

---

## Part B — New `no-adhoc-chip` rule

**Location:** `plugins/primitives/plugins/badge/lint/` (Badge is the primary
migration target; lint location is purely organizational — rules apply repo-wide
regardless). Two files:

- `plugins/primitives/plugins/badge/lint/no-adhoc-chip.ts` — the rule.
- `plugins/primitives/plugins/badge/lint/index.ts` — barrel:
  `export default { name: "badge", rules: { "no-adhoc-chip": rule }, ignores: { "no-adhoc-chip": [] } }`.
  Repo-wide id: `badge/no-adhoc-chip`. **Empty `ignores`.**

Mirror `no-arbitrary-font-size.ts` for the `ESLintUtils.RuleCreator` header.

### Algorithm

Unlike the font-size rule (which scans each `Literal`/`TemplateElement`
independently because its target is a single token), the chip fingerprint is a
**co-occurrence of several classes that may live in different `cn()` fragments**,
so we must **aggregate per `className` attribute**:

1. **Visitor:** `JSXAttribute` where `node.name.name === "className"`.
2. **Host-tag gate:** from `node.parent` (the `JSXOpeningElement`), require
   `name.type === "JSXIdentifier"` and `name.name ∈ {span, div, button}`. This
   skips component elements (`<Badge>`, `<Foo>`) and `<code>/<a>/<input>` for
   free — removing the inline-code and input false-positive classes.
3. **Token aggregation:** recursively walk `node.value` collecting every string
   `Literal` value and every `TemplateElement.value.raw`; split on whitespace
   into one token set. Walking only string literals + template chunks means
   identifiers from dynamic expressions (e.g. `STATE_STYLES[r.state]`) are not
   mistaken for class tokens. Class strings contain no escapes, so raw === value.
4. **Fingerprint (flag when ALL present):**
   - a `rounded` token: `/^rounded(-|$)/`
   - a small horizontal pad, **exact** token ∈ `{px-0.5, px-1, px-1.5, px-2}`
     (must not prefix-match `px-2.5`)
   - a small vertical pad, **exact** token ∈ `{py-px, py-0.5, py-1}`
5. **Row/overlay exclusions (skip if ANY present)** — these are the structural
   markers that separate chips from interactive rows / positioned overlays, the
   buckets that have no primitive home yet:
   - `w-full` (a chip is never full-width)
   - any `hover:bg-…` token: `/^hover:bg-/` (interactive row/menu)
   - `text-left`
   - `absolute` / `fixed` / `sticky` (positioned overlay)
   - any named padding token (`p-chip`, `p-control`, …): belt-and-suspenders —
     these preclude raw px/py anyway, but listing them documents the token escape.
6. **No auto-fix.** Choosing a primitive + variant, mapping a dynamic color map
   to `colorClass`, and adding an import is unsafe to mechanize. Omit
   `meta.fixable`; `fix: null`.

### Message (single `messageId: "adhocChip"`)

> Ad-hoc chip/badge markup (rounded + small px/py on a span/div/button) is
> banned — use a sanctioned primitive: `Badge` (static colored label/status,
> `@plugins/primitives/plugins/badge/web`), `ToggleChip`/`SegmentedControl`
> (interactive on/off), `FilterChip` (filter rows), or `LinkChip` (inline
> navigation). For a color from a dynamic class map, pass `colorClass` to
> `Badge`. If this is intentionally not a chip (positioned overlay, container),
> render it through a component or use a named padding token (`p-chip`/
> `p-control`) instead of raw `px-/py-`.

### Interaction with `no-arbitrary-font-size`

A chip like `<span className="rounded px-1.5 py-0.5 text-[10px] …">` trips both
rules (different namespaces, different locs). That's fine and desirable —
migrating to `Badge` (which uses `text-3xs`/`text-xs` via `p-chip`) clears both
at once. No dedup needed.

---

## Part C — Migrate the chip sites (so `ignores` stays empty)

~**55 files / ~83 sites** match the chip-precise fingerprint. Each migrates to a
primitive (per-site judgment on which primitive + variant):

| Shape found | Target |
|---|---|
| Static colored label / status / mono code-token span | `Badge variant=… size=…` (mono: add `className="font-mono"`) |
| Dynamic color from a class map (`STATE_STYLES[…]`, `familyClass(…)`) | `Badge colorClass={…} size=…` |
| `<button>` toggling state / segmented selector | `ToggleChip` / `SegmentedControl` |
| Filter-row chip | `FilterChip` |
| Clickable inline "jump to X" in prose/rows | `LinkChip` |

**Representative sites** (`rg -nP` with the Part B fingerprint lists all):
`plugins/debug/plugins/queue/web/components/queue-view.tsx:183,243,315`
(STATE_STYLES → `Badge colorClass`), `…/claude-cli-calls/web/components/call-row.tsx:28,31,40,115`,
`…/tool-call/web/components/tool-call-card.tsx:39`,
`…/tool-call/plugins/agent/web/components/agent-tool-view.tsx:25,34,61`,
`plugins/review/plugins/plugin-changes/web/components/plugin-changes-summary.tsx`,
`plugins/build/web/components/build-popover-content.tsx:198`.

**Non-chip stragglers** that match but shouldn't become a chip — apply a marker
instead of migrating:
- `plugins/primitives/plugins/markdown/web/internal/base-components.tsx:74` —
  inline `<code>` renderer (markdown's *sanctioned* home for code styling). The
  host-tag gate already skips `<code>`; if it's a `<span>`, route through the
  token or inline-disable.
- `plugins/apps/plugins/sonata/.../chord-overlay/web/components/chord-overlay.tsx:39`
  — positioned overlay (`absolute … backdrop-blur`); excluded by the `absolute`
  rule, no action.

**Caveat — size normalization.** `Badge` sizes are `sm → text-3xs (10px)` and
`md → text-xs (12px)`; there is no 11px Badge size, yet many chips use
`text-[11px]`. Migrating them collapses 11px → 10 or 12px (a deliberate
consequence of consolidating onto the scale). If preserving 11px across many
chips matters, add a Badge size backed by the existing `text-2xs` token; decide
during migration.

**Per-site safety valve.** Any site that can't be cleanly migrated in this pass
(risky visual change) uses an inline `// eslint-disable-next-line
badge/no-adhoc-chip -- <reason>` rather than re-introducing a central allowlist.
This keeps the "no allowlist" invariant while not blocking the change.

---

## Follow-up (separate plan, not this change)

Build a generic **`Row`/`ListItem`** primitive encapsulating
`rounded px-2 py-1 hover:bg-accent flex items-center gap-* [w-full text-left]`
(with `as`, selected/disabled, and a muted-uppercase "section header" variant),
then migrate the ~28 Tier-2 row files and widen `no-adhoc-chip` to ban ad-hoc
rows. The tree plugin's `RowChrome` should be refactored to compose it. ~6–8
irreducible overlay/container files (Tier 3) stay handled by markers.

---

## Critical files

- `plugins/ui/plugins/tokens/plugins/typography/lint/no-arbitrary-font-size.ts` — Part A edit + template for Part B
- `plugins/ui/plugins/tokens/plugins/typography/lint/index.ts` — barrel shape to mirror
- `plugins/primitives/plugins/badge/lint/no-adhoc-chip.ts` — **new**
- `plugins/primitives/plugins/badge/lint/index.ts` — **new** (empty `ignores`)
- `plugins/primitives/plugins/badge/web/internal/badge.tsx` — migration target API (`variant`, `size`, `colorClass`, `as`)
- `plugins/primitives/plugins/{toggle-chip,filter-chips,link-chip}/web/` — other migration targets
- `eslint.config.ts` — auto-discovers the new barrel (no edit; registers `error` repo-wide)
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` — codegen that finds `lint/index.ts` (no edit)

## Verification

1. `./equin build` — regenerates `lint.generated.ts` (codegen discovers the
   new `badge/lint` barrel); `plugins-registry-in-sync` confirms.
2. `./equin check --eslint` — must pass **green with empty `ignores`**,
   proving every chip site was migrated or marked. Confirm `badge/no-adhoc-chip`
   and `typography-tokens/no-arbitrary-font-size` are both registered as `error`.
3. Negative test: temporarily add `<span className="rounded px-1.5 py-0.5
   bg-muted">x</span>` to a `.tsx` and confirm `eslint` flags it; confirm a
   `<div className="rounded px-2 py-1 w-full hover:bg-accent">` is **not** flagged
   (row exclusion); confirm `<Badge>` usage and `p-chip` users are not flagged.
4. Visual spot-check: screenshot a few migrated surfaces (queue view, claude-cli
   calls, tool-call cards) via Playwright to confirm chips render correctly after
   migration. See `e2e/screenshot.mjs`.
5. `./equin check` (full) — all checks green.
