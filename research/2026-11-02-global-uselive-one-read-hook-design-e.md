# `useLive` as the one read hook — design E (plain discriminated query) + one kind precedence

Task: `task-1793632232-gktoub`. Supersedes `task-1791751944-3ej507` / `conv-1793060873-5wwh20`
(its plan, carried over below: `research/2026-10-27-global-fold-uselive-row-into-uselive.md`).
Track: Network Layer › Resources, item [9] (delete legacy paths).

## Context

`network/live`'s rule: one read hook, new read capabilities are options `useLive` reads
(`research/2026-10-11-global-endpoint-reads-onto-live.md` P0.1). Two exceptions predate it:

- `useLiveScroll` is **already gone on main** (`1f49945319` replaced it with
  `useLive(c, q, { viewport })`; 0 hits in `plugins/`). Nothing to do but keep it out of the docs.
- `useLiveRow(c, id)` is still on main (128 files). The previous session (worktree
  `att-1793060873-h50hv4`, uncommitted) migrated every call to `useLive(c, { id })`,
  deleted the hook, added the `live:read-hooks` and `live:read-misuse-diagnostics` checks
  and a 100-case misuse suite (`web/__tests__/use-live-query-types.test.ts`: 44 × TS2322,
  43 × TS2345, 10 × TS2353, 3 × TS2769 recorded exceptions; each pinned to its line).

Its review (user agreed) found the type layer **correct but not clean**: the merged collection
signature captures the whole query as `const Q`. An inferred `Q` keeps every key it was given, so
tsc's own excess-property and discriminated-union checks never run, and ~670 lines
(`use-live.ts` L255–925 there: `QueryKind`, `IsSet`, `KeyCheck`, `ExtraKeyCheck`,
`UnsetIdCheck`, `IdReadKeysCheck`, `CountSkipCheck`, `WhereColumnsCheck`, …) rebuild them.
The read kind is decided three times (`QueryKind`, `QueryReadOf`, runtime `readKindOf`) with
different precedence, and they already disagree: an untyped `{ ids, count: true }` reads a count
and silently drops `ids`. There is a confirmed false error (`useLive(counted, { groupBy: undefined, orderBy })`
refused on `orderBy`). A new query form needs ~8 coordinated edits.

**Done =** every read spelled through `useLive`; the rule's exception list is only what cannot be
expressed (`useOptimisticResource`, read+write; `useLiveReader`, the recorded event-read
exception); a wrong option gives a tsc error **on its own property**, not "No overload matches";
the read kind decided once.

## Starting point — carry the previous work over

The old worktree is at `5d347f58ce` (2 commits behind this branch's base `7925b725c7`), its third
rebase finished with one file still flagged unmerged (`status-badge.tsx`, markers already resolved)
and **one new `useLiveRow` call from main** left unmigrated
(`apps/places/plugins/page-overlay/web/internal/use-page-overlay.ts`).

1. `git -C <old> diff --binary HEAD` (staged + unstaged) → patch; the 5 untracked paths
   (`live/check/internal/`, `live/core/internal/read-hooks.ts`, `live/scripts/`,
   `live/web/__tests__/use-live-query-types.test.ts`, the 2026-10-27 plan) copied as files.
   Read-only on the old worktree (the user granted this one bypass; nothing written there).
   Backup of the same state: `/tmp/fold-pre-rebase3/`.
2. Apply here with `git apply --3way`; resolve what the 2 newer main commits (spacing refactor,
   hibernation) touch; migrate the page-overlay call; grep `useLiveRow` → only the
   `no-legacy-resource-spelling` REPLACEMENT entry and its lint test.
3. Gate before the spike: `./equin check type-check plugin-boundaries live:read-hooks live:read-misuse-diagnostics`
   green on the carried-over (old-machinery) state. This is the **baseline** E is measured against,
   and the fallback if E is rejected.

## Runtime — one precedence list, mixed kind keys throw (done regardless of E)

- `live/core`: `export const COLLECTION_KIND_KEYS = ["id", "ids", "count", "groupBy", "select"] as const`
  with `KindKey = (typeof COLLECTION_KIND_KEYS)[number]`. This is the single source; the types
  derive from it (below), never restate it.
- `readKindOf` (`web/internal/use-live.ts`): collect the kind keys **holding a value**
  (`!== undefined`, by value as today: `{ id: undefined, where }` is a window read). More than one →
  throw `useLive("<key>"): a query reads one thing — got id and count …` (generalises
  `assertNoSelect`). Exactly one → its kind; none → `all` / window by the declaration as today.
  `{ ids, count: true }` now throws instead of dropping `ids`.
- Test: a table test in `use-live.test.tsx`, one row per form plus each mixed pair, asserting the
  runtime kind. Paired with a type-level table in the misuse suite, so runtime and types agree by test
  as well as by derivation.

## Design E — the query is a plain discriminated union

Drop `const Q`. Infer only the pieces the result type needs, one type parameter per kind key, each
defaulting to `never` (no inference candidate → the default):

```ts
export function useLive<
  Row, F = never, S extends string = never, B extends string = never, D extends object = object,
  I extends string | null = never,          // { id: I }
  Ids extends readonly string[] = never,    // { ids: Ids }
  C extends true = never,                   // { count: C }
  G extends LiveGroupableColumn<F> = never, // { groupBy: G }  (keeps the literal → LiveGroupValue<Row, G>)
  R = never,                                // { select: (row) => R } on `all`
  NM extends MachineFeature | undefined = undefined,
>(
  collection: D & LiveRowsCollection<Row> & CollectionFacets<Row, F, S, B> & MachineDecl<NM>,
  query: CollectionQuery<D, Row, F, S, B, I, Ids, C, G, R> | undefined,
): WithMachine<NM, ReadOf<D, Row, F, KindParams<I, Ids, C, G, R>>>;
```

- `CollectionQuery` = a plain union of the existing core shapes (`LiveQuery<F,S>`,
  `LiveGroupQuery<F,G>`, `LiveCountQuery<F>`, `LiveIdsQuery`, a new `LiveRowQuery`, `LiveAllSelect`,
  `LiveScopedAllQuery<B>`), each with the other kind keys as `?: never` discriminants (the previous
  session already added `id?`/`ids?: never` to the core shapes). `where` stays literally
  `LiveWhere<F>`, so `or()`'s column typing keeps its contextual type.
- The collection kind (lookup-only / `all` / scoped `all` / window / counted window) picks which
  members are in the union, from `D` only — a conditional on `D`, never on the query.
- `KindParams` walks `COLLECTION_KIND_KEYS` and returns the first kind whose parameter is not
  `never`; `ReadOf` is an interface indexed by that kind (`row → LiveRowResult`,
  `ids → ResourceResult<Row[]>`, `count → ResourceResult<number>`, `groupBy → LiveListResult<LiveGroup<…G>>`,
  `select → R`, none → `all`/window by `D`). One classifier, derived from the runtime list.
- What tsc now does itself: unknown key (TS2353 on the key, also on a hoisted fresh literal), a
  foreign key beside a kind key (`{ id, limit }`: TS2322 on `limit` via the `?: never` discriminant),
  wrong value types, `or()` columns, `groupBy` on a non-groupable column. Kept from the old layer only
  where tsc cannot see it, each as a property type on the form (not a check over `Q`): `id: string | null`
  (rejects `string | undefined`), `count` only on counted `D`.
- Deleted: the whole `QueryChecks` family, `QueryKind` / `QueryReadOf` / `IsSet` / `IsMixedKind` /
  `UndefinedKeysBesideId` / `UnsetIdKeys` and their siblings. Expected −450…−550 lines.

**Known costs of E (from the review, to be measured):**

1. A query whose branches are different reads (`cond ? { id } : { where }`) is no longer a compile
   error — every branch fits some member. The runtime kind latch / mixed-key throw still fires.
   **Spike attempt to keep it a compile error:** infer the given keys into a parameter constrained to
   the known key set (`K extends QueryKeyName`), used only in the return / a rest-arity position so the
   query's own target type stays exact (excess checks intact), and refuse when `K` holds two kind keys
   or a kind key plus a foreign key. Kept only if it adds no false errors and stays a few lines.
2. A non-fresh object (`const q = { id, foo }; useLive(c, q)`) is no longer checked for `foo`
   (tsc never excess-checks a non-fresh object). Count it.
3. Messages become tsc's own wording instead of the hand-written sentences.

## Gate — measured, then replace or STOP

Run the full suite (`live:read-misuse-diagnostics` + the positive cases + the existing
`use-live-types` / `use-live*.test.tsx` type tests) against E. Record, per marker: still an error /
same line / same code; plus `type-check` instantiations and wall time vs the baseline.

- **E replaces the machinery** only if: every misuse that is not one of the named known costs is
  still an error on its own line; no positive case breaks (generic callers `useLivePagesPaging`,
  `live-source.tsx:447`, `GroupsRead`, `FacetRead`, scoped `all` + `select`, the nullable count skip,
  same-kind spread unions); no TS2769 beyond the 3 recorded; instantiations not above baseline.
  Markers whose code or wording changed are re-pinned (the check asserts codes, not messages).
- **Otherwise STOP** (the user asked for this explicitly): leave the spike in the worktree beside the
  carried-over baseline, and report the numbers — cases lost (by class), cases moved to the argument
  line, mixed-kind compile-time coverage, type-check cost, line delta — with the choice
  (E with its trade-off / baseline with the review's incremental cleanup). Known-cost 1 counts as a
  real trade-off unless the spike's key inference closes it.

## Steps

1. Carry over (above); baseline gate green; record baseline type-check numbers.
2. Runtime: `COLLECTION_KIND_KEYS`, `readKindOf` throw, table test.
3. Spike E in `use-live.ts` (old layer kept in git history only — the baseline is the patch);
   iterate on the suite; measure.
4. Gate: replace → delete the old layer, update `live/CLAUDE.md` (Read section, Internals: how to add
   a query form = one core shape + one `COLLECTION_KIND_KEYS` entry + one `ReadOf` row; exception list),
   the 2026-10-27 plan's Result, this doc's *Result*. Or STOP → outcome report with the numbers.
5. `./equin build` in the background; smoke on my build (`browser_*`): a row pane (Debug → Reports
   report), an unknown id → not-found, a grouped chip bar, a scrolled list.
6. Track page: "Open related tasks" line (remove `task-1791751944-3ej507`, which this replaces) and
   [9] (new checked item: one read hook, `useLiveRow` folded into `useLive`, kind decided once).
   The next main task of the track already exists (`task-1793632244-7x1bv4`, [12] session 3), so none
   is filed.

## Verification

- `./equin check` (type-check, eslint, plugins-doc-in-sync, `live:read-hooks`,
  `live:read-misuse-diagnostics`, exempt manifests).
- `./equin test plugins/network/plugins/live plugins/primitives/plugins/live-state plugins/primitives/plugins/data-view plugins/primitives/plugins/optimistic-mutation plugins/framework/plugins/browser-server`
  plus the plugins whose `vi.mock` stubs fake row reads (`page/editor`, `tasks/task-triage`).
  Known pre-existing failures to diff against main, not attribute to this change: data-view
  `live-source.test.tsx` (14), `compile-sql-golden`.
- `rg -n 'useLiveRow|useLiveScroll' plugins docs CLAUDE.md` → only the legacy-spelling lint entry.
- Smoke on the deployed build (step 5).

Not pushed: the user reviews first.

## Spike result (2026-11-02) — STOPPED on a real trade-off

Done and kept regardless:

- **Carried over** the previous session's work (patch applied cleanly with `--3way`); the
  conflicted `status-badge.tsx` and main's new `places/page-overlay` call migrated. Baseline gate
  green (`type-check`, `plugin-boundaries`, `live:read-hooks`, `live:read-misuse-diagnostics` 100/100).
- **Runtime**: `COLLECTION_KIND_KEYS` (`live/core`, `core/internal/query.ts`) is the one precedence
  list; `readKindOf` throws on two kind keys holding values (`{ ids, count: true }` no longer drops
  `ids`). Test: every pair of kind keys throws, naming both (`use-live-all.test.tsx`, 15/15 pass).

Design E, as built (`web/internal/use-live.ts`, in the working tree; baseline kept at
`~/.equin/worktrees/att-1793632232-s8b13r/spike-e/use-live.baseline.ts`):

- No `const Q`. One type parameter per kind key, inferred through `KindKeyValues`
  (`id?: I; ids?: Ids; count?: C; groupBy?: G; select?: R`, "not given" = `undefined`);
  `KindOf` walks `COLLECTION_KIND_KEYS` with a distributive step (a generic caller's
  `groupBy: G` reads as a grouping); the result is `CollectionReads[KindOf<…>]`.
- The query is the plain union of the forms the declaration takes (core shapes `& OnlyKind<k>`),
  intersected with `KindGuard`: the named kind's key is required as `{} | null` — a unit type, so
  every form refusing it reduces to `never` (one form left → tsc elaborates on the property), and
  a union whose branches read different things fails on the branch missing the key.
- Holes inferred, not always present: `N & undefined` / `N & null` (a union with either stops tsc's
  elaboration); a `null` requires a count (`SkipGuard`).
- Lines: `use-live.ts` 1922 (baseline) → **1477** (−445; main is 1205). Adding a form: a core
  shape in `CollectionForms`, a `COLLECTION_KIND_KEYS` entry, a `KindKeyValues` key + signature
  parameter, a `CollectionReads` row.

Measured against the 100-marker suite (`live:read-misuse-diagnostics`'s own compare):

| Outcome | Markers |
|---|---|
| Same line, same code | 77 |
| Same line, tsc's own code (2322 ↔ 2353 / 2561 / 2345) | 17 |
| Moved 2 lines down, onto the failing branch of a multi-line ternary (still an error) | 3 |
| No longer an error | 3 |

The 3 lost: `{ ids, limit: undefined }` and `{ id, where: undefined }` (a foreign key spelled
`undefined` — the runtime reads it as absent, nothing is dropped), and a **hoisted** union of two
`where`s with an unknown column in one branch.

- **Known cost 1 — closed.** `cond ? { id } : { where }` (and `{ id } | { ids }`, a list beside a
  count's skip) are compile errors (TS2345, on the argument), via `KindGuard`.
- **Known cost 2 — real, measured.** A query object built before the call is not excess-checked
  by tsc. Probe (outside the suite), baseline vs E: `{ id, foo }`, `{ ids, foo }`,
  `{ where, foo }`, `{ groupBy, foo }`, `{ count, foo }`, `{ where: w }` with `w` naming an
  unknown column, and a hoisted union `where` — **baseline rejects all 7, E accepts all 7** (known
  keys in a hoisted object — `{ id, limit }` — are still refused: forms spell them `?: never`).
  Clean fixes tried: inferring the query's key set (`K`, keys only) catches the 5 top-level cases but
  breaks `or()`'s column typing (10 suite lines: `Filter<Filterable>`), in two spellings; inferring
  `where`'s key set catches the 2 `where` cases but breaks generic callers (4) and moves 3 value
  errors. Reverted both.
- **Baseline false errors E removes**: `useLive(counted, { groupBy: undefined, orderBy })`, a
  hoisted same-kind union `const q = cond ? { id } : { id: null }`.
- **Cost**: instantiations on the consumers (live type tests, data-view `live-source` /
  `use-live-pages-paging`, queue panes, notifications panel, `use-live.ts`) 497,276 → **464,755
  (−6.5%)**; on the suite file 434,147 → 328,015 (−24%). Repo-wide `type-check`: no real call site
  breaks (one did — notifications' generic `groupBy: G` — fixed by the distributive step).
- Dropped: a bare `useLive(counted, null)` literal is no longer a "count" (no call site does it;
  `cond ? { count: true } : null` — the queue pane's — still is).

Not done pending the decision: re-pinning the 20 markers whose code/line changed, the docs
(`live/CLAUDE.md`'s *One collection signature*), `./equin build`, the track page.

### Follow-up: can the pre-built-query check be a type? (2026-11-02)

Mostly yes. The two earlier key-set attempts broke `or()` because the inferred-keys mapped type
gave `where` the contextual type `unknown`. Giving that slot the collection's own `where` fixes it:

```ts
type KnownKeysOnly<K extends PropertyKey, Known, W> = {
  readonly [P in K]?: P extends "where" ? W : P extends Known ? unknown : never;
};
// query: … & KnownKeysOnly<K, QueryKeyName, CollectionWhere<D, Row, F, B>>
```

`K` is the query's own key set (keys only, never values). `CollectionWhere` is picked by `D` alone
(a window's `LiveWhere<F>`, a scope, or none), never distributed over the forms, which deferred for
a generic `F`.

- **Top-level unknown key on a pre-built query** (`const q = { id, foo }`, with `ids` / `where` /
  `groupBy` / `count` likewise): 5/5 are now a **type error** (TS2345 on the argument).
  `or()` keeps its columns, and generic callers pass. In the suite, unknown keys report TS2322 again
  (the old code), so violations to re-pin drop from 43 to 31. Line placement is unchanged.
- **Unknown column inside a pre-built `where`** (`{ where: w }`; a hoisted union of `where`s, the
  suite's 551): still accepted. The same trick one level down (`where`'s key set) catches neither,
  silences 12 `where` checks and breaks generic callers. Reverted. The server's strict filter
  decode refuses an undeclared column at runtime (a loud error, never a silent read).
- **Cost** over all 473 non-test files calling `useLive`: instantiations baseline 2,617,354 →
  E 2,610,402 (−0.3%) → **E + key check 2,849,533 (+8.9%)**, wall 28.6 s → 29.2 s. On the suite
  file alone: 434k → 1.04M (it holds 100 misuse calls).

## As landed (2026-11-02) — for review

Decision (user): design E + the key-set check (+8.9% accepted); a pre-built `where` is declared with
its collection's where type, required by a type-aware lint.

- **Types** (`web/internal/use-live.ts`, 1922 → ~1520 lines): the design above plus
  `KnownKeysOnly<K, QueryKeyName, LiveWhereOf<D>>` — the query's inferred key set, its `where`
  slot typed by the declaration (so `or()` keeps its columns).
- **`LiveWhereOf<typeof c>`** (`live/core`, `core/internal/live-collection.ts`): the `where` a
  collection takes (a window's `LiveWhere<F>`, a scope record, else `never`). The one source:
  `useLive` reads it for the slot above.
- **Lint `live/where-declared`** (`lint/where-declared.ts`, type-aware, `noDebt`): on a
  `useLive` / `useOptimisticResource` call, a `where` whose type is an object literal written
  outside the call (an undeclared `const`, a function's inferred return, a pre-built query) is
  refused with the `LiveWhereOf` spelling. 16 rule-test cases. Fixed in the repo: 4 sites
  (`window-op-gantt.tsx`, page editor `block-store.ts`, `use-reaching-notifications.ts` ×2).
- **Runtime**: `COLLECTION_KIND_KEYS` + `readKindOf` throw on two kind keys (above).
- **Suite** (`use-live-query-types.test.ts`): 105 markers, 0 violations — 11 codes re-pinned
  (tsc's own), 3 moved onto the failing branch, 2 cases turned positive (a key holding `undefined`
  is absent), the hoisted union replaced by 3 declaration cases (`LiveWhereOf` object, union,
  scope → TS2353 / TS2322 at the declaration), 5 hoisted top-level unknown-key cases added.
- **Docs**: `live/CLAUDE.md` *One collection signature* rewritten; pointer in the 2026-10-27 plan.
- **Verified**: repo-wide `type-check` (tsc + every lint) green; tests green — `network/live`,
  `optimistic-mutation`, `notifications`, `browser-server`, `task-triage` (73 bun / 21 vitest
  files), `data-view` + `page/editor/web` (957 bun tests, 628 vitest tests).
