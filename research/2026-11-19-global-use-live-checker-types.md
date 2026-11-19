# What `useLive` costs the checker per call, and why

2026-11-19. Follows `2026-11-18-global-type-check-batch-working-set.md` §2: "the first
`useLive(taskWindow, …)` call adds +21k types / +83k instantiations, each new `where`
shape ~18k types".

## Result

- **Where the types came from.** Not the overload set and not the result types: the
  `where` object literal's CONTEXTUAL type. tsc gets an object literal member's
  contextual type from the parameter type left GENERIC (only a signature's contextual
  type is instantiated with the inference mapper), so `where: { status: { in: … } }`
  is typed against `LiveWhere<F>` with `F` a type parameter. Two things then multiply:
  1. **Two spellings of the same `where`, intersected.** The query parameter is
     `forms & … & KnownKeysOnly<…>`. The forms' `where` was `LiveQueryWhere<F, Cols>`;
     `KnownKeysOnly`'s slot was `LiveWhereOf<D, Cols> | ScopeSkip<D>` — the same type
     once instantiated, a DIFFERENT type while generic. The `where` property of the
     intersection is their intersection: a cross product of the two clause unions
     (every op of every column against every other) — ~7.3k intersection types for
     one call.
  2. **`OpsFor<D>` over a generic domain.** `{ [K in FilterOpId]: D extends … ? K :
     never }[FilterOpId]` resolves, for a generic `D` (`DomainOf<F["status"]>`), to a
     union of 17 deferred conditionals. `ExactlyOne<ColumnOps<Col>>` maps over those
     keys and builds `Exclude<keyof T, K>` per key: 17 × 17 conditionals plus their
     intersections, per column NAME the literal uses (~5.8k `Exclude`, ~4.6k
     intersections for one call).
- **Fixed** (for every concrete collection the typing is exactly as strict — the
  `live:read-misuse-diagnostics` check, 113 markers, the live type tests and an
  independent review's ~130-call probe give the same diagnostics and the same
  emitted result types; one difference, inside a GENERIC caller
  `useG<F>(c: LiveCollection<Row, F, S>)`: `useLive(c, { where: or() })` was a
  spurious TS2322 and now compiles, as it always did on a concrete collection, and
  some generic misuses report one code instead of two — no repo caller is generic
  this way):
  1. One alias, `QueryWhere<D, Row, F, B, Cols>` (`web/internal/use-live.ts`), is the
     forms' `where` AND `KnownKeysOnly`'s slot, so the intersection is `X & X = X`.
  2. `OpsFor<D>` is a lookup in a table computed once over the concrete domains
     (`OpsByDomain[D]`, `filter/core/internal/ops.ts`): over a generic `D` it stays ONE
     deferred indexed access.

## Measurements (tsc 6.0.3, this Mac)

Probe programs: one file importing `useLive` + `taskWindow` (A), plus one
`useLive(taskWindow, { where: { status: { in } }, orderBy, limit })` (B), plus a second
call with another `where` column (C). Deltas are what the call adds:

| | before | fix 1 only | both |
| --- | --- | --- | --- |
| first call (B − A) types | +18.8k | +15.2k | **+1.7k** |
| first call instantiations | +72k | +65k | **+12k** |
| second where shape (C − B) types | +5.1k | +3.2k | **+0.19k** |

`supervisor-roles/pane/web/internal/reads.ts` alone (2,005 files): types 540k → 444k,
instantiations 2.64M → 2.06M, check 16.6 s → 11.7 s.

A batch-like program (the 55 `useLive` readers under `tasks/` and
`apps/agent-manager`, 4,102 files), live heap after a full GC (`node --expose-gc`,
the TS API):

| | before | after |
| --- | --- | --- |
| types | 910,842 | 790,883 (−13 %) |
| instantiations | 4.53M | 3.52M (−22 %) |
| checker live (checked − bound) | 1,296 MB | 1,248 MB (−4 %) |
| check time (noisy, loaded host) | 31.5–35.4 s | 24.5–25.6 s (two outliers at 67–71 s) |

**The memory gain is much smaller than the type-count gain**: the types removed are
small generic intersections and conditionals; the checker's live memory is dominated
by other structures (the relation caches and the large concrete types every batch
builds). A full cold batched run was not repeated (the host is under memory pressure);
expect the batch peak to move by a few percent, and the check's CPU more.

## How it was measured

`tsc -p <one-file tsconfig> --generateTrace` for the probes with and without the call;
the two `types.json` agree up to the call's first type, and everything after it is
the call's — grouped by alias / symbol, and intersections by their members' names.
The trace's `checkExpression` events put ~170 of the call's 195 ms in the `where`
literal, which is what pointed at contextual typing.
