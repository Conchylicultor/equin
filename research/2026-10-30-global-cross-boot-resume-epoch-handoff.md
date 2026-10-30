# Resume the epoch across a hot swap: the handoff (phase 2)

**Date:** 2026-10-30 · **Category:** global (resource-runtime, query-resource, change-feed, live-state-snapshot, server-core)
**Task:** task-1793368132-bk33ds · **Parent:** research/2026-10-30-global-cross-boot-resubscribe-resume-epoch.md (part 1)

## Context

After a backend restart the open tabs replay every sub. `config-v2.values` is now answered by
ETag (phase 1, 4a6aa14946). What remains are the `*:rows` point reads
(`conversation-progress`, `conversation-preprompts`, `task-short-titles`, `conversations.by-id`):
247 loader runs on the measured restart, each ~10 ms of work and ~1.4 s of queueing in the
6-slot read gate. They take the full path because the version short-circuit's epoch is random
per process, so nothing proves an unchanged tuple is still current across a restart.

**The hard requirement (supervisor brief):** the failure mode is a stale value served as
`up-to-date`, which nothing heals until the next change. So any doubt must fall back to a
full loader run, never to `up-to-date`. Doubt includes:
- a missing or partial record;
- a cut not proven complete;
- a definition or code change;
- an epoch mismatch.

Each fallback arm gets a test. A class that cannot be proven stays on the full path.

### What exploration changed vs the parent doc

- **The parent doc's eligible set is empty as written.** It says entries "with a
  `definitionOf`" qualify: windows, point reads and aliases. Only the `all` (alias) compile
  carries a definition today (`compile-alias.ts`). Every bounded compile passes none
  (`compiledRoutePlan(..., definition?)`: "Absent for every bounded compile").
  So the point compile must mint one first (see 1).
- **The change feed holds a transaction's changes until its end marker arrives**
  (`createBurstRouter`). So a barrier NOTIFY arriving is not enough: the barrier must also
  flush what the burst router holds. A flush is sound because everything held committed
  before the barrier.
- **`onShutdown` hooks run concurrently** (`runShutdownHooks` is a `Promise.all`), so
  change-feed's `stopListener` would race the barrier. The handoff therefore runs as its own
  step before the hooks, in the serving host's `shutdown()`. Sockets close only at
  `process.exit`, and the gateway SIGTERMs the old backend only after the swap, so the record
  is written before any tab reconnects.
- **Produced tables (traces, slow-ops, reports) have no trigger and no changelog.** Neither do
  feed-excluded tables or rollups. An entry routed on any table outside the changelog's
  coverage is not eligible.

## As built (deviations from the design below)

- The point definition is not `RoutePlanInput.definition` (that stays the L2
  one, persisted entries only) but a separate `handoffDefinition` THUNK on the
  plan: rendering the SQL goes through the database driver, which the compile
  (at module eval) must not touch. Memoized by the compiler.
- `handoffState` does not check for an in-flight load (the runtime has no
  per-tuple flight index): a flight running at the cut acks its client at the
  version current then, with a value read after the change it raced — any
  change below the cut was routed (a pending ⇒ left out), any change at or
  above it is replayed (⇒ dirty). The claim likewise does not refuse a tuple
  another tab's full-path load is still reading: that load's value is newer
  than the cut, and a clean shadow proves the old one equal to it.
- A client whose cached version equals the inherited one drops the
  `up-to-date` by its version guard (it still counts as answered), so its
  entry keeps the OLD epoch. Its next replay echoes that epoch again; the
  record of that boot (kept an hour) is then replayed over the whole interval
  since its cut, which is still sound — or it loads.
- Shadow expiry is not covered by a test (a 60 s module constant).

## Design

The proof: if the old backend would have answered `up-to-date` at the cut, and no change has
reached the tuple since the cut, then the client's value is current.

### 1. A definition for a compiled point read (`query-resource`)

The point kind of `compileWindowQuery` mints `definition` = sha256 over:
- the point query rendered through drizzle's `PgDialect` (`renderQuery`) at a placeholder id;
- each projected field's `decoderId`;
- `describeZod` of the row schema;
- the encode-row id;
- `POINT_DEFINITION_VERSION`.

It reuses `fingerprint.ts` as is. **Fail-closed: no definition** in these cases:
- a function `where`;
- an `encodeRow` with no id;
- an opaque decoder or schema part;
- a non-literal param.

An entry with no definition is never inherited. `serveCollection` passes an `encodeRowId`
only when its encodeRow is the `$columns` fold alone (`fold:<sorted wire→set.field>`); a
wire-codec column has no id, so it gets no definition. The definition rides the existing
`RoutePlanInput.definition`. Point entries are never persisted, so no L2 path reads it.

### 2. The cut primitive (`change-feed`): `feedCut()`

`feedCut(): Promise<{ cutXid }>` works in four steps:
1. Capture `X = pg_snapshot_xmin(pg_current_snapshot())`.
2. Send `pg_notify(live_state_barrier, token)`. The listener LISTENs it in the same statement
   as the feed channels.
3. On that token, the listener flushes the burst router (it routes every held transaction)
   and resolves.
4. It rejects with no live session, or past a deadline (1.5 s).

**Why it is complete:**
- Every transaction with xid < X committed before step 2 committed. Postgres delivers one
  session's notifications in commit order, so their NOTIFYs and end markers arrive before
  the barrier.
- Routing (`routeTableChange`) is synchronous, so their pendings exist when it resolves.
- A transaction with xid ≥ X is in the changelog, which the successor replays.

The sibling task (kjrocf, persisted-floor raise) reuses this.

### 3. The old backend writes the record (`resource-runtime` + `live-state-snapshot`)

- Runtime `handoffState()`: `{ epoch, tuples: [{ key, pk, version, definition }] }`. It
  lists every tracked tuple of an **eligible** entry that:
  - has a snapshot and a version > 0;
  - has no pending notify, is not draining, and has no load in flight.

  The same predicate decides at the claim.
- An entry is **eligible** when all of these hold:
  - it is a routed point membership with a definition;
  - it has no drift (no `drifted`, `driftBases` or `seededDrift`);
  - it reads no relations, derived reads, unfed, notified, tagged or `via` tables;
  - it has no `onFirstSubscribe`, no `authorize`, no upstream edges and no revalidate;
  - it is not external.
- live-state-snapshot `writeEpochHandoff()`:
  1. `feedCut()`;
  2. `handoffState()`;
  3. INSERT one row into the new `live_state_handoff` table (epoch PK, cut_xid, tuples
     jsonb, written_at), deleting rows older than 1 h;
  4. the whole step is bounded by a 3 s deadline.

  Any failure is reported and writes no record. The table is fork-excluded.
- server-core: `setEpochHandoffHooks({ write, load })` (the boot-injection pattern). The
  serving `shutdown()` awaits `handOffEpoch()` before `runShutdownHooks`.

### 4. The successor resumes (`resource-runtime`)

- A new runtime option, `resumeEpoch(epoch)`, resolves to `null | { cutXid, tuples,
  changelogTables, replay(route) }`.
- A single flight per foreign epoch runs `resumeFor(epoch)`:
  1. Load the record. If there is none: refusal `no-record`.
  2. For each tuple whose entry is eligible here too, has an **equal definition**, and has
     every route table in `changelogTables`: install a **shadow** `{ version, dirty: false }`
     (synchronously).
  3. `await replay(markShadows)`. This reads the changelog rows with `xid ≥ cutXid` and then
     the prune horizon. It reports `pruned` (refusal) when the horizon ≥ cutXid.
     It is also refused (`healed`) if this boot healed a rollup.
  4. Shadows are installed before the replay read, so live changes and the replay together
     cover everything since the cut.
- **Shadow marking:**
  - `routeEntryChange` evaluates every shadow of the entry. A shadow is marked dirty unless
    `routeTuple` is `untouched`, or is scoped with nothing left after the point-id cut.
  - A drifted or unrouted table, or a `usesOf` failure, marks it dirty.
  - `scheduleNotify` marks dirty the shadow of its pk, or every shadow of the key for `{}`.
- **Claim:** this happens in `handleSub` and `handleSubBatch`, for a foreign `(epoch, version)`
  on an eligible entry. The flow awaits `resumeFor` and then re-checks: the shadow is present,
  clean, and `shadow.version === echoed version`. Then one of these applies:
  - **Opened by a claim:** `inherited[slot] === versions[pk]` → `up-to-date` at that version.
  - **Fresh here:** the span opened at version 1 by this process's first registration, with
    no snapshot, pending, draining or in-flight load. Then `versions[pk] = version`,
    `inherited[slot] = version` → `up-to-date (bootEpoch, version)`.
  - **Anything else** (`loaded-here`): full path.
- After the claim the tuple is ordinary and tracked, with no snapshot. Its first change
  drains FULL (`drainMembershipFull`), as for any snapshot-less tuple.
- Shadows and the memo expire 60 s after install (a one-shot unref'd timer).
- `_debug` gets `resume: { resumedSubs{key}, refusals{reason} }`.

### What stays on the full path (stated in the report)

These stay on the full path in v1:
- windows (params-dependent SQL; a follow-up can fingerprint them the same way);
- `all` aliases (persisted, with their own catch-up);
- externals and `revalidate` entries (their ETag already covers them);
- hand-written loaders;
- point reads with a wire codec, a function `where`, drift, or a table outside the changelog.

## Critical files

- `plugins/infra/plugins/query-resource/server/internal/compile-window.ts`, `fingerprint.ts`: the point definition.
- `plugins/network/plugins/live/server/internal/serve-collection.ts`: `encodeRowId`.
- `plugins/database/plugins/change-feed/server/internal/listener.ts`, `burst.ts`, `txn-end.ts`: the barrier channel and `feedCut`.
- `plugins/framework/plugins/resource-runtime/core/runtime.ts`: `handoffState`, `resumeEpoch`, shadows, the claim and `_debug`.
- `plugins/framework/plugins/server-core/core/resources.ts`, `bin/index.ts`: hook injection and the shutdown step.
- `plugins/database/plugins/live-state-snapshot/server/`: the table DDL, write and load/replay (reusing `catch-up.ts`'s row reader + `readLayout`, `isPrunedPast`).
- `plugins/database/plugins/admin/server/internal/fork-exclusion.ts`: exclude `live_state_handoff`.

## Verification

- Runtime harness `core/runtime-resume-epoch.test.ts`. Each fallback arm is covered:
  - a clean inherited tuple gets `up-to-date` with 0 loader runs;
  - a second tab is answered from the same inheritance;
  - no record → load;
  - a definition mismatch → load;
  - an echoed version mismatch → load;
  - a dirty shadow from the replay → load;
  - a dirty shadow from a live change after install → load;
  - `pruned` → load;
  - an ineligible entry (no definition) → load;
  - a tuple already loaded here → load;
  - a pending tuple is excluded from `handoffState`;
  - an expired shadow → load;
  - after a claim, the first change ships a FULL frame.
- query-resource: the point definition is stable across two compiles. It moves with the
  select, the where and the schema. It is null for a function `where`, an `encodeRow` without
  an id, and an opaque decoder.
- change-feed DB test: `feedCut` resolves only after a held burst is routed, and rejects
  with no session.
- live-state-snapshot DB test: write/load round trip; replay since cut; pruned past ⇒ refusal.
- End-to-end: on the worktree build with 3 tabs, restart (`./equin build`) and compare
  `_debug.resume`, the read-admit queue and the `*:rows` loader counts.
- `./equin check`.
