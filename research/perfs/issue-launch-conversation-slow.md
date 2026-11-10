# Launching a task/conversation is slow (Ongoing)

**Symptom:** clicking **Launch** on a task (or the +Sonnet/+Opus / fork / investigate
affordances) blocks the UI spinner for a long time before the conversation pane opens.
Observed **`POST /api/conversations` = 12.97 s** in a single live sample on `singularity`;
the uncontended floor is **~3.8 s**. The launch is perceived as "very slow".

> **Method:** follow the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md)
> skill. This doc is the living session log + Causes checklist for this issue. Status stays
> **(Ongoing)** — a hotspot and a *sufficient* cause are named, but no fix has landed or been
> re-validated on data.

## TL;DR (current best understanding — 2026-07-02)

The launch endpoint is **synchronous end-to-end**: the Launch button awaits `POST
/api/conversations`, and that request awaits the entire `createConversation()` body before
returning. The one expensive blocking step on the critical path is **`git worktree add`** — a
full working-tree checkout of the whole repo (**8385 tracked files**), measured at **~3.8 s
uncontended**. Everything else on the path is cheap single-row Postgres I/O or already
off-path.

The amplifier that turns the ~3.8 s floor into the observed 13 s is **machine IO/CPU
contention**, NOT a git lock (index-lock serialization *refuted* — see the 2026-07-02 trace
below). The `git worktree add` checkout writes 77 MB / 8395 files against the **new** worktree's
own index (`git reset --hard` with `GIT_DIR=<newpath>/.git`), holding **no repo-global lock** —
so concurrent worktree ops run in **parallel**, they do not serialize. What amplifies a launch is
that the same window ran a pile of heavy IO/CPU work — `worktree-cleanup.reap-stale` (**58 s**,
up to 6 concurrent full-tree `git worktree remove --force`, each ~1.2 s of 77 MB rm), `database.fork`
(7.4 s × 2, `pg_restore`), and `conversation-category.classify` (7–15 s Haiku) — all competing for
the same disk/CPU bandwidth as the launch's own checkout. Measured: a foreground add under a 6-way
remove/add churn slows **3.2 s → 7.7 s median (+141 %), 10.7 s max** — enough to reach ~13 s once
the concurrent forks + classify are added on top.

**Likely cure altitude (not yet built): structural / off the interactive path**, mirroring the
DB-fork pattern that *already exists in this same function*. `git worktree add` is largely
**irreducible** (the agent needs a real full working tree) — so making it *cheaper* is
containment and a probable dead-end. The real fix is to **not block the interactive response on
it**: insert the conversation row in a `starting` state, return immediately, and run
`setupWorktree` + `runtime.create` in a durable graphile job (the UI already renders `starting`
conversations via live-state). See **Open questions** for what must be verified before building
this.

## Evidence (three converging lines — 2026-07-02, on `singularity`)

1. **Live profile** (`get_runtime_profile`, ~206 s window on `singularity`):
   - `http`: **`POST /api/conversations` avg/max 12,966 ms**, `workMs 12966`, no tracked waits
     (single sample, `count 1`).
   - `job`: `database.fork` avg 7274 ms / max 7449 ms (×2); `worktree-cleanup.reap-stale`
     **57,981 ms** (×1); `conversation-category.classify` 7–15 s; `tasks.maybe-launch` 2830 ms.
   - **Nuance — this is NOT an event-loop block.** `git worktree add` is an awaited
     *subprocess* (`Bun.spawn(...).exited`) that yields the loop. The profiler reports it as
     `workMs` only because it subtracts *tracked gate* waits (loader-acquire, heavy-read),
     not generic subprocess-await. So this is a **per-request latency** problem for the
     launcher, **not** a server-wide event-loop stall (unlike the `buildPluginTree` issue).
     Do not re-diagnose it as CPU/loop starvation.
2. **System / data:**
   - `git ls-files | wc -l` = **8385** tracked files; 77 MB working tree.
   - `/usr/bin/time git worktree add -b <br> <tmp> main` = **real 3.81 s** (uncontended,
     warm), "Updating files: 100% (8385/8385)".
   - `.cache/tsbuildinfo` = **5.6 MB** across 8 files, string-rewritten (`.split(repoRoot).join(wtPath)`)
     synchronously inside `setupWorktree` — a smaller secondary cost.
   - Worktree `node_modules` absent → **no `bun install` on this path** (confirmed: build/install
     are *not* part of launch).
3. **Code path:**
   - Launch button awaits the POST, then opens the pane:
     `plugins/primitives/plugins/launch/web/components/launch-control.tsx:74-76` (`await
     fetchEndpoint(createConversation, …)` → `openPane(...)`). The whole perceived latency = this
     one request.
   - Endpoint `POST /api/conversations` → `handleCreate` (fully sync) →
     `createConversation` (`plugins/conversations/server/internal/lifecycle.ts:50-247`).
   - **Dominant blocking step:** `await setupWorktree(id, worktreePath)` (`lifecycle.ts:139`) →
     `git worktree add -b <branch> <wtPath> main` + tsbuildinfo copy + `mise trust`
     (`plugins/infra/plugins/worktree/server/internal/worktree.ts:57-77`).
   - Correctly **off-path** (async job / fire-and-forget): `databaseForkJob.enqueue`
     (`lifecycle.ts:147`; the `pg_dump|pg_restore` fork runs later in a worker —
     `plugins/database/plugins/fork/server/internal/fork-job.ts`), `void forkConfig(...)`
     (`lifecycle.ts:140`), and the `conversationCreated.emit` subscriber jobs (title, preprompt,
     queue-rank).
   - `await runtime.create(...)` (`lifecycle.ts:208` →
     `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:654-742`) is
     sync **but fast**: it only awaits `tmux new-session -d` exiting, not the `claude` CLI
     booting inside the detached pane.

## Causes — checklist

- ✅ **`git worktree add` (full 8385-file checkout, ~3.8 s) is the dominant blocking step on
  the synchronous launch critical path.** Measured in isolation + confirmed as awaited in
  `createConversation`. This is a *sufficient* cause for the steady-state floor (gate 1).
- ✅ **The Launch UX blocks on the whole `POST /api/conversations` request** — no job sits
  between click and response (`launch-control.tsx:74`; `handleCreate` fully sync).
- ❌ **git index-lock *serialization* is the primary amplifier** — **REFUTED** (2026-07-02
  Phase-2 controlled trace, gate: direct measurement / counterfactual). `git worktree add` takes
  **no repo-global lock** during its expensive step: `GIT_TRACE` shows it = `git branch` (a ~ms ref
  lock) + `git reset --hard` with `GIT_DIR=<newpath>/.git`, i.e. the 8395-file checkout writes the
  **new** worktree's own index, never the main index. Measured: **K concurrent adds run in parallel,
  not serialized** — K=2 wall **2.4 s**, K=4 wall **3.9 s** (each 3.8 s), K=6 wall **5.7 s** (each
  5.6 s); if a lock serialized them, wall would be base×K = 6.4 / 12.8 / **19.2 s**. **Zero**
  `index.lock` / `File exists` / `cannot lock` errors; all ops exit 0. So there is no hard lock to
  contend on — the serialization mechanism is refuted. **But the amplifier itself is real** — see
  the reclassified entry below.
- ✅ **Machine IO/CPU contention (concurrent heavy checkouts/removes) IS the primary amplifier**
  (reclassified from the index-lock hypothesis; 2026-07-02, gate 1 sufficiency passes). A foreground
  `git worktree add` run *during* a 6-way `git worktree remove`/`add` churn (mirroring the reap job's
  `pMap(limit=6)`) slows from **3.20 s baseline → 7.72 s median (+141 %), 10.67 s max**. The reap's
  removes are heavy IO too (each ~1.2 s deleting a 77 MB tree). Stacked with the same-window 2×
  `database.fork` `pg_restore` + 7–15 s Haiku classify, this is *sufficient* to lift the ~3.8 s floor
  to the observed ~13 s. Legitimacy (gate 2): reaping 226 worktrees is legitimate maintenance, but
  running it at 6-way concurrency *against* interactive launches is a reschedulable choice, not a
  requirement. Counterfactual (gate 3): throttling/serializing reaps vs launches only makes the
  checkout *cheaper under load* (containment) — the origin cure remains taking the checkout **off the
  interactive path** (below), after which contention no longer touches perceived latency at all.
- 🔬 **`worktree-cleanup.reap-stale` taking 58 s** — is that legitimate (how many stale
  worktrees?) or is *it* a second issue doing redundant work / holding the git lock too long?
  Trace separately; it may deserve its own entry.
- 🔬 **`copyTsBuildInfoToWorktree` (5.6 MB rewrite)** — secondary sync cost; quantify its share
  of the ~3.8 s before deciding if it matters.
- ❌ **DB fork on the critical path** — refuted: enqueued as a durable job, runs off-path
  (CLAUDE.md + `fork-job.ts` + code order confirm).
- ❌ **`./equin build` / `bun install` on the launch path** — refuted: not present anywhere
  in the flow (no build step; `node_modules` not created per launch).
- ❌ **Claude CLI boot blocking the response** — refuted: `tmux new-session -d` detaches; the
  request does not wait for `claude` to start.
- ❌ **Event-loop/CPU block (à la `buildPluginTree`)** — refuted: the cost is awaited-subprocess
  wall-clock that yields the loop; `workMs` here is a profiler-labeling artifact, not CPU.

## Open questions before writing a fix

1. **Reorder safety for the "insert row first, background the setup" cure.** Today the
   conversation row is `insertConversation`-ed *after* `setupWorktree`, and `runtime.create`
   needs the worktree to exist. To background it: the attempt's `worktreePath` is derived purely
   from the id (`worktreePathFor`), so it's known up front — but we must verify (a) what initial
   status a not-yet-spawned conversation should carry, (b) that the poller / live-state and the
   sidebar render a pre-spawn `starting` row correctly, and (c) the existing error-cleanup
   (delete-orphaned-attempt, mark-gone) still holds when the work moves into a retryable job.
2. **The agent-stalls-on-still-forking-DB subtlety.** Even with worktree setup backgrounded, the
   spawned agent's first DB-backed op can race the async `database.fork`. Out of scope for the
   *launch-latency* symptom, but note it so the cure doesn't make it worse.
3. ~~**Should the index-lock amplifier get its own boundary invariant?** e.g. cleanup reaps
   yielding the git lock between removes, or a bounded reap.~~ **Resolved (2026-07-02):** there is
   no git lock to yield — the amplifier is IO/CPU bandwidth contention, not lock serialization. A
   "yield the lock between removes" invariant is moot. If containment is ever wanted before the
   origin fix lands, the lever is **scheduling** (throttle/deprioritize the reap's 6-way concurrency
   vs interactive launches, or bound the reap), not lock discipline. The origin fix (background the
   checkout) makes even that unnecessary for perceived latency.

## Next steps

- ~~Phase-2 trace of the index-lock amplifier.~~ **Done 2026-07-02** — see Session log; lock
  serialization refuted, amplifier reclassified as IO/CPU contention.
- Quantify the `copyTsBuildInfoToWorktree` share of `setupWorktree`.
- Decide the cure altitude with data in hand (structural background-job vs any cheap containment),
  then design + land + **re-validate on `singularity`** before promoting to `(Completed)`.

## Session log

### 2026-07-02 — Phase-2 index-lock trace (index-lock serialization REFUTED; amplifier = IO/CPU contention)

**Experiment** (controlled, on the real `/Users/epot/__A__/dev/singularity` main repo, 8395 tracked
files / 77 MB tree, 226 live worktrees, 18 CPUs; throwaway worktrees only, under a scratchpad
`idxlock-*` path + `perftest/idxlock-*` branches, fully cleaned up afterward — real worktrees never
touched). A bun harness timed `git -C <root> worktree add -b <br> <tmp> main` (identical to
`setupWorktree`) across four conditions:

1. **Baseline (idle, warm, sequential):** median **3.20 s**, mean 3.42 s, range 2.06–5.09 s
   (reconfirms the ~3.8 s floor; high variance even idle). Baseline `git worktree remove --force`:
   median **1.17 s**.
2. **K concurrent adds — the serialize-vs-parallel test:** K=2 wall **2.39 s** / K=4 wall **3.87 s**
   (each ~3.84 s) / K=6 wall **5.68 s** (each ~5.63 s). A hard lock would force wall = base×K =
   6.4 / 12.8 / **19.2 s**; instead wall ≈ a single add ⇒ the adds run **in parallel**. **Zero**
   `index.lock` / `File exists` / `cannot lock` errors; every op exited 0.
3. **`GIT_TRACE` decomposition:** `git worktree add` = `git branch <b> main` (momentary ref lock,
   ~ms) + `git reset --hard --no-recurse-submodules` with `GIT_DIR=<newpath>/.git` — the 3.8 s
   checkout writes the **new** worktree's own index, **not** the main index, so no repo-global lock
   is held during it. A 50 ms lock-file poll of `.git/*.lock` + `.git/worktrees/*.lock` during a
   full add caught **nothing**.
4. **Foreground add under 6-way remove/add churn** (mirrors the reap's `pMap(limit=6)`): median
   **7.72 s**, mean 8.07 s, **max 10.67 s** — a **+4.52 s / +141 %** delta over the 3.20 s baseline.

**Verdict.** The 🔬 hypothesis — *git index-lock serialization is the primary amplifier* — is
**refuted**: git takes no repo-global lock during the checkout, concurrent adds run in parallel, and
no lock errors ever fire. The amplifier is nonetheless **real and primary**, but its mechanism is
**IO/CPU bandwidth contention** between the launch's own 77 MB checkout and the other heavy IO/CPU
work in the window (the reap's 6 concurrent 77 MB `git worktree remove`s + 2× `pg_restore` DB fork +
Haiku classify). **Gates:** sufficiency ✅ (7.7 s median / 10.7 s max under churn, stacked with the
concurrent forks/classify, closes the 3.8 s → ~13 s gap); legitimacy — the contending work is
legitimate maintenance but its concurrency/timing vs interactive launches is reschedulable;
counterfactual — reducing contention is **containment** (checkout still costs 3.8 s cold); the
**origin cure stays**: move `setupWorktree` + spawn **off the interactive response** into a durable
job, after which contention never touches perceived latency. The gate that stopped the climb:
**gate 3 counterfactual** — there is no lock to remove, so the only durable fix is backgrounding the
checkout, not any lock/scheduling tweak.

### 2026-07-02 — Fix IMPLEMENTED + deployed on the worktree + functionally verified (status still Ongoing)

The origin cure landed on this worktree (`att-1782981514-leja`) per
[`2026-07-02-launch-background-worktree-setup-DESIGN.md`](./2026-07-02-launch-background-worktree-setup-DESIGN.md).
Files: new `conversations.spawn` durable job (`plugins/conversations/server/internal/spawn-job.ts`,
mirrors `databaseForkJob`); `createConversation` new-attempt branch drops the inline `setupWorktree`,
inserts the `starting` row, emits `conversationCreated` right after insert, and enqueues the spawn job
(reuse/fork branch unchanged); `setupWorktree` made idempotent (`existsSync` early-return) **and
fails loudly** on a genuine `git worktree add` nonzero exit (fixing a latent swallowed-exit bug);
tmux `create` made idempotent via a new `Runtime.isRunning()` probe (`tmux has-session`); regression
backstop = a declarative `defineEndpoint({ slowThresholdMs })` (HTTP twin of `defineJob({ slowThresholdMs })`)
wired through slow-ops, with `POST /api/conversations` held to 1 s. No schema/migration change.
`./equin build` green (all checks) and **deployed**.

**Verification (on the worktree):**
- **Functional ✅** — a real launch returns `status: "starting"` while the worktree dir does **not
  yet exist**; the background `conversations.spawn` job then creates the worktree (`git worktree add`),
  spawns the tmux session, and the poller flips the row `starting → waiting` (Claude idle). Ran 4
  launches; all reached `waiting`. The `conversations.spawn` job showed `workMs 19195` (the deferred
  checkout+spawn) — confirmed **off** the interactive path.
- **Latency ✅ (worktree)** — steady-state in-process **`POST /api/conversations` workMs ≈ 390 ms**
  (0.39 s wall), down from the **3.8–13 s** baseline. First-after-restart samples read higher
  (684 ms–2.6 s) but were contaminated by the cold-boot fan-out + 3 self-induced concurrent forks;
  the settled single sample is ~390 ms.

**NOT yet done (do not promote to Completed):**
- **Re-validate on `singularity`/main** — the whole win must be re-measured on main after a push
  (per the doc-currency rule). Not on main yet (needs the user's push).
  **2026-07-10 verification: landed on main as `40ef2ae9f` (2026-07-02)** (and the `worktree-mutate`
  gate as `a23732d29`) — the "not on main yet" above is stale. The post-merge re-measurement on
  `singularity` has still not been recorded, so the status stays Ongoing.
- **Residual ~390 ms in-process** is NOT the checkout (that's off-path) — it is the serial DB
  round-trips (`createTask`/`createAttempt`/`insertConversation`/preprompt+effort reads/`emit`) + the
  two job enqueues, measured while the DB pool was still draining the boot fan-out. A smaller,
  separate optimization (batch the inserts / move more off-path); worth a follow-up, not part of the
  checkout cure.
- **Forced-failure idempotency (verification step 5) + reuse/auto-start paths (steps 6–7)** verified
  by code review, **not** exercised live yet.
- **Throughput follow-up filed:** `task-1782991245011-l3m3an` (git worktree add/remove serialize
  under load — the deferred index-lock/IO-contention amplifier, now off the interactive path but still
  a worker-throughput concern).
