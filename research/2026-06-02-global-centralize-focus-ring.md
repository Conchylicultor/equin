# Centralize the focus-ring treatment (kill the double-border under saturated themes)

## Context

Several shadcn-derived form controls use the focus recipe
`focus-visible:border-ring` **+** `focus-visible:ring-3 focus-visible:ring-ring/50`
together. On focus the border flips to the `--ring` hue **and** a ring of the
same hue is drawn — a two-tone "double border". It's invisible in the default
theme because `--ring` is achromatic (`oklch(0.708 0 0)`), but any imported
tweakcn theme sets a saturated `--ring`, exposing it everywhere the recipe
appears.

Commit `cc40d6393` already fixed three controls (Input, multiline Textarea,
text-editor wrapper) by deleting `focus-visible:border-ring` and relying on the
ring alone. Three controls still carry the bug, and the recipe is copy-pasted
inline in every control, so it can drift again on the next shadcn paste.

**Goal:** define the neutral focus ring **once** as a Tailwind v4 `@utility`, and
migrate every control (the 3 buggy + the 3 already-fixed) onto it. The border
never flips; the ring is the sole focus indicator; the recipe lives in one place
so it can't desync per-component. (Decisions confirmed with user: *CSS @utility +
migrate all*, and *align the Button too*.)

This is the clean primitive over per-file patching: a CSS utility is global, needs
no import, and so works from any plugin (e.g. `launch-agent-popover` in
`plugins/primitives`) without tripping the cross-plugin boundary checker — a
shared TS constant exported from `web-core` could not (deep-path cross-plugin
import is forbidden).

## Current state (verbatim, post-`cc40d6393`)

Stack is **Tailwind CSS v4** (`@import "tailwindcss"`, `@theme inline`,
`@layer base`, `@apply`). `--ring` mapped via `--color-ring: var(--ring)`. No
custom `@utility` exists yet. `cn()` = `twMerge(clsx(...))` from
`@/lib/utils`. Global base applies `* { @apply border-border outline-ring/50 }`,
so `outline-none` on a control swaps that default outline for the ring.

| Component | File:line | Focus tokens | State |
|---|---|---|---|
| Button (cva base) | `plugins/framework/plugins/web-core/web/components/ui/button.tsx:7` | `outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` | **BUG** |
| Button `destructive` variant | `…/button.tsx:19` | `focus-visible:border-destructive/40 focus-visible:ring-destructive/20` | special-case |
| SelectTrigger | `…/web-core/web/components/ui/select.tsx:42` | `outline-none … focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` | **BUG** |
| launch-agent textarea | `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx:49` | `outline-none … focus-visible:border-ring focus-visible:ring-ring/50 … focus-visible:ring-3` | **BUG** |
| Input | `…/web-core/web/components/ui/input.tsx:12` | `outline-none … focus-visible:ring-3 focus-visible:ring-ring/50` | fixed → migrate |
| multiline Textarea | `plugins/config_v2/plugins/fields/plugins/multiline-text/web/components/multiline-text-renderer.tsx:57` | `focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50` | fixed → migrate |
| text-editor wrapper | `plugins/primitives/plugins/text-editor/web/components/text-editor.tsx:142` | `has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50` | fixed → migrate (container variant) |

Good references for the clean target (ring + offset, no border flip):
avatar/swatch selection rings (`ring-2 ring-ring ring-offset-1 ring-offset-background`)
and `resizable.tsx` (`ring-offset-background … focus-visible:ring-1 focus-visible:ring-ring`).

## Plan

### 1. Define the utilities — `…/web-core/web/theme/app.css`

`@utility` must be top-level (not inside `@layer`). Add near the `@layer base`
block:

```css
@utility focus-ring {
  @apply outline-none;
  &:focus-visible {
    @apply ring-3 ring-ring/50;
  }
}

@utility focus-ring-within {
  &:has(:focus-visible) {
    @apply ring-3 ring-ring/50;
  }
}
```

- `focus-ring` — for controls whose own focus drives the ring (inputs, select,
  button). Bundles `outline-none` so the global `outline-ring/50` is replaced.
- `focus-ring-within` — for wrappers that ring when a child is focused
  (text-editor's `has-[:focus-visible]` pattern). No `outline-none` (it's a
  non-focusable div).

This is the single source of truth: the ring width (`ring-3`) and neutral color
(`ring-ring/50`) now live in exactly one place. **Note:** `web/theme/CLAUDE.md`
forbids *plugin-specific* CSS and *token definitions* here — a global focus
utility is neither (it's global base infrastructure, like the existing
`@layer base` resets), so this is the correct home.

### 2. Migrate the controls

Each edit: drop `focus-visible:border-ring`, the `focus-visible:ring-3`,
`focus-visible:ring-ring/50`, and any standalone `outline-none` that the utility
now supplies; add `focus-ring`. The static `border-input` / `border-transparent`
class stays — border is neutral at all times.

- **button.tsx:7 (base)** — replace `outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` → `focus-ring`. (`border-transparent` stays; it no longer flips.)
- **select.tsx:42** — replace `outline-none … focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` → `focus-ring` (keep `transition-colors`, `border-input`).
- **launch-agent-popover.tsx:49** — replace `outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3` → `focus-ring` (keep `border-input`).
- **input.tsx:12** — replace `outline-none … focus-visible:ring-3 focus-visible:ring-ring/50` → `focus-ring`.
- **multiline-text-renderer.tsx:57** — replace `focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50` → `focus-ring`.
- **text-editor.tsx:142** — replace `has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50` → `focus-ring-within`.

### 3. Button `destructive` variant (special-case) — button.tsx:19

The destructive variant intentionally tints the focus ring (`ring-destructive/20`)
and currently also flips the border (`border-destructive/40`). Two changes:

- Drop `focus-visible:border-destructive/40` — aligns with "ring alone, no border
  flip" (matches the neutral fix).
- Keep `focus-visible:ring-destructive/20` to override the base color.

**Verification-sensitive:** `focus-ring` bakes `ring-ring/50` inside a custom
utility, so `tailwind-merge` cannot dedupe it against the variant's
`focus-visible:ring-destructive/20` — the destructive color must win by CSS
source order instead. This must be **confirmed visually** (step 4). If Tailwind's
utility ordering emits `focus-ring` after the override (destructive ring renders
grey, not red), the fallback is to bump specificity on the override, e.g.
`focus-visible:[--tw-ring-color:var(--destructive)]/20` or an arbitrary-property
form, rather than reintroducing the border flip.

### 4. Optional consistency follow-up (not required)

`scroll-area.tsx:18` uses `focus-visible:ring-[3px] focus-visible:ring-ring/50`
(no border flip → no bug). Migrate to `focus-ring` only if we want zero inline
copies of the recipe; out of scope otherwise.

## Files to modify

1. `plugins/framework/plugins/web-core/web/theme/app.css` — add the two `@utility` blocks
2. `plugins/framework/plugins/web-core/web/components/ui/button.tsx` — base (L7) + destructive variant (L19)
3. `plugins/framework/plugins/web-core/web/components/ui/select.tsx` — L42
4. `plugins/framework/plugins/web-core/web/components/ui/input.tsx` — L12
5. `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx` — L49
6. `plugins/config_v2/plugins/fields/plugins/multiline-text/web/components/multiline-text-renderer.tsx` — L57
7. `plugins/primitives/plugins/text-editor/web/components/text-editor.tsx` — L142

> Heads-up: `web-core/CLAUDE.md` marks `components/ui/*` as "generated, do not
> edit manually". Precedent `cc40d6393` already edited `input.tsx` for this exact
> fix, so editing `button.tsx`/`select.tsx`/`input.tsx` here is an accepted,
> consistent deviation.

## Verification

1. `./equin build` from the worktree; app at `http://att-1780357454-47je.localhost:9000`.
2. Apply a **saturated-ring tweakcn theme** (the condition that exposes the bug) via the theme/tweakcn settings, so `--ring` has chroma > 0.
3. Drive with Playwright (`e2e/screenshot.mjs`), focusing each control and capturing before/after:
   - Each text field (launch-agent textarea, Input, multiline Textarea, prompt/text-editor) — focus shows a **single** ring, border stays neutral (no second colored stroke).
   - SelectTrigger — focus shows single ring, neutral border.
   - Button (default/outline/ghost) — focus shows a normal single ring, no colored border stroke.
   - **Button `destructive`** — focus ring renders **destructive-colored** (confirms the §3 override survives; if grey, apply the §3 fallback).
4. Toggle back to the default (grey-ring) theme and confirm focus still reads correctly (single neutral ring) in light and dark.
5. `./equin check` (eslint + boundaries) passes — no cross-plugin import was introduced (utility is pure CSS).
```bash
bun e2e/screenshot.mjs --url http://att-1780357454-47je.localhost:9000/ --click "<control>" --out /tmp/focus-<control>
```
