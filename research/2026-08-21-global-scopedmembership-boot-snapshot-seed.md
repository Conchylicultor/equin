# Seed the in-memory diff base from L2 so a persisted `scopedMembership` resource skips its per-boot FULL recompute

## Context

Every server boot, the first DB change to a persisted (boot-critical)
`scopedMembership` resource — `tasks`, `attempts`, `conversations-active`,
`conversations-system`, `browser` bookmarks, `plugin-health` — costs a **FULL**
recompute: an unbounded O(collection) scan (`buildFull`, no `LIMIT`), a full
per-row snapshot rebuild, and a full `value`-as-jsonb `persistSnapshot` write.
These are the heaviest live-state values in the app (the whole task tree, all
attempts, all active conversations), so this is real, repeated boot latency.

It happens for two reasons, both wasted work (the value is already correct and
durably stored — this is pure over-computation, not a correctness gap):

1. **The in-memory diff base is never restored at boot.** A persisted
   `scopedMembership` alias reconstructs its FULL value incrementally by
   `JSON.parse`-ing its per-pk snapshot (`entry.snapshots`, the `retainSnapEncoder`
   canonical-JSON map). That map is allocated **empty** at registration
   (`runtime.ts:1987`) and only ever filled by an actual recompute or a sub-ack.
   The durable `live_state_snapshot.value` row holds the exact value the map would
   be rebuilt from, but nothing wires the row into the map. So the first change per
   pk hits `!hasSnapshot` (`drainEntry`, `runtime.ts:3189-3194`) and degrades to
   `drainMembershipFull`. After that one FULL the snapshot is seeded and every
   later change resumes scoped — the cost is strictly the first change per boot.

2. **Catch-up strips DELETE ids, so a delete during downtime replays as FULL.**
   `replayChange` (`catch-up.ts:27-33`) nulls `ids` on every `D` row. For a
   membership entry the live path routes a `D`-with-ids to a cheap **scoped exit**
   (`deleted` set → remove from snapshot, *zero* queries;
   `applyDbChange`, `runtime.ts:4497-4508`). Nulling the ids forces `affected =
   null` → FULL, defeating that path for exactly the membership resources it
   exists for. This also silently violates catch-up's own stated invariant —
   *"replay the missed rows as if they had just arrived"* — which the live path
   does not.

The two compound: fix (2) alone does nothing at boot, because a `D`'s scoped
`deleted` set still hits `!hasSnapshot` → FULL until fix (1) seeds the base. Both
land together.

Confirmed against the code and the design docs
(`plugins/framework/plugins/resource-runtime/CLAUDE.md` §"Bounded membership",
`live-state-snapshot/CLAUDE.md`,
`research/2026-06-22-global-live-state-l2-persisted-materialization.md`). Note the
resolved subtlety: `scopedMembership` folds to `{kind:"window", bounded:false}`, so
`membershipBounded()` is **false** for it — it *is* persisted and goes through the
**membership** drain branch (scoped-if-`hasSnapshot`), not the plain-keyed
always-FULL branch. Only this unbounded-window alias (`isUnboundedWindow`) keeps
`retainSnapEncoder` bytes and survives N→0 when persisted, which is exactly why its
durable value is byte-sufficient to reconstruct the in-memory base.

**Out of scope** (noted, not fixed here): a *non*-persisted `scopedMembership`
resource evicts its snapshot on every N→0 and re-pays FULL on a bursty
subscribe/unsubscribe cycle. That is a live-path concern, not a boot one.

## Approach

Two coordinated changes. The primary is (1); (2) removes a divergent code path so
catch-up replays a delete identically to the live path.

### Fix 1 — seed `entry.snapshots` from the persisted L2 row at boot (before catch-up)

Reconnect the two halves that already hold the same value: the durable
`live_state_snapshot.value` and the in-memory `entry.snapshots` diff base. Reuse
`snapshotOf(entry, value)` (`runtime.ts:2382`) — the exact primitive the sub-ack
seed and FULL rebuild use to turn a value array into the per-pk `Map<rowId,
SnapEntry>`; for the alias it uses `retainSnapEncoder`, byte-identical to what
`drainMembershipScoped` later `JSON.parse`s.

**New runtime accessors** (mirror `boundedMembershipKeys` exactly — inner fn on the
runtime, added to the returned object, re-presented through server-core):

- `unboundedWindowKeys(): string[]` — registered keys where `isUnboundedWindow(entry)`
  is true. Symmetric to `boundedMembershipKeys()` (`runtime.ts:4642`).
- `seedPersistedSnapshot(key, paramsKey, value): void` — guard: entry registered,
  `isUnboundedWindow(entry)`, and **no snapshot already present** for `paramsKey`
  (never clobber a fresher sub-ack seed). Then
  `entry.snapshots.set(paramsKey, snapshotOf(entry, value))` and
  `reseedOrderSigs(entry, paramsKey, value)` (a no-op for the alias, which declares
  no `orderSignatureOf`, but keeps the seed lifecycle identical to the FULL
  rebuild). No-op if any guard fails, so a wrong key from the caller is harmless.

**Wire it in at boot**, in `live-state-snapshot/server/index.ts`'s `onReady`,
*before* `runCatchUp(db)` so replays already find a base and go scoped. Fold into
the existing read-set loop; read seed values in one batched query via the existing
`readPersistedSnapshots(db, keys)` (jsonb comes back as a parsed JS array — no
`JSON.parse` needed):

```ts
const usable = await readPersistedReadSets(db);
const aliasKeys = new Set(unboundedWindowKeys());
const seedKeys: string[] = [];
for (const key of bootCriticalKeys()) {
  if (!usable.get(key)?.length) { recomputeResource(key); continue; } // force-FULL, unchanged
  if (aliasKeys.has(key)) seedKeys.push(key);
}
if (seedKeys.length) {
  const values = await readPersistedSnapshots(db, seedKeys);
  for (const [key, value] of values) seedPersistedSnapshot(key, "{}", value);
}
await runCatchUp(db);
```

All L2 v1 rows are param-less (`params_key = "{}"`), matching `readPersistedSnapshots`'s
own filter and `paramsKey({})`.

**Why eager-at-boot, not lazy-on-first-miss:** a lazy seed inside `drainEntry`
would scatter a DB read into the hot flush path and need a new `readPersistedValue`
hook. Eager is bounded, one batched read, reuses the existing boot read pattern,
and — critically — runs *before* catch-up so the missed-changes replay is scoped
too. Same observable result, cleaner locality.

### Fix 2 — stop stripping DELETE ids in catch-up replay

Delete the special-case in `replayChange` (`catch-up.ts:28`) so a replayed change
routes exactly as the live listener would:

```ts
route({ table: row.t, op: row.op, ids: row.ids, xid: null });
```

Safe for every op: a genuinely id-less bulk statement still has `row.ids === null`
→ FULL; a plain (non-membership) keyed entry already routes `I`/`D` to FULL
regardless of ids (`applyDbChange`); only a **membership** entry gains the scoped
exit it gets live. Update the now-stale comment block (lines 20-26) that claims a
delete "cannot be a scoped recompute."

### Seed–replay idempotency (why over-replay stays correct)

The snapshot floor for catch-up is `min(position)` across *all* persisted rows, so
a row seeded at its own (newer) watermark may see replays older than it. This is
safe because the membership scoped path is **re-query based**, not delta-apply: a
replayed `I`/`U` re-`SELECT`s the affected ids at *current* DB state and reconciles
(idempotent for an already-applied change); a replayed `D` removes a key, a no-op if
already absent. `runtime-catchup.test.ts` already pins over-replay idempotence;
extend it to cover the seeded case.

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — add
  `seedPersistedSnapshot` + `unboundedWindowKeys` inner fns (near `boundedMembershipKeys`,
  `runtime.ts:4642`), the `ResourceRuntime` interface entries (near `:1160`), and
  the returned-object entries (`:4650`). Reuses existing `snapshotOf`,
  `isUnboundedWindow`, `reseedOrderSigs`.
- `plugins/framework/plugins/server-core/core/resources.ts` — destructure + comment
  the two new values (near `:303`).
- `plugins/framework/plugins/server-core/core/index.ts` — re-export the two new
  values (near `:46`).
- `plugins/database/plugins/live-state-snapshot/server/index.ts` — seed loop in
  `onReady` before `runCatchUp` (imports the two new accessors + existing
  `readPersistedSnapshots`).
- `plugins/database/plugins/live-state-snapshot/server/internal/catch-up.ts` — the
  one-line `replayChange` change + comment.

### Docs to update

- `resource-runtime/CLAUDE.md` §"Bounded membership … Persistence" — note the boot
  seed restores the alias's diff base so the first post-boot change is scoped.
- `live-state-snapshot/CLAUDE.md` — the boot flow now seeds membership bases before
  catch-up; catch-up preserves `D` ids (replay ≡ live path).

## Tests

- **`live-state-snapshot/server/internal/catch-up.test.ts`** (DB-backed, recording
  `route` spy): flip the existing `D`-row expectation from `ids: null` to the
  preserved ids (lines ~91/99). The genuinely-`null`-ids `U` row stays FULL.
- **`resource-runtime/core/runtime-scoped-membership.test.ts`**: new case — after
  `seedPersistedSnapshot(key, "{}", value)`, the first change resumes **scoped** (no
  FULL). The existing "first pre-snapshot change FULL-recomputes" case is unchanged
  (it does not seed), proving the seed is the only difference.
- **`resource-runtime/core/runtime-catchup.test.ts`**: extend over-replay
  idempotence to a seeded entry replaying `I`/`U`/`D` at xids straddling the seed
  watermark; assert the client view converges and no FULL fires for an in-window
  scoped change.

## Verification (end-to-end)

1. `./equin build` (background), then confirm deploy via
   `~/.singularity/worktrees/<wt>/build-status.json` → `status: ok`.
2. `./equin test plugins/framework/plugins/resource-runtime` and
   `./equin test plugins/database/plugins/live-state-snapshot`.
3. Live check with the runtime profiler: pick a heavy alias (`tasks`), restart the
   backend, make one small mutation (e.g. rename a task), and confirm via
   `get_runtime_profile` / the op log that the first post-boot recompute for
   `tasks` runs the **scoped** `WHERE id IN (…)` refill, not the unbounded
   `buildFull` scan — and that a task **delete** during a brief restart window
   replays with **zero** loader queries. The boot profile Gantt (Debug → Slow
   Events / Profiling) should show the first-change cost drop from O(collection) to
   O(changed) for these resources.
