# Drain the `no-adhoc-spacing` BURNDOWN allowlist

## Context

The `no-adhoc-spacing` lint rule (spacing plugin) shipped in commit `1419a76d6`
with a large **BURNDOWN allowlist** of 389 grandfathered files in
`plugins/primitives/plugins/spacing/lint/index.ts`. Those files predate the rule
and still use raw Tailwind spacing (`gap-*`/`p*-*`/`m*-*`/`space-*`), so the rule
only enforces on new/touched code. Stack/Inset are currently used **nowhere** —
this is the first migration, so it establishes the convention.

**Goal:** migrate every grandfathered file to the spacing primitives / named
density utilities, remove its allowlist entry, until the array is empty (the
sanctioned "no exemptions" state). Do not add new entries.

## Decisions (locked with the user)

1. **Migration style — Hybrid.** Named density utilities are the default
   (`gap-2` → `gap-sm`). Introduce `<Stack gap>` for plain flex+gap containers
   and `<Inset pad>` for standalone padding boxes only where conversion is
   unambiguous and safe. Named utilities are a legitimate, permanent part of the
   clean end state (any element that is *both* a flex-gap container and has its
   own padding keeps padding as named `px-*`/`py-*` utilities — Stack only owns
   the gap).
2. **Half-steps — Round DOWN** (preserves the snug feel of `gap-1.5`, the
   icon→label gap; never loosens layouts).
3. **Margins — Restructure when clean, else disable-comment.** Lift a margin
   into the parent's `<Stack gap>` / `<Inset pad>` when the JSX makes it safe;
   otherwise escape per-site with
   `// eslint-disable-next-line spacing/no-adhoc-spacing -- <reason>`.

## The canonical mapping table

Raw Tailwind unit = 0.25rem. Comfortable ramp: `2xs`=0.125 `xs`=0.25 `sm`=0.5
`md`=0.75 `lg`=1 `xl`=1.5 `2xl`=2 rem.

| Raw suffix | Ramp step | Notes |
| ---------- | --------- | ----- |
| `0`            | `none` | |
| `0.5`          | `2xs`  | |
| `1`            | `xs`   | |
| `1.5`          | `xs`   | round down (≈251 sites) |
| `2`            | `sm`   | dominant (≈555 sites) |
| `2.5`          | `sm`   | round down |
| `3`            | `md`   | |
| `3.5`          | `md`   | round down |
| `4`            | `lg`   | |
| `5`            | `lg`   | round down (1.25rem → lg) |
| `6`            | `xl`   | |
| `7`            | `xl`   | round down (1.75rem → xl) |
| `8`            | `2xl`  | |
| `10`/`12`/`14`/`16` | `2xl` (clamp) **or** per-site disable | These exceed the ramp top; rare. If it is genuine rhythm, clamp to `2xl`; if it is a layout-specific dimension the ramp can't express, use a disable-comment. Judgement per site. |
| arbitrary `*-[7px]` | nearest step, **or** disable if a precise pixel is required | |

Class families and their named targets:

- `gap-N` → `gap-<step>`; `gap-x-N`/`gap-y-N` → `gap-x-<step>`/`gap-y-<step>`.
- `p-N`/`px`/`py`/`pt`/`pr`/`pb`/`pl` → `p-<step>` / `px-<step>` / … (all exist).
- `space-y-N` / `space-x-N` → **no named equivalent.** Convert the container to a
  flex `<Stack gap>` (block siblings stacked vertically = `<Stack gap>`); if the
  element genuinely can't be flex, disable-comment.
- `m*-N` (margins) → restructure into parent gap/pad, else disable-comment.
  Negative margins (`-mt-2`) have **no** negative ramp → disable-comment or
  restructure (never a named util).
- `mx-auto` / `my-auto` are word-valued and already allowed — leave untouched.
- Variant prefixes are preserved: `md:gap-2` → `md:gap-sm`, `hover:px-3` →
  `hover:px-md`.
- Tokens inside `cn(...)`/`clsx(...)`/`twMerge(...)` args count too — rename
  them in place (e.g. `cn("flex gap-1.5", active && "...")` → `gap-xs`).

### When to reach for Stack / Inset (the "clean" cases)

- `flex flex-col gap-N` (no padding on the same element) → `<Stack gap="<step>">`
  (drop `flex flex-col`). `flex flex-row gap-N` → `<Stack direction="row" gap>`.
- `space-y-N` wrapper of block children → `<Stack gap="<step>">`.
- A pure padding box `<div className="p-N">…</div>` → `<Inset pad="<step>">`.
- Add `align`/`justify` props when replacing `items-*`/`justify-*` on a Stack.

Keep it as a **named-utility rename** (don't force Stack/Inset) when: the element
mixes gap + padding + borders/bg/rounded, it's an inline `<span>`, it's a CSS
grid, it's a third-party component, or wrapping would change the DOM/semantics.

Primitives import: `import { Stack, Inset } from "@plugins/primitives/plugins/spacing/web"`.

## Files to modify

- **389 component files** listed in the allowlist (all `.tsx`, under
  `plugins/**/web/**`). Source of truth: the array in
  `plugins/primitives/plugins/spacing/lint/index.ts` (extract programmatically).
- **`plugins/primitives/plugins/spacing/lint/index.ts`** — drain the array to
  `[]` (each file's entry removed as it is migrated). Keep the `ignores` key with
  an empty array (build-lint-config filters empty glob arrays — `core/build-lint-config.ts:155-164`)
  and update the BURNDOWN comment to note it is fully drained.

No change to the rule, the primitives, or `app.css`.

## Execution strategy

Mechanical-at-scale with per-site judgement → fan out across batches.

1. **Batch by plugin subtree** (~12–16 batches of ~25–35 files: `conversations/jsonl-viewer`,
   `conversations/*` rest, `tasks/*`, `stats/*`, `fields/*`, `ui/tokens/*`,
   `primitives/*`, `apps/sonata/*`, `apps/* rest`, `studio/*`, `debug/*`,
   `page/*`, `plugin-meta/*`, misc). Each batch handled by an **Opus** subagent
   (implementation work, per project convention), given: this plan's mapping
   table + style/margin rules, its file list, and the instruction to remove each
   migrated file from the allowlist array.
2. **Per file**, the agent: applies the mapping table to every flagged token
   (className attrs *and* `cn()`/`clsx()`/`twMerge()` args), introduces
   Stack/Inset only on the clean cases above, restructures or disable-comments
   margins, removes the file's allowlist entry.
3. Agents edit the shared `lint/index.ts` allowlist — to avoid write races, each
   agent removes **only its own batch's lines**; run batches in waves and
   re-read the file between waves, or have one coordinator strip entries after
   each batch reports its completed file set. (Simplest: agents return the list
   of files they finished; the orchestrator removes those lines.)

## Verification

- **Per file / per batch:** remove the entry from the allowlist, then
  `bunx eslint <file...>` (root `eslint.config.ts` flat config) must report
  **zero** `spacing/no-adhoc-spacing` errors and no new errors of any kind. While
  a file is still in the allowlist the rule is `off` for it, so the entry must be
  removed to actually test.
- **Whole repo, final:** with the array at `[]`,
  `./equin check type-check` must pass (unified TS + type-aware ESLint;
  the rule now enforces repo-wide with no exemptions). Also confirms no Stack/Inset
  type errors and no broken imports.
- **Build + visual:** `./equin build`, then Playwright screenshots of a few
  representative dense surfaces to confirm no layout regression from the
  round-down / restructures:
  - conversation view — `http://<wt>.localhost:9000` jsonl viewer
  - tasks pane, studio explorer, settings → appearance (token rows)
  ```bash
  bun run playwright screenshot --wait-for-timeout 3000 \
    --viewport-size "1280,800" http://<wt>.localhost:9000 /tmp/spacing-check.png
  ```
- **Sanity grep:** `rg -n '(gap|gap-x|gap-y|p[xytrbl]?|m[xytrbl]?|space-[xy])-(\d|\[)'`
  scoped to the formerly-allowlisted files should return only lines carrying an
  adjacent `eslint-disable-next-line spacing/no-adhoc-spacing` comment.

## Risks / notes

- **Round-down changes pixels** on ~290 half-step sites (mostly tightening
  `gap-1.5`→`xs`). Intentional per the decision; the visual spot-check covers it.
- **Control insets** (`px-2 py-1.5` on inputs/buttons) round to ramp steps here;
  a later pass could move them to the existing `p-control`/`p-chip` word-valued
  utilities, but that is out of scope for the drain.
- **Margins are the slowest part** — restructuring lifts spacing to the parent
  and can require reading sibling layout. When unclear, prefer the disable-comment
  (with a concrete reason) over a risky restructure.
- Do **not** run `git commit` / `./equin push`; stop at build + verify and
  hand back for review.
