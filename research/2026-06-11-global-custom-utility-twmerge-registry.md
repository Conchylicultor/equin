# Custom `@utility` → tailwind-merge registry (fix the silent-strip class)

## Context

`cn()` (clsx + tailwind-merge) silently drops custom `@utility` classes that
tailwind-merge doesn't know about. The live symptom: Badge/Text `md` size renders
at the inherited body size (16px) instead of caption (12px) because `text-caption`
is stripped before reaching the DOM.

**Root cause.** tailwind-merge classifies a class by its name. `text-caption`'s
suffix is a word, so twMerge files it under the **text-color** group (the `text-*`
fallback). Badge also applies a variant text-color class (e.g.
`text-muted-foreground`) later in the string; twMerge sees two text-color classes,
treats them as conflicting, and keeps only the later one — deleting `text-caption`.
The `control-*` / `p-*` utilities avoid this entire bug because they are registered
in the twMerge config (`control-utilities.ts` + `lib/utils.ts`) and kept in sync
with `app.css` by the `app-css-utilities-in-sync` check. The typography role
utilities — and several others — were never registered.

This is **a class of bug, not one instance.** Every custom `@utility` in `app.css`
that sets a property a built-in Tailwind group also controls, but which is not
registered with twMerge, is a latent silent-strip / fail-to-dedupe:

| `@utility` | sets | built-in group it collides with | registered today? |
|---|---|---|---|
| `text-title … text-caption` | font-size | `font-size` | ❌ (the live bug) |
| `z-base … z-max` | z-index | `z-index` | ❌ |
| `h-chrome-bar` / `h-chrome-pane` | height | `h` | ❌ |
| `px-chrome` | padding-x | `px` | ❌ |
| `pl-chrome` | padding-left | `pl` | ❌ |
| `pr-floating-bar` | padding-right | `pr` | ❌ |
| `icon-auto` | width + height | `w` / `h` / `size` | ⚠️ in check's `OWNED_EXACT` but **never wired into twMerge** |
| `control-*`, `control-icon-*`, `control-min-*`, `p-chip/control/row` | height / w+h / min-h / padding | `h`/`size`/`w`/`min-h`/`p` | ✅ |
| `focus-ring`, `focus-ring-within` | box-shadow/outline (additive) | none | n/a |

**Intended outcome.** A custom `@utility` cannot exist that `cn()` mishandles, and
adding one cannot silently skip twMerge registration — enforced structurally, so
this whole class cannot recur.

## Approach (single-source registry + universal sync check)

Chosen over a "derive twMerge config by parsing each `@utility`'s CSS properties"
codegen because the load-bearing fact — *which twMerge conflict group a utility
belongs to* — is a policy decision **not present in the CSS** (height → `h` only,
or also `size`? `text-caption` sets font-size + line-height + font-weight but must
live in font-size only; `focus-ring` → no group). The codegen approach would still
need a hand-authored property→group map plus per-utility overrides, *plus* a CSS
parser and a generated artifact with a worse failure mode. The registry puts that
one irreducible decision on one typed line per utility, derives all wiring from it,
and mirrors the proven `control-*` precedent (registry + check) — just generalizing
its coverage to every custom utility.

### 1. Generalize the registry → `custom-utilities.ts`

Rename `plugins/framework/plugins/web-core/web/theme/control-utilities.ts` →
`custom-utilities.ts` (it now covers all custom utilities, not just control). Keep
the existing named arrays, add the missing families, and replace
`CONTROL_UTILITY_GROUPS` with a single data registry that declares each family's
twMerge wiring. Two wiring shapes plus an explicit no-op:

```ts
// Existing
export const CONTROL_HEIGHT_UTILITIES = ["control-xs","control-sm","control-md","control-lg"] as const;
export const CONTROL_ICON_UTILITIES   = ["control-icon-xs","control-icon-sm","control-icon-md","control-icon-lg"] as const;
export const CONTROL_MIN_UTILITIES     = ["control-min-xs","control-min-sm","control-min-md","control-min-lg"] as const;
export const PAD_UTILITIES             = ["p-chip","p-control","p-row"] as const;
// New
export const TEXT_ROLE_UTILITIES   = ["text-title","text-heading","text-subheading","text-body","text-label","text-caption"] as const;
export const Z_LAYER_UTILITIES      = ["z-base","z-raised","z-nav","z-float","z-overlay","z-popover","z-draw","z-max"] as const;
export const CHROME_HEIGHT_UTILITIES = ["h-chrome-bar","h-chrome-pane"] as const;
export const CHROME_PADX_UTILITIES   = ["px-chrome"] as const;
export const CHROME_PADL_UTILITIES   = ["pl-chrome"] as const;
export const CHROME_PADR_UTILITIES   = ["pr-floating-bar"] as const;
export const ICON_AUTO_UTILITIES     = ["icon-auto"] as const;
export const FOCUS_RING_UTILITIES    = ["focus-ring","focus-ring-within"] as const;

// `extend`     → append literals into an existing built-in group (full mutual conflict, no text-color collision)
// `group`+`conflictsWith` → synthetic group conflicting with the listed built-in groups (multi-property utilities)
// `standalone` → intentionally outside twMerge; `reason` documents why (parsed/enforced by the check)
export const CUSTOM_UTILITY_REGISTRY = [
  { classes: TEXT_ROLE_UTILITIES,    extend: "font-size" },
  { classes: Z_LAYER_UTILITIES,      extend: "z-index" },
  { classes: CHROME_HEIGHT_UTILITIES, extend: "h" },
  { classes: CHROME_PADX_UTILITIES,  extend: "px" },
  { classes: CHROME_PADL_UTILITIES,  extend: "pl" },
  { classes: CHROME_PADR_UTILITIES,  extend: "pr" },
  { classes: CONTROL_HEIGHT_UTILITIES, group: "sg-control-height", conflictsWith: ["size","h"] },
  { classes: CONTROL_ICON_UTILITIES,   group: "sg-control-icon",   conflictsWith: ["size","h","w"] },
  { classes: CONTROL_MIN_UTILITIES,    group: "sg-control-min",    conflictsWith: ["min-h"] },
  { classes: PAD_UTILITIES,            group: "sg-pad",            conflictsWith: ["p"] },
  { classes: ICON_AUTO_UTILITIES,      group: "sg-icon-auto",      conflictsWith: ["size","h","w"] },
  { classes: FOCUS_RING_UTILITIES,     standalone: true, reason: "Additive box-shadow/outline; no single-value built-in group to conflict with." },
] as const;
```

Notes:
- **`extend` (preferred for single-property utilities):** appending the literals
  into the built-in group (`font-size`, `z-index`, `h`, `px`, `pl`, `pr`) gives
  order-independent mutual conflict for free, and — crucially — moves
  `text-caption` out of the text-color fallback, so `cn("text-caption","text-muted-foreground")`
  keeps **both**. Literal class names take precedence over twMerge's text-color
  validator, so this resolves `text-caption` to font-size.
- **`group`+`conflictsWith` (multi-group):** reproduces today's `control-*` wiring
  exactly and handles `icon-auto` (sets w+h, must conflict with `w`/`h`/`size`).
- Built-in group ids (`font-size`, `z-index`, `h`, `px`, `pl`, `pr`, `size`, `w`,
  `min-h`, `p`) are tailwind-merge's documented default class-group keys — verify
  against the installed `tailwind-merge` during implementation.

### 2. Derive the twMerge config from the registry — `lib/utils.ts`

Replace the hand-written `classGroups` / `conflictingClassGroups` literals with a
loop over `CUSTOM_UTILITY_REGISTRY` (file:
`plugins/framework/plugins/web-core/web/lib/utils.ts`). This removes the
"must also hand-edit `conflictingClassGroups`" coupling that let the bug exist —
adding a registry entry now auto-wires twMerge.

```ts
import { CUSTOM_UTILITY_REGISTRY } from "@/theme/custom-utilities";

const classGroups: Record<string, string[]> = {};
const conflictingClassGroups: Record<string, string[]> = {};
for (const e of CUSTOM_UTILITY_REGISTRY) {
  if ("extend" in e)      (classGroups[e.extend] ??= []).push(...e.classes);
  else if ("group" in e) { classGroups[e.group] = [...e.classes];
                           for (const c of e.conflictsWith) (conflictingClassGroups[c] ??= []).push(e.group); }
  // standalone: no twMerge entry
}
const twMerge = extendTailwindMerge({ extend: { classGroups, conflictingClassGroups } });
```

Keep a typed union of the synthetic group ids (derive from the registry entries
that have `group`) to preserve `extendTailwindMerge`'s generic type safety.

### 3. Make the sync check universal — `app-css-utilities-in-sync/check/index.ts`

File: `plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/check/index.ts`.
This is the structural keystone — it turns "every custom utility is registered"
into an invariant.

- Point the path constant at `custom-utilities.ts`.
- `expectedUtilities()`: generalize from four hard-coded array names to **every**
  top-level `const \w+_UTILITIES = [...] as const` array in the file (regex over
  `(\w+_UTILITIES)\s*=\s*\[([^\]]*)\]`, collect the string literals). This excludes
  group ids / `conflictsWith` values (they're scalars, not inside `*_UTILITIES`
  arrays), so the parser stays robust without importing the module.
- **Reverse check becomes total:** drop `OWNED` / `OWNED_EXACT`. Every `@utility`
  declared in `app.css` must appear in the registry (the union of all
  `*_UTILITIES` arrays — `focus-ring`/`focus-ring-within` are covered by
  `FOCUS_RING_UTILITIES`). Adding a `@utility` without a registry entry now fails
  the check, with a hint pointing at `custom-utilities.ts`.
- Forward check unchanged (every registry class must be declared in `app.css`).

### 4. Ripple updates (rename fallout)

- `app.css`: update the `control-utilities.ts` mention in the comment near the
  `@utility` blocks.
- `css-vars-supplied/check/index.ts`: update the `control-utilities.ts` mention in
  its doc comment (line ~23).
- CLAUDE.mds: `app-css-utilities-in-sync/CLAUDE.md` and
  `plugins/primitives/plugins/icon-auto/CLAUDE.md` — refresh the filename and the
  "control-/p-/icon-auto only" description to "all custom utilities".
- No other TS importers exist (`CONTROL_*` symbols are imported only by
  `lib/utils.ts`).

### Files

- `plugins/framework/plugins/web-core/web/theme/control-utilities.ts` → **rename** to `custom-utilities.ts`, generalize.
- `plugins/framework/plugins/web-core/web/lib/utils.ts` — derive twMerge config from registry.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/check/index.ts` — universal reverse check + path + parser.
- `plugins/framework/plugins/web-core/web/theme/app.css` — comment only (the `@utility` blocks already exist; **no CSS change needed**).
- `.../app-css-utilities-in-sync/CLAUDE.md`, `plugins/primitives/plugins/icon-auto/CLAUDE.md`, `css-vars-supplied/check/index.ts` — doc/comment refresh.

No changes to `text.tsx` / `badge.tsx` — they already call `cn()` correctly; the
fix is entirely in twMerge configuration.

## Verification

1. **Check passes / catches drift.**
   `./equin check app-css-utilities-in-sync` → green. Temporarily add a bogus
   `@utility foo-bar { … }` to `app.css` and re-run → it must **fail** (proves the
   reverse check is now total). Remove it.
2. **twMerge resolution** (quick `bun` repl importing `cn`):
   - `cn("text-caption","text-muted-foreground")` → contains **both** (no strip).
   - `cn("text-body","text-sm")` → `"text-sm"` (role utilities dedupe as font-size).
   - `cn("z-base","z-max")` → `"z-max"`; `cn("h-chrome-bar","h-10")` → `"h-10"`.
3. **Live app.** `./equin build`, then a scripted Playwright run against
   `http://<worktree>.localhost:9000` rendering a Badge `md` with a variant that
   adds a text-color class; assert `getComputedStyle(badge).fontSize` ===
   `var(--font-size-caption)` resolved (12px), not 16px. Use `e2e/screenshot.mjs`
   as the harness base.
4. `./equin check` (full) → all green (eslint typography lint, type-check,
   etc.).
```
