# Stale tabs keep loading their own code

## Context

A tab left in the background came back showing a full-width red banner listing
64 plugins that "Failed to fetch dynamically imported module".

What happened (investigated 2026-09-10):

- The tab had booted from a build of Sep 8–9. Chrome froze it before the page's
  second loading step ran (after the first paint, the page fetches every app's
  plugins in batches — the "deferred tier", `web-core/web/App.tsx:223-243`).
- When the tab was brought back, that step resumed and asked for the Sep 8–9
  file addresses. Main had been rebuilt many times since. Each build serves only
  its own addresses, and deletes the folder the previous build served
  (`dist-publish.ts:149-151`). Every plugin whose code changed since Sep 9 got a
  404. Plugins unchanged since then loaded fine, which is why only some failed.
- The files themselves were still in the shared cache
  (`~/.singularity/cache/web-artifacts/store`, kept 14 days after last use). They
  were just no longer linked from the served folder.
- The loader tries each plugin once, and Chrome remembers a failed import for the
  life of the page, so the tab stays broken until reloaded.
- No crash report reached the database. The exact cause for this incident can't
  be proven after the fact (reports are kept 7 days; nothing was logged). Two
  real weaknesses were found on the way — see Part 3.

Intended outcome:

1. An old tab keeps working. It loads exactly the files its own build pointed
   at, never the current build's.
2. When a background-loaded plugin still fails, the app stays calm: no banner.
   The Build button's Reload chip turns red. Failures in the core (loaded before
   first paint) keep today's explicit banner listing each failure — decided by
   the user.
3. Plugin-load failures reliably produce a report.

## Why serving old files is safe (no version mixing)

- An address is a hash of the plugin's own files plus the build tooling (tool
  versions, builder source, minify flag). A build-time audit fails if any code
  reaches a file without being counted in its hash
  (`web-artifacts/CLAUDE.md`, "An artifact's address covers exactly what its
  bytes inline").
- The cache is write-once per address: `publishArtifact` renames into place and
  discards its own copy if the address already exists (`store.ts:109-125`).
  Vendor sets (`vendors.ts:568-575`) and CSS cache dirs (`global-css.ts:295-301`)
  follow the same rule.
- A tab resolves every import through the address list baked into the page it
  loaded. It cannot reach a newer build's files.

So a tab served old addresses gets byte-for-byte the files it was built with.
The only remaining skew is old frontend ↔ current server, which already exists
for every stale tab today and is what the Reload chip is for.

## Part 1 — Keep serving old addresses (build side, no gateway change)

Chosen over a gateway fallback because: it needs no gateway rebuild (a
gateway change only takes effect after the user runs `./equin start`);
the gateway stays ignorant of the cache layout; and it also covers fonts, which
are copied into each build folder rather than linked.

**Mechanism: carry forward.** When a build publishes a *served* folder (a
checkout's app or a served composition — not a release), it first copies over
from the currently-served folder every entry the new build doesn't have and the
cache still holds:

- `artifacts/<name>` — each is a symlink to an absolute cache path
  (`compose.ts:184-191`). Recreate the same symlink if `readlink` target still
  exists. No need to parse names or tell plugin artifacts from vendor sets. A
  target exists only once fully published (meta.json is written before the
  rename, `store.ts:114-117`), so existence is an exact test.
- `assets/<file>` (global CSS + fonts; fonts are fetched lazily, same bug) —
  copied files, not links. Their timestamp resets on every copy, so an age rule
  would never expire them. Keep one only while some cache dir under
  `web-artifacts/css/` still contains that filename (new `cssCacheHasAsset`).

Because each served folder already contains everything carried before it, a
build only diffs against the previous served folder. The set is: everything
this namespace served that the cache still holds. Cache pruning (14 days since
last use, `store.ts:34`, `vendors.ts:584`, `global-css.ts:314`) bounds it. When
a target is pruned, its link is dropped at the next publish (honest 404 in
between).

Accepted risk, to be written in the function's docblock so nobody "fixes" it
with a lock: another worktree's build may prune a target between the existence
check and the swap. One address 404s until the next publish.

Changes:

- New `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/carry-forward.ts`:
  ```ts
  export function carryForwardServedEntries(opts: {
    liveDir: string;    // the served folder, still the previous build
    stagingDir: string; // this build's folder, after compose + verify
  }): { artifactsCarried: string[]; assetsCarried: string[]; artifactsDropped: string[] };
  ```
  No-op when `liveDir` doesn't exist (first build).
- `web-artifacts/core/internal/global-css.ts`: add
  `cssCacheHasAsset(name: string): boolean` (scan of the CSS cache dirs, bounded
  at ≤600 by `pruneGlobalCssCache`).
- Export both through `web-artifacts/core/index.ts`.
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`
  (~1108-1118, right before `publishDistAtomic`): when
  `opts.target.kind === "served"`, call it with `livePath` / `stagingPath` and
  log one line with carried / dropped counts.
- `web-artifacts/CLAUDE.md`: one invariant paragraph — a served folder keeps
  every address it ever served while the cache holds it; releases never carry.

Needs no change, confirmed: `scanStagedModules` (runs inside the pipeline, before
carry-forward, `pipeline.ts:404`), the `web-artifacts:map-in-sync` check (reads
only the import map in `index.html`), the gateway (`proxy.go:148-155` follows
symlinks), server readers of the dist (only `.build-graph` / `.build-commit`).

## Part 2 — What the user sees

**Core (eager) failures:** unchanged — the explicit red banner listing each
failure.

**Background (deferred) failures:** no banner. Instead:

- The Build button's Reload chip shows when the tab is stale **or** a deferred
  plugin failed. Red when something failed, blue when only stale. Tooltip:
  - stale only: "Server was rebuilt — click to reload this tab" (today's text)
  - failed: "Part of the app didn't load — reload to fix"
  - both: "This tab is out of date and part of the app didn't load — reload to fix"
- The collapsed action-bar status dot turns red for failures (today stale →
  amber).
- Opening an app whose plugin failed still shows the existing "Couldn't load
  this app — Retry" pane (`route-fallback`, `apps-layout`), unchanged.
- A report is filed (Part 3).

Accepted edge: if the user disables the action bar (Settings → "Action bar"),
there is no chip or dot; the per-app pane remains.

Changes:

- `plugins/framework/plugins/web-core/web/App.tsx`: split load errors by stage.
  `state.errors` holds only core-stage errors (set once, never appended);
  deferred errors no longer enter it and still go through `recordErrors`
  (publishes failed paths on the deferred-load store + fires the report sink).
  No `tier` field on `PluginLoadError` — each call site already knows its stage.
  `plugin-load-errors.tsx` unchanged.
- New `plugins/build/web/hooks/use-reload-advice.ts`:
  ```ts
  type ReloadAdvice =
    | { kind: "none" }
    | { kind: "stale" }
    | { kind: "broken"; stale: boolean; failedCount: number };
  ```
  Reads `useStaleFrontend()` and `useDeferredLoadState().failedPluginPaths`
  (`@plugins/framework/plugins/web-sdk/core`). Exported from `build/web`.
- `plugins/build/web/components/build-button.tsx`: chip driven by
  `useReloadAdvice()`; replace the hand-rolled `<span>` (lines 116-131) with the
  `Badge` primitive (`variant` info / destructive, `as="button"`, `MdRefresh`
  icon). Keep a hover affordance so it still reads as clickable.
- `plugins/shell/plugins/global-action-bar/web/internal/use-action-bar-status.ts`:
  switch from `useStaleFrontend` to `useReloadAdvice`; `broken` → destructive.

## Part 3 — Reports that can't get lost

1. **Core-stage failures are always dropped today.** `App.tsx:220-221` fires the
   report sink right after `setState`, before the reporter component has mounted
   and registered (`plugin-load-error-reporter.tsx:24-29`); the sink drops when
   no handler is registered (`deferred-load-store.ts:41-59`). Fix at the
   primitive: a sink **holds emits until a handler registers, then replays them**
   (cap ~100; this is an error path, not a queue). Apply the same shape to both
   copies of this contract: `pluginLoadReportSink` (`deferred-load-store.ts`)
   and the generic `defineReportSink`
   (`plugins/primitives/plugins/report-sink/core/internal/define-report-sink.ts`,
   used by `boundaryReportSink`), so they stay one contract.
2. **Delivery dies silently during a server restart or host overload.**
   `report()` (`plugins/reports/web/report.ts:41-64`) swallows every failure.
   - Add opt-in `retry?: FetchWithRetryOptions` to `fetchEndpoint`
     (`plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts`), using
     the existing `fetchWithRetry`
     (`plugins/primitives/plugins/networking/web/fetch-with-retry.ts`: bounded
     exponential backoff, retries network errors and 502/503/504).
   - `report()` passes it (enough attempts to outlast a hot restart, ~30 s
     total). On final failure: `console.warn` with the report's summary, still
     never throws (it runs on error paths).
   - A retry after a lost response can only bump an existing row's count
     (reports dedupe by fingerprint), not create a duplicate.

## Approval needed

`plugins/framework/CLAUDE.md` requires the user's explicit OK for any change
under `plugins/framework/`. This plan touches:

- `web-artifacts` (new `carry-forward.ts`, `global-css.ts`, barrel, CLAUDE.md)
- `cli/plugins/build/cli/internal/app-artifacts.ts` (one call before publish)
- `web-core/web/App.tsx` (split errors by stage)
- `web-sdk/core/deferred-load-store.ts` (sink holds until registered)

## Order of work

1. Part 1 + unit tests (self-contained, biggest user impact).
2. Part 3.1 (sink buffering) + tests.
3. Part 3.2 (retry) + tests.
4. Part 2 (hook, Build button, status dot, App.tsx split) + tests.
5. e2e, `./equin build`, verification below.

## Verification

Unit (`./equin test <path>`):

- `web-artifacts/core/internal/carry-forward.test.ts` (tmpdir fixtures, like
  `dist-publish` tests): carries a link whose target exists; drops a link whose
  target is gone; skips entries the new build already has; no-op without a
  live folder; asset kept / dropped by `cssCacheHasAsset`.
- Sink tests (both sinks): emit before register → register replays in order;
  cap respected; emit after register goes straight through.
- `fetchEndpoint` retry: mocked fetch 503 → 200 succeeds; network error × N →
  throws after N; 400 is not retried.
- jsdom `plugins/build/web/__tests__/`: chip hidden / blue / red per
  `ReloadAdvice`; tooltip text per state.
- jsdom `web-core/web/__tests__/`: a deferred failure never appears in the
  banner; a core failure does.

Real deploy (worktree namespace):

1. `./equin build`; note an artifact address for one plugin from the
   served `index.html`.
2. Edit that plugin trivially, `./equin build` again.
3. `curl` the old address → 200 (was 404 before). The build log shows the
   carry-forward line. `readlink` shows it points into the shared cache.

e2e `plugins/build/e2e/stale-tab-reload.ts` (harness
`@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e`, modeled on
`plugins/build/e2e/runs-surface.ts`):

- Intercept one deferred plugin's artifact URL with a 404 (Playwright
  `page.route`) → assert: no top banner; Build chip is red with the "didn't
  load" tooltip; a `plugin-load` report row appears (`query_db` on the worktree
  DB).
- Intercept one core-stage plugin's artifact → assert the explicit banner shows
  it, and a report row appears (proves Part 3.1).
- Screenshot both states (`--color-scheme light` and `dark`).

`./equin check` passes (boundaries: `build/web` → `web-sdk/core` value
import is legal; `no-adhoc-chip` no longer applies to the chip).
