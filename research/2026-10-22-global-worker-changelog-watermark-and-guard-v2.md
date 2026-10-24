# Worker change feed parity (v2): live-state-snapshot in the worker + coverage guard (cost, raw routes)

Supersedes `2026-10-22-global-worker-changelog-watermark-and-guard.md` (v1).
Subtrack: *portable server code (server/ vs machine/)*, wiki page `block-323b766d-7ddf-4555-820a-80d82d6737f3`.
Previous session: `research/2026-10-22-global-demo-writes-render-portable-change-feed.md` (Outcome → Open 1, 2).

## Context

Writes in the demo render now: `database/change-feed` runs in the browser worker on PGlite. Two places still make the worker host different from the desktop:

1. **The changelog grows for the life of the tab.** Every feed trigger INSERTs one `live_state_changelog` row per write statement. Only live-state-snapshot (L2) reads or prunes that table.
2. **The browser host sends no snapshot watermark.** `server-core/core/resources.ts` has `captureWatermark` return `undefined` when `getBootMode() === "browser"`, because the watermark SQL sits in L2's hooks.
   - An optimistic op whose exact `ackTx` is missed therefore never confirms on this host.
   - The desktop instead falls back to `snapshotWatermark > ackWatermark` (`optimistic-mutation/web/internal/overlay.ts`).

Both gaps have one cause: **L2 is the one database plugin the worker does not boot.**

v1 fixed the changelog with a new "drain" mode: a second trigger-function body, used only where L2 is absent. That adds a code path only the worker would run, which is the opposite of the subtrack's goal: as little difference as possible between the desktop server and the browser one.

v2 boots L2 in the worker instead. The same code then runs on both hosts:
- the same prune job and the same policy for the changelog;
- the same hook for the watermark.

It is also the code a browser app needs once PGlite persists to IndexedDB (the "local data" target), where L2 is what makes a reload instant.

**L2 is close to portable.** Its only machine-only import is `database/admin/server`, used only for `ExcludeFromFork`. change-feed had exactly this import and split it into `change-feed/machine` last session. Everything else it imports is already portable:
- `database`, `change-feed`, `derived-tables`, `jobs`;
- `primitives/log-channels`, `sql-rows`, `derived-views/core`;
- `server-core/core`, `report-sink/core`.

It reads no `getBootMode`, `process` or `Bun` value. The in-process job queue already fires scheduled jobs (`jobs/in-process/server/internal/memory-queue.ts`), so L2's hourly prune and compact jobs run in the worker unchanged.

Then the next step, from the wiki's open items: the coverage guard's cost (about 5 s per derivation, paid on every `build` and `push`), and its blind spot for raw `/api` routes. Fixing these first keeps the guard exact for the Pages and Prototypes session, because Prototypes' routes are exactly the kind it cannot see today.

## A. live-state-snapshot runs in the worker

1. **`live-state-snapshot/machine/index.ts` (new).**
   - Holds the `ExcludeFromFork({ table: LIVE_STATE_SNAPSHOT_TABLE, … })` contribution, moved from `server/index.ts` together with its comment.
   - Follow `change-feed/machine/index.ts`'s shape exactly: a `MachinePluginDefinition` with `contributions` only.
2. **`live-state-snapshot/server/index.ts`.**
   - Drop the `admin/server` import and add `portable: true`.
   - Add a comment like change-feed's: it runs on every host with a database; forking, and so the fork exclusion, is the desktop's (`./machine`).
3. **Codegen picks it up.** No composition edit is expected: the worker graph is inferred from the `agent-manager-demo` composition's portable barrels.
   - `./equin build` regenerates `apps/agent-manager/plugins/demo/bin/browser-host.generated.ts` (185 → 186 nodes expected).
   - The portable-closure check proves the closure is free of computer-only code, and the platform-value AST pass checks `setImmediate`, `Buffer` and `.unref()` uses.
   - Anything the check flags is fixed at its source, the way change-feed's `node:crypto` and `unref` were.
4. **`server-core/core/resources.ts`.**
   - Delete the `getBootMode() === "browser"` branch in `captureWatermark`, and the import if nothing else uses it.
   - The hooks are now installed on every database host before anything is served. Their absence is the boot-order bug the existing throw names, on both hosts.
   - Fix the comments that call browser frames tokenless: here, `resource-runtime/core/runtime.ts:~1715,1734`, `resource-runtime/CLAUDE.md:~746`, `live-state-snapshot/CLAUDE.md:~174`, `browser-host.test.ts:232`, and `change-feed/CLAUDE.md`'s outbox follow-up.
5. **Behaviour on an in-memory database (to measure, not to special-case):**
   - **Boot.** `onReadyBlocking` creates the snapshot and horizon tables and runs the sweep. `onReady`'s catch-up finds no rows and recomputes every persisted key from the seed, after the listener is up (the existing ordering invariant).
   - **Steady state.** Each flush of a persisted key writes `live_state_snapshot`. Nothing reads those rows back until the database outlives the tab.
   - **Changelog.** Bounded by the same `pruneChangelog` policy as the desktop: rows below the minimum snapshot position, or older than 24 h, deleted hourly.

   If boot time or the persist writes turn out to cost too much, the fix is a policy every host shares, for example "persist only when the database is durable" as a `DatabaseDriver` capability the PGlite driver states. It is never an `if (browser)`. That decision is taken on the numbers in Verification, not up front.
6. **PGlite pin.** In `pglite/server/internal/notifications.test.ts`, `pg_snapshot_xmin(pg_current_snapshot())` must return xid8 text greater than a committed write's `currentTxId`.
   - PGlite serializes `query` and `transaction` under one mutex, so the capture never sees an in-flight xid. The floor is the next xid, which is the safe direction.

## B. The watermark is the database's (ownership fix, no host difference)

The watermark is "the xmin of the DB snapshot a frame was read under". L2 consumes it only as an argument the runtime passes, as its persist floor. After A, B is no longer needed for the worker; it is kept because the ownership is wrong and that causes a desktop bug. When L2's init degrades, `setLiveStateSnapshotHooks(null)` currently turns watermarks off too.

1. **`database/server/internal/snapshot-watermark.ts` (new).**
   - `snapshotWatermark(exec)`, beside `currentTxId`, with the same `executeOne` shape. Export it from `database/server`.
   - Replace the inline copies of the SQL: `current-tx-id.test.ts:60`, `tasks-core/server/testing/tree-oracle.ts:276`, `serve-collection-all-oracle.test.ts:286`.
2. **`server-core/core/resources.ts`.**
   - A `setWatermarkSource(fn | null)` holder, shaped like `setRelationBases`. `captureWatermark` reads it and throws when it is absent.
   - `LiveStateSnapshotHooks` loses `captureWatermark`.
   - A boot assert beside `assertDbReadsHaveChangeFeed` in `runPostReadyPhases`: DB-backed reads with no watermark source fail boot.
3. **`database/server/index.ts` `onReadyBlocking`** calls `setWatermarkSource(() => snapshotWatermark(db))` right after `driver.ready()`.
4. **L2.** `boot-init.ts` drops its `captureWatermark` wiring, and `persist.ts`'s `captureWatermark` is deleted. Its tests move to `database/server`.
5. **`serve-collection-all-oracle.test.ts`** installs and resets the source (it persists through the flight watermark).
6. **Known limit, out of scope.**
   - A `SOURCE_TX_CAP` overflow suppresses the ack without forcing a FULL recompute.
   - A scoped-delta collection then confirms only at its next sub-ack or FULL frame. This is the same on both hosts.
   - Record it in the Outcome as a runtime follow-up.

## C. Guard cost: measure, then derive once

The 5 s figure is a single unprofiled estimate.

1. **Measure first.**
   - Time the sub-phases of `deriveBrowserHostGraph` (`codegen/core/browser-host-gen.ts`) through the existing `onStep` profiler (`regen-pipeline.ts`): inference, the closures and the number of `Bun.build` calls, and the coverage scan.
   - Do the same for each caller.
2. **Derive once per snapshot.** Today four call sites re-run the inference:
   - `generateBrowserHosts`
   - `plugins-registry-in-sync`
   - `codegen/check` (`browser-host:contributions-covered`)
   - `config_v2/check/registrations-paired.ts`

   Memoize `inferBrowserHostGraph` and `deriveBrowserHostGraph` on the `RegistryGenContext`. Its design comment already puts snapshot memos on the ctx. Share one ctx between `build`'s codegen and its checks where they are separate.
3. **If `importClosure` still dominates**, there is one `Bun.build` per call (`import-closure/core/import-closure.ts:~322`). Run one multi-entrypoint build over the entry plus every unreached member barrel, keep its edges, and compute an import chain lazily, only when reporting a failure.
4. **Share the coverage scan's `createReader` memo** on the ctx.
5. **Target.** Under 1 s added to `build` and under 1 s added to `check`. Record before and after.

## D. Raw `/api` routes become declarations the guard can read

**The gap.**
- The guard's `httpRoutes()` (`browser-host-coverage.ts:~844`) reads only `[x.route]` keys and string literals. It silently drops computed-constant keys. There are 4 barrels and 7 keys:
  - asset-mirror (2);
  - mail remote-images (1);
  - prototypes files (3);
  - prototypes thumbnails (1).
- `:596-612` then skips any raw prefix no barrel visibly routes, as "dynamically registered".
- Consumers rely on a hand check of `servesUrls`.

**The fix.**
1. **Each route becomes a GET `defineEndpoint` in its plugin's `core/`**, with a literal `route`.
   - `needsMachine` is set where the handler needs disk. The asset mirror's cache is on disk, and so are prototype files and thumbnails, so their handlers go to `machine/` through `machineHandler`. The mail proxy stays portable if its handler already is.
   - The key becomes `[decl.route]`, wrapped by `rawEndpointHandler` / `machineHandler`, because these return raw bytes.
2. **Consumers build an `AssetPath`** (`assetPath(decl, params)`) and load it with `useAssetSrc`.
   - The hand `servesUrls` checks in `emoji-picker.tsx` and `asset-src.ts` become the transport's own `unavailable` arm.
   - `use-reconnecting-ws.ts` and `markdown/base-components.tsx` keep theirs: a WebSocket and persisted markdown are not assets.
3. **The guard becomes strict.**
   - `httpRoutes()` throws on a key that is neither `[ident.route]` nor a literal, naming the file and the key.
   - The "not judged" `continue` is deleted. A raw `/api/<prefix>` in scope must hit a served prefix, or a core-owned one (`RESOURCE_HTTP_ROUTE`).
   - Update the skip's test (`browser-host-coverage.test.ts:238-268`), plus the codegen and endpoints `CLAUDE.md` text.
4. **`defineAssetMirror`'s id registry stays.** It holds ids, not routes.

## Verification

All runs go through `./equin test <paths>` and `./equin build`, backgrounded.

- **A, worker.**
  - `browser-host.test.ts` boots the regenerated graph on PGlite, with L2 in it.
  - A fresh `sub-ack` after a write carries a `watermark` greater than the write's xid. That needs `watermark?` added to its `Frame`.
  - After a write, the changelog row is pruned by a direct `pruneChangelog` call.
  - `overlay.test.ts`: an op with its exact ack suppressed confirms through the watermark.
  - `apps/demo/e2e/no-leak.ts` passes 30/30.
- **A, measurements (the go/no-go for any shared persist policy):**
  - worker boot to ready, 3 warm loads, against today's 1241 ms (main) and 1363 ms (last branch);
  - L2's `onReadyBlocking` and catch-up time;
  - the bundle size and the module and graph-node counts;
  - persist writes per minute during the e2e;
  - `live_state_snapshot` and `live_state_changelog` sizes after the e2e.
- **B.**
  - `runtime-watermark.test.ts` and the moved watermark tests.
  - A degraded-L2 test: hooks set to null still leaves frames carrying watermarks.
  - The boot assert fires on a DB-reading graph without a source.
- **Desktop.**
  - A steady-state restart logs "signatures unchanged — skipping rebuild".
  - L2's catch-up logs look as before.
  - A smoke title edit renders and confirms, and frames carry watermarks (`browser_*` against this build).
  - A worktree fork still excludes `live_state_snapshot` (the `ExcludeFromFork` move).
- **C.** Guard timings from the step profiler, before and after, on two consecutive `build`s and one `check`.
- **D.**
  - `./equin check` is green.
  - Strictness proven by temporarily adding a `[CONST]` route key and seeing the guard name it, then reverting.
  - Emoji picker, mail remote image and prototypes gallery work on the desktop (screenshots), and are unavailable or unchanged in the demo.
- **Wiki.**
  - New status and measurements on the subtrack page.
  - Tick the changelog and watermark follow-ups.
  - File one next task: Pages and Prototypes back in the demo, citing the page id and the track-instructions block.

## Outcome (2026-10-24)

Every part landed, plus one the plan had not foreseen (server companions, A′ below). The final build is green and deployed. `apps/demo/e2e/no-leak.ts` passes 30/30.

### A. live-state-snapshot runs in the worker
- `ExcludeFromFork` moved to `live-state-snapshot/machine`; the server barrel is `portable: true`. No platform value had to change.
- The `getBootMode() === "browser"` branch in `resources.ts` is deleted.
- Desktop unchanged: a restart logs "147 table(s), signatures unchanged — skipping rebuild", and L2's catch-up replays as before.

### A′. Server companions (found during the build)
- Marking L2 portable did not put it in the worker. The worker graph takes what the `agent-manager-demo` composition reaches, and nothing imports L2 (L2 imports change-feed, not the reverse). So no served agent-manager composition on the desktop had L2 either, and their changelogs were never pruned.
- Fix: the companion edge now covers server contribution kinds as well as web slots.
  - `defineServerContribution(name, { companions: true })` opens a kind. `Kind({ …, companion: true })` is type-enforced and statically read: parse-utils' `parseServerContributionDeclarations` (moved from codegen and shared) and the contributions facet's `serverCompanionKinds` / `serverCompanions`.
  - `collectCompanionSlots` returns them as `runtime: "server"` entries, so the closure engine draws owner → contributor hard edges. The engine stays browser-safe: the owner is read off the `@plugins/<path>/server` specifier through `tree.byPath`.
  - `machine/` is refused on both sides (a browser host boots the owner but never a `machine/` half). `companions-visible` compares runtime and static counts for server barrels, choosing which barrels to import from the cross-refs facet.
- change-feed declares `ChangelogRetention` and L2 contributes it as a companion. change-feed's `onReady` (serving hosts only) asserts at least one retention contribution. It only logs, because change-feed is not `loadBearing`.
- Result: all 21 compositions that bundle change-feed now bundle L2. The demo graph went from 185 to 186 nodes.

### B. The watermark is the database's
- `snapshotWatermark(exec)` is in `database/server` (exported through `server/testing`; R13). `database`'s `onReadyBlocking` installs it with `setWatermarkSource`.
- `LiveStateSnapshotHooks` lost `captureWatermark`, so a degraded L2 init leaves watermarks on (tested).
- `assertServedReadsHaveWatermarkSource` runs in `runPostReadyPhases` over every served key, because every flight captures a watermark, DB-backed or not.
- Desktop frames carry watermarks (`task-categories` → `watermark: "38798284"`). A PGlite pin shows `snapshotWatermark` is greater than a committed write's `currentTxId`. The demo host test asserts a post-write sub-ack watermark greater than the write's xid, and that a prune empties the changelog below the snapshot floor.

### C. Guard cost
- Inference: 110 `Bun.build` calls became 3 (`importClosures`: one union build per fixpoint round, import chains computed lazily on failure).
- The derivation is memoized per `RegistryGenContext`, and `buildRegistryGenContext(root, repo)` is memoized per run file set. Four in-process derivations per check pass became one.
- The coverage scan shares one masked-source memo per file (`ctx.sourceScans()`), filters files by text before masking, and reads in parallel.
- Measured in isolation at load ~15: the guard took about 0.7–0.85 s, down from 3–4 s. Inference took about 1 s, down from 5.8–9.2 s.
- Full-script reruns at load 28–33 are not comparable: even the unchanged `buildRegistryGenContext` went from 6–9 s to 23–30 s. A clean before/after needs an idle host.
- Not done: a cross-process cache of the derivation (not provably sound, because Bun.build's resolution inputs are invisible). `build` therefore still derives twice: once in codegen and once in its check subprocess.

### D. Raw `/api` routes are declarations
- asset-mirror (2), mail image proxy (1), prototype files (3) and thumbnails (1) are `defineEndpoint` GETs with literal routes and `needsMachine`. Their handlers live in `machine/` behind `machineHandler`.
- Consumers use `AssetPath` / `useAssetSrc`, or the new `useAssetUrl` / `assetUrlOver` / `assetBase` for sinks that load by URL themselves (an iframe, `<img>` inside HTML, frimousse).
- The guard throws on any `httpRoutes` key that is neither `[decl.route]` nor a literal, in every backend barrel. The "not judged" skip is deleted. `CENTRAL_RESOURCE_HTTP_ROUTE` is exported from resource-protocol.
- In the demo, mail shows "Displaying an email's remote images isn't available…" in place of the button, and a prototype thumbnail renders loading and unavailable states.
- Desktop verified: thumbnails 200, prototype file 200 and redirect, asset mirror 200, mail image proxy 200 `image/png`.

### Measurements
| | main (same load) | this branch |
|---|---|---|
| Worker bundle | — | 22,986,105 B, 2,521 repo modules, 186 nodes |
| Worker ready (warm, 4 loads) | 1747 / 1800 / 1729 / 1722 ms | 1643 / 1726 / 1811 / 1611 ms |
| Post-ready phase | 21–24 ms | 29–35 ms (L2 catch-up) |
| L2 `onReadyBlocking` in the worker | — | 7–8 ms |
| Inference `Bun.build` calls | 110 | 3 |
| Derivations per check pass | 4 | 1 |

### Tests
- The touched suites pass when each file runs alone.
- The combined 223-file run had 14 failures in 5 tests:
  - `tree-oracle`, `clusters` and `mail-core` account: failed only inside the combined process, and pass alone (7/7, 15/15, 4/4). The cause is cross-suite interference (host-service providers, timing). Not checked against main.
  - `prototypes/checkpoints` `touchedPrototypeIds`: already failing; untouched by this branch.

### Open
1. **Guard:** clean before/after timings on an idle host. Decide whether `build`'s check subprocess must re-derive what codegen just rendered.
2. **`SOURCE_TX_CAP` overflow:** it suppresses the ack without forcing a FULL drain, so a scoped-delta collection confirms only at its next sub-ack (both hosts).
3. **Sonata's instrument factories** still spell `/api/asset-mirror` (`assetMirrorUrl`). The guard will refuse it once Sonata is scoped; pass a resolved base into the factory contract.
4. **Test hygiene:** cross-suite interference in combined runs; tests that never install a watermark source log a loud capture stack per flight.
5. **change-feed's retention assert only logs** (the plugin is not load-bearing). Making it fatal needs a generic serving-host assertion.
6. **Next session:** Pages and Prototypes back in the demo.
