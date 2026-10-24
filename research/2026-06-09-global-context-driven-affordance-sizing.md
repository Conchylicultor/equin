# Context-Driven Affordance Sizing

> Status: IMPLEMENTED & verified. Scope C (full generalization), em-based model.
>
> **Outcome (verified 2026-06-09):** `./equin build` + all `./equin check`
> green (incl. new `app-css-utilities-in-sync` check, the precise
> `no-adhoc-slot-icon-size` lint rule, typescript, and the `cn` vitest). Playwright
> measurement of FilePath cards: copy button 32px → **~18–20px** (now tracks
> surrounding text), file-path row ~32px → **~20px**, across 38 rendered cards.
>
> **Refinements made during implementation (vs the plan above):**
> - `cn` needed an explicit `extendTailwindMerge<CustomGroupId>` type arg (computed
>   classGroup keys widen to `string`); union derived from `CONTROL_UTILITY_GROUPS`.
> - The `inline` Button size also sets `text-[1em]` so `icon-auto` resolves against
>   the *surrounding* font-size (Button base forces `text-sm` otherwise → too large).
> - The lint rule was narrowed to **fire only when the parent is an auto-sizing
>   primitive `{Badge,Row,LinkChip,ToggleChip,Breadcrumb}` AND the slotted child is a
>   bare (childless), non-host glyph** — the prop-name-only version had a high
>   false-positive rate (custom components like ToolButton/BulletList, `<span>`
>   spacers, Badge-as-label). Accepted false negatives: aliased parents (e.g.
>   `RowPrimitive`) and wrapped/variable icons.
> - The sweep covered the full lint-surfaced tail (~30 sites total, not just the ~20
>   in the table below) — the precise rule drove it to completion.

## Context

Embedded affordances render at a fixed size regardless of the density of the
context they sit in, so every call site locally overrides the size — and the
override often doesn't even win. The trigger case: `CopyButton` inside `FilePath`
(jsonl-viewer) renders **~32px** despite the call site passing `size-5` (20px)
and `iconClassName="size-2.5"`, which sets the row height of every file-path card
(~50px vs ~32px for text-only cards).

Investigation found **two distinct root causes**:

1. **Silent-override bug (why the override doesn't win).** `cn()` is bare
   `twMerge(clsx(...))` (`web-core/web/lib/utils.ts:5`). Vanilla tailwind-merge
   has zero knowledge of the custom Tailwind v4 `@utility` classes in
   `app.css:303-319` (`control-*`, `control-icon-*`, `p-chip/control/row`). So a
   call-site `size-5` does **not** strip the variant's `control-icon-md`; both
   survive and CSS source-order makes `control-icon-md` (= `var(--control-height-md)`
   = 32px) win. This is a whole *class* of silent bug: any standard-utility
   override of a custom utility quietly fails.

2. **No context-driven sizing (why call sites hardcode).** Every icon-slot
   primitive (`icon=`, `leading=`, `actions=` on Badge/Row/LinkChip/Breadcrumb/
   ToggleChip) imposes zero sizing, forcing ~50 call sites to hardcode
   `size-3`/`size-3.5`/`size-4`. Density exists only as a *global* CSS-var system
   with no local scoping and no React context.

**Outcome wanted:** one CSS-native, cascade-based mechanism where embedded glyphs
auto-track their surrounding font-size (the context signal already set on every
chip/row/path), call sites stop hardcoding sizes, and overrides — when used —
actually win. Touches load-bearing primitives (`web-core` cn/button,
`copy-to-clipboard`, `icon-button`, `badge`); **approved** by the user.

**Decisions locked with the user:** Scope **C** (full generalization);
sizing model **em / `icon-auto`**.

**Placement decision.** The new merge-config source-of-truth lives **in web-core**,
co-located with `app.css` — because the custom `@utility` definitions
(`control-*`/`p-*`/`z-*`) and their consumer (`button.tsx` cva) already live there,
so the twMerge mirror is web-core describing *its own* utilities (cohesion, not
bloat). Distributing it to the `control-size`/`z-layers` plugins was rejected: those
are lint-rule satellites with no runtime, and it would split the source-of-truth
(CSS in core / config in plugins) and invert layering (foundational `cn` importing
primitives above it). `cn` stays put — it's an ambient global util (root tsconfig
`@/*` alias, ~123 importers, shadcn convention); relocating it is disproportionate
churn. The genuine "slim web-core" refactor — extracting `cn` + `components/ui` +
`theme` into a dedicated ui-kit primitive — is filed as a **separate task**
(`task-1781020410122-xgy62t`) and intentionally not entangled here.

## Design at a glance

| Layer | What | Risk |
|---|---|---|
| 4 (first) | Single source of truth for custom-utility names + conflict families | low |
| 1 | `extendTailwindMerge` so `size-*`/`h-*`/`w-*`/`p-*` strip custom utilities | **app-wide** |
| 2 | `icon-auto` (em) utility wired into text-embedded icon slots | medium (visual) |
| 3 | `size="inline"` affordance box (no control-height) + CopyButton/IconButton | medium |
| 4 (rest) | `app-css-utilities-in-sync` check + `no-adhoc-slot-icon-size` lint | low |
| 5 | Sweep ~22 call sites to drop hardcoded icon sizes | low (mechanical) |

---

## Layer 4a — Single source of truth (build this first)

**New: `plugins/framework/plugins/web-core/web/theme/control-utilities.ts`** — owns
only the custom-utility class-name strings, grouped by which built-in
tailwind-merge group must override them. `ControlSize` stays in `button.tsx`.

```ts
export const CONTROL_HEIGHT_UTILITIES = ["control-xs","control-sm","control-md","control-lg"] as const;
export const CONTROL_ICON_UTILITIES   = ["control-icon-xs","control-icon-sm","control-icon-md","control-icon-lg"] as const;
export const PAD_UTILITIES            = ["p-chip","p-control","p-row"] as const;
export const ICON_AUTO_UTILITY        = "icon-auto" as const;

export const CONTROL_UTILITY_GROUPS = {
  controlHeight: { groupId: "sg-control-height", classes: CONTROL_HEIGHT_UTILITIES, overriddenBy: ["h","size"] },
  controlIcon:   { groupId: "sg-control-icon",   classes: CONTROL_ICON_UTILITIES,  overriddenBy: ["w","h","size"] },
  pad:           { groupId: "sg-pad",            classes: PAD_UTILITIES,           overriddenBy: ["p"] },
} as const;
```

Consumed by `lib/utils.ts` (real behavior). The `app.css` `@utility` block is the
hand-written CSS mirror; the Layer-4 check keeps them in sync.

---

## Layer 1 — Fix `cn()` (`web-core/web/lib/utils.ts`)

Replace bare `twMerge` with `extendTailwindMerge`. **Built-in groups are the KEYs**
(later-wins): the variant emits `control-icon-md` first, the call-site `className`
(`size-5`) comes last, so `{ size: ['sg-control-icon'] }` makes the trailing
`size-5` strip the earlier custom utility.

```ts
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { CONTROL_UTILITY_GROUPS } from "@/theme/control-utilities";

const { controlHeight, controlIcon, pad } = CONTROL_UTILITY_GROUPS;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      [controlHeight.groupId]: [...controlHeight.classes],
      [controlIcon.groupId]:   [...controlIcon.classes],
      [pad.groupId]:           [...pad.classes],
    },
    conflictingClassGroups: {
      size: [controlHeight.groupId, controlIcon.groupId],
      h:    [controlHeight.groupId, controlIcon.groupId],
      w:    [controlIcon.groupId],
      p:    [pad.groupId],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- **One-directional only** (built-in-later-wins). We deliberately do *not* add the
  reverse (`sg-control-icon: ['size','w','h']`) — the custom util is always emitted
  before the className in our composition order, so the reverse case never arises
  and adding it risks a control losing its own height.
- `control-icon-*` is square (w+h): overriding one axis (`h-8` alone) strips the
  whole utility (loses width too). Acceptable/documented — overriding one axis of a
  square control opts you out of the square utility; set both.
- **Add a vitest** (`web-core` has vitest): `cn("control-icon-md","size-5")==="size-5"`,
  `cn("control-md","h-8")==="h-8"`, `cn("p-chip","p-2")==="p-2"`.

---

## Layer 2 — `icon-auto` em mechanism

**`app.css`** (after line 319, same `@utility` region):

```css
/* Em-based icon sizing — glyphs in text-embedded slots (Badge/Row/LinkChip/
 * ToggleChip/Breadcrumb leading+actions) track the slot's font-size instead of a
 * hardcoded size-N. 1.15em ≈ "slightly larger than cap height": next to text-xs
 * (12px) → ~13.8px, matching today's dominant size-3.5 (14px) far better than
 * bare 1em (12px, optically small). Kept in sync with control-utilities.ts via
 * the app-css-utilities-in-sync check. */
@utility icon-auto { width: 1.15em; height: 1.15em; }
```

**Multiplier `1.15em`** chosen from current ratios (badge `size-3`/`text-xs` = 1.0;
row `size-3.5`/`text-xs` ≈ 1.17). `1em` is the conservative fallback if visual
sign-off prefers exact parity.

Wire `[&_svg:not([class*='size-'])]:icon-auto` into the slot containers (the `:not`
preserves explicit overrides):

- **Badge** `badge/web/internal/badge.tsx` root className (icon slot is a descendant).
- **Row** `row/web/internal/row.tsx` root (covers `icon` + `actions`); **SectionHeaderRow** inherits.
- **LinkChip** `link-chip/web/internal/link-chip.tsx` root (covers `leading`).
- **ToggleChip** `toggle-chip/web/internal/toggle-chip.tsx` root (icon glyph only; chip height stays `control-*`).
- **Breadcrumb** `breadcrumb/web/internal/breadcrumb.tsx` root span (covers `actions`).

**Button base keeps fixed glyph fallbacks** (`button.tsx:7,26,27,31` — `size-4`/
`size-3`/`size-3.5`). Standalone controls want a fixed optical glyph independent of
any text run; `icon-auto` is only for icons embedded in a text flow. The
text-embedded affordance case is handled by the new `inline` size (Layer 3).

**StatusDot stays fixed** (`size-1.5/2/2.5`) — it's a non-glyph semantic indicator
consumed via its `size` prop, and renders a `<span>` (unaffected by the svg-only
selector anyway).

---

## Layer 3 — `inline` affordance box

**`button.tsx` cva `size` variants** (add):

```ts
inline:
  "h-auto rounded-[min(var(--radius-md),8px)] p-0.5 align-middle [&_svg:not([class*='size-'])]:icon-auto",
```

No `control-*` height → collapses to content; `p-0.5` minimal hit padding;
`align-middle` centers on the line; `icon-auto` glyph tracks surrounding font-size.
Box ≈ `1.15em + 4px` ≈ line height, so it no longer forces a 32px row.

- **`CopyButton`** (`copy-to-clipboard/web/internal/copy-button.tsx`): add
  `size?: "icon" | "inline"` (default `"icon"`), pass to `<Button>`. **Remove the
  `iconClassName` default `"size-3"`** (keep the prop, no default, as an escape
  hatch) — `inline` supplies `icon-auto`, `icon` keeps Button's `size-4` fallback.
- **`IconButton`** (`icon-button/web/components/icon-button.tsx:40`): replace
  hardcoded `<Icon className="size-4" />` with `<Icon />` so Button's per-size
  fallback applies (fixes `icon-xs` wrongly getting 16px today).
- **`FilePath`** (`file-path/web/components/file-path.tsx:47-53`):
  ```tsx
  <CopyButton text={relativePath} title="Copy path" size="inline"
    className="opacity-0 group-hover/path:opacity-100 transition-opacity shrink-0"
    onClick={(e) => e.stopPropagation()} />
  ```
  Remove `size-5` and `iconClassName="size-2.5"`. **Primary goal — row shrinks to ~text height.**

---

## Layer 4b — Sync check + lint rule

**Check `app-css-utilities-in-sync`** — new plugin-contributed check (auto-discovered):
`plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/{check/index.ts,package.json,CLAUDE.md}`.
Mirror the `no-raw-websocket` `Check` literal. To avoid any runtime-isolation
question, it **text-parses both files** (no TS import): regex `@utility ([\w-]+)`
from `app.css` → declared set; regex the string literals from
`control-utilities.ts` → expected set; assert every expected name is declared, and
every `control-*`/`p-chip|control|row`/`icon-auto` declaration is in the expected
set. Fail loudly with the diff + hint "register it in control-utilities.ts and add
its twMerge conflict in lib/utils.ts."

**Lint `no-adhoc-slot-icon-size`** — new plugin holding only the rule + doc
(mirrors `control-size` holding a rule while the `@utility` lives in `app.css`):
`plugins/primitives/plugins/icon-auto/{lint/index.ts,lint/no-adhoc-slot-icon-size.ts,CLAUDE.md,package.json}`.
- Visitor: `JSXAttribute` named `icon`/`leading` whose value is a
  `JSXExpressionContainer` wrapping an **inline `JSXElement`**; if its `className`
  contains a `size-\d`/`h-\d`/`w-\d` token, report (report-only, no autofix).
- **Honest scope:** catches the inline-literal pattern (the bulk of real sites);
  does NOT catch `const ico = <X className="size-3"/>; icon={ico}` nor
  component-internal hardcodes. `actions=` is out of scope (often Buttons with
  their own fixed glyphs). Documented as a convention in the plugin CLAUDE.md, not
  a guarantee — do not over-promise AST coverage.
- Auto-registered: `lint/index.ts` default-exports `{ name, rules, ignores }`;
  `lint.generated.ts` regenerates on build; `eslint.config.ts` enables it `error`
  repo-wide.

---

## Layer 5 — Call-site sweep

After Layers 1-3, drop hardcoded slot-icon sizes. `[ACT]` = dead override that
becomes live after Layer 1 (intended shrink — eyeball each).

| File | Line(s) | Change |
|---|---|---|
| `…/jsonl-viewer/plugins/file-path/web/components/file-path.tsx` | 47-53 | `size="inline"`; drop `size-5`, `iconClassName`. `[ACT]` |
| `primitives/…/filepath-breadcrumb/web/internal/filepath-breadcrumb.tsx` | 32-34 | CopyButton `size="inline"`; drop `size-5`. `[ACT]` |
| `review/plugins/code-review/web/components/review-file-row.tsx` | 90-94 | CopyButton `size="inline"`; drop `size-5`+`iconClassName="size-3"`. `[ACT]` |
| `review/…/file-changes/web/components/file-changes-section.tsx` | 60-64 | CopyButton `size="inline"`; drop `size-4`+`iconClassName="size-3"`. `[ACT]` |
| `page/plugins/code-block/web/components/code-block.tsx` | 167-170 | CopyButton `size="icon-sm"`; drop `size-6`. `[ACT]` |
| `auth/…/setup-wizard/web/components/google-setup-pane.tsx` | 149-153 | CopyButton default `size="icon"`; drop `size-8`+`iconClassName="h-4 w-4"`. `[ACT]` |
| `…/allow-monitor/web/components/allow-monitor-chip.tsx` | 38 | Badge `icon={<MdWarning/>}`; drop `size-3.5`. |
| `…/conversation-preprompt/web/components/preprompt-chip.tsx` | 28 | drop `size-3` (verify PrepromptIcon forwards className/renders svg). |
| `plugin-meta/plugins/plugin-view/web/components/plugin-detail.tsx` | 37 | Badge: drop `size-3`. |
| `…/facets/…/render-detail/web/components/structure-detail-section.tsx` | 41, 51 | Badge: drop `size-3` (×2). |
| `…/queue-operation/web/components/queue-operation-row.tsx` | 68 | Badge: drop `size-3` (line 59 standalone — leave). |
| `…/tool-call/plugins/workflow/web/components/workflow-tool-view.tsx` | 104 | Badge: drop `size-3` (line 62 standalone — leave). |
| `…/tool-call/plugins/workflow/web/components/workflow-graph.tsx` | 104 | Badge: drop `size-3.5`. |
| `…/tool-call/plugins/agent/web/components/agent-tool-view.tsx` | 107 | Row icon: drop `size-3.5`, keep `shrink-0` (line 85 standalone — leave). |
| `active-data/plugins/plugin-link/web/components/plugin-link-chip.tsx` | 81 | LinkChip leading: drop `size-3`, keep `shrink-0 text-muted-foreground`. |
| `primitives/plugins/row/web/internal/section-header-row.tsx` | 66 | drop `size-4` chevron (Row icon-auto). |
| `build/web/components/build-popover-content.tsx` | 105-113 | raw Button → `CopyButton size="icon-sm"`; drop `size-6`/`size-3`. `[ACT]` |
| `build/plugins/build-logs/web/components/build-log-section.tsx` | 48-55, 162-170 | raw Button → `CopyButton size="icon-sm"` (×2); drop `size-6`/`size-3`. `[ACT]` |
| `build/plugins/build-info/web/components/build-info.tsx` | 18,25,32,38 | StatusDot stays fixed — **no change**. |
| `…/jsonl-viewer/…/collapsible-card/web/components/collapsible-card.tsx` | 86 | chevron rendered directly (not a slot) — **leave**. |

The new lint rule will flag any inline-literal slot icon still hardcoding a size,
driving the sweep to completion.

---

## Verification

1. `./equin build` — tsc + vite pass; confirm `check.generated.ts` /
   `lint.generated.ts` regenerate to include the two new plugins (commit them or
   `plugins-registry-in-sync` fails).
2. `./equin check` — all checks incl. new `app-css-utilities-in-sync` +
   eslint with `no-adhoc-slot-icon-size`.
3. vitest in web-core for the `cn` conflict cases (above).
4. **Playwright** on a conversation with a Read tool call rendering `<FilePath>`:
   screenshot the file-path row before/after, measure the bounding-box height —
   expect ~32px → ~16-18px. Spot-check Badge/Row/LinkChip glyphs render ~13-14px
   and didn't visibly distort.
5. Eyeball every `[ACT]` site in the running app — confirm intended shrink, nothing broken.

## Risks

- **R1 (highest): Layer 1 activates dead overrides app-wide.** All `[ACT]` sites
  above currently keep `control-icon-md` (32px) and ignore their `size-N`; after the
  fix the override wins (they shrink). Intended, but eyeball each; final grep for
  `size-/h-/w-` co-located with `size="icon*"`/CopyButton before merge.
- **R2:** `control-icon-*` square — one-axis override strips both (documented).
- **R3:** `1.15em` is subjective; `1em` fallback; tunable in one place.
- **R4:** Lint rule covers inline-literal slot icons only (documented convention,
  not a guarantee).
- **R5:** `icon-auto`'s `:not([class*='size-'])` won't exclude an `h-4`/`w-4`
  override (only `size-`); minor — the lint rule + convention steer callers to `size-*`.

## Critical files

- `plugins/framework/plugins/web-core/web/lib/utils.ts` (Layer 1)
- `plugins/framework/plugins/web-core/web/theme/control-utilities.ts` (**new**, Layer 4a)
- `plugins/framework/plugins/web-core/web/theme/app.css` (Layer 2)
- `plugins/framework/plugins/web-core/web/components/ui/button.tsx` (Layer 3)
- `plugins/primitives/plugins/copy-to-clipboard/web/internal/copy-button.tsx` (Layer 3)
- `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx` (Layer 3)
- `plugins/primitives/plugins/{badge,row,link-chip,toggle-chip,breadcrumb}/web/internal/*.tsx` (Layer 2)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/` (**new**, Layer 4b)
- `plugins/primitives/plugins/icon-auto/` (**new** lint plugin, Layer 4b)
- ~20 call-site files (Layer 5 table)
