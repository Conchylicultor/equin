# Build crash-safety: a flock'd lock and an unfoolable "did my build land?"

## Context

Two `./equin build` runs reported success to an agent's shell while having
actually failed. A full e2e suite was then run and believed against the
**previous** bundle; ~1.5 h was lost before it was caught. Every downstream
verification claim in that session was unsound.

The report named three compounding issues. Exploration showed they are not
equally live — one is already solved, one is narrower than it looked, and one is
real and unaddressed:

1. **Stale build lock.** Real, but not for the stated reason. `.build.lock` is
   the *only* cross-process mutex in the repo still on the bespoke
   symlink + PID + heartbeat scheme (`bin/build-lock.ts`). Every other lock —
   `push`, `cpu`, `db-fork`, `worktree-mutate`, `heavy-read`, `layout-geometry` —
   already uses kernel `flock(2)` via `createHostSemaphore`, which
   `worktree-op.ts:269-275` itself calls *"the ONLY crash-safe, PID-reuse-proof
   truth"*. The symlink scheme has two holes flock closes for free: **PID reuse**
   (a recycled pid makes a dead holder look alive, and the waiter then throws
   "appears wedged" or hangs to the 10–30 min `capMs` ceiling) and **liveness ≠
   progress** (the 5 s heartbeat keeps stamping as long as the event loop turns,
   so a build wedged on a hung child looks perfectly healthy forever).

2. **`| tail -30` masking the exit status.** Mostly already solved, and not the
   cause here. `emitVerdict` writes the verdict banner with `writeSync(1, …)`
   (not `console.log`, so a following `process.exit` cannot truncate it) and
   `installVerdictGuard` registers a `process.on("exit")` backstop so the build
   *cannot* terminate without printing one — it even prints a loud "this is a bug
   in build.ts" banner when the emitted verdict disagrees with the exit code.
   That landed in `9f5655caf` on 2026-07-10, four weeks **before** the incident.
   So every *graceful* failure — a thrown step, `process.exit(1)`,
   SIGINT/SIGTERM/SIGHUP/SIGQUIT, and the build-lock timeout throw (which happens
   *after* the guard is installed) — already shows `BUILD FAILED` through a pipe.

   The residual gap is exactly **SIGKILL**: uncatchable, so no handler runs and
   the CLI prints nothing at all. No banner can cover it *by construction*, and
   the pipe compounds it — `$?` is `tail`'s 0 rather than 137, and a killed
   pipeline loses `tail`'s buffered output too. This is the case the incident hit.

3. **No cheap way to answer "did my build actually land?"** Real and
   unaddressed. Two host-global durable ledgers already record every build's
   terminal outcome — `~/.singularity/build-progress.jsonl`
   (`run`/`enter`/`leave`/`pending`/`done`, with `runId`+`pid`+`worktree`, written
   through a *synchronous unbuffered* `appendFileSync` so lines survive SIGKILL)
   and `~/.singularity/op-log.jsonl`. **Neither is exposed as a query.** So the
   only apparent answer is `ls -t ~/.singularity/worktrees/<wt>/build-*.log | head -1`,
   which is a guaranteed false positive: that file is written *once, atomically,
   at the end* of a build, so a killed build writes nothing and the newest match
   is a **previous** run's `BUILD OK`.

**Intended outcome.** A killed build can never leave a lock that outlives it, and
"did my build land?" has one cheap, fixed-path, unfoolable answer that a killed
build cannot fake.

**Decisions taken** (asked and confirmed): migrate the lock to `flock`; **no**
e2e-harness freshness gate; **no** pipefail guard and no docs rule for issue 2 —
the existing banner covers graceful failures and `build-status` covers the
SIGKILL case that no banner can reach. That makes `build-status` load-bearing
rather than a convenience, so the plan makes it hard to skip.

## Part 1 — `.build.lock` on kernel `flock`

### 1a. Extract the libc `flock` binding as a primitive

The `dlopen(libc, { flock })` binding is already duplicated in
`plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts:55-60`
and `plugins/infra/plugins/worktree/server/internal/worktree-op.ts:320-338`. A
third copy is the smell, so extract it once:

- New `plugins/packages/plugins/flock/` (sibling of `host-semaphore` /
  `semaphore`), barrel `server/index.ts`, exporting a minimal surface:
  `flockTry(fd): boolean` (`LOCK_EX|LOCK_NB`), `flockRelease(fd)` (`LOCK_UN`),
  and the `LOCK_*` constants.
- Migrate `host-semaphore.ts` and `worktree-op.ts` onto it (mechanical; both
  keep their current behaviour).

This does **not** conflict with the `host-pools-declared` check — that check makes
`infra/host-admission` the sole importer of `createHostSemaphore` (the *pool*
registry), not of the raw syscall binding.

**Hard constraint.** `bin/build-lock.ts` is reachable from the bootstrap
(`bin/index.ts` → `ensure-deps.ts` → `build-lock.ts`), so its transitive
**static** import set must reach no npm package or the `cli:bootstrap-package-free`
check fails. `bun:ffi` is a Bun builtin, not a package — fine. The new plugin must
import nothing but node builtins and `@plugins/*`.

### 1b. Rewrite `bin/build-lock.ts` on flock

Keep the public API byte-for-byte — `acquireBuildLock(lockPath, opts?) =>
Promise<() => void>` — so both call sites are untouched
(`acquireArtifactLock` in `commands/internal/app-artifacts.ts:304-309`, and
`.install.lock` in `ensure-deps.ts:395`, which gains the same crash-safety).

- The lock is a **regular file**, not a symlink: `openSync(lockPath, "w")`, then
  `flockTry(fd)`.
- **The file is never unlinked.** Release is `closeSync(fd)` — the kernel drops
  the lock. This deletes an entire bug class: today's `release()` unlinks
  unconditionally with no ownership check, so it can remove a *successor's* lock.
  `**/.build.lock` is already gitignored (`.gitignore:27`), so a persistent
  0-byte file is free.
- The holder's pid is written into the file **as diagnostics only**. Correctness
  never consults it again: no `kill(pid, 0)`, no steal, no heartbeat, no
  `lutimesSync`/temp-symlink-rename dance. PID reuse can now at worst produce a
  misleading *message*, never a wrong lock decision.
- Waiting keeps the current shape: poll `flockTry` every `pollMs` (500 ms) up to
  `capMs`. No turnstile/fan-out is needed — this is a size-1 mutex and the
  existing code already polls.
- Delete `readHolder`, `refreshLock`, `LUTIMES_AVAILABLE`, `staleMs` as a
  *stealing* input, and the ESRCH-steal branch.

### 1c. Wedge detection moves from liveness to progress

`flock` answers dead-vs-alive perfectly and alive-vs-wedged not at all — which is
the right split, because the repo already records progress properly.

After waiting longer than `staleMs`, the waiter reports using
`readBuildProgress()` (`bin/build-progress.ts:230`), which reconstructs each run
and exposes `outstanding` — the `enter − leave` set, i.e. the span the holder is
actually stuck in. The message becomes e.g.:

```
Waiting 4m for the build lock at <path>, held by pid 12345,
stuck in "web artifacts" for 3m52s.
Full history: ~/.singularity/build-progress.jsonl
```

Import `readBuildProgress` **dynamically** (`await import(…)` inside the slow
branch only) so the bootstrap-critical static import set stays minimal.

## Part 2 — a deploy receipt at one fixed path

**No new CLI command** (decided). The false positive in issue 3 comes entirely
from the **glob**: `build-<buildId>.log` has a per-run filename written once at
the end, so when a build is killed, `ls -t … | head -1` matches a *previous*
run's `BUILD OK`. A fixed filename cannot do that. So the existing `build`
command gains one small artifact and nothing else grows.

**Path.** `~/.singularity/worktrees/<name>/build-status.json` — no `buildId`
suffix, no glob. Added as `worktreeArtifacts.buildStatus(name)` in
`plugins/infra/plugins/paths/core/internal/paths.ts`, beside the existing
`buildLogText` / `buildLogs` entries, so the path is defined once.

**Shape** (a discriminated `status`, never an absorbable value, per the repo's
failure-must-be-a-type rule):

```jsonc
{
  "status": "running" | "ok" | "failed" | "superseded",
  "buildId": "321c0e2cb-1785922172918",
  "commit": "321c0e2cb…",     // headAtStart — the tree this build answers for
  "pid": 40321,
  "startedAt": "2026-08-05T11:15:02.114Z",
  "finishedAt": null,          // set on every graceful terminal path
  "exitCode": null,
  "url": "http://<name>.localhost:9000",
  "logPath": "…/build-<buildId>.log"
}
```

`superseded` is its own arm because `failBuild` already distinguishes it
(`BUILD_EXIT_SUPERSEDED` = 75, `EX_TEMPFAIL` — HEAD moved mid-build, so the
build answers for no coherent tree); collapsing it into `failed` would misreport.

**Write points** — both already exist as funnels, so nothing new has to be kept
in sync:

- `running` is stamped **after the build lock is granted** (`commands/build.ts`
  ~line 757, right where `setWorktreeOpPhase(name, "build", "running")` already
  fires). After, not before, because the lock serializes builds in a checkout —
  so exactly one build owns the receipt at a time and a queued build cannot
  overwrite a live one's.
- The terminal rewrite happens in **`finalizeBuild`** (`commands/build.ts:701`),
  which is already the single idempotent graceful-exit funnel — reached from the
  `process.on("exit")` backstop, the catchable signal handlers, and `failBuild`.
  So every graceful path lands `ok`/`failed`/`superseded`.
- Written atomically (tmp + `renameSync`), reusing the `writeAtomic` shape in
  `bin/build-logs-writer.ts:57-61`, so a reader never sees a torn file.

**Why a killed build cannot fake success.** SIGKILL runs no handler, so the
terminal rewrite never happens and the receipt is left at `status: "running"`
with a pid that is now dead. That reads unambiguously as "did not complete" — and
because the path is fixed, there is no older `ok` for it to be confused with.
`cat`ting the file is the whole query.

A tiny shared helper — `plugins/framework/plugins/cli/bin/build-receipt.ts` —
owns the type, the atomic write, and `readBuildReceipt(name)` (which resolves
`running` + dead pid to `interrupted` via `process.kill(pid, 0)`). Not a command;
just the one place the shape is defined, so the writer and the two readers below
cannot drift.

## Part 3 — making it hard to skip

Since there is no pipefail guard and no e2e gate, the receipt must be reachable
without discipline:

1. **`build`'s verdict pointers name it.** Add `Deploy receipt: <path>` to the
   `pointers` array in both the OK and FAILED verdicts in `commands/build.ts`
   (built at `buildOkVerdict()` ~line 1144 and in `failBuild` ~line 1096), beside
   the existing `Full output:` pointer.
2. **Self-healing: the next op reports an interrupted predecessor.** At the start
   of `build`, `check` and `push`, if `readBuildReceipt(name)` resolves to
   `interrupted`, print one loud line:
   `⚠ The previous build (<buildId>, started <t>) never completed — it did NOT deploy.`
   This needs no discipline from the caller and costs one small file read.
3. **`CLAUDE.md`** — one line in the Agent Workflow section: after `./equin
   build`, the deploy receipt at that fixed path is the authority on whether the
   build landed; never infer it from `ls -t … build-*.log`.

## Files

**New**
- `plugins/packages/plugins/flock/{server/index.ts,server/internal/flock.ts,package.json,CLAUDE.md}`
- `plugins/framework/plugins/cli/bin/build-receipt.ts` — receipt type, atomic write, `readBuildReceipt`
- `plugins/framework/plugins/cli/bin/build-receipt.test.ts` — pure status-derivation tests (`bun:test`, beside source per the test-layout split)

**Modified**
- `plugins/framework/plugins/cli/bin/build-lock.ts` — rewritten on flock
- `plugins/framework/plugins/cli/bin/build-lock.test.ts` — the "steals a lock held
  by a dead process" / "throws against a live wedged holder" cases are replaced by
  flock semantics: a killed holder's lock is acquirable immediately (no steal
  step), and a live holder is never acquirable
- `plugins/infra/plugins/paths/core/internal/paths.ts` — add `worktreeArtifacts.buildStatus(name)`
- `plugins/framework/plugins/cli/bin/commands/build.ts` — stamp `running` after the
  lock is granted, terminal rewrite in `finalizeBuild`, verdict pointers,
  interrupted-predecessor line
- `plugins/framework/plugins/cli/bin/commands/{check,push}.ts` — interrupted-predecessor line
- `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` and
  `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` — use the flock primitive
- `plugins/framework/plugins/cli/CLAUDE.md` — the lock section currently documents
  the heartbeat scheme; rewrite it for flock and note the never-unlink invariant
- `CLAUDE.md` — deploy-receipt line

No new CLI command, no `bin/cli.ts` change, no new registration.

## Verification

1. `./equin build` — must still deploy cleanly, and
   `http://att-1785922172-rm0r.localhost:9000` must serve the new bundle.
2. `cat ~/.singularity/worktrees/att-1785922172-rm0r/build-status.json` — shows
   `"status": "ok"` with the current commit and a real `finishedAt`.
3. **The incident, reproduced.** Start a build, `kill -9` it mid-flight, then:
   - the receipt still reads `"status": "running"` with a now-dead pid — and,
     critically, `ls -t …/build-*.log | head -1 | xargs grep 'BUILD OK'` still
     reports success off the *previous* run. Confirm that contrast explicitly:
     it is the exact false positive that cost 1.5 h.
   - a second `./equin build` acquires the lock **immediately** (the kernel
     released it on death — today this is where the stale lock appears) and prints
     the interrupted-predecessor warning.
4. **Lock contention.** Two concurrent `./equin build` runs in one checkout:
   the second prints "Another build is in progress; waiting…" and proceeds when
   the first finishes — never both at once.
5. **Graceful failure still self-reports.** Break a step deliberately: the receipt
   reads `failed`, and `./equin build | tail -30` still shows the
   `BUILD FAILED` banner (confirming the existing verdict guard is untouched).
6. **Wedge message.** With a holder stopped mid-span (`kill -STOP`), the waiter's
   message names the stuck span from `build-progress.jsonl`.
7. `./equin check` — in particular `cli:bootstrap-package-free` (the new
   static import set) and `plugin-boundaries` (the new `flock` plugin).
8. `./equin test plugins/framework/plugins/cli plugins/packages/plugins/flock`
   — both runner buckets.
9. `mcp__singularity__query_db` is not needed: every fact this plan reads lives on
   the filesystem, not in Postgres.

## Explicitly out of scope

- **No e2e-harness freshness gate** (decided). The harness's own CLAUDE.md
  principle — *"a script that goes green without exercising the app is worse than
  no script"* — argues for one, and gating `withBrowser` on `build-status` would
  make verifying against a stale bundle unreachable. Worth revisiting; not done here.
- **No new CLI command** (decided). The receipt is a plain file the existing
  `build` writes; nothing new to invoke, register, or remember.
- **No pipefail guard, no CLAUDE.md piping rule** (decided). Residual known gap: a
  SIGKILLed build behind a pipe yields neither a banner nor a non-zero status, so
  the *only* signal is the receipt (or the next op's warning).
- **No freshness comparison against your working tree.** The receipt records the
  commit the build answered for and when it finished; it does not try to prove
  "my uncommitted edits are in the bundle". That would need a source signature,
  which the build's own regenerated output (migrations, registries, plugin docs)
  makes fragile. Timestamp + commit is the honest, cheap answer.
- **No change to the `build_runs` Postgres ledger.** Its CLI writer targets main's
  DB and agent worktree builds never write through it, so it cannot answer this
  question for a worktree; `build-progress.jsonl` can and already does.
