# Demo: writes render — a portable change feed on the worker

Subtrack: "portable server code (server/ vs machine/)" (wiki block-323b766d-7ddf-4555-820a-80d82d6737f3). Previous session: research/2026-10-22-global-demo-scope-sealed.md (Outcome → Open 1).

## Context

The demo is sealed: every write inside `DemoScope` reaches the browser worker and lands in PGlite (New task, a title edit, a dependency and the launch options all return 200). But nothing on screen changes, and a resubscribe does not help either.

**Why (measured in code, not guessed).**
- On the desktop, recomputing a live read after a write has exactly one cause: the DB change feed. AFTER STATEMENT triggers `pg_notify('live_state', …)`, `change-feed/server/internal/listener.ts` LISTENs on a dedicated pg client, and `routeChange` → `runtime.routeTableChange` → `scheduleNotify` → flush → frames.
  - No task handler invalidates anything itself: `tasks/server/internal/handle-create.ts` and `handle-update.ts`, and `tasks-core/…/mutations/tasks.ts`.
  - No task table has a change producer.
- The worker graph (`apps/agent-manager/demo/bin/browser-host.generated.ts`, 183 entries) does not contain `database/change-feed`. So after a write nothing calls `routeTableChange`.
- **The "resubscribe" only looked stale.** A first subscribe to a tuple always reloads in full (`runtime.ts` ~6343, ~6662). The `up-to-date` short-circuit applies only to a second subscriber of a tuple another reader already holds, and its version counter moves only on a notify. So a reader remounted while another still holds the tuple is told its old value is current. Routing changes fixes that too.

**Intended outcome.** A write made in the demo renders in the demo through the same mechanism as on the desktop: triggers, then NOTIFY, then the listener, then `routeChange`, with `ackTx` by xid. The event-driven effects of a write run too, because the worker runs the post-ready phase that the desktop runs (D1). `apps/demo/e2e/no-leak.ts` asserts it.

## The model

`change-feed/server` becomes **portable**, and the one thing that really differs per host moves behind the `DatabaseDriver` host service: **opening a LISTEN session**.

- **The trigger layer is the same on both hosts.** That is the plpgsql DDL, the fingerprints, and the boot invariants A1′/A2′/A3/D6/D35.
- **So is the consumer.** That is the burst router, the end-marker ordering, `routeChange` and the reconnect policy.
- The desktop opens a pg client on the direct socket. PGlite LISTENs on its single in-process connection.
- No `if (browser)` anywhere. Which LISTEN runs is decided by which driver the host booted.

## What blocks portability today (all verified)

| Blocker | Where | Fix |
|---|---|---|
| `createHash` (node:crypto) | `triggers.ts:1,595` | `sha256Hex` from `@plugins/packages/plugins/string-hash/core`. It gives the same digest, so the desktop rebuilds no triggers. |
| `AsyncLocalStorage.snapshot()` | `producer.ts:1,174` (profiler attribution only, not correctness) | A `runInRootContext` runtime in `runtime-profiler/core`, installed by `runtime-profiler/server` with ALS. The default is identity. It follows the pattern of `installSpanContextRuntime`, `installProfilingSuppressionRuntime` and `installBackgroundLaneRuntime` (`recorder.ts`). |
| `createDbClient`, `DbClient`, `connectionString` | `listener.ts:2-6` (connection/server, admin/server: pg, node:*) | New `DatabaseDriverImpl.listen` (G2) |
| `withQueryDeadline`, `BOOT_DDL_QUERY_DEADLINE_MS` | `server/index.ts:10-13` | `DatabaseDriver.get().bootDdl(fn)`. It already wraps that deadline on the desktop (`database/machine/internal/pg-driver.ts:546`) and is identity on PGlite. Add an optional `reason` so the desktop keeps its span label. |
| `ExcludeFromFork` | `server/index.ts:14` (admin/server is machine) | Move change-feed's changelog fork-exclusion into a new `change-feed/machine`. Forking is a desktop concept. |
| `setImmediate` default `defer` | `burst.ts:119`, evaluated at module eval via `listener.ts:336` | `yieldMacrotask` from `packages/macrotask-yield/core` |
| `timer.unref()` | `burst.ts:96`, `producer.ts:324` (a number in a browser, so a TypeError) | The guarded form already used in `resource-runtime/core/runtime.ts:4925`: `(t as { unref?: () => void }).unref?.()` |
| `z.instanceof(Buffer)` and `raw.toString("utf8")` | `route-layout.ts:61,66` (PGlite returns bytea as `Uint8Array`) | `z.instanceof(Uint8Array)` plus `TextDecoder`. `Buffer` is a `Uint8Array`, so the desktop is unchanged. |
| A13: producer `mutate` requires `bootMode === "serve"` | `producer.ts:263` | Admit `"browser"` too: that host has a feed. No producer is in the worker today. This only stops the guard from lying. |
| `startListener()` in `onReady` | `server/index.ts` | It stays there. `bootBrowserHost` gains the post-ready phases (D1). |

The last three rows in the table are **blind spots of the portability guard**: `PLATFORM_GLOBAL_RE` (`boundaries/core/platform-apis.ts`) only matches `setImmediate(`, `Buffer.` and `Buffer(`. G1 closes the class, not just these instances.

## Decisions

- **D1: the browser host runs the post-ready phases, after the seed, and the listener stays in `onReady`.**
  - Today `bootBrowserHost` runs exactly `exec`'s phases. But the worker is a **serving** host, like `serve`, and `exec` is the one host with no subscribers.
  - So: barrier → seed → `onReady` → `onAllReady`, the same sequence `bin/index.ts` runs. The seed goes first so it plays the part of data present at boot.
  - On the desktop nothing moves. `exec` still skips `onReady`, so no exec child opens a LISTEN. Nothing flushes before the barrier lifts (live-state-snapshot's `boot-init.ts:84-86` invariant holds). The relation graph is installed before the listener exists. The catch-up ordering is untouched.
  - What else starts in the worker, audited:
    - `queue` runs `repairBlockedOrder`.
    - `attachments` runs `ensureRoot` (memory blobs).
    - `events` syncs and sweeps its trigger contributions.
    - `jobs` starts the in-process queue and its schedules. This is the agreed design: portable jobs run while the tab is open, and enqueued events like `tasks.titleChanged` / `tasks.statusChanged` now reach their portable subscribers.
    - `custom-columns` watches scoped definitions.
    - `tasks-core` runs `sweepOrphanedAttempts`, which deletes only attempts with no conversation (every seeded attempt has one), and `PushLedger.ensureFresh` on the seeded ledger.
    - Anything that misbehaves shows up in the e2e's no-console-error assertion.
  - Update the header comment of `server-core/core/browser-host.ts`. The alternative, starting the listener inside the barrier, was rejected in review: exec children would each LISTEN, and the barrier would flush early.
- **D2: the driver opens a session; the listener owns the policy.**
  - New: `DatabaseDriverImpl.listen(channels, { notification(channel, payload), lost(err) }): Promise<{ close(): Promise<void> }>`. It resolves once LISTEN on all channels has committed, as one statement, so both channels start together.
  - Reconnect, backoff, the liveness watchdog, first-connect versus `fullSweep`, and `burst.close()`/`reopen()` stay in the portable `listener.ts`, which already has injected timers.
  - **Desktop:** the current `createDbClient({ name: "change-feed" })` direct-socket session moves verbatim into a factory, `openListenSession`, in `database/plugins/connection/server` (which already owns `createDbClient`). That includes the "act only while current" `error`/`end` handling and the deadline semantics. `database/machine`'s `pgDriver.listen` delegates to it. It lives in connection/server because `listener.test.ts` (a `server/` test, whose import row has no `machine`) must import it directly.
  - **PGlite** (`database/plugins/pglite/server/internal/pglite-driver.ts`): uses the root client's `onNotification` (channel plus payload, one queue), plus `LISTEN a; LISTEN b` through `exec`. It never calls `lost`. The `scriptQueries` transaction proxy has no `listen`, so this goes through the root client.
  - `createChangeFeedListener` takes `listen` instead of `connectionString`. `listener.test.ts` keeps its real-Postgres coverage, including the `pg_terminate_backend` reconnect case.
- **D3: a serving host that serves DB-backed reads must have a change feed. This is a loud failure at boot.**
  - At the start of the post-ready phase, which only `serve` and `browser` run: if any DB-backed resource is registered and `setRelationBases` was never called (the feed installs it, D34), throw. The message: "DB-backed live reads on a host with no change feed never recompute".
  - Scoped by phase, not by an `if (mode)`. `exec` and the partial-graph test harnesses (`task-category`'s `portable-boot.test.ts`, `boot-stages.test.ts`) never reach it.
  - The worker boot test does reach it, so today's silent freeze becomes a test failure.
  - This is rung 4, because only boot knows the graph's resources. No codegen rule names change-feed: that would be a consumer naming a contributor.
- **D4: getting the feed into the worker graph.** Once it is portable, it joins if it is in `agent-manager-demo`'s bundle. The graph is that composition's portable server barrels.
  - Verify with `./singularity build`, which regenerates `browser-host.generated.ts`.
  - If it is absent, add `database.change-feed` to the `agent-manager` composition. A standalone desktop agent manager needs it just as much.
  - D3 fails the boot test if this is missed.

## Gates

**G0 — PGlite spike** (a Bun test in `database/plugins/pglite`, kept as a regression test). On PGlite 0.5.10, with the real `rebuildTriggers` on a tiny schema:
- statement triggers with `REFERENCING OLD/NEW TABLE` work;
- `pg_current_xact_id()` works;
- the deferred `CONSTRAINT TRIGGER` end marker fires at commit;
- `onNotification` delivers only after commit, with `live_state` before `live_state_end` for one transaction and nothing for a rolled-back one;
- `tgargs` comes back as `Uint8Array`.

If any of these fails, stop and re-plan; don't work around it.

**G1 — close the guard's blind spot.**
- Catch value uses of `setImmediate` (called or passed as a value) and of `Buffer` (in an expression), plus an unguarded `.unref(`. Keep the value-use-only contract:
  - a type position is not a use (`interface Buffer`, `setImmediate?:`);
  - a property key or destructuring key is not a use;
  - the guarded `.unref?.()` is not a use.
- Prefer a TypeScript AST pass over a wider regex.
- Add regression cases to `platform-apis.test.ts` for `macrotask-yield/core/internal/yield.ts`, change-feed's `producer.ts` (local `Buffer` interface) and `runtime.ts:4925`, which must stay clean.
- Run `boundaries:portable-closure`. Fix every new hit in an already-portable closure, the same way as in the blockers table, and list them in the Outcome.
- If the count explodes (more than about 15), stop and report it before going on.

**G2 — `DatabaseDriver.listen`.**
- Add it to the interface (`database/server/internal/driver.ts`) and to both providers (D2).
- Refactor `listener.ts` onto it.
- `listener.test.ts` and `burst.test.ts` must stay green.

**G3 — make change-feed portable.**
- Apply the blockers table: sha256Hex, `runInRootContext`, `bootDdl`, `change-feed/machine` for the fork exclusion, `yieldMacrotask`, `unrefTimer`, `Uint8Array`, A13.
- Set `portable: true` and delete the `exempt/index.ts` debt entry.
- The `change-feed:producer-writes` check and the `server/testing` barrel are unchanged.

**G4 — wire it on both hosts.**
- `bootBrowserHost` runs the post-ready phases after the seed (D1), and the server-core assertion is added (D3).
- Get the feed into the worker graph (D4).
- Resolve whatever the guards say. Review found no expected complaint: no in-scope resource declares `outsideFeed`, and machine halves are not inspected. Expected side effect: tables that out-of-graph plugins exclude or produce (reports, debug) get ordinary triggers in the worker. That is harmless, but it counts in G7's `installFeed` cost.

**G5 — a Bun test on PGlite, end to end.** Extend the existing "closure boots on PGlite" test, or the browser-host boot test:
- boot the worker graph;
- subscribe to the tasks collection and to one task's value;
- `createTask` and `updateTask` through the real handlers;
- assert a delta or update frame and an `ack` for the write's xid.

This is the non-browser proof that a write recomputes.

**G6 — e2e asserts it.** In `apps/demo/e2e/no-leak.ts`:
- Promote the two `r.note`s to `r.ok`: the created task's row renders, and the edited title renders in the tree. Use `waitFor`, not a single count.
- Add assertions that:
  - the edited title shows in the task detail header;
  - the new prerequisite shows in the detail's dependencies card;
  - each launch-option pick renders from its side table: Thinking mode, Preprompt, plus Workspace and Auto-start whenever they are enabled;
  - a pasted image renders in the read-only description once the editor closes, and the task's attachments card lists it;
  - **a second subscriber sees the new state:** close and reopen the task detail while the tree still holds `taskRows`. This exercises the `up-to-date` version short-circuit, the only stale path. A page reload would reseed the in-memory database, and a first subscribe always reloads.
- Keep every existing leak assertion.
- Update the header comment, which currently says writes are "noted, not asserted".

**G7 — desktop parity and measurements.**
- Desktop smoke on this worktree's build: edit a task title and add a dependency, and both render.
- `./singularity test plugins/database/plugins/change-feed plugins/database/plugins/live-state-snapshot`.
- Boot logs: the steady-state restart still takes zero table locks, because the trigger fingerprints are unchanged by the sha256 swap.
- Measure:
  - worker boot to ready, before and after, warm, 3 loads;
  - the `installFeed` span on PGlite (a fresh in-memory database rebuilds every table's triggers on every boot);
  - worker bundle bytes and modules;
  - write-to-render latency in the demo (POST response → row visible).
- If `installFeed` adds more than about 400 ms to worker boot, record it and file a follow-up, for example a pre-migrated PGlite data dir. Don't specialise the install for PGlite.

## Reuse

- `sha256Hex`: `plugins/packages/plugins/string-hash/core`. Same digest as `node:crypto`; jobs' `superseded-trigger.ts` is precedent.
- `yieldMacrotask`: `plugins/packages/plugins/macrotask-yield/core`.
- `DatabaseDriver.bootDdl`: `plugins/database/server/internal/driver.ts`.
- The runtime-install pattern: `plugins/infra/plugins/runtime-profiler/core/recorder.ts` (`install*Runtime`).
- `createChangeRouter` / `routeChange`: `change-feed/server/internal/route-change.ts`. Unchanged; it is already any-runtime.
- e2e harness: `waitFor`, `report`, `tapSharedSocket` (`e2e-harness/e2e`, `networking/e2e`).
- Seed tasks for the e2e: `task-demo-dark-mode`, "Dark mode resets after a reload" (`apps/agent-manager/demo/core/internal/stories.ts`).

## Risks

- **PGlite notification semantics** (G0 retires this). Ordering across channels is the one the burst router depends on.
- **Boot cost** of a full trigger rebuild on a fresh in-memory database, on every load (G7 measures it).
- **The worker's changelog grows unbounded.** The prune lives in live-state-snapshot, which is not in the worker. It is negligible for a demo session; recorded as a follow-up, not solved here.
- **Portable jobs and schedules now run in the worker** (D1). A job written assuming the computer but living in `server/` would surface here. The e2e's no-console-error assertion and G5 catch it.
- **The ack backstop is absent on the browser host.** It sends no snapshot watermark (`server-core/core/resources.ts:408-412`), so an optimistic op whose exact `ackTx` is missed (more than `SOURCE_TX_CAP` = 64 per cycle, or evicted) stays pending. Exact acks reach parity; the watermark is a follow-up: a portable `captureWatermark`, `pg_snapshot_xmin(pg_current_snapshot())`, served without the rest of L2.

## Verification

1. `./singularity test plugins/database/plugins/pglite plugins/database/plugins/change-feed plugins/database/plugins/live-state-snapshot plugins/framework/plugins/server-core plugins/tasks/plugins/task-category plugins/framework/plugins/tooling/plugins/boundaries`. Covers the G0 spike, the listener (real Postgres) and the G5 end-to-end test on PGlite.
2. `./singularity build`, green: checks including `boundaries:portable-closure`, `browser-host:contributions-covered`, `host-services:provider-placement`, `plugins-registry-in-sync`.
3. `./singularity run plugins/apps/plugins/demo/e2e/no-leak.ts`, all assertions passing, including the new render assertions.
4. A desktop smoke through `browser_*`: edit a title and add a dependency on `http://<worktree>.localhost:9000/agents/…`, and both render.
5. Measurements table in the Outcome; wiki subtrack page updated; next task filed.

## Outcome (2026-10-22)

Every gate landed. The last build is green and deployed. `apps/demo/e2e/no-leak.ts` passes 30/30, with every write now asserted to render:
- the created task;
- the edited title, in the tree, in the detail header, and again after reopening;
- the new prerequisite;
- Thinking mode and Preprompt (Workspace and Auto-start are disabled on this host);
- the pasted image, in the editor, the description and the Attachments card;
- a second subscriber: the detail is closed and reopened while the tree still holds the rows.

Every leak assertion still passes.

### What changed
- **change-feed is `portable: true`.**
  - `sha256Hex` replaces `node:crypto`. The fingerprints are identical: the desktop's steady-state restarts log "signatures unchanged — skipping rebuild".
  - `runInRootContext` is a new install-pattern runtime in `runtime-profiler/core`, and its server half installs the ALS version.
  - The trigger rebuild runs under `bootDdl(fn, reason)`.
  - The burst router's default `defer` is `yieldMacrotask`. Timers use the guarded `unref?.()`.
  - `tgargs` are read as `Uint8Array` and decoded with `TextDecoder`.
  - A13 admits `"browser"`.
  - The fork exclusion moved to the new `change-feed/machine`, and the debt exemption is deleted.
- **`DatabaseDriverImpl.listen(channels, { notification, lost })`.**
  - Desktop: `openListenSession` in `database/connection/server`, which is the old listener's session code. `database#machine` delegates to it.
  - PGlite: the root client's `onNotification` plus `LISTEN a; LISTEN b`.
  - `listener.ts` keeps the reconnect policy and takes an injected `listen`.
- **The serving hosts share their post-ready phases.**
  - `runPostReadyPhases` in `boot-stages.ts` runs D3 (`assertDbReadsHaveChangeFeed`), then `onReady`, then `onAllReady`. Both `bin/index.ts` and `bootBrowserHost` call it; the browser host calls it after its seed.
  - `exec` and partial-graph test boots never reach it.
  - The worker now starts the in-process job queue and its schedules.
- **D4 needed no composition edit.** The regenerated worker graph took in `database/change-feed` (184 → 185 nodes).
- **G1:** the platform-global guard is a TypeScript AST pass (`platformValueUsesIn`) instead of a regex. It is value-use only, and its regression cases are in `platform-apis.test.ts`. It found nothing new in closures that were already portable.
- **Found on the way, a pre-existing bug, fixed:** `infra/endpoints/web/internal/asset-src.ts`. `useAssetSrcs` threw away what `useSyncExternalStore` returned and read the store directly. Under the React Compiler, the answer was then memoized on the asset list alone, so an image that mounted while its bytes were loading spun forever. This only happens on blob-serving hosts (the demo). The snapshot is now an immutable map, read through the hook.
- **`imperative-create-table-allowlisted`:** a test that opens an argument-less, in-memory PGlite is now recognised as a throwaway database, like `createTestDb`.
- **The review found two listener defects, both fixed:**
  - `openListenSession` dropped NOTIFYs delivered while the LISTEN statement was still in flight. They are now forwarded.
  - `stop()` racing an in-flight open leaked the session. The session is now closed, and `listener-stop.test.ts` covers it.

### Measurements
| | main now | this branch |
|---|---|---|
| Worker bundle | 22,913,936 B | 22,962,302 B (+48 KB) |
| Worker repo modules | 2,485 | 2,504 |
| Worker graph nodes | 184 | 185 |
| Worker boot to ready (warm, 3 loads) | 1276 / 1195 / 1251 ms (avg 1241) | 1362 / 1354 / 1372 ms (avg 1363, +122) |
| `installFeed` on PGlite | — | 204 / 202 / 202 ms |
| Post-ready phase in the worker | — | ~16 ms |
| Demo title edit → visible in the tree | never | 22–29 ms after the edit (the delta lands before the PATCH response) |
| Desktop title edit → visible in the tree | | 107–136 ms |

### Open
1. **The worker's `live_state_changelog` is never pruned.** Nothing reads it there. Prune it, or skip the outbox, where no catch-up consumer is booted.
2. **The ack watermark backstop is still absent on the browser host.** Exact `ackTx` acks work; a missed one has no fallback.
3. **Two test failures already on main, not caused by this branch:**
   - `connection/lint/no-raw-pg-connection.test.ts`: six stale `valid` cases since the inverted-exemptions refactor (`49091e8c6e`).
   - `task-category/portable-boot.test.ts`: no ConfigStore provider since `f4ec26f75b`.
4. **Test hygiene:**
   - barrel-import's stub `window` leaks into the shared bun process, which sends PGlite down its browser path. Three suites now re-run themselves in a fresh process; that helper should be shared.
   - Listener tests write into the worktree's `change-feed` log channel.
5. **A lint against discarding `useSyncExternalStore`'s result.** That pattern breaks under the React Compiler the same way `asset-src.ts` did.
6. **Workspace and Auto-start were not exercised by the e2e:** both are disabled on this host.
