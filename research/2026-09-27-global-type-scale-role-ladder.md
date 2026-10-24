# Restore the type-scale role ladder

## Context

The typography system was designed as a **closed ladder of semantic roles**
(`research/2026-06-09-global-text-role-primitive.md`): components pick a role
(`<Text variant>` / `text-<role>`), themes set role tokens, `no-adhoc-typography`
bans raw sizes. It drifted:

- The two Mist passes (`620bb1610`, `4b1c7c371`;
  `2026-09-25-global-agent-manager-sidebar-mist-metrics.md`,
  `2026-09-26-global-agent-manager-main-pane-mist.md`) followed the rule "every
  shared size becomes a token whose default is today's value", which minted
  **component-named type tokens**: `ChipCompact`, `ChipHeader`, `ToolBadge`,
  `Code` (inline), `Count`, `ControlCompact`, plus `sidebarLabel*` in
  sidebar-metrics (the last added as a stopgap on this branch).
- Lint only bans Tailwind's *named* sizes, so any custom `text-<name>` utility
  passes; and the class walk never reads `cva(...)`, so the sidebar's `text-xs`
  escaped.
- No shared scale: "make the text one step bigger" meant editing ~13 values —
  which is how this surfaced (the user asked to switch Mist from the prototype's
  `inter-small` to `inter`, and the sidebar did not follow).

**Outcome:** one closed role set (single constant), components pick roles, themes
set only roles, a `fontScale` factor scales everything, and a check + lint make
the drift impossible to repeat. Mist renders the prototype's `mist-text=roles`
option (= `inter`, now declared as a role ladder in
`~/.singularity/apps/prototypes/proto-1789643584-ldt6/mist.css`).

## Decisions (user, 2026-09-27)

- Roles win over pixel-identical output in other apps; every visible
  default-theme change is listed below.
- Keep the mockup's half-pixel values (no rounding — rounding was tried as a
  variant and rejected: it broke the prose/code/control ratios).
- Add `fontScale` in this plan.
- Sidebar labels (nav rows, conversation titles, quiet group headers) use the
  `label` role — other apps' sidebar nav goes 12 → 13px.
- New `tag` role (header tag + tool badge), so the tool badge keeps its size
  instead of shrinking into the compact chip.

### Mist role ladder (target)

| Role | Mist | Used for |
|---|---|---|
| tag compact rung | 10.5px / 600 | count chips (Badge xs) |
| 2xs | 11px | times, counts |
| tag | 11.5px / 600 (strong 700) | header chips, tool badge, Badge md |
| caption / control | 12px (control weight 600, strong 700) | buttons, tabs, footer pills |
| code | 12.5px, line 19px | inline + block code |
| label / base | 13px, line 18.2px (13 × 1.4) | sidebar, section heads, inherited text |
| body | 13.5px, line 19px | messages, prompt |

Known deviations from the mock: quiet group header 13px (mock 12.5), block code
12.5px (mock 12). Both are the role winning.

## Design

### 1. The closed role set — one constant

New `plugins/primitives/plugins/css/plugins/text/core/roles.ts` (+ `core/index.ts`
barrel). Lives under `primitives` because Text imports it (primitives never import
`ui/*`).

```ts
export const TYPE_ROLES = {
  display:    { weight: "bold",     compact: "title" },
  title:      { weight: "semibold", compact: "heading" },
  heading:    { weight: "semibold", compact: "subheading" },
  subheading: { weight: "semibold", compact: "body" },
  body:       { weight: "normal",   compact: "label" },
  label:      { weight: "medium",   compact: "caption" },
  caption:    { weight: "normal",   compact: "2xs" },
  control:    { weight: "token", strong: true, compact: "caption" },
  tag:        { weight: "token", strong: true, compact: "own" },
  code:       { weight: "normal", family: "mono", compact: "2xs" },
} as const;
export const TYPE_SUBSCALE = ["2xs", "3xs"] as const;
export const TEXT_TREATMENTS = ["eyebrow", "count"] as const; // built on roles
export function typeVar(name): string; // calc(var(--x) * var(--font-scale))
```

**Fate of each drifted token**

| Token(s) | Becomes | Default-theme change |
|---|---|---|
| `ControlCompact` size/lh | deleted; `text-control-compact` reads caption vars | none |
| `ChipCompact` size/lh/weight | `tag` compact rung: `fontSizeTagCompact`, `lineHeightTagCompact` | none |
| `ChipHeader` size/lh/weight | merged into `tag` | none |
| `ToolBadge` size/lh/weight | `tag` + `font-tag-strong` | tool badge 11 → 12px |
| `Code` (inline) size/lh | the `code` role's own tokens; `text-code` serves block + inline, `text-inline-code` deleted | inline code line-height 16 → 20px |
| `Count` size/lh/weight | deleted; Text `count` = `text-control-compact tabular-nums` | counts weight 400 → 500 |
| `ControlStrong` weight | kept as an attribute of `control`; `fontWeightTagStrong` added | none |
| sidebar-metrics `sidebarLabel*` + `text-/font-sidebar-label` | deleted; sidebar uses `label` | sidebar nav 12 → 13px |
| `Display` | kept as a role | none |

### 2. Bundles and rungs

- Every role has `fontSize<Role>` + `lineHeight<Role>`, both lengths (so they scale).
- Weight: frozen roles read the shared weight tokens in their utility; `control`
  and `tag` have `fontWeight<Role>` + `fontWeight<Role>Strong` and a weight-only
  utility (`font-control`, `font-tag`), so Button/Badge/ToggleChip can swap the
  size class and keep the weight.
- Compact rungs keep the base role's weight/tracking with the next rung's metrics;
  `tag-compact` has its own size tokens (Mist needs 10.5px while 2xs stays 11px).
- New tokens get **literal defaults**, not `var()` chains (a chain freezes inside
  sub-themes, which only emit the keys they name). Only the Strong weights chain.
- Non-role keys: `fontScale`, `fontSizeBase`, `lineHeightBase`, `measureReading`,
  the 2xs/3xs sub-scale, the four weights.

### 3. `fontScale`

- Token `fontScale: { default: "1" }` → `--font-scale`.
- Applied **in the utilities, at the element** — every role/compact utility in
  `app.css` (~1540-1602) writes `font-size: calc(var(--font-size-X) * var(--font-scale))`
  and the same for line-height; the `@theme inline` bridges for `text-2xs/3xs`
  likewise. Works in every scope, sub-themes included.
- Base: `[data-theme-scope] { font-size: calc(var(--font-size-base) * var(--font-scale)) }`,
  and `fontSizeBase` default **`1em` → `1rem`**: every pane is a nested
  `<Theme>` scope (`pane-box.tsx:75`), so an em base would compound the scale.
  `lineHeightBase` stays unitless.
- Not scaled: weights, `html` (spacing untouched), `measureReading`.
- Raw-var consumers move to `typeVar("line-height-body")`:
  `page/plugins/{sub-page,page-link,place}/core/*-block.ts`.
- twmerge: add `/* twmerge: extend … */` markers on the new utilities; the build
  regenerates `custom-utilities.generated.ts`.
- Out of scope (documented): plugin-local CSS with px sizes does not follow the scale.

### 4. Enforcement

- **`class-token-walk.ts`**: add `"cva"` to `CLASS_BUILDERS`; skip non-computed
  identifier `Property` keys (cva's `variants`/`size`). Fallout is limited to
  `sidebar.tsx` (migrated) and `button.tsx` (passes).
- **`no-adhoc-typography`**: message lists every Text variant; patterns unchanged.
- **`no-arbitrary-font-size`**: drop the 12px/0.75rem autofix to `text-xs` (itself
  banned); report only.
- **New check** `type-scale:closed-role-ladder`
  (`plugins/ui/plugins/tokens/plugins/type-scale/check/index.ts`), fails when:
  1. type-scale keys ≠ keys derived from `TYPE_ROLES` + the non-role list;
  2. any other token group (`TOKEN_GROUP_VARS`) declares a font-size / font-weight
     / line-height var (would have caught `sidebarLabel*`);
  3. an `app.css` `@utility` setting font-size / line-height / font-weight is not a
     derived role utility, or a role utility lacks `* var(--font-scale)`;
  4. the lint message misses a Text variant;
  5. `var(--font-size-*)` / `var(--line-height-*)` appears in `.ts(x)` outside the
     text and type-scale plugins (use `typeVar`).
- Avatar `SIZE_MAP` (function-result class map the walk couldn't read): done —
  the walk now follows a same-file function's return values and any local's
  initializer; the avatar's glyph is a `cqh` share of its box, not a role.

### 5. Consumer migration

- **Sidebar**
  - `ui-kit/.../ui/sidebar.tsx` cva: drop `text-sm`/`font-sidebar-label` from the base; sizes `default` → `text-label`, `sm` → `text-caption`, `lg` → `text-body`.
  - `conversation-item.tsx`: `ConvTitle` gains `variant?: "caption" | "label"`; the line layout passes `label` (drops `font-medium`); `ConvRelativeTime` `text-3xs` → `text-2xs`.
  - `data-view/.../grouped-sections.tsx` quiet header → `text-label font-semibold`.
- **Main pane**
  - `header-chip.tsx` drops its type classes (Badge md = tag).
  - `tool-call-card.tsx` → `text-tag font-tag-strong`.
  - `inline-code.tsx` → `text-code`.
  - `commits-chip.tsx` → `text-control-compact tabular-nums`.
  - `build-info.tsx` and `release-artifact.tsx` → `text-code`, which removes their eslint-disables.
- **Primitives**
  - `badge.tsx` → `text-tag(-compact) font-tag`.
  - `text.tsx` variant and compact maps: add `tag`; `count` becomes a treatment.
- **Ordering note:** the leftover single-weight `font-sidebar-label` would beat a role's weight under Tailwind v4's property-count sort. That is why it is deleted, not kept.

### 6. Themes

- **Mist** (`agent-manager/shell/web/internal/theme.ts`):
  - Remove the sidebar label keys and every deprecated type key.
  - Revert the stopgap `fontSizeCaption` and `font-size-3xs`.
  - Set:
  ```ts
  fontSizeBase: "0.8125rem", lineHeightBase: "1.4", measureReading: "47.3125rem",
  fontSizeBody: "0.84375rem", lineHeightBody: "1.1875rem",
  lineHeightLabel: "1.1375rem",
  fontSizeControl: "0.75rem", fontWeightControl: "600", fontWeightControlStrong: "700",
  fontSizeTag: "0.71875rem", lineHeightTag: "0.9375rem", fontWeightTag: "600", fontWeightTagStrong: "700",
  fontSizeTagCompact: "0.65625rem", lineHeightTagCompact: "0.9375rem",
  fontSizeCode: "0.78125rem", lineHeightCode: "1.1875rem",
  ```
- **chrome-theme and website:** no key changes; check them and update comments only.

### 7. Docs

- `text/CLAUDE.md`: the variant table, roles and rungs, `fontScale`, enforcement (cva is walked, the check).
- `.claude/skills/theme/SKILL.md`: the closed ladder, and the rule that a theme sets roles, never component tokens.
- `type-scale/CLAUDE.md`, `sidebar-metrics/CLAUDE.md`, `badge/CLAUDE.md`, `ui-kit/CLAUDE.md`.
- A "Superseded 2026-09-27" note on the two Mist research docs, pointing here.

## Every visible default-theme change

- **Sidebar nav rows, every app:** 12px/16px/400 → 13px/20px/500. The fixed 32px row height stays; the `lg` size's line height goes from 20px to 24px.
- **Sidebar conversation titles** (queue and history lists): 12px → 13px, line height 16px → 20px.
- **Quiet group headers:** 12px → 13px, semibold.
- **Conversation times, everywhere:** 10px → 11px.
- **Tool-call badge:** 11px → 12px.
- **Toolbar and diff counts:** weight 400 → 500.
- **Inline code, build-info hash, release-artifact path:** line height 16px → 20px, same size.
- **Possible only:** text with no role inside a `<Theme>` scope that sits in a container whose text isn't 16px, because the base changes from `1em` to `1rem`. The computed-style diff in the verification settles this.

Badges, header chips, buttons, captions and the chrome stay pixel-identical.

## Work packages (parallel implementation agents)

Deprecated tokens and utilities stay alive until WP5, so the build is green after every package.

- **WP1 — Foundation (first, alone):**
  - `text/core/roles.ts` and its barrel.
  - `type-scale/core/group.ts`: `fontScale`, tag tokens, code tokens, base default → rem.
  - `app.css`: scaled utilities, tag utilities, `text-code` on the code tokens.
  - `text.tsx`, `badge.tsx`, plus their tests.
- **WP2 — Sidebar** (after WP1): `sidebar.tsx`, `sidebar-nav-item.tsx` (comment), `conversation-item.tsx`, `grouped-sections.tsx`, `sidebar-metrics.ts` e2e.
- **WP3 — Main pane and other consumers** (after WP1): `header-chip`, `tool-call-card`, `inline-code`, `commits-chip`, the count sites, `build-info`, `release-artifact`, the three page block files.
- **WP4 — Themes** (after WP1): the Mist fragment; review the chrome and website themes; the supersede notes on the research docs.
- **WP5 — Removal and enforcement** (after WP2–WP4):
  - Delete the deprecated keys and utilities.
  - `class-token-walk` cva support, both lint rules and their tests.
  - The new check and its negative tests.
  - The docs.

WP2, WP3 and WP4 touch disjoint files.

## Verification

1. `./equin build` succeeds; generated files regenerated.
2. `./equin check`: the new check, `app-css-utilities-in-sync`,
   `token-group-vars-in-sync`, `class-token-walk-single-source`, eslint. Negative
   test: a temporary `fontSizeFoo` key or `@utility text-foo { font-size… }` fails.
3. `./equin test` on text, badge, ui-kit control-size, the two lint rules
   (a cva case), and the new roles and line-height-length tests.
4. `./equin run plugins/apps/plugins/agent-manager/plugins/shell/e2e/sidebar-metrics.ts`. Expect:
   - nav rows and conversation titles: 13px / 500 / 18.2px
   - times: 11px
   - quiet headers: 13px / 600
   - compact chips: 10.5px / 600
5. Computed-style diff of this branch against `main`, for Mist (`/agents`: the sidebar and a conversation) and for the default theme (another app's sidebar and a transcript). Every difference must be on the list above.
6. `compare-diff.ts --name proto-1789643584-ldt6 --options mist-text=roles,mist-groups=quiet`. The only remaining differences should be the two known deviations.
7. Set `fontScale: 1.1` in the customizer. Expect:
   - roles, sub-scale and inherited text all ×1.1, with no compounding in panes
   - page block bullets stay aligned
   - the chrome is unaffected

## Addendum 2026-09-27 — the `group` role

At the user's request, the quiet group header ("Queue 14") no longer borrows
`label` (the plan's "quiet headers: 13px / 600"): role values must match what the
app renders in the mock exactly, and the mock's group head is 12.5px, not the
rows' 13px. It moved to a new role, `group` (semibold, frozen; compact rung =
caption metrics), used by data-view's quiet `SectionHeaderRow`.

- Defaults: `fontSizeGroup` 0.75rem / `lineHeightGroup` 1rem — the caption
  12px/16px + semibold other apps' quiet group headers rendered before this plan,
  so they return to it.
- Mist: 0.78125rem (12.5px, proto-1789643584-ldt6's quiet group head) on
  1.09375rem (12.5 × 1.4 = 17.5px, the mock's inherited line).
- Verification step 4 now expects quiet headers at 12.5px / 600.
