# `worktree-cleanup.reap-stale` — why it is slow, and how to bound it

Status: **implemented** (Part A, and Part B slice 4a). Measured results below.

## Results

Benchmarked read-only via `collectReapable()` on the same box, same forked DB
(3,918 attempt rows), same disk state, with `targets=0` both times — i.e. this is
pure scan cost, the job deciding it has nothing to do:

| | before | after |
|---|---|---|
| wall clock (median of 3) | **15,066 ms** | **6,183 ms** |
| attempt rows scanned | 3,918, one `stat` each | 3,918, set lookups, no I/O |
| rows with anything to reclaim | — | **127** |
| git hygiene probes (K) | ~111 | **41** |
| probe concurrency | 24, **unadmitted** | 4, **admitted** |

**2.4× faster while cutting host concurrency 6×** — the wall-clock number
understates it, because the old job was partly racing itself. The residual
6.2 s is almost entirely the 41 probes at 4-wide (41/4 × ~0.6 s), which accounts
for the whole figure.

**K = 41 is material**, so §A4's criterion ("if K is single-digit, add no cache")
is met on paper. It is still NOT implemented, and there is now a reason beyond
scope: the designed in-memory variant would rarely be warm, because main restarts
on every push and this is a main-only job. A negative cache that survives restarts
would have to be DB-backed — a bigger design than A4 assumed. Left open.

## Discovered while verifying: `timedOut` could be a false positive

Not in the original plan; found because these timeouts put `spawnCaptured` on a
hot path. **`timedOut` was set whenever the deadline timer ran, not when a child
was actually killed** — and the two come apart under parent event-loop
starvation, because `child.exitCode` is populated at reap time and reaping needs
that same loop.

Field evidence: `./equin check` blocks its own loop ~77 s building
TypeScript programs, and a `git worktree list` that finished in ~73 ms returned
`timedOut: true, exitCode: 0` — a successful result discarded as a timeout. With
`worktreeListPaths` throwing on `timedOut`, that **crashed the CLI at boot, so
`./equin check` silently ran no checks at all** while still exiting 0.

Fixed in `spawn-captured.ts` by deciding on the OUTCOME, not the timer: a child
that exited of its own accord (clean status, no signal) did not time out, and its
result is returned rather than thrown away. This matches the contract the
plugin's own `CLAUDE.md` already stated — "`timedOut` is `true` iff OUR deadline
fired and we killed the child". Pinned by a regression test that reproduces the
ordering deterministically (a SIGTERM-proof child that succeeds after the
deadline) and which was verified to FAIL without the fix.

Consequence for the timeout constants: the values in `worktree.ts` were first
raised on the mistaken theory that starvation made the commands genuinely slow.
They are kept generous anyway — these are wedge-breakers, and a false positive
costs a failed checkout or removal while being late costs one hourly tick — but
the false-positive class itself is now fixed at the primitive.

---

Status (original): proposed
Supersedes nothing. Extends `research/2026-08-17-global-bounded-job-execution.md` (Phase 4).

## Context

The task that prompted this was Phase 4 of the bounded-job-execution design: `reap-stale`
shells out to `git worktree remove` with no timeout while holding a slot in the host-wide
`worktree-mutate` flock pool, so a wedged reap can block worktree checkouts on every backend
on the machine. `serial: true` landed as a stopgap; the unbounded wait is untouched.

The first question asked was **why the job takes so long**. Measuring that first turned out to
matter, because **the answer is not the flock, and Phase 4 does not fix it.** The steady-state
slowness and the outage risk are two different bugs with two different fixes. This doc plans
both and sequences them.

### What the measurements say

Evidence: ~200 captured traces (2026-08-09 → 08-17), the `slow_ops` aggregate, `EXPLAIN
ANALYZE`, and direct timing on this host.

**It is not the lock.** Every one of ~200 traces shows `childMs: 0` and `waitMs ≈ 0`. Exactly
one recorded any `worktree-mutate-acquire` wait at all — 1.98 ms. The 10.7 M ms of acquire wait
in the `slow_ops` aggregate is concentrated in a few pathological runs, not the norm.

**It is the scan, and the scan is driven by history rather than by artifacts.**
`collectReapable()` reads `listAttempts()` — **3,919 rows** — and runs `pMap(attempts, 24, …)`
over all of them, hourly. On disk there are **111 worktree dirs, 127 fork DBs, 94 registry
specs**: at most ~150 ids have anything to reclaim. So **~96 % of each scan proves that a row
is already fully cleaned**, one `stat` at a time — a fact one `readdir` answers for all 3,919
rows at once. Cost is O(attempts ever created) and grows forever.

**The expensive part is an unadmitted burst.** For each row with a live dir, `getGitHygiene`
spawns `git status --porcelain=v2 --branch` — measured **0.4 s warm / 0.95 s cold** (the
worktrees are **76 GB across 110 dirs**). ~111 spawns per run, fired **24-wide, bypassing
`withHeavyReadSlot` entirely**. The host `heavy-read` pool is `max(1, cpus/4)` = **4 slots**.
A background cleanup job opens a git burst **6× the host's entire sanctioned read budget** —
which is why its duration tracks host loadAvg (17–37 on 18 cores during the 20–51 s runs), and
very likely why `sub:worktree-ops` spends **90 % of its span** in `read-admit`.

**Ruled out:** `listAttempts()` is 2.7 ms uncontended (three seq scans, all buffer hits); its
285 s max in `slow_ops` is pure contention, not a slow query.

**Why none of this was visible:** the git calls are raw `Bun.spawn` under the
`plugins/**/server/**` lint exemption. That one exemption removes **both the timeout and the
tracing** — hence 200 traces of an unattributed black box. Closing it fixes the observability
and the wedge in the same move.

### Intended outcome

- The hourly job costs sub-second + a small bounded number of admitted git probes, and stops
  oversubscribing the host read budget.
- Its cost stops growing with the attempt table.
- Its duration becomes attributable (`childMs` non-zero) instead of a black box.
- A wedged git subprocess fails loudly in bounded time and frees the host-wide flock, instead
  of holding it forever.

---

## Part A — make the scan cheap (do this first)

Files: `plugins/debug/plugins/worktree-cleanup/server/internal/{reap-policy,safety,dirs,reap-job,handle-list}.ts`

### A0. Make the classification pure and pin it

Nothing currently pins `collectReapable` (`safety.test.ts` only covers the parser), and the
inversion rewrites exactly that unpinned logic. Before changing behaviour, extract the
per-attempt decision out of the `pMap` closure into a pure function in `reap-policy.ts`:

```ts
classifyAttempt(attempt, { hasDir, hasDB, hasRegistry, taskStatus, hygiene?, now })
  -> ReapTarget | null | "needs-hygiene"
```

Add `reap-policy.test.ts` covering all four target classes plus the `retained` guard.

### A1. One `readdir` replaces ~4,100 `stat`s

In `dirs.ts`, add `readWorktreeDirIndex(root)` returning both halves of a single
`readdir(gitWorktreesDir(root), { withFileTypes: true })`:

- `allNames: Set<string>` — **every** dirent name, unfiltered by type and unfiltered by
  `WORKTREE_NAME_RE`
- `canonical: WorktreeDir[]` — the existing filtered list

`readWorktreeDirs` delegates to it, so `handle-list.ts` and the reaper share one enumeration.

In `collectReapable`:

- `hasDir := isCanonicalWorktreePath(a.worktreePath, root) && allNames.has(basename(a.worktreePath))`.
  Exact, because `isCanonicalWorktreePath` already asserts
  `dirname(path) === gitWorktreesDir(root)` (`infra/worktree/server/internal/worktree.ts:76-81`).
- The attempt loop becomes **synchronous** — no `pMap`, no per-row I/O. 3,919 rows cost set lookups.
- Replace `dirExists(await worktreePathFor(id))` at `reap-policy.ts:174` and `:186` with
  `!allNames.has(id)`.
- `listAttempts()` stays — at 2.7 ms it is the *lookup* for policy (`retained`, `createdAt`,
  `taskId`), not the driver.

> **Invariant — the set may only be used to SKIP work.** Before any classification whose
> destructive consequence depends on "the dir is absent" — the orphan branch at `:138-141` and
> the DB-only / registry-orphan branches at `:172-189` — **keep the existing `dirExists` stat as
> a confirmation.** That is a handful of stats, and it makes the whole set-vs-stat divergence
> class (APFS case-folding, NFD/NFC normalisation, dangling symlinks) unable to produce a false
> "absent". The reverse direction is already conservative: a false "present" routes the row
> through hygiene and the 72 h / 90 d floors. **Do not drop these as an optimisation.**

> **Trap to comment in the code:** `hasDir` must use the **unfiltered** `allNames`, never
> `canonical`. Today `dirExists` returns true for any node type and any name. Narrowing it to
> the `WORKTREE_NAME_RE`-filtered list would flip a regex-failing dir to `!hasDir`, send it down
> the age-free orphan branch, and have `reap.ts:39-48` remove the dir with **no hygiene check
> and no age floor**. This is the most dangerous possible edit to this file.

### A2. Run hygiene only where it can change the answer

With `retained: false` (proven at `:125`) and `dirExists: true`, `isSafeToReap` reduces to
`(clean && taskDeletable && age >= 72h) || age >= 90d`, where `clean` is the only term the
subprocess supplies. So:

```
needsHygiene = !hardFloor && taskDeletable && age >= SAFE_REAP_AGE_MS
```

- `hardFloor` ⇒ reap regardless ⇒ skip the spawn
- `!hardFloor && !cheap` ⇒ not reapable regardless ⇒ skip the spawn
- otherwise the verdict *is* `clean` ⇒ spawn required

This is **bit-identical** to today, only reordered. Export `needsHygiene` from `safety.ts`
immediately beside `isSafeToReap` so the short-circuit and the conjunction it derives from
cannot drift apart, and add a property test:
`needsHygiene(x) === false ⇒ isSafeToReap({...x, clean}) === isSafeToReap({...x, dirty})`.

(`dbPresent` is dead input on this path — `isSafeToReap` only reads it in the `!dirExists` branch.)

### A3. Admit the fan-out, and make it visible

Rewrite `getGitHygiene` (`safety.ts:65-89`):

- Wrap the body in `withHeavyReadSlot` (`@plugins/infra/plugins/host-read-pool/server`).
  Precedent — gate the *named operation*, never a generic runner:
  `conversations/…/code/server/internal/compute-edited-files.ts:67-70` and
  `code-explorer/server/internal/get-push-files.ts`. Gating **inside** `getGitHygiene` (not at
  the call site) also fixes `handle-list.ts`'s 50-wide unadmitted burst with no drift risk.
- Replace the raw `Bun.spawn` with `spawnCaptured` + `timeoutMs: 30_000`. Map both
  `timedOut` and `exitCode !== 0` to the existing `HYGIENE_UNKNOWN` — the conservative
  default (`{unpushedCount: 1, isDirty: true}` ⇒ not reapable) is the safe direction.
- Add opt-in `{ background: true }` (applies `backgroundArgv`); the reaper passes it,
  `handle-list` does not.
- Wrap each probe in `runTracked("worktree-cleanup:hygiene", …)`. The job body already runs
  inside `recordEntrySpan("job", …)` (`jobs/server/internal/worker.ts:341`), so this converts
  today's 100 %-unattributed self-time into real `childMs`. **This is the instrument that would
  have found the bug in one look.**

Drop the 24-wide `pMap`; drive the hygiene batch at `heavyReadSlotCount()` so the pool is the
regulator. Log `scanned / candidates / hygieneProbes / targets` from `reap-job.ts` so the
residual probe count K is measurable next tick.

> **Accepted trade:** gating inside `getGitHygiene` slows the human-triggered Worktree Cleanup
> pane from a 50-wide burst to admitted probes (~111 × 0.4 s / slots ≈ tens of seconds instead
> of ~1 s). The pane already streams NDJSON, so rows still render progressively. Taking this
> hit is deliberate: the pane was an unadmitted burst too.

### A4. Caching — deliberately not now

- **`git-read-cache` — no.** `createGitStateMemo` requires the signature to be a faithful
  function of everything the result reads, and there is no cheap ungated fingerprint of a
  working tree: `.git/index` mtime misses untracked files, HEAD/upstream oids miss uncommitted
  edits. Serving a stale *clean+pushed* would delete a dirty worktree — precisely what
  `HYGIENE_UNKNOWN` exists to prevent.
- **`corpus-index` — no.** It is an `(mtime,size)`-keyed *file* index; it cannot answer
  "is this worktree dirty", and pointing it at 110 × 690 MB costs more than the probe.
- **If K is still material after A3**, the fitting tool is a one-sided *negative* cache local to
  this plugin (`Map<id, expiresAt>`, written only when hygiene **fails**, 6–24 h). The only
  cached verdict is "not reapable this tick": staleness can delay a reap (irrelevant against
  72 h/90 d floors) and can never cause one. **Gate this on the A3 log** — if K is single-digit,
  add no cache state at all.

---

## Part B — bound the wedge (Phase 4a)

Phase 4 splits cleanly by dependency. **Only the first slice fixes the observed incident, and
it depends on nothing.**

| slice | contents | depends on |
|---|---|---|
| **4a** | implement `signal` in `spawnCaptured`; migrate `worktree.ts` + `safety.ts` off raw `Bun.spawn` with explicit `timeoutMs`; shrink the lint glob to an explicit file list | nothing |
| **4b** | `AcquireHooks.signal` → `defineHostPool.run` → `withWorktreeMutateSlot` → `ctx.signal` | Phase 2 (producer) **and** Phase 3 (consumer) |
| **4c** | make the bound required at the type level; delete the glob; ban the `unbounded:` arm in server code | nothing, but it is a 52-site churn commit |
| ~~4c'~~ | `createSemaphore` signal | **drop** |

**Drop `createSemaphore` signal.** Its motivating consumer (`renderGate`) was deleted in
Phase 1. All 22 remaining sites are short request- or process-scoped leases whose critical
section is shorter than any plausible budget. Adding an unused option to the most-used gate
primitive in the repo is surface area with no consumer.

### B1. `signal` in `spawn-captured.ts` (~15 lines, self-contained tests)

Reuse the existing SIGTERM → `SIGKILL_GRACE_MS` → SIGKILL escalation at `:108-126` by
extracting it once. The `killTimer === undefined` guard is load-bearing: with both `timeoutMs`
and `signal` set, two paths could each schedule a timer and the `finally` clears only the last.

- `signal?.throwIfAborted()` **before** `Bun.spawn` — an already-forfeited handler must not
  launch a new `git worktree remove`.
- `addEventListener("abort", onAbort, { once: true })`, **removed in the existing `finally`** —
  non-negotiable: `getGitHygiene` alone would attach ~111 listeners to one dispatch-lifetime
  signal and trip `MaxListenersExceededWarning`.
- Throw after the inner `finally`, before `readFileSync`.

**`signal` throws; `timeoutMs` keeps returning `timedOut: true`.** The asymmetry is deliberate:
`timeoutMs` is the caller's own deadline, so the caller classifies it. An abort is ambient
("everything you are doing has been abandoned"), and a result field would be **absorbed** —
`getGitHygiene`'s catch would map it to `HYGIENE_UNKNOWN` and the reap would do 110 more
spawns after being told to stop. That is the absorbed-failure pattern the repo bans. Throwing
also means `spawnExpectOk` needs **zero changes** — the abort propagates before the exitCode
check, so it is never mis-reported as `SpawnFailedError`. **Throw `signal.reason`**, not a
fresh error, so Phase 2 can attach context that surfaces at the wedge site.

Document two edges on the option: abort wins over `timedOut` when both fire; abort after a
clean exit still throws.

### B2. Migrate the six sites

| site | change |
|---|---|
| `worktree.ts:24-40` `worktreeListPaths` | `timeoutMs: 10_000` — pure metadata read, called *inside* the gate, so it must be the tightest bound in the file |
| `worktree.ts:98-125` `worktree add` | `background: true, timeoutMs: 300_000` — user-visible; loose on purpose. **See risk 1.** |
| `worktree.ts:129-135` `mise trust` | `timeoutMs: 10_000` |
| `worktree.ts:199-205` `worktree prune` | `background: true, timeoutMs: 30_000`, **and start reading `exitCode`** (log, don't throw — the destructive `rm` already succeeded) |
| `worktree.ts:210-226` `worktree remove --force` | `background: true, timeoutMs: 120_000` — ~100× the 1.2 s p50; short enough that a wedged reap frees the host flock within one hourly tick |
| `safety.ts:65-89` `getGitHygiene` | `timeoutMs: 30_000` → `HYGIENE_UNKNOWN` (folded into A3) |

`backgroundArgv` composes: `spawnCaptured` already applies it under `background: true`
(`spawn-captured.ts:100`), and `taskpolicy` **execs**, so Bun's pid is git's pid and the kill
lands directly (verified on this host).

**Independent win, worth stating in the commit — and a correction to Phase 4's
attribution.** Phase 4 calls `worktree.ts:210-222` (`git worktree remove`) "the *exact* bun
1.3.13 exit-during-stream-pull shape". Reading it, **it is not**: that race needs a stream pull
IN FLIGHT when the child exits, and this site awaits `proc.exited` first and only reads stderr
afterwards. What it has instead is two piped fds never drained while the child runs — a plain
deadlock past the ~64 KB pipe buffer, though `worktree remove --force` rarely emits that much.

The exit-during-pull shape lives in its two siblings, which DO pull concurrently with exit:
`worktreeListPaths` (24-40) and `setupWorktree`'s `worktree add` (98-111). `worktreeListPaths`
is called from inside the mutate gate by `removeWorktreeUnlogged`, so **the likelier wedge point
in the 2026-08-17 outage was the `list`, not the `remove`**. Nobody captured a stack, so which
one hung is not provable either way — recorded so the next reader does not inherit a wrong
certainty.

Either way `spawnCaptured`'s numeric fds remove both mechanisms outright, which is why **B2 has
value even if every timeout were infinite**: the structural fix retires the known causes and the
bound only backstops the unenumerated ones (a disk stall, a git lock, NFS).

### B3. Shrink the lint glob rather than deleting it

`plugins/infra/plugins/spawn/lint/index.ts:36` cannot simply be deleted — at least six server
sites are **genuinely streaming** and can never use temp-file capture:

- `host-semaphore.ts:72` (`spawnWait`) — reads `"granted\n"` off live stdout while holding
  stdin open as the release channel; after-exit capture is structurally impossible
- `database/admin/…/fork.ts:76,89` — `pg_dump → pg_restore` stdin chaining
- `launcher/…/boot.ts:465`, `release/…/preview-manager.ts:80` — long-lived processes
- `tmux-runtime.ts:334`, `review/plugin-changes/handle-plugin-changes.ts:18-22` — pipe chains

So replace the **directory glob with an explicit file list**, each with its own justification —
the mechanism `migrations-interactive.ts` already uses. That converts "34 files are exempt
because of where they live" into "6 files are exempt and each says why", available in 4a at no
extra cost, and makes 4c's eventual deletion a small delta rather than a cliff.

Also in this commit: delete the `reap-job.ts:43-58` IOU paragraph, and rewrite the two now-false
sections of `spawn/CLAUDE.md` (the Stage-2 gate has flipped — a field wedge has been observed
twice — and the `timeoutMs` "no ceiling at all" prose is no longer true for the server population).

### B4. Deferred to 4b/4c (recorded, not built now)

- **`AcquireOptions.signal`** (rename `AcquireHooks` while touching it — its docblock claims
  "neither gates behavior", which `lane` already made false). The hazard to record: on abort,
  `fanOut` (`host-semaphore.ts:501-529`) must **kill and reap every child**. If an abort merely
  throws out of `Promise.any`, all `size` children survive, each blocked on `flock(LOCK_EX)`,
  each eventually *winning* a slot and holding it until the parent process dies — converting a
  recoverable job wedge into a **permanent host-wide gate wedge**. That is the single most
  important detail in 4b.
- **Required bound** — `SpawnOptions = SpawnBaseOptions & SpawnBound` with a **closed** union
  (`unbounded?: never` on the bounded arms; the doc's literal shape lets
  `{timeoutMs, unbounded}` type-check). Pair it with a rung-3 rule
  `spawn-safety/no-unbounded-spawn-in-server`, or arm 3 is a one-token bypass of arm 1 exactly
  where slots are held.

**4b is inert until Phase 2 lands** — `ctx.signal` never aborts before then, so shipping the
plumbing early is mildly harmful: a reviewer reading `withWorktreeMutateSlot(fn, {signal})`
would reasonably conclude that abandoning a job frees the flock, which would be false.

---

## Sequencing

1. **A0–A2** — pure classifier + `readdir` inversion + hygiene short-circuit. Behaviour-identical.
2. **A3** — admission + `spawnCaptured` + tracing. **Biggest single win; also lands the
   `getGitHygiene` half of B2.**
3. **B1–B3** — `signal` implementation, the five `worktree.ts` sites, the glob shrink.
4. *(Phase 2 budget lands per the original doc's ordering.)*
5. **4b** with Phase 3; **4c** last, as an isolated churn commit.

A and B touch disjoint files except `safety.ts`, so A3 and B2 should be one commit for that file.

## Risks

1. **`setupWorktree`'s idempotence guard turns a timeout into silent corruption.**
   `worktree.ts:88` is `if (existsSync(wtPath)) return;`. A `worktree add` killed mid-checkout
   leaves a partial tree; the durable job's retry sees the dir and returns early, handing a
   **half-populated worktree** to `runtime.create` — strictly worse than today's hang.
   **The 300 s timeout must not ship without a companion:** on `r.timedOut`, clean up *inside
   the same gate hold* (`rm -rf` then a bounded `prune`), then throw. Do **not** call
   `removeWorktree`, which re-enters `withWorktreeMutateSlot` and would consume a second of the
   three host slots. **Gate the whole B commit on this.**
2. **SIGTERM reaches the direct child only.** `taskpolicy` execs (verified), so the kill lands
   on git — but git's forked `checkout`/`read-tree` grandchildren survive and may write into a
   tree risk 1 is about to `rm`. Accept, document, rely on `rm -rf` idempotence plus the next
   tick's unregistered-leftover branch. **Unverified:** what git leaves behind (`locked`,
   `index.lock`) when killed mid-`worktree add`. Check before finalising the 300 s value.
3. **Set-vs-stat divergence** — the only way the A1 inversion can over-reap. Fully mitigated by
   the confirm-stat rule; the risk is that someone later removes it as an optimisation.
4. **Short-circuit drift** — if `isSafeToReap` gains a term that reads hygiene when
   `taskDeletable` is false, `needsHygiene` becomes wrong. The A2 property test is the guard,
   and is why `needsHygiene` must live in `safety.ts`.
5. **`spawnCaptured`'s per-call synchronous tmpdir work** (`mkdtempSync` + 2 `openSync` +
   2 `readFileSync` + `rmSync`) at ~111 probes/run. Almost certainly negligible against a
   `git status` over a 690 MB tree, but **unmeasured** and it lands inside the surface A is
   optimising. Measure before/after.
6. **Worktree Cleanup pane latency regression** (A3, accepted above).

## Verification

- **Equivalence, the strongest available check:** snapshot the current on-disk + DB state once
  as a fixture and assert the new pure classifier returns the **identical target set** as the
  current logic. Cheap the moment A0 makes classification pure.
- `./equin test plugins/debug/plugins/worktree-cleanup` and
  `./equin test plugins/infra/plugins/spawn`.
- **Spawn unit tests** (mirror the existing `timeoutMs` triplet at `spawn-captured.test.ts:102-128`):
  abort before the call (no child spawned); abort mid-flight on `sleep 30` (rejects within the
  2 s grace, child gone); abort after clean exit (still rejects); `timeoutMs`+`signal` both set
  (abort wins); 500 sequential spawns on one signal (no `MaxListenersExceededWarning`);
  `spawnExpectOk` propagates the reason, not `SpawnFailedError`.
- **Integration:** point `GIT` at a sleeping stub; assert `removeWorktree` fails in bounded
  time, `hostOccupancy()` shows the `worktree-mutate` slot free afterwards, and
  `getGitHygiene` returns `HYGIENE_UNKNOWN` rather than hanging the reap.
- **Field, after deploy** — the numbers that decide whether this worked:
  - `job worktree-cleanup.reap-stale` in Debug → Slow Events: `childMs` must become **non-zero
    and dominant** (today it is 0 in 200/200 traces), and total should fall from 5–51 s to
    sub-second + K × ~0.4 s.
  - Probes must appear on the `heavy-read` gauge; `sub:worktree-ops`'s `read-admit` share
    should fall from its 90 %.
  - Re-run under host load and confirm duration **no longer tracks loadAvg**.
  - `reaped n/m` in the `worktree-cleanup` log sink must stay stable across the change — the
    target set is unchanged by construction.
- `./equin build` after each step (both plugin `CLAUDE.md`s regenerate their `Uses:`
  lists; `plugins-doc-in-sync` fails otherwise).

## Open questions

- Steady-state K (dirs passing every cheap predicate but failing hygiene) — **not measurable
  before A3 ships**; it decides whether A4's negative cache is needed at all.
- Real p99 of `git worktree add`/`remove` under darwinbg throttling at 3-way concurrency. The
  timeout values above are derived from the p50s quoted in `mutate-gate.ts:9-11` and
  `research/perfs/2026-07-02-worktree-mutation-host-gate-DESIGN.md`, not fresh measurement.
- `spawn/CLAUDE.md` claims "~65 sites, 38 files"; a fresh count finds **34 files** with raw
  async `Bun.spawn` under `plugins/**/server/**`. Re-count with the rule itself before writing
  the explicit file list.
