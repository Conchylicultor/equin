# Main runs from per-commit slots, not from the checkout push rewrites

Task: task-1794819580-f8vw44 (folds in task-1793896151-00k5ry, "Main's runtime loads code from the
mutable checkout").

## Context

Everything on main reads code from one directory: main's checkout
(`~/__A__/dev/singularity`). `./equin push` rewrites that directory in place
(`git merge --ff-only`, `push/cli/land.ts:187`, `push/cli/run.ts:731`). Two kinds
of failure follow.

1. **Torn reads.** A process reading the tree while a fast-forward rewrites it
   sees two commits at once.
   - 2026-11-16 08:48: `build-1794818863-qp2oev` crashed mid-codegen
     (`takeCrawlSnapshot not found`) and left 8 half-written docs.
   - `build-1794818895-qrn55q` then failed on those leftovers
     (conv-1794818984-ko0nuv).
   - 2026-11-05: `worktree.prepare` and `database.fork` died on
     `WorkspaceReclaimed not found`.
2. **Version skew.** After a push, every new child and every lazy `import()`
   gets commit N+1. The backend and the database stay at N until the next
   deploy, roughly 10 minutes later.

Today's mitigations only limit the damage:
- `infra/git/tree-lock` holds a lock while a process starts up. It does nothing
  for the build, which reads for 10 minutes, and nothing for later lazy loads.
- `main-tree-guard` + `restoringMainTreeOnThrow` clean up after a build that
  wrote into the tree.

**Outcome:** a build reads exactly one commit. Main's backend, central and
their children run exactly the commit that was built. A push never writes
into a directory anything runs from. `tree-lock` and the restore-on-throw code
are then deleted.

## Measurements (2026-11-16)

**Cost of preparing a directory at a commit** (25.6k tracked files):

| Method | Time |
|---|---|
| `git worktree add` | 6.3 s |
| `clonefile()` of the source tree | 1.0 s |
| `clonefile()` of `node_modules` | 11.3 s |
| Per-file `cp -c -R` | 11 s (source), 80 s (`node_modules`) |
| `git checkout --detach <sha>` in an existing worktree | 0.35–0.47 s for 35 or 410 changed files; mostly a fixed index cost |

**Main build rate:** 646 builds in 7 days. The median gap between one build
ending and the next starting is 271 s; 10% of gaps are under 16 s.

**Supervised children still running at a deploy switch:**
- 471 of 619 switches had at least one.
- How long after the switch the last one finished: p50 3 s, p90 71 s, p99 347 s,
  max 1551 s.
- The longest ones are `desktop.fullscreen-budget` (up to 26 min),
  `type-check.backstop` (10 min), `worktree.prepare` and `spare-refill` (9 min),
  and `deps.install` (5 min).
- They are detached on purpose (`server-core/cli/run-exec.ts`) and survive a
  backend restart by design.

**Who reads code after starting:**

| Process | Reads code after startup? | Evidence |
|---|---|---|
| Supervised `run` child | Yes | `supervised-job/cli/internal/cli-exec-context.ts:16`, `attached.ts:42`; spawns `flock/scripts/flock-wait.ts` and `Worker`s from the checkout |
| `argv` job (`./equin <verb>`, `cwd: REPO_ROOT`) | Yes | Runs for minutes |
| Agent host (`runtime-sdk/bin/agent.ts`) | No | Static imports only; spawns only the cloned Claude binary |
| The agent's Claude CLI | Yes, on every command | `CLAUDE_CODE_SHELL_PREFIX` = the backend checkout's `bin/background-shell` (`agent.ts:132`); a scratch agent's `GUARDS_ROOT` is the launching backend's checkout |

## Design

### The slot pool

A **slot** is a linked git worktree, detached at one commit, under a declared
data dir: `~/.equin/main-slots/<id>`. It has its own `node_modules`, installed
by `bun install` from bun's cache as APFS clones, the same way an agent worktree
gets its packages.

- **`current`** (`~/.equin/main-slots/current`) is a symlink to the slot main is
  served from.
- **Each slot is a reader/writer lock.** This reuses `tree-lock`'s per-checkout
  `<git dir>/tree.lock`; a linked worktree has its own git dir, so each slot
  gets its own lock.
  - **Shared lease:** held by anything that runs code from the slot. The serving
    backend, central and supervised children hold it **for their whole life**.
    Short readers (agent-host boot, a guard hook, the converge step) hold it
    **only while loading**.
  - **Exclusive lease:** held by a build while it runs `git checkout --detach
    <sha>` in the slot, and for the whole build.
- **Choosing a slot.** A build takes the least recently served slot that it can
  lock exclusively **without waiting** (`flockTry`).
  - If none is free and the pool is under its cap, it creates one: `git worktree
    add --detach` plus an install, about 6 s plus the install, paid once per
    slot.
  - The pool starts at 2 slots and has a cap of 4. The measured drain tail means
    a third slot is created only when the previous backend's children are still
    running as the next build starts.
- **The pool is full** (every slot held, cap reached): the build waits on the
  least recently served slot and files a **report naming each slot's holders**.
  Holders are recorded as `<slot>/.leases/<pid>.json` with their kind, written
  on acquire and removed on release; stale pids are ignored. Being held is
  normal; a full pool is not, so only the full pool is reported.

### The build

Example: `current` = A at commit `c1`. Pushes move only `refs/heads/main`.

1. **Trigger.** The gateway's converge starts as today, but runs
   `<current>/equin build --allow-main --converge` with `Dir` = `current`. When
   no slot exists yet (bootstrap), it falls back to the repo root.
   - Change in `gateway/main_deploy.go:155-177`: resolve `current` before each
     run.
2. **Pick the commit and the slot.** Converge reads `refs/heads/main` (say
   `c4`), acquires a free slot (B) exclusively, runs `git checkout --force
   --detach c4` there, and runs `ensureDeps` (a no-op unless `bun.lock`
   changed).
   - The checkout is `--force` so the slot's earlier leftovers never count as
     "dirty before".
3. **Build in the slot.** Converge re-execs the build inside B (`<B>/equin build
   --allow-main --slot-build`). The existing self-re-exec is at `run.ts:586`
   and `converge.ts:269`. Every step reads and writes only B.
   - `main-tree-guard` stays as a **determinism check**: tracked files in B must
     be unchanged at the end.
   - `restoringMainTreeOnThrow` is deleted. The next `checkout --force` resets B
     anyway, and nothing runs from B while it is being built.
4. **Deploy.**
   - `deployNamespace` writes main's spec with `server = <B>/plugins/framework/plugins/server-core`.
     This already follows `root` (`deploy-namespace.ts:725-760`).
   - Central's spec is written from the **slot root**, not `getMainRepoRoot()`
     (`build/cli/run.ts:1314`, `:1766`).
   - The gateway's hot restart swaps the socket as today.
   - Once health passes, `current` is pointed at B (atomic symlink rename) and
     the build's exclusive lease is released. The new backend already holds its
     shared lease.
5. **Afterwards.** A drains: the old backend exits, and its children finish and
   release their leases. A stays intact as the rollback target until a later
   build takes it.
   - **Health fails:** `current` keeps pointing at A, and the dist rollback
     happens as today (`dist-publish.ts`).

### Main identity: a slot counts as main

Today `checkoutRef` (`infra/paths/core/internal/checkout-ref.ts:58`) treats a
root as main only if it is git's main checkout. `mainNamespaceOwner`
(`checkout-deploys.ts:568`) reads the owning checkout from `spec.server`. Changes:

- `checkoutRef(root)` returns `{kind: "main"}` when the root is under
  `mainSlotsDir()` and its git common dir is the owner repo's. Otherwise it keeps
  today's rule for the repo root.
- `mainNamespaceOwner` derives **the repo** from `spec.server`: the git common
  dir of the slot or checkout it names. The repo root and the slots are then
  all "main"; another clone still is not.
- Replace the `branch === "main"` tests with `checkout.kind === "main"`. A
  detached slot has no branch, and these tests pick the build's lane and
  priority:
  - `laneFor` (`run.ts:719`)
  - `publishLane` (`run.ts:1054`)
  - `opPriority` (`run.ts:1059`)
- The `--allow-main` guard (`run.ts:635`) also applies to slot checkouts.
- Split the one question "main's checkout" into two named helpers:
  - `getMainRepoRoot()`: the git store (refs, worktrees, the human checkout).
  - `servedMainRoot()`: the `current` slot, i.e. the code main runs.

  Audit the roughly 15 non-test `getMainRepoRoot` callers, including:
  - `build-targets.ts:149`
  - `adopt.ts:116`
  - `reports/outbox/watcher.ts:32`
  - `review/plugin-changes/main-plugins-dir.ts:8`
  - `file-explorer/places/served.ts:13`
  - `gateway-drift`
  - `hints/ask/checkout.ts:11`
  - the guards' main fallback

### Runtime leases

- **Serving backend and central.** They take the shared lease at boot and hold
  it for life. Today they hold nothing; this replaces `holdTreeRead`'s
  boot-only hold.
- **Supervised children** (`run-exec.ts:150`). `holdTreeRead(REPO_ROOT)` becomes
  a **lifetime** shared lease: no early `releaseNow` after the load waves.
  `argv` children (`./equin <verb>` from `REPO_ROOT`, which is now the slot) take
  the same lease through the CLI bootstrap.
- **Agent host.** Holds the shared lease only while it starts up (static
  imports only). Two things it hands to the Claude CLI move off the slot:
  - **`background-shell`:** copied into `<agent dir>/bin/` at launch,
    content-addressed, the same pattern as the Claude binary clone
    (`runtime-sdk/machine/internal/named-claude.ts`, the
    `process-name/cloneNamedBinary` precedent).
  - **Scratch agents' `GUARDS_ROOT`:** set to `~/.equin/main-slots/current`
    rather than the launching slot's path. Each hook call then resolves the
    serving slot afresh. The guard bootstrap
    (`guards/bin/bootstrap.ts`, `node:` builtins only) takes the shared lease
    with `open(…, O_SHLOCK)` before its dynamic `import("./hook")`.
- **Out of scope:** agents working in their own worktree run their own guards
  and are untouched.

### What gets deleted

- `infra/git/tree-lock`. Push still fast-forwards the repo root for human use,
  but nothing runs from it any more. Its readers become slot leases.
- `restoringMainTreeOnThrow` and `restoreMainTreeWrites`'s restore path.
- The `withTreeWrite` wrappers in `push/cli/land.ts:187` and `push/cli/run.ts:731`.

## Plugin layout

- **New:** `plugins/infra/plugins/git/plugins/main-slots`.
  - `core/`: `mainSlotsDir()`, the `current` path, `SlotLease` (acquire
    shared/exclusive, holder records), `listSlots()`.
  - `cli/`: `acquireBuildSlot(sha)`: pick, create, checkout, install.
  - `data-dirs/`: declares `main-slots`.
- **Lease primitive:** moves from `tree-lock` (same flock file, lifetime holds);
  `tree-lock` is then removed.
- **Report kind:** `main-slots-exhausted`, filed through the reports outbox,
  naming holders and their kinds.

## Rollout

Each phase lands on its own.

1. **`main-slots` plugin**, plus the identity changes (`checkoutRef`,
   `mainNamespaceOwner`, the `branch === "main"` replacements,
   `servedMainRoot`). No behaviour change: no slot exists yet.
2. **Build in a slot.** Converge acquires a slot and re-execs into it; the
   specs point into the slot; `current` is flipped. Gateway resolves `current`.
   From here a push can no longer tear a build.
3. **Runtime leases.** Lifetime leases for the backend, central and exec
   children; boot lease for the agent host; `background-shell` copy;
   `GUARDS_ROOT` = `current`; the pool-full report.
4. **Delete** `tree-lock`, restore-on-throw and push's `withTreeWrite`.

Separate tasks (not this plan):
- Postgres and PgBouncer run binaries from main's `node_modules`. Install them
  into `~/.equin` like the gateway.
- `desktop.fullscreen-budget` has a 26–34 min tail against a 74 s median.

## Verification

- **Unit tests** (`main-slots`), on a temporary git repo, as in
  `main-tree-guard.test.ts`:
  - a held shared lease makes `acquireBuildSlot` skip that slot;
  - a full pool waits and reports;
  - least recently served is chosen first;
  - `checkout --force` clears leftovers;
  - `checkoutRef` answers `main` for a slot of the owner repo and `worktree`
    for another clone's slot.
- **Build profile:** a `slotAcquire` span (checkout + `ensureDeps`). Target: no
  more than 0.5 s without a lockfile change.
- **Live on main after phase 2:**
  - `build_runs` over a week shows no torn-tree failures;
  - `lsof` shows main's backend, central and children with cwd under
    `~/.equin/main-slots/*`;
  - `readlink ~/.equin/main-slots/current` matches the deployed commit;
  - no slot is checked out while held (holder records vs build log).
- **Race test:** `e2e/` script in `main-slots`, on a throwaway clone. Start a
  build in a slot, fast-forward the clone's `main` repeatedly during it, and
  assert the build's codegen inputs hash to the slot's commit.
- **Checks:** `./equin check` passes, including `plugins-doc-in-sync`,
  `boundary-rules` and `paths:no-undeclared-data-dirs` for the new data dir.
