# Chip controls derive size from ambient control density (Phase 1: chips)

## Context

`Badge`, `ToggleChip`, and `SegmentedControl` take an ad-hoc per-instance `size`
prop. `Badge` never reads the ambient `ControlSize` at all, so a chip placed
beside a same-density button (or among other chips) can render at a mismatched
height/text size, and ~93 call sites pass an explicit `size=` by hand to
compensate — the same class of inconsistency that produced mismatched header
buttons in the Pages app (fixed for `IconButton` on this branch in
`626887171`).

This is the **first brick** of a larger arc the user wants: **size stops being a
per-element property and becomes a property of the region.** You declare *where
you are* (a table, a toolbar, a card, a pane) via one ambient `ControlSize`, and
every leaf inside — text, button, chip, badge, icon — auto-infers its size from
it. A single control then *cannot* desync from its neighbors, because there is no
per-instance dial left to set wrong. This is the same "write the role, the
container owns the policy" philosophy the `css`/`theme` primitives already
enforce for layout, spacing, radius, and control height.

**This landing = Phase 1 only: the chip family.** `Button`'s own `size` prop
(Phase 2) and abstracting the provider into region primitives (Phase 3) are filed
as follow-ups (see end). Per the user, dense-pane labels are allowed to
**normalize** — we simply strip the `size=` props and let chips fall to the
ambient density; we do **not** sprinkle `ControlSizeProvider` to preserve the old
smaller text.

## Desired invariant

Chip primitives (`Badge`, `ToggleChip`, `SegmentedControl`) derive their size
solely from the container's ambient control density (`ControlSizeProvider` /
`useControlSize`), with **no per-instance `size` override that can diverge** —
enforced by the type system (passing `size` is a compile error), not by review.

## Existing mechanism to reuse

- `useControlSize()` / `ControlSizeProvider` / `ControlSize` (`"xs"|"sm"|"md"|"lg"`,
  default `"md"`) — `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx`.
- `ToggleChip` **already** derives from density via
  `chipSizeForDensity(density) = density === "xs" ? "sm" : "md"` and only uses
  `size ?? …` as the override. Phase 1 deletes the override path.
- `IconButton` is the exact precedent: `Omit<…, "size">` + `iconSizeFor(useControlSize())`
  (`plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`).
- The leak the task calls out: both `BadgeProps` and `ToggleChipProps` have a
  permissive `[key: string]: unknown` passthrough that spreads onto the host (and
  onto `Badge`), so `size` can sneak through even after the named prop is removed.

## Changes

### 1. Badge — `plugins/primitives/plugins/css/plugins/badge/web/internal/badge.tsx`

- **Remove** the `size?: BadgeSize` prop and the `BadgeSize` type (no external
  importers — confirmed; only the autogen CLAUDE.md/package.json mention it).
- **Derive** text size from ambient density, matching ToggleChip's `xs` threshold
  so chips and badges agree by construction:
  ```ts
  const density = useControlSize();
  // text-3xs only at the most compact density; text-caption otherwise.
  // (no provider → "md" → text-caption, identical to today's default)
  density === "xs" ? "text-3xs" : "text-caption"
  ```
  Import `useControlSize` from `@plugins/primitives/plugins/css/plugins/ui-kit/web`.
- **Plug the leak:** add `size?: never;` to `BadgeProps` alongside the existing
  `[key: string]: unknown`. A named member takes precedence over the index
  signature for that key, and `"sm"` is not assignable to `never`, so any
  `<Badge size=…>` becomes a tsc error while the rest of the passthrough is
  untouched.
- Update barrel `…/badge/web/index.ts`: drop the `BadgeSize` re-export.

Net effect: untouched (no-`size`) badges are unchanged (`md` → `text-caption`);
the 15 `size="md"` sites are unchanged after stripping; the ~62 `size="sm"`
labels normalize to `text-caption` (slightly larger) until their region declares
a compact density in Phase 3.

### 2. ToggleChip + SegmentedControl — `…/toggle-chip/web/internal/toggle-chip.tsx`

- `ToggleChip`: remove the `size` param from the signature and the `size ??` in
  `effectiveSize`, leaving `const effectiveSize = chipSizeForDensity(density)`.
  Remove `size?: ToggleChipSize` from `ToggleChipProps` and add `size?: never;`
  next to its `[key: string]: unknown` (same leak plug — this is the one that
  could previously spread `size` onto `Badge`).
- `SegmentedControl`: remove the `size?` prop and the `size={size}` it forwards to
  each `ToggleChip`.
- Keep the `ToggleChipSize` type **internal** (still the return type of
  `chipSizeForDensity` + the `effectiveSize === "sm"` branch) but drop it from the
  barrel export (no external importers — confirmed).
- Update barrel `…/toggle-chip/web/index.ts`: drop the `ToggleChipSize`
  re-export.

`ToggleChip` keeps controlling its own height/padding/text via `className`
(`control-xs p-chip text-2xs` / `control-sm p-control text-caption`); those win
over Badge's derived text class, so its appearance is unchanged at a given
density. Default density (`md`) → `control-sm` (was `control-xs` only when a site
passed `size="sm"` — those now normalize up to match neighboring `sm` buttons,
which is the correct behavior).

### 3. Call-site migration — strip every `size=` (normalize, no wrapping)

Mechanically delete the `size=` attribute from all `Badge` / `ToggleChip` /
`SegmentedControl` usages (~93 sites across ~56 files; full inventory in the
exploration — e.g. `debug/reports`, `debug/queue`, the `jsonl-viewer/tool-call/*`
views, `review/*`, `fields/*`, `config_v2/settings`, `shell/notifications`,
`sonata/*`). **The change is tsc-driven:** after the prop removal + `size?: never`,
`./equin check type-check` enumerates every remaining call site, so none
can be missed. No `ControlSizeProvider` is added in this phase.

### 4. Docs — make the region-owns-size mental model explicit

The canonical home for the control-density model is the **theme** skill +
`control-size` CLAUDE.md (the `css` skill defers tokens/standards to `theme`),
but the user explicitly asked the **css** skill to carry it too. So:

- **`.claude/skills/theme/SKILL.md`** §"Control size = density inherited from
  context" (line 51): rewrite the stale bullet
  *"Controls (`Button`/`IconButton`/`PaneIconAction`/`ToggleChip`) omit `size` to
  inherit. An explicit `size` is the escape hatch …"* — chips (`Badge`,
  `ToggleChip`, `SegmentedControl`) now have **no `size` prop at all**; size is
  derived from ambient density, period. Note `Button`'s `size` is the remaining
  hole (Phase 2).
- **`plugins/primitives/plugins/css/plugins/control-size/CLAUDE.md`** lines 46–47:
  same correction (drop the "explicit `size` still wins" escape-hatch line for
  chips; `Badge` now listed among the density-deriving controls).
- **`.claude/skills/css/SKILL.md`** "Mental model": add a short bullet tying chip
  size into the same "container owns the policy" principle — *size/density is a
  region property inherited from `ControlSize`, never a per-element prop* — with a
  pointer to the theme skill for the full model.
- **`plugins/primitives/plugins/css/plugins/badge/package.json`** description:
  drop "size ×" from "size × variant chip" (it feeds the autogen doc block).
- `badge` / `toggle-chip` CLAUDE.md autogen blocks regenerate via
  `./equin build` (do not hand-edit).

### 5. Enforcement

No new lint rule. Props are tsc's domain: the removed prop + `size?: never`
sentinel makes a regression a **compile error**, caught by the `type-check`
check (which runs in `build` and `push`). The existing `no-adhoc-chip` lint
(`…/badge/lint/no-adhoc-chip.ts`) already covers ad-hoc chip *markup* and is
unaffected.

## Follow-ups to file (via `add_task` MCP, during execution)

- **Phase 2 — remove `size` from `Button`.** The last per-instance control-size
  escape hatch; converts explicit `size=` call sites to region density. This is
  what makes mixed containers (e.g. the `debug/queue` row: small badge + sized
  Retry/Cancel buttons) fully consistent. Large blast radius (`Button` is the
  most-used primitive).
- **Phase 3 — region primitives own density.** Bake intrinsic density into the
  region primitives (`Bar`, `Card`, `data-table`, pane toolbars) via the existing
  `defineRenderSlot(id, { controlSize })` auto-wrap mechanism, so a `<Table>`
  *is* compact and a toolbar *is* `sm` without hand-written `ControlSizeProvider`.
  Includes setting sensible compact densities on the dense debug/status panes
  whose badges normalized in Phase 1. Optionally flow density into `Text` so
  typography scales with compactness too.

## Verification

1. `./equin build` (regenerates autogen docs + runs checks).
2. `./equin check type-check` — must be clean; this is also the proof every
   `size=` call site was migrated (any leftover is a compile error).
3. Screenshot dense panes to confirm normalization reads fine:
   - `http://<wt>.localhost:9000/agents` → Debug → **Reports** and **Queue**
     (status badges now `text-caption`).
   - A `jsonl-viewer` conversation with tool-call cards (many `size="sm"` badges).
4. Confirm chips in toolbars now height-match neighboring buttons:
   - **Review** pane source toggles (`review/web/source.tsx` ToggleChips).
   - A `SegmentedControl` (e.g. `reorder/edit-mode` scope toggle, `fields/bool`
     filter) — should sit at `control-sm` and align with `sm` buttons.
   Use `bun e2e/screenshot.mjs --url … --out /tmp/chips` for before/after.

## Critical files

- `plugins/primitives/plugins/css/plugins/badge/web/internal/badge.tsx` (+ `web/index.ts`, `package.json`)
- `plugins/primitives/plugins/css/plugins/toggle-chip/web/internal/toggle-chip.tsx` (+ `web/index.ts`)
- ~56 call-site files (strip `size=`; full list in exploration / via type-check)
- `.claude/skills/theme/SKILL.md`, `.claude/skills/css/SKILL.md`
- `plugins/primitives/plugins/css/plugins/control-size/CLAUDE.md`
