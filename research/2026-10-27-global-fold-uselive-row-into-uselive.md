# Fold `useLiveRow` into `useLive` — one read hook, misuse reported on its property

Task: `useLiveRow` and `useLiveScroll` are separate read hooks beside `useLive`.
This is follow-up `task-1791751944-3ej507` (cited in `network/live/CLAUDE.md:25`).

## Context

`network/live`'s design rule ("grow `useLive`, don't add APIs") lists exceptions
that predate it. Findings (exploration workflow, 2026-10-27, checked against the
worktree and TypeScript 6.0.3's checker source):

- **`useLiveScroll` is already gone.** `1f49945319` (key-range pages) replaced it
  with `useLive(c, q, { viewport })`; it survives only in `research/` history. No
  work beyond dropping it from the task's framing.
- **`useLiveRow(c, id)`** (`plugins/network/plugins/live/web/internal/use-live.ts:1142`)
  is the remaining exception: **113 production calls in 88 files** (all `web/`),
  27 test calls, 5 `vi.mock` stubs, ~77 comment lines and ~45 hand-written
  `CLAUDE.md` files naming it. Its result `LiveRowResult` (loading | error{stale?}
  | ready{found:true,row} | ready{found:false}) is named in ~30 files.
- **Misuse is not precise today either.** `useLive` has 17 overloads. A failing
  collection call has ~12 candidates in tsc's argument bucket; with >3 candidates
  `resolveCall` reports only the LAST — #15, the typed-query value overload — on
  argument 0: "No overload matches this call… `LiveCollectionOf<…>` is not
  assignable to `LiveQueryValue<…>`". Every negative `useLive` test puts its
  `@ts-expect-error` above a single-line call, so none can tell. Adding a row
  overload naively keeps it that way. Prior art of the pain:
  `research/2026-10-09-global-live-structured-paged-values.md:214`,
  `core/internal/compile-value.ts:648`.
- tsc facts the design rests on ([TS-SRC] = read in `typescript.js` 6.0.3, not yet compiled):
  exactly **one** argument-bucket candidate → its own elaborated error on the
  property, no 2769 header; 2–3 → 2769 with each chain; a rest whose
  *instantiated* tuple has the wrong length is re-checked for arity and moved to
  the arity bucket (only for a non-array rest — a conditional qualifies).
  `or()` infers its `F` once, against the first arity-matching candidate's
  contextual `where`, so that candidate must expose `where: LiveWhere<F>` with `F`
  a signature type parameter.

Outcome: every row read is `useLive(c, { id })`; `useLiveRow` is deleted; the
exception list is `useOptimisticResource` (read+write) alone; a wrong option on a
collection read errors **on its own property, with no 2769**, pinned by a check.

## Design

### 1. Spelling and semantics — `useLive(c, { id: string | null })`

- Result `WithMachine<NM, LiveRowResult<CollectionRow<Row>>>`. `LiveRowResult`,
  `mapRow`, pane `resolveRow` / `rowOrStale`, `rowReferent` keep their names and
  shapes, so consumers do not change. Drop its stale "`pending` is the pre-`status`
  spelling" line.
- Takes any `LiveRowsCollection` (window, lookup-only, `all`) via `:rows`, as
  `{ ids }` does. `{ id }` mirrors `{ ids }`; `all.by` can never name the id
  (`live-collection.ts:1132`), so no collision with a scoped `where`.
- Semantics carried over verbatim from `use-live.ts:1149-1204`: a `null` or
  non-point id (`!isPointId`) is `NO_ID` (`ready/found:false`) from the first
  render with `useResource(rows, null)` (nothing read); `stale` from
  `stale?.[0]`; same memoisation. Documented difference kept: `{ ids }` throws on a
  non-point id (code builds a set), `{ id }` answers not-found (an id from a URL,
  token, tool input).
- Machine: the existing `"unavailable"` kind (computed before `readKindOf`,
  `use-live.ts:600`) already answers `LiveUnavailable`; port `useLiveRow`'s memo
  into `useUnavailable` so the result identity is stable.
- Runtime dispatch (`readKindOf`, `use-live.ts:702`): add `row: "row by id"` to
  `READ_KIND` (`:687`); after the value branch (`:711`) and before `all` (`:722`):
  `query.id !== undefined` → `"row"` — **by value, not `"id" in query`** (no
  `exactOptionalPropertyTypes`, so `{ id: undefined, where }` type-checks against
  `id?: never`; same precedent as `groupBy` at `:736`). `null` still counts as
  present. Body of `useLiveRow` becomes private `useRow`. Kind latch unchanged.
- Values with an `id` param (22 declarations, e.g. `useLive(screenshot, { id })`)
  are unaffected: runtime returns on `"live" in source` first; types fail the
  collection signature on argument 0.

### 2. Signatures — one candidate per failing collection call

Base: the risk-first design (smallest restructure that meets the bar).

**Kept as is:** 1-arg `useLive(collection)` and `useLive(all)` (arity keeps them
out of 2-arg diagnostics); both 3-arg viewport overloads (#4 collection, #12 paged
value — `null` source/query skip, required `options`, so `useLive(c, {}, maybe)`
stays an error, `use-live-types.test.ts:84,116`); the count-with-`null` overload
(#3 — `useLivePagesPaging` / `live-source.tsx:447` pass `C | null`).

**Merged:** #1's 2-arg half, #2 group, #6–#8 `all` select/scope, #9 ids, and the
new row form → **one collection signature, first among 2-arg signatures** (the
`or()` anchor):

```ts
export function useLive<
  Row, F = never, S extends string = never, B extends string = never,
  D extends object = object, const Q extends object = {},
  NM extends MachineFeature | undefined = undefined,
>(
  collection: D & LiveRowsCollection<Row> & CollectionFacets<Row, F, S, B> & MachineDecl<NM>,
  query: (Q & CollectionQueries<Row, F, S, B> & QueryChecks<D, NoInfer<Q>, F, S, B, Row>) | undefined,
): WithMachine<NM, CollectionReadOf<D, Q, Row, F>>;
```

- `CollectionFacets` infers `F`/`S`/`B` structurally from argument 0 (as #1/#7 do);
  `D` captures the declaration (the `& V` pattern #10/#11 use).
- `CollectionQueries` is a **plain** union (`LiveQuery<F,S> | LiveGroupQuery<F> |
  LiveCountQuery<F> | LiveIdsQuery | LiveRowQuery | LiveAllSelect | LiveScopedAllQuery<B> | …`)
  whose `where` is literally `LiveWhere<F>` — never inside a conditional on `D`
  (a deferred conditional gives `or()` no contextual property).
- `const Q` captures the literal (replaces #2's `const G`) for the result and checks.
- `QueryChecks` (resolved at applicability, where elaboration hits the property):
  - **unknown key** → that property typed as a branded message type;
  - **kind gate**: lookup-only allows `id`/`ids` only (and rejects `{}`, which
    `readKindOf` would send to `all-pages`); `all` allows `select`/`where`/`id`/`ids`;
    window allows window/group/count/`id`/`ids`; `count` requires `D extends { count }`;
  - **exclusive keys**: with `id`/`ids`/`count`/`groupBy` present, every foreign
    key is `never` (error on `limit` in `{ ids, limit }` — today a union would
    silently match `LiveIdsQuery` and drop it);
  - **row id** `string | null` (rejects `1` and `string | undefined` on `id`);
  - **one read kind per call**: reject a `Q` that is a union of *different* forms
    (`cond ? { id } : { where }` passes a merged union and would throw on the kind
    latch at runtime), while accepting same-kind unions data-view builds from
    conditional spreads (`live-sections.tsx:187`, `facet-options.tsx:144`).
- `CollectionReadOf` tests required value types (`Q extends { id: string | null }`,
  `{ ids: readonly string[] }`, `{ count: true }`, `{ groupBy: infer G }`,
  `{ select: … }`, then `D extends { all }`, else window) and returns today's result
  types. `WithMachine` stays outside it.
- Add `id?: never; ids?: never` to `LiveQuery`, `LiveGroupQuery`, `LiveCountQuery`
  (`core/internal/query.ts:97-168`); keep every existing `?: never` key. Move
  `LiveIdsQuery` (+ new `LiveRowQuery`, `LiveScopedAllQuery`) to `live/core` with
  the matching `?: never` keys; `optimistic-mutation/web/internal/source.ts:17-29`
  imports them and deletes its copies `OptimisticIdsQuery` / `OptimisticScopedQuery`.
- **Route value overloads out of collection calls**: each keeps its argument-0
  type (plus `& V` capture) and turns the rest into
  `...args: V extends <its kind> ? [today's params] : [never, never, never, never]`
  — an impossible arity for a collection, so it lands in the arity bucket. Value
  inference reads argument 0 only and its params are already `NoInfer`. Value
  misuse diagnostics stay as today (out of scope; see Open points).

### 3. Lint, checks, docs, exception list

| Where | Change |
|---|---|
| `live/lint/no-sentinel-param.ts:11,22,26,86-110` (+ test 30,31,51) | Drop `useLiveRow` from `READS` and its arg-1 case; check the `id` property of a `useLive` query; message spells `{ id: cond ? x : null }` (never `cond ? { id } : null` — mixed kind) |
| `live-state/lint/result-binding.ts:15`, `result-constructors.ts:26,52` | Drop entry; `useLive` text gains "one row by id"; `mapRow` reworded |
| `live-state/lint/no-pending-data-collapse.ts:84`, `no-ready-negation.test.ts:113` | Comment / fixture |
| `reactive-server-io/lint/no-reactive-server-io.ts:54` (+ test 67,108,117) | Drop name |
| `live/lint/no-legacy-resource-spelling.ts:17,48,143` (+ test `:45` valid fixture) | `REPLACEMENT.useLiveRow = "useLive(c, { id })"`, listed in `LEGACY_BARRELS` for the live web barrel; `usePointResource` → `useLive(c, { id })`; rewrite the fixture |
| `checks/keyed-resource-scope/check/index.ts:259`, `no-raw-sse/check/index.ts:55` | Hint text |
| `live-collection.ts:1132` | Error message names `useLive(c, { id })` |
| `optimistic-mutation/exempt/index.ts` | Reason: read+write hook, not "substrate" |
| `live/CLAUDE.md` | Rule §9-28: exception list = `useOptimisticResource` only; Read section 610-632 → `useLive(c, { id })`; fix "query param is `NoInfer`" (Internals); every other mention |
| Root `CLAUDE.md:282,287`, `docs/abstractions.md`, ~45 plugin `CLAUDE.md`s (outside AUTOGENERATED), ~77 TS comments, `use-live.ts:365` JSDoc, `web/index.ts:5,59` (export + description) | Reworded; generated docs regenerate on `./equin build` |

**Enforcement (keeps a second read hook from reappearing):**
1. Inexpressible-ish: no row hook exported; `useLiveRow` is a deleted spelling that
   tells its replacement.
2. tsc: one collection signature — a new query form is a `CollectionQueries`
   member, not a function.
3. Check `live:read-hooks` (`plugins/network/plugins/live/check/`): every `use*`
   value export of `network/live/web/index.ts` must be in a data table in
   `live/core` (`useLive` read, `useLiveReader` event read,
   `useFieldPresentations` / `useClientFieldsResolvers` slot registries). Also
   narrow `live/exempt`'s `paths: ["."]` for `no-legacy-resource-spelling` to the
   substrate files that need it.
4. **Diagnostic pin** `live:read-misuse-diagnostics` (`live/check/`): compiles a
   string fixture with `ts.createProgram` under the repo's compiler options and
   asserts, per `// @expect-ts <code>` marker, `{ code, line }` on the property
   line, and that no diagnostic is 2769. `@ts-expect-error` cannot see 2769, which
   is the regression this task forbids. (A generic `@expect-ts` in `type-check` is
   the nicer primitive but touches a load-bearing check — follow-up if wanted.)

## Steps

0. **Prototype gate — before any call site moves.** Scratch fixture in the worktree,
   real diagnostics read via `./equin check type-check` (and the new diagnostic
   check). Must prove:
   1. `or()` with a wrong column/operand errors on the clause line under the new
      signature; a correct one passes (no such test exists today).
   2. Exactly one argument-bucket candidate: each row of the table in step 4 lands
      on its property with no 2769 — for literals **and** hoisted `const`s.
   3. Value calls do not regress: `use-live.test.tsx:954-990`,
      `use-live-list.test.tsx:287-304`; typed-param literals (`{ window: "1h" }`);
      `NM` (`use-live-machine.test.tsx:150-173`), refusal `C`, paged `C` via
      `NoInfer` (`use-live-types.test.ts:95-117`), snapshot `refresh()`.
   4. `const Q` keeps the `groupBy` literal (`LiveGroupValue<Row,"n">`) and
      `groupBy: "notGroupable"` errors on `groupBy`.
   5. Generic callers resolve: `useLivePagesPaging` (`use-live-pages-paging.ts:51,74,83`),
      `live-source.tsx:447`, `GroupsRead`, `FacetRead`; same-kind spread unions pass,
      mixed-kind unions fail.
   6. Wrong-source calls (a non-live object; `C | null` where no `null` is taken)
      do not degrade into a misleading "Expected 4 arguments"; if they do, add an
      optional catch-all last signature.
   7. tsc cost: whole-repo `type-check` wall time within ~10% of today.
   8. Counted collections: either the `null` skip folds into the merged signature,
      or the 2-candidate 2769 there is accepted and recorded.

   **Fallback ladder** (in order; `useLiveRow` is deleted in every outcome):
   (a) item 1 fails → keep a dedicated window overload first purely as the `or()`
   anchor, merge the rest after it; (b) item 2 fails → merged signature placed LAST
   among 2-arg candidates: errors elaborate on the property but carry the "last
   overload" header — the diagnostic check asserts the anchor line only, and I
   report the observed diagnostics; (c) items 3/5 fail → `{ id }` as one extra
   overload after `{ ids }`, errors no better than today, stop and report.

1. Types + runtime in `use-live.ts` and `core/internal/query.ts`;
   `useLiveRow` temporarily `return useLive(c, { id })` so every existing call
   exercises the new path.
2. Codemod (throwaway, TS compiler API via `./equin run`, uncommitted):
   `useLiveRow(A, B)` → `useLive(A, { id: B })` (shorthand when `B` is `id`), fix
   imports from `@plugins/network/plugins/live/web`, rewrite `` `useLiveRow(c, id)` ``
   in TS comments and Markdown prose outside AUTOGENERATED blocks. Argument 0 is
   always a collection, so no value read can turn into a row read.
3. By hand: `network/live/web/__tests__` (`use-live.test.tsx:478-697,1068`,
   `use-live-all.test.tsx:326,456`, `use-live-machine.test.tsx:87,169-170`),
   `browser-server.test.tsx:256,339,419`, and the five `vi.mock` stubs
   (`text-undo-entries`, `block-text-write-stored`, `collab-hydration-state`,
   `collab-session`, `triage-card`) — they wrap the original `useLive` with
   `importOriginal` and fake only `query.id !== undefined` calls.
4. Delete `useLiveRow`; lint / check / doc / exempt edits (§3); new
   `web/__tests__/use-live-query-types.test.ts` + diagnostic fixture. Negative
   cases, each multi-line with the marker above the property: `{ id: 1 }`,
   `{ id: maybe?.id }`, `{ id, limit }`, `{ id, ids }`, `{ ids, limit }`,
   `{ wehre }`, `{ groupBy: "nope" }`, `{ groupBy, orderBy }`,
   `{ count: true, limit }`, `{ count }` on uncounted, wrong clause in `or()`,
   `{ where }` on lookup-only, `{}` on lookup-only, `{ select }` on window,
   scoped `where: { pageId: 1 }` / `{ other }`, `cond ? { id } : { where }`,
   `{ id }` with `{ viewport }`. Positive: `{ id }` / `{ id: null }` on every
   collection kind, machine row read `| LiveUnavailable`, value `{ id }` still
   `ResourceResult`, generic `<Row,F,S>` wrapper. Runtime cases in
   `use-live.test.tsx`: lookup / `all` / window, `null`, `""`, `"a,b"`, error with
   stale, no machine, `null` → string id, value-with-`id`-param beside a row read.
5. `./equin build` (regenerates docs, runs checks) in the background; report.

## Verification

- `./equin check` — `type-check`, `eslint`, `plugins-doc-in-sync`,
  `live:read-hooks`, `live:read-misuse-diagnostics`, `exempt:manifests-valid`.
- `./equin test plugins/network/plugins/live plugins/primitives/plugins/live-state plugins/primitives/plugins/data-view plugins/primitives/plugins/optimistic-mutation plugins/framework/plugins/browser-server`
  plus the plugins with migrated `vi.mock` stubs (`page/editor`, `tasks/task-triage`).
- `rg -n 'useLiveRow' plugins docs CLAUDE.md` → only the `REPLACEMENT` /
  `LEGACY_BARRELS` entry and its lint test.
- Before/after `type-check` wall time recorded in this doc's *Result*.
- Smoke on my build: open a pane reading a row (Debug → Queue run, a report, a page
  link chip), and an unknown id URL renders not-found (`browser_*` tools).

## Open points

- **Value misuse stays as today** (2769 against the last single-value overload,
  usually on the right property). Routing values out of collection calls narrows
  them, but making every value form single-candidate is a follow-up.
- One push for the whole change (no intermediate state ships), unless you prefer
  types-first then migration.

## Result

> **2026-11-02:** the type layer described below (`const Q` + the `QueryChecks` family) was replaced by design E — the query is never captured whole; one type parameter per kind key, one precedence list (`COLLECTION_KIND_KEYS`) shared with the runtime, a key-set check for pre-built queries and the lint `live/where-declared`. See `research/2026-11-02-global-uselive-one-read-hook-design-e.md`.

**Landed.** `useLiveRow` is deleted; every row read is `useLive(c, { id })` (non-test
call sites rewritten by codemod, plus tests, five `vi.mock` stubs and prose). The
design rule's exception list is `useOptimisticResource` alone, enforced by the
`live:read-hooks` check over the `LIVE_WEB_HOOKS` table (`live/core`).
`useLiveScroll` needed nothing (gone since `1f49945319`).

**Signature as built** (diverges from §2's sketch where measurement forced it):
- `const Q extends CollectionQueriesFor<D,Row,F,B> | CountSkip<D>` with
  `query: (Q & QueryChecks<…>) | (Q & null) | WindowDefault<D>`. Q must be bare in
  the constraint: `Q & union` with unit-literal discriminants collapsed to `never`.
- `or()` stays anchored only while `where`'s contextual type reads nothing of Q.
  Every value check on `where` (`WhereColumnsCheck`) is a separate intersected
  check gated on `SetsWhere<Q>`, never a Q-dependent `where` property.
- `QueryChecks` is ONE mapped type over the fixed all-optional key set plus the
  filtered extra keys (a separate empty mapped type `{}` broke weak-type detection
  for hoisted consts).
- `id` / `ids` / `count` are discriminants and read **by value** at runtime and in
  types (`{ ids: undefined }` is a window read on both sides); a required
  `groupBy` is always set (a generic `G` defers), mixed-kind unions are refused
  via `IsMixedKind<Q>`.
- Value overloads are routed out of collection calls by an impossible-arity rest
  (`V extends { rows } ? … : [never ×4]`); paged values on `unknown extends QIn`.
  The nullable-count overload is routed the same way, so a failing non-null
  collection call has exactly one argument-bucket candidate.
- Runtime backstops: `select` beside `id` / `ids` or on a non-`all` collection
  throws.

**Gate outcomes.**
1. `or()` wrong column / operand rejected on the clause (window, group, count): pass.
2. Collection misuse on its property, no 2769: pass where a property exists.
   On the argument line (TS2345): `{}` on lookup-only, mixed-kind unions, hoisted
   consts, a bad branch of a union `where`, `{ ids: null }`.
3. Value reads unchanged (still 2769 on misuse, as before — out of scope).
4–6. `groupBy` literal, generic callers, wrong sources: pass.
7. Cost: cold whole-repo +2.6% instantiations, +0.9% types, 0 diagnostics. Wall
   time not comparable (host load avg 30–56 throughout).
8. Counted null: `useLive(counted, null)` and `cond ? { count: true } : null` kept.

**Accepted TS2769s** (pinned with code markers in `use-live-query-types.test.ts`,
asserted by `live:read-misuse-diagnostics`): a bare `null` collection with a
`where`; a nullable counted collection with a bad `where`; wrong sources (a
non-live object). All were 2769 before too.

**Known gaps.** A generic scoped wrapper `useLive(c: LiveAllCollection<R, B>,
{ where })` does not compile (it did not before either). An inline
`{ id, where: undefined }` is reported on `id` with the `where` sentence.

**Process note.** Three adversarial rounds against a HEAD baseline (460 cases)
found and closed ~30 silent accepts the first prototype introduced; without them
the precise-error design would have been a net regression.

**Test failures outside this change** (seen before and after, or in untouched
files, not re-verified on main): data-view `live-source.test.tsx` ×14
(PluginProvider — confirmed on HEAD), optimistic-mutation
`await-resource-write.test.ts` (BareListError on its own fixture), page/editor
`markdown.test.ts` (block-type generator), `serve-collection-scoped-oracle.test.ts`
(`log-channels.persistence` has no provider), plus load-sensitive timeouts.
