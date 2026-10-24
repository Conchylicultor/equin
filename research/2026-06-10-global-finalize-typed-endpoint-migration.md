# Finalize the typed-endpoint migration

## Context

The repo has been migrating all HTTP traffic to the typed-endpoint primitive
(`defineEndpoint` in `core/`, `implement()` on the server, `useEndpoint`/
`fetchEndpoint` on the client). The migration is **almost complete**: both
enforcement checks already have empty allowlists and pass.

Two things remain:

1. **Vestigial allowlist machinery + stale doc-strings.** The `typed-handlers`
   check still carries an empty `ALLOWED` set + bypass; `typed-web-fetches`
   still carries an empty `Map` + per-file cap and a `description` that lies
   ("legacy call sites are allowlisted with a per-file cap"). Nothing is
   allowlisted anymore — these should reject unconditionally.

2. **One real legacy island: the `stats` plugins** (`commits`, `cost`,
   `pushes`, `tasks`). They still use the *old pattern* end-to-end: untyped
   `defineEndpoint` (no `query`/`response`), manual query extraction
   (`parseBucket`/`parseScope`/`new URL`), raw `Response.json()` handlers with
   manual `Server-Timing` headers, and a `useFetchJson` web helper that calls
   `fetchWithRetry(runtimeUrl)`. Because the URL is built at runtime (not a
   `fetch("/api/...")` literal), it **evades** the `typed-web-fetches` regex
   check entirely. This is the concrete proof the current checks have a hole.

The outcome: only the `defineEndpoint` + `implement()` + `useEndpoint` path
works, the two evasions (runtime-URL web fetch; JSON handler bypassing
`implement()`) are made unrecurrable by enforcement, and the stale doc-strings
are gone. Canonical reference doc:
`plugins/infra/plugins/endpoints/CLAUDE.md` (already up to date — leave it).

**Decisions confirmed with the user:**
- Drop the manual `Server-Timing` headers (runtime-profiler already records
  HTTP spans; `implement()` deliberately owns serialization).
- Add a lint rule forbidding raw `fetch`/`fetchWithRetry` in web code AND
  migrate the one non-stats straggler (`debug/logs` log-viewer) so the rule
  needs zero product-code exemptions.
- Add an `endpoints:no-raw-json-handlers` check (raw `Response.json()` in
  server handlers is forbidden) with 2 documented exemptions.

---

## Part 1 — Simplify the two checks

### `plugins/infra/plugins/endpoints/check/index.ts` (`typed-handlers`)
- Delete the `ALLOWED = new Set<string>([])` and the `if (ALLOWED.has(...)) continue;`
  line. The check already finds zero offenders; this just removes dead bypass.
- Keep the literal-route-key grep as-is.

### `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`
- Delete the `ALLOWED = new Map(...)` and the per-file cap logic
  (`const allowed = ALLOWED.get(path) ?? 0; if (count > allowed)`). Replace
  with: any `/web/` file with ≥1 match is an offender.
- Fix the `description` (drop "legacy call sites are allowlisted with a per-file
  cap") and the error `message`/`hint` (drop "exceeding the allowlist").
- The per-file count machinery can collapse to a simple per-file offender list.

---

## Part 2 — Migrate the `stats` legacy island

For **each** of the ~17 endpoints across `commits`, `cost`, `pushes`, `tasks`:

1. **Type the contract** in the plugin's `shared/endpoints.ts`:
   - Add a `query:` Zod schema where the handler reads query params
     (`bucket`, `breakdown`, `dedup`, `scope`, `limit`). Use `z.enum` for the
     bucket/scope/breakdown values; coerce/optional with defaults matching
     today's behavior (e.g. `bucket` default `"day"`, `scope` default
     `"singularity"`). Note `commits` bucket = `hour|day|week|month|year` (5),
     `pushes` bucket = `day|week|month` (3).
   - Add a `response:` Zod schema matching the exact JSON shape (see the
     inventory in this doc's companion exploration — every shape is enumerated).
   - **Polymorphic responses** (`commits` `rate`/`cumulative`/lines, which
     return a different shape when `?breakdown=` is set): model the response as
     a `z.union` / discriminated shape (e.g. `points` items have the plain
     fields OR the `byCategory`/`byExt` map, plus optional `categories`). The
     web call site narrows by the `breakdown` it requested. Keep it precise —
     do not collapse to `z.unknown()`.

2. **Convert handlers to `implement()`** (`server/internal/handle-*.ts`):
   - Wrap with `implement(endpoint, async ({ query }) => { ... return obj; })`.
   - Replace manual `new URL(req.url).searchParams.get(...)` / `parseBucket(req)`
     / `parseScope(req)` with the typed `query` arg.
   - Return the plain object (no `Response.json`). **Drop the `Server-Timing`
     header** and the `withCostTiming`/`commitsTimingHeader`/manual-header
     wrappers entirely.
   - Rework `parseBucket`/`keyFor` so `keyFor` (still needed for bucketing) is
     kept but `parseBucket` (query extraction) is deleted — the enum lives in
     the endpoint `query` schema now. `commits`' private `parseBucket`/`keyFor`
     live in `handle-rate.ts`; `pushes`' shared ones in
     `server/internal/buckets.ts` (`parseBucket` exported — drop it, keep
     `keyFor`). `cost`'s `parseScope` in `load-usage.ts` — drop it, keep the
     loader.
   - Route registration in each `server/index.ts` is already `[ep.route]: fn`;
     no change needed (the key stays, the value is now an `implement()` result).

3. **Migrate web consumers** (21 call sites) from `useFetchJson` to
   `useEndpoint`:
   - Replace `useFetchJson<T>(urlString, cacheKey)` with
     `useEndpoint(endpoint, params?, query?)`. The query object replaces the
     hand-built `?bucket=...&breakdown=...&dedup=1` / `withScope(...)` strings.
   - `useEndpoint` wraps TanStack Query; the `cacheKey` arg (used today to
     force refetch on scope/dedup change) is subsumed by the query object being
     part of the query key — verify each chart still refetches when
     `bucket`/`scope`/`dedup` change.
   - Map the old `{ data, error }` destructure to `useEndpoint`'s
     `{ data, error, isLoading }` shape; `ChartState` consumers expect
     `data | null` + `error` — adapt to TanStack's `data: undefined` while
     loading.
   - Remove the now-dead `withScope` helper (`cost/web/.../use-scope.ts`) and
     inline `?dedup`/`?breakdown` string-building.

4. **Delete `useFetchJson`** from
   `plugins/stats/plugins/commits/web/components/chart-primitives.tsx` and its
   re-export in `plugins/stats/plugins/commits/web/index.ts`. After step 3 it
   has zero callers. `fetchWithRetry` (the networking primitive) stays — it is
   still used by `log-viewer` until Part 3 and is a legitimate primitive.

**Critical files (server):**
`plugins/stats/plugins/{commits,cost,pushes,tasks}/shared/endpoints.ts`,
`.../server/internal/handle-*.ts` (+ `cost/.../handlers.ts`,
`commits/.../handle-rate.ts`, `pushes/.../buckets.ts`,
`cost/.../load-usage.ts`).
**Critical files (web):** the 21 chart components listed in the exploration
inventory under `stats/{commits,cost,pushes,tasks}/web/components/`, plus
`commits/web/components/chart-primitives.tsx`, `commits/web/index.ts`,
`cost/web/.../use-scope.ts`.

---

## Part 3 — Structural enforcement (make evasions unrecurrable)

### (A) Lint rule: no raw fetch in web code
- New plugin-contributed ESLint rule under
  `plugins/infra/plugins/endpoints/lint/index.ts`, default-export
  `{ name: "endpoints", rules: { "no-raw-web-fetch": rule }, ignores: {...} }`.
- Rule: in `**/web/**` files, flag any `CallExpression` whose callee is
  `fetch`, `fetchWithRetry` (any name-based match). Message: use
  `fetchEndpoint`/`useEndpoint` from the endpoints primitive.
- `ignores` exemptions (primitive internals only — no product code):
  `plugins/primitives/plugins/networking/web/**` and
  `plugins/infra/plugins/endpoints/web/**`.
- Follow the existing rule shape (`reactive-server-io` /
  `promise-safety`): `ESLintUtils.RuleCreator`, ESLint v9. Add the plugin to
  `lint.generated.ts` (regenerated by `./equin build`).
- **Migrate the straggler first** so the rule is green with zero product
  exemptions: `plugins/debug/plugins/logs/web/components/log-viewer.tsx:47`
  uses `fetchWithRetry("/api/logs/channels")`. The `getLogChannels` endpoint
  already exists and is typed — replace the raw call with
  `fetchEndpoint(getLogChannels, {})` (it's inside a `useEffect`, so
  `fetchEndpoint` is the direct swap; or `useEndpoint` if refactoring the
  effect). Drop the now-unused `fetchWithRetry` import there.

### (B) Check: no raw `Response.json()` in server handlers
- New plugin-contributed check `endpoints:no-raw-json-handlers` in
  `plugins/infra/plugins/endpoints/check/` (add to the default-export array in
  `check/index.ts`).
- Use `grepCode` for `Response\.json\(` with `pathspecs` scoped to
  `*/server/**/*.ts` and `*/central/**/*.ts` (exclude `/web/`). Tight signal:
  JSON responses must go through `implement()`; raw handlers are only for
  binary/stream/custom-status.
- Exclude the endpoints primitive itself
  (`plugins/infra/plugins/endpoints/**` — `implement()` legitimately calls
  `Response.json`) and the server-core error fallback
  (`plugins/framework/plugins/server-core/bin/index.ts`).
- **2 documented exemptions** (legitimately raw, can't use `implement()`):
  - `plugins/conversations/plugins/conversation-category/server/internal/routes.ts`
    — `handleClassify` returns `202 Accepted`.
  - `plugins/debug/plugins/worktree-cleanup/server/internal/handle-delete.ts`
    — `400/404` guards before an NDJSON stream.
  Each exemption carries an inline comment explaining why. (`events-test` uses
  `Response.json` in long-poll/onDeadline handlers — include it in the
  exemption set too, or scope the check to exclude `events-test` as a test
  fixture; prefer an explicit exemption with a comment.)
- After Part 2, the stats handlers no longer match — the check passes.

---

## Part 4 — Remove the legacy doc-strings

- The `typed-web-fetches.ts` `description` / `message` / `hint` updates land in
  Part 1.
- No CLAUDE.md teaches the old pattern (server-core & web-sdk already defer to
  `implement()`/`useEndpoint` — verified, leave them).
- The endpoints `CLAUDE.md` is canonical and current — leave it. If the new
  lint rule / `no-raw-json-handlers` check warrant a one-line mention of "raw
  handlers are only for binary/stream/custom-status, enforced by
  `endpoints:no-raw-json-handlers`", add it to the endpoints `CLAUDE.md` prose
  (above the AUTOGENERATED block).
- Optional: the two superseded server-API design docs
  (`research/2026-04-08-server-plugin-api.md` and `-v2.md`) teach the pre-typed
  pattern. They're dated `research/` iterations, not live guidance — leave
  unless the user wants them pruned.

---

## Verification

1. `./equin build` — confirm migrations/codegen regenerate
   (`lint.generated.ts`, `check.generated.ts`) and the server restarts clean.
2. `./equin check` — all green, specifically:
   - `endpoints:typed-handlers`, `endpoints:typed-web-fetches`,
     `endpoints:no-raw-json-handlers`, and `eslint` (the new
     `endpoints/no-raw-web-fetch` rule).
3. **Negative checks** (prove enforcement bites): temporarily add a
   `fetch("/api/x")` in a web file → `eslint` fails; add a raw
   `Response.json()` in a stats handler → `no-raw-json-handlers` fails. Revert.
4. **End-to-end UI**: open `http://<worktree>.localhost:9000` → Stats app.
   Drive each chart group with `e2e/screenshot.mjs` and confirm data renders
   and the bucket/scope/dedup toggles refetch correctly (Commits rate +
   breakdown, Cost daily/sessions with scope toggle, Pushes throughput with
   bucket toggle, Tasks cumulative/velocity). Confirm the Debug → Logs viewer
   still lists channels (log-viewer migration).
5. `grep` sanity: `rg 'useFetchJson|withScope' plugins/stats` returns nothing;
   `rg 'fetchWithRetry' plugins --glob '*/web/**'` returns only the networking
   primitive definition.

## Risk notes
- `useEndpoint` (TanStack Query) loading state is `data: undefined`, not
  `null` — the `ChartState`/chart components currently branch on `null`. Adapt
  each consumer's empty/loading branch.
- Polymorphic `commits` responses: get the union schema right or the client
  type narrows wrong. Validate the breakdown charts specifically.
- Dropping `Server-Timing` is intentional and user-approved; the
  runtime-profiler covers timing.
