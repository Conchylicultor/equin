# Worker change feed parity (changelog, watermark) + coverage guard: cost and raw routes

Subtrack: *portable server code (server/ vs machine/)*, wiki page `block-323b766d-7ddf-4555-820a-80d82d6737f3`.
Previous session: `research/2026-10-22-global-demo-writes-render-portable-change-feed.md` (Outcome → Open 1, 2).

## Context

Writes in the demo render now: `database/change-feed` runs in the browser worker on PGlite. Two places still make the worker host different from the desktop:

1. **The changelog grows for the life of the tab.** Every feed trigger INSERTs one `live_state_changelog` row per write statement. Only live-state-snapshot (L2) reads or prunes that table, and L2 is not in the worker.
2. **The browser host sends no snapshot watermark.** In `server-core/core/resources.ts`, the runtime's `captureWatermark` returns `undefined` when `getBootMode() === "browser"`, because the SQL (`pg_snapshot_xmin(pg_current_snapshot())`) lives in L2's hooks. An optimistic op whose exact `ackTx` is missed therefore never confirms on this host. The desktop instead falls back to `snapshotWatermark > ackWatermark` (`optimistic-mutation/web/internal/overlay.ts`, `confirmPass`). Exact acks can be missed through `SOURCE_TX_CAP` overflow, a joiner's flight, the 256-entry ack ring, or a resubscribe.

The root cause is the same in both: the change-feed's outbox, and the watermark it is ordered against, are owned by L2, the one plugin that is not on every database host. Each fix moves that ownership to the layer that is on every database host.

The next step is chosen from the wiki's open items:
- **Guard cost.** The coverage guard costs about 5 s per derivation. That cost is paid on every `build` and every `push`.
- **Raw /api routes.** The guard cannot see raw `/api` routes whose keys are constants, so it skips them.
- **Pages and Prototypes back in the demo.** This is feature-sized (about 8 server splits plus a pages seed), and Prototypes' routes are exactly the kind the guard cannot see.

So this session does the two guard items. That keeps every build cheaper, and makes the guard exact before Pages and Prototypes go back in, which is then the next session's task.

## A. The changelog drains at commit when nothing retains it

The outbox is change-feed's own table, so change-feed decides its retention, and a consumer declares that it needs the rows.

Why not the other options:
- **Not a periodic prune.** It would leave rows to pile up between runs, and copy L2's horizon policy.
- **Not skipping the INSERT.** The end-of-transaction marker `live_state_txn_end` is a deferred constraint trigger `AFTER INSERT ON live_state_changelog`, and its `n` counts the rows. Removing the INSERT means re-homing three fingerprinted function bodies.

1. **`change-feed/server/internal/retention.ts` (new).**
   - `RetainChangelog = defineServerContribution<{ reason: string }>("change-feed-changelog-retainer")`, the same shape as `ExcludeFromChangeFeed` in `exclusion.ts`.
   - `changelogMode()` returns `"retain"` when there is at least one contribution, else `"drain"`.
   - Export it from `change-feed/server/index.ts`.
2. **`txn-end.ts`.** `TXN_END_FUNCTION_DDL` becomes `renderTxnEndFunctionDdl(mode)`.
   - `"retain"` returns today's text byte for byte. A test pins it, so the desktop's shared-layer signature (a hash of the DDL strings in `rebuildTriggers`) is unchanged and nothing rebuilds.
   - `"drain"` deletes the firing row itself, `DELETE … WHERE seq = NEW.seq`, in both branches. On the guard branch the row is deleted and the function returns. On the first firing the row is deleted after the `count` and the `pg_notify`.
   - So `n` is still correct.
   - Each deferred firing removes only its own row, so `SET CONSTRAINTS ALL IMMEDIATE` cannot leak later rows.
   - Postgres fires the remaining queued events for rows this transaction already deleted (`AfterTriggerExecute` fetches with `SnapshotAny`), and those firings hit the guard.
   - The changelog has no DELETE trigger: it is denylisted, and `assertNoOtherDeferredTriggers` rejects any other trigger on it.
   - Use DELETE, not TRUNCATE: TRUNCATE fails with "pending trigger events".
3. **`triggers.ts`.**
   - `rebuildTriggers(…, changelog: "retain" | "drain" = "retain")`. The default keeps the roughly 15 direct test and oracle callers unchanged.
   - The rendered string is used in both places that use it today: the signature array, and the prelude's `CREATE OR REPLACE` (around line 830).
4. **Drain-to-retain correctness.**
   - The hole: a database that held L2 snapshots and booted once without a retainer would later replay an empty changelog. Catch-up would read "already current" and serve a stale snapshot.
   - The fix: when the prelude installs `"retain"` over a layer signature that was not the retain one (a fresh install, or a switch from drain), it upserts `live_state_trigger_state('#retained_since') = pg_current_xact_id()`. `planRebuild`'s `forget` skips that row, as it skips `LAYER_ROW`.
   - change-feed exports `changelogCompleteSince(db)`.
   - L2's catch-up (`catch-up.ts` / `boot-catch-up.ts`, next to `isPrunedPast`) treats a floor below it as pruned past, which falls back to its existing full recompute.
5. **`install-feed.ts` and `server/index.ts`.**
   - `FeedInstallInputs.changelog` is required.
   - `onReadyBlocking` fills it from `changelogMode()`, read once, like `excludedTableNames()`.
   - The mode is logged at boot.
6. **live-state-snapshot `server/index.ts`** contributes `RetainChangelog({ reason: "L2 catch-up replays it from a snapshot's floor; pruneChangelog bounds it under the horizon" })`.
7. **Physical growth on PGlite** (no autovacuum).
   - Insert-then-delete still leaves about 70–80 B per write statement: dead line pointers and dead btree entries. Today it is several hundred bytes.
   - **Measure** the changelog's on-disk size (`pg_total_relation_size`) after the no-leak e2e and after 1,000 scripted writes, before and after the change.
   - Add an occasional `VACUUM live_state_changelog` in drain mode only if that number is material, after confirming PGlite accepts it.
8. **Docs.** Update `change-feed/CLAUDE.md`: the outbox section (replace the "prune it, or skip it" follow-up), the marker section and the shared-layer section.

## B. The watermark is the database's, set on every database host

The watermark is "the xmin of the DB snapshot a frame was read under". L2 only hosted the SQL; it reads the watermark only as an argument the runtime passes it.

1. **`database/server/internal/snapshot-watermark.ts` (new).**
   - `snapshotWatermark(exec: DbExecutor): Promise<string>`, using the same SQL as today and `executeOne`, next to `currentTxId`.
   - Export it from `database/server`.
   - The inline copies move to it: `current-tx-id.test.ts:60`, `tasks-core/server/testing/tree-oracle.ts:276`, `serve-collection-all-oracle.test.ts:286`.
2. **`server-core/core/resources.ts`.**
   - A `setWatermarkSource(fn | null)` holder, shaped like `setRelationBases`.
   - `captureWatermark` reads the holder and throws when it is absent. The `getBootMode()` branch and its import go.
   - `LiveStateSnapshotHooks` loses `captureWatermark`.
   - A boot assert in `runPostReadyPhases`, beside `assertDbReadsHaveChangeFeed`: DB-backed reads with no watermark source fail boot. A graph with no database stays tokenless on purpose.
   - The runtime option type narrows back to `() => Promise<string>` (`resource-runtime/core/runtime.ts:~1738`). Central and the in-realm test server still pass no option.
3. **`database/server/index.ts` `onReadyBlocking`.**
   - Calls `setWatermarkSource(() => snapshotWatermark(db))` right after `driver.ready()`.
   - This is earlier than L2 installs its hooks today, so the desktop's pre-ready window narrows.
   - It also fixes a desktop bug: when L2 init fails, `setLiveStateSnapshotHooks(null)` currently also kills the watermark.
4. **L2.** `boot-init.ts` drops its `captureWatermark` wiring, and `persist.ts`'s `captureWatermark` is deleted. Its tests move to `database/server`.
5. **PGlite.**
   - A `snapshotWatermark` test on PGlite in `pglite/server/internal/notifications.test.ts`: it returns xid8 text greater than a committed write's `currentTxId`.
   - PGlite serializes `query` and `transaction` under one mutex, so a capture never sees an in-flight xid. The floor is the next xid, which is safe.
6. **Fix-ups.**
   - `serve-collection-all-oracle.test.ts` installs and resets the source; it persists through the flight watermark.
   - Docs that call browser hosts tokenless: `resources.ts`, `runtime.ts:1715,1734`, `resource-runtime/CLAUDE.md:~746`, `live-state-snapshot/CLAUDE.md:~174`, `database/CLAUDE.md` (list `snapshotWatermark` beside `currentTxId`), `browser-host.test.ts:232`.
7. **Known limit, out of scope.**
   - A `SOURCE_TX_CAP` overflow suppresses the ack without forcing a FULL recompute.
   - A scoped-delta collection then confirms only at its next sub-ack or FULL frame. This is the same on both hosts.
   - Note it in the Outcome as a runtime follow-up.

## C. Guard cost: measure, then derive once

The 5 s figure is a single unprofiled estimate.

1. **Measure first.**
   - Time the sub-phases of `deriveBrowserHostGraph` (`codegen/core/browser-host-gen.ts`) through the existing `onStep` profiler (`regen-pipeline.ts`): inference, the closures and the number of `Bun.build` calls, and the coverage scan.
   - Do the same for each caller.
   - Record the baseline.
2. **Derive once per snapshot.** Today four call sites each re-run the inference:
   - `generateBrowserHosts`
   - the `plugins-registry-in-sync` check
   - `codegen/check` (`browser-host:contributions-covered`)
   - `config_v2/check/registrations-paired.ts`

   Memoize `inferBrowserHostGraph` and `deriveBrowserHostGraph` on the `RegistryGenContext`. Its design comment already says to put snapshot memos on the ctx, not at module level. Share one ctx between `build`'s codegen and its checks where they are separate today.
3. **If `importClosure` still dominates**, there is one `Bun.build` per call (`import-closure/core/import-closure.ts:~322`):
   - Run one multi-entrypoint build over the entry plus every unreached member barrel, and keep its edge map.
   - Compute the per-barrel import chain lazily, from those edges, only when reporting a failure.
4. **Share the coverage scan's `createReader` module memo** on the ctx too.
5. **Target.** The guard adds under 1 s to `build` and under 1 s to `check`. Record before and after on the wiki.

## D. Raw `/api` routes become declarations the guard can read

**The gap.**
- The guard's `httpRoutes()` scan (`browser-host-coverage.ts:~844`) reads only `[x.route]` keys and string literals.
- It silently drops computed-constant keys. There are 4 barrels and 7 keys:
  - asset-mirror: `MIRROR_ROUTE_KEY` and `MIRROR_NESTED_ROUTE_KEY`;
  - mail remote-images: `MAIL_IMAGE_PROXY_ROUTE`;
  - prototypes files: 3 routes;
  - prototypes thumbnails: 1 route.
- `:596-612` then skips any raw prefix that no barrel visibly routes, as "dynamically registered".
- In-scope consumers rely on a hand check of `servesUrls`.

**The fix.**
1. **Each route becomes a `defineEndpoint` GET in its plugin's `core/`**, with a literal `route`.
   - `needsMachine` is set where the handler needs disk. The asset mirror's cache is on disk, and so are prototype files and thumbnails, so they move to `machine/` with `machineHandler`. Mail's image proxy stays portable if its handler already is.
   - The key becomes `[decl.route]`, wrapped by `rawEndpointHandler` / `machineHandler`, because these return raw bytes.
2. **Consumers build an `AssetPath`** (`assetPath(decl, params)`) and load it with `useAssetSrc`.
   - The URL builders `assetMirrorUrl`, `prototypeFileUrl` and the like return an `AssetPath`, or a persisted path via `interpolatePath`.
   - The hand checks of `servesUrls` in `emoji-picker.tsx` and `asset-src.ts` become the transport's own `unavailable` arm, as long as nothing else reads them.
   - `use-reconnecting-ws.ts` and `markdown/base-components.tsx` keep theirs: a WebSocket and persisted markdown are not assets.
3. **The guard becomes strict.**
   - `httpRoutes()` throws on any key that is neither `[ident.route]` nor a literal, naming the file and the key.
   - The "not judged" `continue` is deleted. A raw `/api/<prefix>` in scope must hit a served prefix, or a core-owned one (`RESOURCE_HTTP_ROUTE`, already imported by codegen).
   - Update the test that pins the skip (`browser-host-coverage.test.ts:238-268`), plus the codegen and endpoints `CLAUDE.md` text.
4. **`defineAssetMirror`'s id registry stays as it is.** It holds ids, not routes.

## Verification

All runs go through `./equin test <paths>` and `./equin build`, backgrounded.

- **A.** In `pglite/server/internal/notifications.test.ts`, a drain case:
  - after a multi-statement transaction commits, the changelog has 0 visible rows;
  - exactly one marker arrives, with the correct `n`;
  - the same holds under `SET CONSTRAINTS ALL IMMEDIATE`.

  Also:
  - a retain-render pin test;
  - a flip test, retain then drain then retain, that stamps `#retained_since` and makes L2 catch-up recompute everything;
  - the existing change-feed and L2 suites.
- **B.**
  - `browser-host.test.ts`: a fresh `sub-ack` after a write carries a `watermark` greater than the write's xid. That needs `watermark?` added to its `Frame`.
  - `overlay.test.ts`: an op with its exact ack suppressed confirms through the watermark.
  - `runtime-watermark.test.ts` and the moved `persist` tests.
- **Desktop.**
  - Steady-state restart logs "signatures unchanged — skipping rebuild".
  - A smoke title edit renders and confirms.
  - Frames still carry watermarks. Check with `browser_*` against my build.
- **Demo.** `apps/demo/e2e/no-leak.ts` passes 30/30. Then `query_db`-style probes through the worker: changelog rows stay at 0, with the PGlite size numbers from A7.
- **C.** Guard timings before and after, from the step profiler, on two consecutive `build`s and one `check`.
- **D.**
  - `./equin check` is green.
  - Prove strictness: temporarily add a `[CONST]` route key and see the guard name it, then revert.
  - The emoji picker, the mail remote image and the prototypes gallery work on the desktop (screenshots). In the demo they are unavailable or unchanged.
- **Wiki.**
  - New status and measurements on the subtrack page.
  - Tick the follow-ups.
  - File one next task: Pages and Prototypes back in the demo, citing the page id and the track-instructions block.
