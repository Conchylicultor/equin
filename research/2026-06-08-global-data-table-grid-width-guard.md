# Data-table `width` grid-track integrity: fix invalid columns + add structural guard

## Context

The data-table primitive's `ColumnDef.width` is fed **directly** into CSS
`grid-template-columns` as a single grid track size:

```ts
// plugins/primitives/plugins/data-table/web/internal/data-table.tsx:39
const template = columns.map((col) => col.width ?? "auto").join(" ");
```

Several Forge catalog facet tables passed a **Tailwind flex/utility class**
(e.g. `"flex-1 min-w-0"`, `"w-12 shrink-0"`) as `width`. A class name is not a
valid CSS grid track, so the entire `grid-template-columns` value becomes
invalid and the grid silently collapses — every column stacks vertically
instead of laying out as a horizontal table.

The `width` contract accepts any `string`, so a class string is silently
accepted with no error at author-time or runtime. This plan (a) fixes every
invalid `width` in the repo and (b) adds a structural guard so a
flex/utility class can never again be accepted as a grid track.

## Scope of the bug (full-repo audit)

Audited every `ColumnDef.width` across the repo. **7 invalid values in 5 files**
— all Forge catalog facet tables. Every other `width` in the repo is already a
valid grid track (`"12rem"`, `"minmax(0,1fr)"`, `"auto"`, `"9rem"`, etc.). The
`structure` facet table was already corrected and is the reference for the fix.

| File | Line | id | Current (invalid) | Fix |
|---|---|---|---|---|
| `plugins/plugin-meta/plugins/facets/plugins/resources/plugins/render-catalog/web/resources-facet-table.tsx` | 22 | `key` | `"flex-1 min-w-0"` | `"minmax(0,1fr)"` |
| `plugins/plugin-meta/plugins/facets/plugins/db-schema/plugins/render-catalog/web/db-schema-facet-table.tsx` | 22 | `name` | `"flex-1 min-w-0"` | `"minmax(0,1fr)"` |
| `plugins/plugin-meta/plugins/facets/plugins/commands/plugins/render-catalog/web/commands-facet-table.tsx` | 21 | `name` | `"flex-1 min-w-0"` | `"minmax(0,1fr)"` |
| `plugins/plugin-meta/plugins/facets/plugins/cross-refs/plugins/render-catalog/web/cross-refs-facet-table.tsx` | 21 | `used` | `"flex-1 min-w-0"` | `"minmax(0,1fr)"` |
| `plugins/plugin-meta/plugins/facets/plugins/registrations/plugins/render-catalog/web/registrations-facet-table.tsx` | 27 | `name` | `"flex-1 min-w-0"` | `"minmax(0,1fr)"` |
| `plugins/plugin-meta/plugins/facets/plugins/routes/plugins/render-catalog/web/routes-facet-table.tsx` | 48 | `method` | `"w-12 shrink-0"` | `"3rem"` (w-12 = 3rem) |
| `plugins/plugin-meta/plugins/facets/plugins/routes/plugins/render-catalog/web/routes-facet-table.tsx` | 64 | `path` | `"flex-1 min-w-0"` | `"minmax(0,1fr)"` |

`"flex-1 min-w-0"` → `"minmax(0,1fr)"` mirrors the already-fixed `structure`
table (`folders`/`looseFiles` use `"minmax(0,1fr)"`). `"w-12 shrink-0"` →
`"3rem"` preserves the original 48px intent (Tailwind `w-12` = 3rem) — mirror
the prior numeric value rather than redesign the column width.

## The structural guard: a type-aware lint rule owned by the data-table plugin

The guard belongs to the plugin that **owns the `width` contract** — the
data-table primitive. Anywhere else would be a consumer naming the primitive's
contract (a boundary leak). It is added as a new, purely-additive `lint/`
subfolder; **no change to the data-table runtime/barrel**.

### Why a lint rule (not a `./equin check`)

- The root `eslint.config.ts` runs **type-aware** linting (`projectService:
  true`), so a rule can use `ESLintUtils.getParserServices` to scope precisely
  to `ColumnDef` objects via their contextual type — zero false positives on
  unrelated `width` props (`<svg width>`, `style={{ width }}`, etc.).
- Plugin lint rules are auto-discovered and registered as `error` repo-wide
  (`eslint.config.ts` walks every `plugins/*/lint/index.ts`); no registry edit.
- It runs inside the existing `eslint` built-in check (so `./equin check`
  and `push` enforce it) **and** gives in-IDE feedback at author time.
- A `./equin check` would have to re-parse TS itself and could not as
  cleanly use contextual types — strictly worse.

### Rule design — `data-table/no-class-as-grid-width`

New files (additive only):

```
plugins/primitives/plugins/data-table/lint/index.ts          # barrel: { name, rules, ignores }
plugins/primitives/plugins/data-table/lint/no-class-as-grid-width.ts
plugins/primitives/plugins/data-table/lint/grid-track.ts      # isGridTrackSize(value) validator
```

**`index.ts`** (mirror `plugins/primitives/plugins/control-size/lint/index.ts`):

```ts
import noClassAsGridWidth from "./no-class-as-grid-width";
export default {
  name: "data-table",
  rules: { "no-class-as-grid-width": noClassAsGridWidth },
  ignores: { "no-class-as-grid-width": [] },
};
```

**`no-class-as-grid-width.ts`** — `ESLintUtils.RuleCreator`, visiting
`Property` nodes:

1. Gate: key name is `width`, value is a string `Literal` (skip dynamic/template
   values — can't validate statically).
2. Scope to `ColumnDef` via type info: get the parent `ObjectExpression`'s TS
   node (`services.esTreeNodeToTSNodeMap.get`), `checker.getContextualType(...)`,
   and require the resolved type's symbol name to be `"ColumnDef"`. If the type
   can't be resolved as `ColumnDef`, **do not report** (no false positives — all
   known facet tables are explicitly typed `ColumnDef<T>[]`, so they resolve).
3. If `!isGridTrackSize(value)` → `context.report({ node, messageId: "classAsWidth" })`.

Message (actionable): *"`width` is a CSS grid track size fed straight into
`grid-template-columns`, not a className. `"<value>"` is not a valid track — use
e.g. `"minmax(0,1fr)"`, `"12rem"`, or `"auto"`."*

**`grid-track.ts`** — single source of truth, positive allowlist (reject
anything not recognised, so unknown junk fails loudly):

```ts
// A single CSS grid track size. Accept the forms the data-table actually uses;
// reject Tailwind classes and other non-track strings.
export function isGridTrackSize(raw: string): boolean {
  const v = raw.trim();
  if (v === "") return false;
  // keywords
  if (["auto", "min-content", "max-content", "0"].includes(v)) return true;
  // <length-percentage> | <flex>  e.g. 12rem, 200px, 3.5rem, 50%, 1fr, 1.2fr
  if (/^[0-9]*\.?[0-9]+(fr|px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)$/i.test(v))
    return true;
  // function tracks: minmax(...), fit-content(...), calc/clamp/min/max(...)
  if (/^(minmax|fit-content|calc|clamp|min|max)\(.*\)$/.test(v)) return true;
  return false;
}
```

Validated against all repo values: every valid width listed in the audit passes;
all 7 invalid Tailwind strings fail (`flex-1 min-w-0`, `w-12 shrink-0`,
`min-w-0`, `flex-1`, `w-12`). The function regex matches the whole trimmed string
so internal spaces inside `minmax(120px, 200px)` are fine.

### Note on load-bearing boundary

The data-table is a load-bearing primitive. This change **only adds a sibling
`lint/` folder** and edits 5 facet-table consumer files — it does **not** modify
the data-table runtime, barrel, or `ColumnDef` type. Surfacing here per the
"modifying load-bearing infra needs approval" rule; approving this plan is the
sign-off.

## Files to modify

- **Fix (5 files):** the 5 facet-table files in the table above.
- **Guard (3 new files):** the `lint/` subtree under
  `plugins/primitives/plugins/data-table/`.

## Implementation steps

1. Apply the 7 width fixes in the 5 facet-table files.
2. Add the `lint/` subtree (`grid-track.ts`, `no-class-as-grid-width.ts`,
   `index.ts`) to the data-table plugin.
3. `./equin build` — regenerates `lint.generated.ts` so the new
   `lint/index.ts` is discovered, rebuilds, redeploys.

## Verification

- **Guard rejects bad values:** temporarily set one column's `width` back to
  `"flex-1 min-w-0"`, run `./equin check eslint` → expect a
  `data-table/no-class-as-grid-width` error pointing at that line. Revert.
- **Guard passes on valid values:** `./equin check eslint` is green with
  the fixes in place (no false positives across the ~30 other valid widths).
- **Visual:** after `./equin build`, open
  `http://att-1780919588-vv8o.localhost:9000` → Forge → Catalog, and check the
  **Commands, Routes, Tables (db-schema), Registrations, Resources, Cross-refs**
  facet tabs render as horizontal tables (columns side-by-side, header row
  aligned), not stacked. Use `e2e/screenshot.mjs` to capture a couple of tabs
  for a before/after.
- **Full check:** `./equin check` is green.
```
