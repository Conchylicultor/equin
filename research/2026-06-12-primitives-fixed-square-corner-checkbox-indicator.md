# Fixed square-corner shape token + shared checkbox/radio indicator primitive

## Context

The corner-radius standard (`primitives/radius`) routes every corner through the
`--radius` shape token so a Shape preset (Sharp / Rounded / Pill) re-softens the
whole app at once. It models exactly **two** preset-independent fixed shapes that
bypass the token: `rounded-none` (hard corner) and `rounded-full` (pill/circle).
Both are always allowed by the `no-adhoc-radius` lint.

There is **no sanctioned token for a small fixed _square_ corner** — the shape a
checkbox indicator needs. A checkbox must stay a slightly-rounded square under
every Shape preset; if it reads `--radius` (e.g. via `rounded-sm`), a generous
preset rounds the ~12px box into a near-circle, making a multi-select look
mutually-exclusive (indistinguishable from a radio).

This just bit the AskUserQuestion multi-select `Indicator`
(`…/ask-user-question/web/components/ask-user-question-tool-view.tsx`), which was
patched with an arbitrary `rounded-[3px]` literal stashed in a `const` (to dodge
the lint, which only scans `className`/`cn` contexts). That closes one spot but
leaves the gap: the next styled checkbox hits the same trap, and the standard has
no answer for it.

**Outcome:** close the gap at the standard level by adding a third sanctioned
fixed shape (`rounded-checkbox`), and add a shared `CheckboxIndicator` /
`RadioIndicator` primitive that owns the box/border/fill/glyph + fixed shape, so
future checkboxes are a one-liner and never touch radius. The native
`<input type="checkbox">` controls (`multi-select/SelectionCheckbox`, the page
to-do block) are **out of scope** — the UA draws their shape; only styled
span-box indicators have the rounding problem.

## Part A — `rounded-checkbox` fixed-shape token

A peer of `rounded-none` / `rounded-full`: a literal corner that does **not**
read `--radius`, declared as a custom `@utility` and wired into twMerge through
the existing single-source registry (the sanctioned, check-enforced path).

1. **`plugins/primitives/plugins/ui-kit/web/theme/app.css`** — add to the
   `@utility` section (near `focus-ring` / the density utilities):
   ```css
   /* Fixed checkbox corner — a preset-independent square-ish shape (peer of
      rounded-none / rounded-full). NOT derived from --radius: a checkbox must
      stay square under every Shape preset. */
   @utility rounded-checkbox { border-radius: 3px; }
   ```

2. **`plugins/primitives/plugins/ui-kit/web/theme/custom-utilities.ts`**:
   - Add `"rounded"` to the `BuiltinGroupId` union (tailwind-merge's built-in
     border-radius group id).
   - Add the family + registry entry so `rounded-checkbox` joins the built-in
     `rounded` group (mutual conflict with `rounded-md` etc., no silent strip):
     ```ts
     export const ROUNDED_FIXED_UTILITIES = ["rounded-checkbox"] as const;
     // …
     { classes: ROUNDED_FIXED_UTILITIES, extend: "rounded" },
     ```
   The `lib/utils.ts` twMerge config derives automatically; the
   `app-css-utilities-in-sync` check then passes (declared ⇔ registered).

3. **`no-adhoc-radius` lint** — **no change needed.** The rule bans only bare
   `rounded` and arbitrary `rounded-[…]`; a named `rounded-checkbox` is allowed
   automatically.

4. **`plugins/primitives/plugins/radius/CLAUDE.md`** — document the third fixed
   shape under "The scale": `rounded-none`, `rounded-full`, **and**
   `rounded-checkbox` are the preset-independent shapes; everything else routes
   through the token. Note it's owned as a custom `@utility` in ui-kit `app.css`.

## Part B — `selection-indicator` primitive (CheckboxIndicator / RadioIndicator)

New pure-library primitive under the `primitives` umbrella, mirroring `status-dot`
(barrel re-export + `definePlugin` with empty `contributions`, auto-discovered —
**no `plugins.ts` / registry edit**). It owns the indicator visual so the fixed
shape lives in one place and consumers never write radius classes.

New files under `plugins/primitives/plugins/selection-indicator/`:

- **`package.json`** — copy `status-dot/package.json`, name
  `@singularity/plugin-primitives-selection-indicator`.
- **`web/index.ts`** — barrel:
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  export { CheckboxIndicator, RadioIndicator, type SelectionIndicatorProps } from "./internal/selection-indicator";
  export default {
    description: "Presentational checkbox / radio indicator boxes (border + fill + glyph) with the correct preset-independent fixed shape baked in (rounded-checkbox / rounded-full).",
    contributions: [],
  } satisfies PluginDefinition;
  ```
- **`web/internal/selection-indicator.tsx`** — depends only on
  `primitives/ui-kit.cn`. A shared `Box` (size-3, `shrink-0`, centered, border
  when unchecked / `border-primary bg-primary` when checked) parameterized by
  shape + glyph; `className` passthrough for margin/size overrides:
  - `CheckboxIndicator` → `shape="rounded-checkbox"`, glyph `✓`
    (`<span className="text-3xs text-white">✓</span>`).
  - `RadioIndicator` → `shape="rounded-full"`, glyph inner dot
    (`<span className="block size-1 rounded-full bg-white" />`).
  Markup mirrors the current `Indicator` byte-for-byte (keep `text-white` /
  `bg-white` as-is — not in scope to re-theme).
- **`CLAUDE.md`** — short prose + the autogen block placeholder (filled by build);
  required by the `plugins-have-claudemd` check.

## Part C — migrate the one styled consumer

**`…/jsonl-viewer/tool-call/ask-user-question/web/components/ask-user-question-tool-view.tsx`**
— replace the local `Indicator` (the `rounded-[3px]`/comment block) with the new
primitive: render `multi ? <CheckboxIndicator checked={selected} className="mt-0.5" /> : <RadioIndicator checked={selected} className="mt-0.5" />`.
Add the import to the plugin's `package.json` deps if needed (it already imports
`primitives/ui-kit`; add `primitives/selection-indicator`). Delete the
`rounded-[3px]` literal and its explanatory comment.

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/ui-kit/web/theme/app.css` | `@utility rounded-checkbox` |
| `plugins/primitives/plugins/ui-kit/web/theme/custom-utilities.ts` | `ROUNDED_FIXED_UTILITIES` + registry entry + `"rounded"` group id |
| `plugins/primitives/plugins/radius/CLAUDE.md` | document third fixed shape |
| `plugins/primitives/plugins/selection-indicator/**` (new) | package.json, barrel, component, CLAUDE.md |
| `…/ask-user-question/web/components/ask-user-question-tool-view.tsx` | migrate `Indicator`; add dep |

## Verification

1. `./equin build` — regenerates plugin docs (compact/details) and runs
   checks. Must pass: `app-css-utilities-in-sync` (new @utility registered),
   `type-check`, `eslint`/`no-adhoc-radius` (no arbitrary literal remains),
   `plugins-have-claudemd`, `plugin-boundaries`.
2. `./equin check` — green.
3. (Sanity) `cn("rounded-checkbox", "rounded-md")` resolves to `rounded-md`
   (mutual conflict, last wins) — confirms twMerge wiring; `cn("rounded-checkbox")`
   alone is untouched (the only call shape the component uses).
4. Visual proof of the fix — open an AskUserQuestion tool-call render and switch
   the Shape preset to **Pill** (the generous preset that caused the bug) via the
   appearance customizer, then screenshot:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/<path-to-a-convo-with-an-AskUserQuestion> --out /tmp/checkbox
   ```
   Confirm the multi-select boxes stay square-cornered (distinct from the round
   radio) under Pill, and the single-select radios stay circular. Compare against
   `rounded-md` boxes (which would balloon to near-circles under Pill) to confirm
   `rounded-checkbox` is preset-independent.

## Notes / non-goals

- Native `<input type="checkbox">` controls are not migrated — they have no
  radius-token problem (UA-drawn) and are functional form controls, a different
  concern from the presentational indicator.
- Value pinned at `3px` (matches the existing fix; reads well on size-3/size-3.5
  boxes). It's a deliberate fixed literal — the whole point is preset-independence.
- Naming: `rounded-checkbox` is use-named for clarity ("why is this corner not
  themed? it's a checkbox-class indicator"), paralleling how `rounded-full` reads
  as its canonical use. Open to `rounded-fixed`/`rounded-square` if preferred.
