# Direct-op single-flight: N concurrent identical checks/tests in one worktree cost one run

## Context

On 2026-10-09 the "Sonata prototype redesign" conversation (worktree `att-1791476180-qcx5`) fanned out ~14 subagents, each running `./singularity check type-check`. That gave 11 concurrent runs (4 granted, 7 queued) plus relaunches, with each type-check worker at 15–20 GB. About 100 GB went into the compressor on a 64 GB host. Checks with a p50 of about 2 min ran for more than 1 h, and every other worktree's builds and E2E runs sat behind the host CPU grant.

Today, nothing lets two callers in one worktree share a run:

- **The check cache only helps after a run finishes.** It is host-global (`~/.singularity/check-cache/`, `checks/core/cache.ts`) and records passes only (`runner.ts:619`, `:653`). Concurrent runs on the same tree all miss it.
- **The direct-op lifecycle never asks whether the same op is already in flight.** `withDirectOp` (`op-runtime/cli/direct-op.ts`) writes one marker per op, so "two checks in one worktree are two markers", and each one queues separately for a host grant.
- **Grants are taken before any cache lookup.** `withHostGrant` runs before `runChecks`, and a `Grant` cannot be released early, so even a cache-hit duplicate holds a share for its whole run.
- **`test` has no result cache at all.** Its durable record, `test-status.json`, sits at one fixed path per worktree, so concurrent runs overwrite each other's status.

**Goal:** N near-simultaneous requests for the same work in one worktree cost about one run.

**Correctness bar:** a caller only ever adopts a verdict from a run that started on the same tree content (tree hash) its own request saw.

## Design

The design has one primitive, a cross-process single-flight, used at two levels:

1. **Run level**, before the grant, in `withDirectOp`. It handles exact duplicates such as N subagents typing the same command, and it covers `check` and `test`. A joiner never takes a grant.
2. **Check level**, inside the runner, per (check, sig, tree). It handles overlapping but different selections, for example a build's nested `--scope tree,deploy` check next to a plain `check type-check`, or `check` next to `check type-check`. A waiter holds the slot its op already has but spends no CPU or memory.

Level 1 alone would have prevented the incident. Level 2 closes the overlap case and is a second consumer of the same primitive. Each level ships as its own phase.

### Primitive: `packages/single-flight` (new, `server` runtime)

```ts
type Flight<V> =
  | { role: "lead"; publish(v: V): void }       // caller runs the work, then publishes
  | { role: "joined"; leader: LeaderInfo; verdict: V };

singleFlight<V>(dir, key, {
  schema: ZodParser<V>,
  onJoin?(leader): void,                        // hook: print "joining…", open an op-log wait
  adoptable(v: V): boolean,                     // e.g. success|failed, never interrupted
}, lead: (publish) => Promise<R>): Promise<...>
```

**Lead path:**

- The lock file is `<dir>/<sha256(key)>.lock`. The lead attempt uses `flockTry` (`packages/flock`).
- The winner writes `<sha>.leader.json` with `{ opId, pid, key, startedAt }`.
- It runs the work, then writes `<sha>.verdict.json` with `{ leaderOpId, verdict }` atomically (temp file plus rename, the same shape as `publishAtomic` in `cache.ts`).
- It releases the lock only after the verdict is written. The kernel releases it on SIGKILL.

**Join path:**

- When `flockTry` fails, the joiner reads `leader.json` and calls `onJoin`.
- It waits for the lock **push-based**. It does not poll. The wait reuses the blocking-flock worker-thread child that host-semaphore already ships (`host-semaphore/scripts/flock-wait.ts` + `flock-block.ts`). That pair moves into `packages/flock` as `waitForFlock(path, signal)`, and host-semaphore consumes it from there.
- When the lock frees, the joiner reads `verdict.json`. It adopts the verdict **only if** `leaderOpId` matches the leader it saw and `adoptable(verdict)` is true.
- In any other case it loops back to `flockTry`: the leader died, was interrupted, or wrote no verdict. On the retry it either becomes the new leader or joins whoever did. The same retry also ensures an old verdict file is never adopted.

**Cleanup:** a leader deletes the previous `verdict.json` when it takes the lock. Stale files are swept by age, through the existing data-dir reclaim and prune paths.

### Phase 1: run level in `withDirectOp`

`DirectOpOptions` gains an optional `flight: { key: string; adopt: (v) => void }`. The key is computed by the command **before** `withDirectOp`. Coalescing is opt-in per command:

- **`check`:** key = `check` + sorted ids + scope + `alwaysRun` + `treeHash`.
  - `computeTreeHash` moves ahead of the grant. It is IO, a temp-index `git add -A`, and does not need a CPU grant.
  - The hash is passed into `runChecks` as `RunChecksOptions.treeHash`, so the tree the flight is keyed on is the tree the cache is keyed on. There is one computation, not two.
  - `--no-cache` and `SINGULARITY_CHECK_NO_CACHE` mean "really run", so they skip the flight.
  - **Verdict:** `{ outcome, transcriptPath }`. The joiner prints `Joined in-flight check <opId> (same tree, started Ns ago)`, then the leader's transcript (`worktreeArtifacts.checkLog`, which is complete once its `done —` trailer is written). It exits with the leader's code.
- **`test`:** key = `test` + sorted resolved file list + `treeHash`.
  - `test-status.json` becomes per-op (`test-status-<opId>.json`). That makes the verdict addressable, and it fixes the clobbering for concurrent runs that differ.
  - `await` reads the file by `opId` instead of the fixed path.
  - **Verdict:** `{ outcome, statusPath }`. The joiner prints the failure summary that `await` already renders.
- **e2e:** not opted in. It drives a live browser with arbitrary args and stdin, so runs are not deterministic.

A joiner is still an op, so the user and `await` can see it:

- It writes its marker and its `requested` record as today.
- It then opens a new `in-flight` op-log wait (new entry in `WAIT_KINDS`, `op-log/core/internal/types.ts`). Its sentence is "waiting on in-flight <kind> <leaderOpId>".
- It completes with the adopted outcome.
- It never calls `withHostGrant`.
- **Nested ops** (a build's or push's check) take part on the same terms. A nested leader is joinable. A nested joiner waits on its parent's grant, which is idle, not double-spent.

### Phase 2: check level inside `runChecks.runOne`

On a cache **miss**, just before the body runs, `runOne` wraps it in `singleFlight`:

- **Location:** `<checkCacheDir>/flights/`.
- **Key:** `(check.id, sig, treeHash)`.

On the join side:

- A leader **pass** is recorded in the cache, so the joiner re-enters the normal lookup and gets a cache hit. This reuses the existing hit path. The `flight` verdict for a pass is just `{ ok: true }`.
- A leader **failure** is shared as `{ result: CheckResult, observations }`. This is the one place a failure is persisted, and it is ephemeral: it is only adoptable by joiners who saw that leader in flight. The "failures always re-run" rule therefore still holds for every later run.
- An `inconclusive` result is **not adoptable**. The joiner re-runs, which keeps today's semantics.

The progress log gets a `joined` record per check, so `check --status` shows what a waiting run is blocked on.

#### Phase 2 implementation notes

- The flight lives in `checks/core/check-flight.ts` (`runCheckFlight`), so it is
  unit-tested without the check registry; `runOne` splits into `lookup` (both
  cache paths) and `runMiss` and calls it on a miss. The verdict is a
  discriminated union `{kind:"pass"} | {kind:"fail", result, observations}`;
  inconclusive and thrown results publish nothing rather than publishing a
  non-adoptable verdict.
- **Gate slot (not in the plan):** the runner's `--jobs` gate is now held as a
  lease (`gateSlot`). A joiner releases its slot when it starts waiting and
  re-takes it only for work. Because no check ever waits on a flight while
  holding a slot, a joiner that wakes holding the flight lock (it could not
  adopt) may simply queue for its slot and lead: the slot holder ahead of it
  always finishes. Holding the slot through the wait would be cycle-free too,
  but would park a `--jobs 1` run behind another run's check.
- A shared failure prints `FAIL (shared with run <id>)`, keeping the runner's
  existing `FAIL` word.
- Progress log: `joined` + `join-ended` records and `sharedFrom` on `end`; a
  joined check leaves the thread watch's running set for the wait.
- Reclaim: `prune()`'s hourly sweep deletes flight triples idle for a day,
  only under the key's own `flockTry`.

### Why tree-hash equality is the right correctness bar

A joiner's request saw tree T, and so did the leader at its start. The leader's body reads the live tree rather than the snapshot; for example, type-check's `readTreeListing` reads through git. A mid-run edit can therefore skew the verdict, but the leader is exposed to that today. A joiner gets exactly the guarantee the leader has. Strengthening that, for example by re-hashing at the end and refusing to publish on drift, is a separate concern and out of scope here.

## Critical files

| Area | Path |
|---|---|
| New primitive | `plugins/packages/plugins/single-flight/server/` (+ tests) |
| Blocking wait (moved from host-semaphore) | `plugins/packages/plugins/flock/{server,scripts}/`; `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` (consumer) |
| Run-level hook | `plugins/framework/plugins/cli/plugins/op-runtime/cli/direct-op.ts` (+ `direct-op.test.ts` via `DirectOpDeps`) |
| check command | `plugins/framework/plugins/cli/plugins/check/cli/run.ts` |
| Runner | `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` (`treeHash` option, `runOne` flight), `tree-hash.ts`, `progress-log.ts` |
| test command | `plugins/framework/plugins/cli/plugins/test/cli/run.ts`; `infra/paths` `worktreeArtifacts.testStatus(slug, opId)`; `cli/plugins/await` |
| Wait kind | `plugins/debug/plugins/profiling/plugins/op-log/core/internal/types.ts` |
| Docs | `checks/CLAUDE.md`, `op-runtime` CLAUDE.md, root CLAUDE.md test/check notes |

## Verification

1. **Unit tests for `single-flight`** (`./singularity test plugins/packages/plugins/single-flight`). Spawn real child processes for:
   - leader plus 5 joiners: one body runs and all adopt;
   - leader SIGKILL: a joiner re-leads;
   - leader not adoptable (interrupted): a joiner re-runs;
   - a stale verdict file from an earlier leader: never adopted;
   - different keys: run in parallel.
2. **`direct-op.test.ts`:** a joiner never calls `withHostGrant`, writes the `in-flight` wait, and completes with the leader's outcome.
3. **End to end, check:** in a worktree, `./singularity check type-check --no-cache` warms nothing. Then launch 5 × `./singularity check type-check` at once after touching a `.ts` file.
   - Expect exactly one `type-check` worker in `ps`, one `host-grant` acquisition in the op-log, and four `in-flight` waits.
   - All five exit 0, and four print "Joined in-flight check".
   - Repeat with an introduced type error: all five exit 1 and print the same failure.
4. **End to end, overlap (phase 2):** `./singularity check` and `./singularity check type-check` launched together give one type-check body. `check --status` shows the joined record.
5. **End to end, test:** 3 × `./singularity test plugins/packages/plugins/single-flight` at once give one bun/vitest run. `await test` on a joiner reports the adopted verdict.
6. `./singularity check` passes, including boundary rules for the new plugin and the moved scripts.
