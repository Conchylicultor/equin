# Dead spacing classes become a lint error

## Context

The spacing ramp declares `@utility` classes only for gap and padding
(`gap|gap-x|gap-y|p|px|py|pt|pr|pb|pl` × `none…2xl`, from app.css
`/* @ramp families: … */`). It declares **no margin or `space-*` classes**, and
app.css defines no `--spacing-*` theme keys, so Tailwind has no word values for
those families either. A class such as `mb-xs` therefore compiles to nothing.

`spacing/no-adhoc-spacing` only bans *numeric/arbitrary* values. Its doc says
"named `*-<step>` utilities are allowed", and its own test file lists `mx-2xl`
and `gap-sm p-md mt-lg` as **valid**. So the rule accepts dead classes. Today
10 production sites use one:

| Site | Class |
| --- | --- |
| `primitives/css/ui-kit/web/components/overlay-panel.tsx:182` | `mb-xs` |
| `primitives/css/ui-kit/web/components/ui/select.tsx:246` | `[&>svg]:mr-sm` |
| `primitives/css/ui-kit/web/components/ui/dropdown-menu.tsx:297,339` | `[&>svg]:mr-xs` |
| `debug/slow-ops/cluster/web/components/cluster-view.tsx:256` | `ml-xs` |
| `primitives/data-view/capsule-toolbar/web/internal/capsule-toolbar.tsx:69` | `mx-xs` |
| `conversations/…/ask-user-question/web/components/option-row.tsx:38` | `mt-2xs` |
| `apps/sonata/transpose/web/components/transpose-control.tsx:135` | `ml-2xs` |
| `page/embed/web/components/embed-block.tsx:111` | `mb-xs` |
| `apps/studio/graph/web/components/graph-view.tsx:113` | `mt-2xs` |

**Decision (user):** margins stay absent, as the spacing doc already says.
The lint rejects them, and the 10 sites are restructured.

**Goal:** any spacing-family class that does not exist (no `@utility` declares
it and Tailwind has no such value) is a lint error that says so. That covers
`mb-xs`, and also a typo or a missing role class such as `p-mdd` or `gap-card`.

## Design

### 1. The set of spacing classes that exist is generated (space-ramp core)

`space-ramp-gen.ts` (`plugins/framework/plugins/tooling/plugins/codegen/core/`)
already reads app.css through `collectUtilityDecls` / `appCssPath`
(`codegen/core/app-css-utilities.ts`) and writes
`primitives/css/space-ramp/core/ramp.generated.ts`. Extend it to also emit:

- `SPACING_FAMILIES`: Tailwind's spacing family prefixes, owned by the
  generator: `gap gap-x gap-y p px py pt pr pb pl ps pe m mx my mt mr mb ml ms
  me space-x space-y`. The generator cannot import a primitives plugin, because
  a framework→primitives edge is illegal, so the list lives in the generator and
  is emitted as data.
- `SPACING_UTILITIES`: every real `@utility` name in app.css that parses into one
  of those families. That is the 14 ramp families × 8 steps plus role classes
  such as `p-chip`, `p-card`, `gap-sidebar-icon`, `px-control-sm` and
  `px-split-arrow`.

Both are re-exported from `space-ramp/core/index.ts`. `space-ramp-in-sync`
already fails on drift, so the set cannot go stale. Adding an `@utility` and
running `./equin build` updates it.

`parseSpacingClass(cls) → { family, value } | null` goes in
`space-ramp/core/internal/ramp.ts`. It takes the longest family prefix followed
by `-`, so `gap-x-sm` parses as `gap-x`, and `max-w-…` or `pointer-…` do not
parse at all. The rule and any future consumer share it.

### 2. `no-adhoc-spacing` checks that a class exists, not just that it is a word

In `plugins/primitives/plugins/css/plugins/spacing/lint/no-adhoc-spacing.ts`,
replace the four regexes with one parse:

1. `c = baseClass(token)` (already strips variants such as `[&>svg]:`, `hover:`
   and the leading `-`). Parse it, and skip the token if no family matches.
2. A numeric or arbitrary value raises the existing `adhocSpacing` error,
   unchanged.
3. A Tailwind built-in keyword passes: `auto` (margin families only), `px`, and
   `reverse` (`space-*` only).
4. A class in `SPACING_UTILITIES` passes.
5. Anything else raises the new **`deadSpacing`** error:
   "`{{token}}` does not exist. No `@utility` in app.css declares it and Tailwind
   has no `{{value}}` value for `{{family}}`, so it compiles to nothing." For a
   margin or `space-*` family, add: "There are deliberately no named margins.
   Use `<Stack gap>` / `<Inset pad>`, or a `gap-<step>` on the parent." For
   other families, add: "Declare a role `@utility` in app.css, or use a ramp
   step."

The lint row may import `core`, so importing `@plugins/primitives/plugins/css/plugins/space-ramp/core`
from `spacing/lint/` is allowed. The generated `.ts` is part of the TS program,
so the type-check's lint pass sees the change when app.css changes. No runtime
read of app.css is needed.

The burndown list stays empty. The 10 sites are fixed in the same change, not
grandfathered, and an `eslint-disable` on a dead class is not a valid escape
because the class still does nothing.

### 3. Migrate the 10 sites

Each site gets a per-site judgement, by default the spacing the author meant:

- **Sibling offset in a flex row or column** (`ml-xs` in cluster-view, `ml-2xs`
  in transpose, `mx-xs` in capsule-toolbar, `mt-2xs` in graph-view and
  option-row, `mb-xs` in embed-block and overlay-panel): move to a `gap-<step>`
  on the parent `<Stack>`/flex, or wrap in `<Inset>`. Where the parent's gap
  can't change (one odd neighbour), use `<Inset t|l|…>` on the element.
- **`[&>svg]:mr-*` in ui-kit `select.tsx` / `dropdown-menu.tsx` ItemText:** the
  children come from consumers and the span must stay `truncate` (inline), so a
  flex gap would break the ellipsis. Declare one role `@utility` in app.css next
  to the other ui-kit role classes, e.g. `item-text-icon-{xs,sm}` setting
  `& > svg { margin-inline-end: var(--space-…) }`, with its `/* twmerge: … */`
  marker (`custom-utilities-gen` requires one). A role class tied to a ramp
  token is the sanctioned way to express it.

These classes have never emitted CSS, so each fix **adds** spacing the
screenshot has never shown. Verify each one visually (see below).

### 4. Docs

- `spacing/CLAUDE.md` Enforcement section: replace "named `*-<step>` utilities
  are allowed" with "a class must exist: numeric and arbitrary values are
  banned, and a word value must be a declared `@utility` or a Tailwind keyword
  (`auto`, `px`, `reverse`)".
- `space-ramp/CLAUDE.md` API: add `SPACING_FAMILIES`, `SPACING_UTILITIES` and
  `parseSpacingClass`.
- The doc comment in `no-adhoc-spacing.ts`.

## Critical files

- `plugins/framework/plugins/tooling/plugins/codegen/core/space-ramp-gen.ts` (emit the two new tables)
- `plugins/primitives/plugins/css/plugins/space-ramp/core/{index.ts,internal/ramp.ts,ramp.generated.ts}`
- `plugins/primitives/plugins/css/plugins/spacing/lint/no-adhoc-spacing.ts` and `.test.ts`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css` (only the `item-text-icon-*` role utility)
- The 10 sites listed above

## Follow-up (not in scope)

Radius, z-layer and type-scale rules have the same hole: a word value no
`@utility` or theme key declares, such as `rounded-foo`. The same pattern
(a generated declared set plus a membership check) applies. File this as a task
once this one lands, rather than widening this change.

## Verification

1. `./equin test plugins/primitives/plugins/css/plugins/spacing`. Update
   the tests: `mx-2xl`, `mt-lg`, `[&>svg]:mr-xs`, `-mb-sm`, `p-mdd` and
   `gap-card` become invalid (`deadSpacing`). `p-chip`, `gap-sidebar-icon`,
   `px-control-sm`, `ml-auto`, `mx-auto`, `space-x-reverse`, `p-px`, `gap-x-sm`
   and `hover:pt-2xs` stay valid. The existing numeric cases still raise
   `adhocSpacing`.
2. Run `./equin build` in the background, with checks. It must report no
   `no-adhoc-spacing` errors, and `space-ramp-in-sync` and
   `app-css-utilities-in-sync` must be green.
3. Negative probe: add `mb-xs` to a scratch component, confirm `type-check`
   fails with the `deadSpacing` message, then revert it.
4. Screenshot the migrated surfaces, before and after, with
   `e2e-harness/e2e/screenshot.ts`: a select/dropdown menu with icons, the
   data-view capsule toolbar, a page embed block, the studio graph, and the
   slow-ops cluster view. Confirm the spacing now shows and nothing else shifts.

## Revision (implementation): no generated manifest; the toolkit carries the fact

Two problems turned up while implementing §1–2:

- A lint rule file cannot import another plugin's values. Rules load under
  jiti, which does not resolve `@plugins/*`.
- A rule that imports `ramp.generated.ts` freezes it. `build` regenerates that
  manifest after it has loaded the lint rules, so the rule would check against
  the old copy. The first build failed `cli:codegen-manifests-not-frozen` for
  exactly this.

Separately, the type-check lint cache did not count app.css as an input, so
removing a `@utility` that is still in use could stay hidden behind a cached
pass.

What was built instead (framework change approved by the user):

- `framework/tooling/lint/core/declared-utilities.ts`: `readDeclaredUtilities(root)`
  reads the `@utility` names from app.css when `buildLintConfig` runs. The
  `LintToolkit` carries them as `declaredUtilities` (`createLintToolkit`
  replaces the old `lintToolkit` constant; the testing barrel builds the
  toolkit over the real app.css).
- `LINT_DATA_FILES` lists app.css. `type-check/check/fingerprint.ts` treats it
  as a global trigger.
- `space-ramp/core/internal/spacing-classes.ts` holds the family list and
  Tailwind's built-in words as plain data, with no generated import.
  `space-ramp/lint/no-dead-spacing.ts` checks each class against them and
  `declaredUtilities`.
- The generator changes in §1 are reverted.
