# Single-source the data-view filter predicate signature

## Context

In the data-view filter system, `FilterContribution.predicate(filterValue, fieldValue)`
is a shared contract implemented separately by every field-type filter plugin
(bool, date, enum, number, text, tags). Each implementation **re-states** its
`fieldValue` parameter type instead of deriving it from the contract.

When the set of values a predicate can receive widened — it recently had to grow
from `FieldValue` to include `readonly string[]` so a multi-value "tags" field
could pass its array through — TypeScript **parameter contravariance** rejected
every existing `(fv: FieldValue) => boolean` against the widened interface
`(fv: FilterFieldValue) => boolean`. One conceptual change to "what a filter
predicate can receive" forced edits to 5 unrelated predicate files.

A `FilterFieldValue` alias was introduced as a stopgap and all predicates now
point at it, but nothing makes implementors *derive* the parameter type rather
than restate a concrete one — so the trap can silently return on the next
widening.

**Outcome:** own the predicate signature in exactly one place so widening it is a
one-line, zero-implementor-edit change, and a narrower restatement becomes a
compile error.

## The mechanism (why this happens)

`FieldValue ⊂ FilterFieldValue`. Under `strictFunctionTypes`, a function with a
**narrower** parameter is not assignable where a **wider** parameter is required:

```ts
// ERROR: '(fv: FieldValue) => boolean' is not assignable to '(fv: FilterFieldValue) => boolean'
const p: (fv: FilterFieldValue) => boolean = (fv: FieldValue) => true;
```

So every predicate that hand-writes its `fieldValue` type re-couples itself to the
contract; widening the contract breaks all of them at once. The slot registration
site (`DataViewSlots.Filter({ predicate })`) *already* enforces non-narrowing —
that enforcement is exactly what surfaced the 5-file break. The remaining
fragility is purely the **restatement**: the type is duplicated at each call site
instead of being owned and inferred.

## Fix: own the signature once, infer it everywhere

Extract the whole predicate signature into a named alias at the seam, reference it
from the interface, and let implementors obtain the parameter type by **contextual
typing** (converting `export function` → `export const ...: FilterPredicate`)
instead of writing it.

### 1. Define + use the alias (the seam)

`plugins/primitives/plugins/data-view/core/internal/types.ts`

```ts
export type FieldValue = string | number | boolean | Date | null | undefined;
export type FilterFieldValue = FieldValue | readonly string[];

/** The pure filter predicate applied in the data-view row pipeline. Owns the
 *  parameter types so implementors derive (never restate) them — widening
 *  `FilterFieldValue` flows to every implementor with zero edits. */
export type FilterPredicate = (
  filterValue: unknown,
  fieldValue: FilterFieldValue,
) => boolean;

export interface FilterContribution {
  match: string;
  Control: ComponentType<FilterControlProps>;
  predicate: FilterPredicate; // ← was an inline function type
  isActive: (filterValue: unknown) => boolean;
}
```

Re-export `FilterPredicate` from the core + web barrels alongside the existing
`FilterFieldValue` export (`plugins/primitives/plugins/data-view/core/index.ts`
and `.../web/index.ts` — wherever `FilterFieldValue` is already surfaced) so
implementors can import it.

### 2. Convert each predicate to a contextually-typed const

For each of the 6 files, change the `export function predicate(...)` declaration
to a `const` annotated with `FilterPredicate`, and **drop the per-file
`fieldValue: FilterFieldValue` annotation** (now inferred). Replace the
`FilterFieldValue` import with `FilterPredicate` where it was only used for the
predicate param.

```ts
// before — fields/text/plugins/filter/web/internal/text-filter-logic.ts
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/web";
export function predicate(filterValue: unknown, fieldValue: FilterFieldValue): boolean {
  const { contains } = asValue(filterValue);
  if (!contains) return true;
  return String(fieldValue ?? "").toLowerCase().includes(contains.toLowerCase());
}

// after
import type { FilterPredicate } from "@plugins/primitives/plugins/data-view/web";
export const predicate: FilterPredicate = (filterValue, fieldValue) => {
  const { contains } = asValue(filterValue);
  if (!contains) return true;
  return String(fieldValue ?? "").toLowerCase().includes(contains.toLowerCase());
};
```

Files to convert (each identical in shape):

- `plugins/fields/plugins/text/plugins/filter/web/internal/text-filter-logic.ts`
- `plugins/fields/plugins/bool/plugins/filter/web/internal/bool-filter-logic.ts`
- `plugins/fields/plugins/enum/plugins/filter/web/internal/enum-filter-logic.ts`
- `plugins/fields/plugins/number/plugins/filter/web/internal/number-filter-logic.ts`
- `plugins/fields/plugins/tags/plugins/filter/web/internal/tags-filter-logic.ts`
- `plugins/fields/plugins/date/plugins/filter/web/internal/date-filter-logic.ts`
  - The `date` file also has a private `toMs(value: FilterFieldValue)` helper.
    Keep that import; the helper legitimately *references* the shared seam type
    (it is internal narrowing logic, not a restatement of the contract). It can
    stay as-is, importing `FilterFieldValue` for `toMs`'s parameter only.

No other call sites change: `export const predicate` imports identically to
`export function predicate`, and the registration sites
(`DataViewSlots.Filter({ … predicate … })`) are unaffected. No tests reference
these predicates (confirmed — no `*.test.*` under the filter plugins).

## Why no lint rule

The change makes the failure mode **structurally impossible** rather than merely
discouraged:

- **Widening = zero edits.** Change `FilterFieldValue` once → all implementors
  infer the wider type automatically (their bodies already narrow via `typeof` /
  `Array.isArray`).
- **Narrowing = compile error.** Annotating `fieldValue: FieldValue` under a
  `: FilterPredicate` const is rejected by contravariance, the same way the slot
  call site already rejects it.

A custom ESLint rule checking type-annotation AST nodes would be the repo's first
of its kind (none exist today) and would only re-assert what the type system
already guarantees. Per the project's "remove the footgun at the source" rule,
the type-level fix is the correct structural answer.

## Files to modify

| File | Change |
| --- | --- |
| `plugins/primitives/plugins/data-view/core/internal/types.ts` | Add `FilterPredicate` alias; `FilterContribution.predicate: FilterPredicate` |
| `plugins/primitives/plugins/data-view/core/index.ts` | Re-export `FilterPredicate` (next to `FilterFieldValue`) |
| `plugins/primitives/plugins/data-view/web/index.ts` | Re-export `FilterPredicate` (next to `FilterFieldValue`) |
| `plugins/fields/plugins/{text,bool,enum,number,tags}/plugins/filter/web/internal/*-filter-logic.ts` | `function predicate` → `const predicate: FilterPredicate`; drop restated param |
| `plugins/fields/plugins/date/plugins/filter/web/internal/date-filter-logic.ts` | Same; keep `FilterFieldValue` import for the private `toMs` helper |

## Verification

1. `./equin build` — must compile clean (the `type-check` check covers
   tsc + type-aware ESLint across all targets).
2. **Negative check (manual, throwaway):** temporarily annotate one predicate
   `fieldValue: FieldValue` and confirm `tsc` errors at the `const` — proves the
   trap can no longer silently return. Revert.
3. **Widening check (manual, throwaway):** add a dummy branch to
   `FilterFieldValue` (e.g. `| readonly number[]`) and confirm **no** predicate
   file errors — proves widening is now zero-edit. Revert.
4. Smoke-test filters in the app at `http://<worktree>.localhost:9000`: open a
   data-view surface (e.g. the tweakcn community browser or tasks list), apply a
   text/enum/tags filter, confirm rows filter correctly (predicates still run).
