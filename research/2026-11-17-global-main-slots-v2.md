# Main slots v2: one pool for every served app, one free slot

Follows [`2026-11-16-global-main-slots.md`](./2026-11-16-global-main-slots.md).
Phases 1–3 of that plan are implemented. This revision replaces only how slots
are **assigned and counted**. The slot itself, its leases, the build handover,
restart-skip and the identity rules stay as they are.

## Context

v1 was designed around main's app alone ("two alternating slots"). Main also
serves compositions (`sonata`, `website`), each with its own backend. Each
backend must keep running from the slot it was built in.

- **In phase 3, each composition pinned a slot.** With `MAIN_SLOT_CAP` = 4
  counting served slots, three apps at three commits left one slot for the next
  build. A slot still draining then made builds fail with "pool full".
- **The user's model**, adopted here:
  - main alternates between two slots;
  - each composition holds one slot;
  - one spare slot is shared by everyone;
  - apps built together share one slot.
- **Requirement:** a process that keeps an old slot busy for more than a few
  seconds after its app switched away is a problem to report, not a normal
  wait.

## Mental model

> **A slot is a checkout of one commit. Every running app lives in the slot it
> was built from. Keep exactly one free slot ready.**

- **A build** takes the free slot and moves it to the commit (≈0.4 s).
- **One build covering several apps** puts them all in one slot.
- **When an app switches** to the new slot, its old slot **drains**: the
  processes it left there finish. The slot then becomes **free**, unless
  another app still lives in it.
- **Free slots beyond one are deleted.** When a build finds no free slot (the
  last one is still draining), it creates one.
- **Main isn't special.** It is the app that rebuilds most often, so it
  alternates between its slot and the free one.

| Time | Event | main | sonata | website | Free |
|---|---|---|---|---|---|
| t0 | | S1 | S2 | S3 | S4 |
| t1 | main rebuilt | S4 | S2 | S3 | S1 (after draining) |
| t2 | main rebuilt | S1 | S2 | S3 | S4 |
| t3 | sonata rebuilt | S1 | S4 | S3 | S2 |
| t4 | all three built together | S2 | S2 | S2 | one of S1/S3/S4, the others deleted |

**Steady state:** number of distinct slots apps live in, plus 1. Normally that
is 2–4.

## Slot states

A slot's state is **derived, never stored**, from two facts that already exist.
Both are read by one function, `slotStates()`:

| State | Defined by |
|---|---|
| **serving** | Some app's `current` link names it. The set of apps is every namespace with a main-built spec: main and its compositions. |
| **draining** | Serves no app, but has live holder records (old backends, their children, a guard hook). |
| **building** | Has an exclusive holder (`claimHandedBuildSlot` → shared after `handOver`). |
| **free** | No app, no live holder. |

`servedSlotPaths` (phase 2/3) becomes `slotStates().serving`.

## Changes

### 1. One `current` per app

- `current` becomes `<main-slots>/current/<namespace>`, one link per served
  app.
  - `serveSlot(slot, namespace)` flips one app's link (rename over).
  - `markSlotServed` keeps the least-recently-served order.
- **Main's link** is the one the gateway resolves:
  - `-main-slots-current` now points at `current/<main namespace>`;
  - the launcher passes the new path;
  - the old single `current` is migrated once (a link renamed into place).
- **Which slot an app lives in** is read from its `current`. A spec naming a
  slot must agree with its `current`. The build writes both, and spec rollback
  (phase 3) restores both.

### 2. Building apps together

Today converge builds main alone, then the due compositions in a second pass
(`converge.ts:249-253`, "one build per pass").

- **New rule:** when main and some compositions are due at the same `HEAD`,
  one pass builds them all: one `build` child, one slot, `--composition` listing
  main's id too. The build CLI already deploys N targets from one tree
  (framework/cli CLAUDE.md, "One invocation, N targets").
- **Ledger:** one `build_runs` row with all targets. This is the row
  `insertRun({targets})` already supports. The loop-termination key stays
  `(head, targets)`.
- **The verdict stays per invocation.** A composition failing fails the build.
  Main's app is still published if its own target succeeded: the deploy receipt
  is per namespace and closed per target. Main's `current` flips per target,
  only for targets that deployed healthy.
- **Apps due at different commits** never share: each build is of one commit.
- **Never build into a slot an app lives in**, even at the same commit. A build
  writes generated files and caches into its slot, and that would be the
  original bug under a running backend. Apps share a slot only by being built
  in the same build.

### 3. Pool size: one free, created on demand, extras deleted

- **`acquireBuildSlot(sha)`:**
  1. Take a free slot (least recently served first).
  2. Else create one: `addCheckout` + stamp + `ensureDeps`, about 6 s plus the
     install. This happens only when the last free slot is still draining.
- **No cap on served slots.** The **leak limit** counts only draining slots
  (default 3). Past it, the build waits on the oldest draining slot and files
  `main-slots-exhausted` naming its holders. That is a leak, not a busy pool.
- **Reclaim** (`reclaimSlots()`): delete free slots beyond one, oldest first,
  with `git worktree remove` under the worktree-mutate gate. It runs:
  - at the end of every build;
  - when a lease is released and finds its slot free, through the push-based
    capture in section 4;
  - in the daily `main-slots.reclaim` job, a backstop for slots freed by a
    killed process. A process killed with SIGKILL never releases its lease,
    and nothing can signal its death, so a scheduled job is the documented
    exception to "no polling".

### 4. Slow drain is reported

**Threshold:** 10 s after a slot stopped serving every app. This is a config
value (`main-slots.drainReportAfterSec`).

- **Record when serving stopped.** `serveSlot` and the reclaim stamp the old
  slot `unservedAt` (in its git admin dir, beside the holder records) when its
  last app leaves it.
- **Capture at release, so nothing is missed between builds.** When a lease is
  released, the release path compares now against `unservedAt`. If the holder
  kept the slot past the threshold, it appends a record to
  `<admin dir>/drain-log/<pid>.<n>.json`:
  `{kind, label, pid, heldPastSwitchMs, slot, commit}`.
  - The release path stays dependency-light: plain `fs` writes, no reports
    import.
  - `label` is new on holder records. A supervised child sets it to its job
    name (`worktree.prepare`), a CLI process to its verb, the backend to its
    namespace.
- **Filing.** `reclaimSlots()` (end of build, daily job) files one
  `main-slot-drain-slow` report per record and deletes the record.
  - The fingerprint is `(kind, label)`, so `worktree.prepare` dedupes into one
    report with its occurrences.
  - Holders still past the threshold at reclaim time are filed too, marked
    "still holding".
- **Who fixes it.** Each report names the job, which is what to make faster or
  stop from outliving its backend. From the 7-day measurements this
  immediately surfaces:
  - `desktop.fullscreen-budget` (up to 26 min);
  - `type-check.backstop` (10 min);
  - `worktree.prepare` and `worktree.spare-refill` (up to 9 min);
  - `deps.install` (5 min).

  These reports are expected at first. They route through the reports engine
  to the right supervisor like any slow-op report.

### 5. Two gaps left by phase 4

- **The gateway is built from the repo root.** Converge's gateway-follow step
  (`infra/launcher/gateway-drift`, `followMainGateway`) compiles the Go gateway
  from the repo root, which a push can be rewriting. Build it from main's
  serving slot instead (`current/<main namespace>`): the commit that was just
  deployed.
- **Builds are only partly serialized.** A relayed build (the Build button, or a
  hand-run one) claims its `build_runs` row only part-way through the child
  build. In the gap between `runInBuildSlot` releasing the slot and the child
  claiming it, a converge run can pick the same slot; the child then refuses
  loudly. Fix: the slot is marked handed to a specific build id (an
  admin-dir record written before release). `acquireBuildSlot` skips a slot
  handed to a build whose process is alive, and `claimHandedBuildSlot` checks
  the id.

### 6. What goes away from phase 3

- `MAIN_SLOT_CAP` counting every slot, and the "every slot served" throw.
- `servedSlotPaths` as a separate notion; it becomes `slotStates().serving`.
- Converge's main-first, one-build-per-pass rule, now one pass per `HEAD`.

## Plugin layout

Everything stays in `plugins/infra/plugins/git/plugins/main-slots`:

- **`core/`:**
  - `slotStates()`
  - `currentLinkFor(namespace)`
  - `serveSlot(slot, namespace)`
  - holder `label`
  - `unservedAt`
  - drain-log writer, in `boot-lease`, since release paths may not import more
- **`cli/`:**
  - `acquireBuildSlot` (free → create)
  - `reclaimSlots`
- **`server/`:**
  - the `main-slot-drain-slow` report kind next to `main-slots-exhausted`
  - the daily `main-slots.reclaim` job
  - the `drainReportAfterSec` config
- **Converge:** the grouping change in `framework/cli/build/cli/internal/converge.ts`
  and `build/converge`'s `decideConvergence` (it already returns `main` and
  `compositions`).
- **Gateway:** only the default of `-main-slots-current`, plus the launcher's
  argument.

## Verification

- **Unit tests** (temp repos, as in phase 1–3's `acquire-build-slot.test.ts`):
  - `slotStates` derives serving, draining and free from links and holder
    records;
  - a build takes the free slot and creates one only when none is free;
  - reclaim keeps exactly one free slot;
  - several targets at one commit share one slot, and the apps' old slots become
    free after draining;
  - never building into a serving slot at the same commit;
  - the leak limit waits and reports;
  - a holder released 15 s after `unservedAt` writes a drain record, and one
    released in 2 s does not;
  - reclaim files the report and deletes the record;
  - spec and `current` rollback restore both for one namespace.
- **Converge test:** a decision with main and two compositions due at one head
  gives one build invocation with three targets. Different heads give separate
  builds.
- **Live on main after landing:**
  - `ls ~/.equin/services/main-slots` shows apps' slots + 1;
  - `readlink current/<ns>` matches each app's deployed commit;
  - the first `main-slot-drain-slow` reports name the long jobs above.
- `./equin check` and `./equin test` on changed plugins; the gateway's
  `go test ./...`.

## Implementation status (2026-11-17)

v1's phases 1–4 and this plan's sections 1–6 are implemented in one branch
(not yet pushed). What landed, and where it departs from v1 and from this
plan.

### Deviations from v1 that this revision builds on

- **Stamp-based identity**, not a location test: a slot is made with a
  `main-slot` stamp in its git admin dir (`stampMainSlot`, `infra/paths`);
  `checkoutRef` answers `main` for a stamped slot of the repo main's spec
  names. `infra/paths` cannot read main-slots' data dir (that declaration
  imports `infra/paths`).
- **Data dir** `~/.equin/services/main-slots` (a `services` data dir: live
  while anything runs), not `~/.equin/main-slots`.
- **Holder records in the git admin dir** (`<git dir>/<lock dir>/leases/`),
  not `<slot>/.leases/`: git never lists them and no check's tree hash sees
  them. The unserved stamp, the handoff mark, the drain log and main's served
  marker live beside them.
- **Build handover through `EQUIN_BUILD_SLOT` + downgrade**: the hander
  (`runInBuildSlot`) releases its lease and the CHILD build claims the slot
  exclusively (`claimHandedBuildSlot`), turning it shared in place
  (`lease.downgrade()`) before it restarts a backend there — an exclusive
  lease held across the whole build deadlocked against the new backend's boot
  lease while the build waited for its health.
- **Restart-skip by content** (`build/restart-skip`'s judge: closure digest,
  resolution and boot inputs byte for byte, every child's closure), so a
  deploy from a new slot with identical code is adopted by the backend
  running from the old one; the spec keeps naming the old slot.
- **Spec switch extracted** to `framework/cli/build`'s `spec-switch.ts`
  (`switchSpec` / `settleFailedServe`): ask before moving the spec, restore
  the previous spec when the previous backend is left serving.
- **`infra/git/tree-lock` deleted**, with restore-on-throw and push's
  `withTreeWrite`.

### v2, as built

- **§1 One `current` per app.** `current/<namespace>` (`currentLinkFor`),
  flipped per target by `serveSlot(slot, namespace, { drainReportAfterMs })`
  once that target deployed healthy and runs from the slot. The gateway's
  `-main-slots-current` default and the launcher's argument name
  `current/<main namespace>`; the gateway still falls back to the repo root
  when the link is missing (including the pre-v2 layout, where `current`
  itself is a link). The old single link is read as main's and migrated once
  (`migrateLegacyCurrentLink`, run by `slotStates` / `serveSlot`).
- **§2 Building apps together.** `build/converge`'s `convergenceBuild(decision)`
  turns a decision into ONE build of the decided HEAD (main's own first, then
  the compositions): one slot, one `build_runs` row with every target,
  `--composition <main> <c…>`; the loop key stays `(head, targets)`. Never
  into a slot an app lives in, even at the same commit.
- **§3 Pool size.** `acquireBuildSlot`: a free slot (least recently served by
  its unserved stamp), else a new one while fewer than `DRAINING_SLOT_LIMIT`
  (3) slots drain, else wait on the oldest draining slot and file
  `main-slots-exhausted` naming its holders. `MAIN_SLOT_CAP` and the "every
  slot served" throw are gone. `reclaimSlots()` keeps `FREE_SLOTS_KEPT` (1)
  free slot, removing the rest oldest first (taken exclusively, renamed out of
  the pool and its own `worktrees/<id>` registration deleted under the
  worktree-mutate gate, then deleted — see review fixes below), at the end of every main build (`runInBuildSlot`) and in the daily
  `main-slots.reclaim` supervised job (main only, `./equin main-slots-reclaim`).
- **§4 Slow drains.** Config `main-slots.drainReportAfterSec` (default 10).
  `main-slot-unserved` stamp `{at, reportAfterMs}`; drain records at release
  (`<admin dir>/drain-log/`); `main-slot-drain-slow` report per record and per
  holder still holding at reclaim, fingerprint `(kind, label)`. Holder
  records carry `label` (a supervised child's job name, a CLI verb, a
  backend's namespace, a build id).
- **§5 Gaps.** The gateway is built from main's served slot, held shared while
  read (`withServedMainRoot`, used by `prepareMainGateway`; the drift row's
  binary comparison reads the same root). A slot is marked handed to a
  handoff id (`main-slot-handed`: `{handoff, pid}`) before its hander releases
  it; `slotStates` reads it as `building` while the hander lives, and the
  child claims only a slot marked with its `EQUIN_BUILD_SLOT_HANDOFF`.
- **§6** `servedSlotPaths` became `slotStates()` (serving / building /
  draining / free); converge's main-first one-build-per-pass rule is gone.

### Decisions where the plan was silent

- **Serving = a `current` link OR a spec names it.** The plan defines serving
  by links only; a spec can name a slot its link does not (a deploy whose new
  backend took over and then failed health: the gateway respawns from the
  spec; a deploy the running backend adopted from its previous slot), and
  building into it would rewrite code under that backend. Links still move
  only on a healthy deploy.
- **Spec + link rollback.** The link moves only after a target is healthy,
  so a failed deploy never moved it; restoring the spec (`settleFailedServe`)
  is the whole rollback and leaves both agreeing.
- **Main's decision reads `lastClosedRun({ includes: main })`**, not
  `{ only: main }`: a grouped row is main's attempt too, or the loop would
  not terminate.
- **`main-slot-served` is main's only.** Written when main's own link moves,
  so the guard bootstrap's fallback (it cannot resolve the data root) still
  finds main's slot, not a composition's. Free-slot LRU order is the unserved
  stamp instead.
- **Holder kind `build-relay`** for a `./equin build` run from a slot it was
  not handed (main's convergence run, a relayed Build-button / hand-run
  build): it causes the switch away from the slot it runs in and waits for
  the build, so it is never reported as a slow drain.
- **Label from argv in the CLI bootstrap** (`bin/index.ts`): the verb, or a
  `supervised-exec` child's job name — argv read as a label only.
- **Lifetime leases note their end at exit** through `releaseAtExitSync`,
  registered by the process root (`serve.ts`, central's `bin/index.ts`): an
  exit handler must be synchronous, and the type-aware `blocking-fs` lint
  rightly refuses a backend-reachable core function that registers sync work;
  a root in `bin/` may.
- **The threshold travels in the unserved stamp** (`reportAfterMs`), read
  from config by the CLI process that stamps (`readDrainReportAfterMs`, off
  disk), so the release paths stay plain `fs`.
- **A drain record is deleted only once written to the outbox**
  (`fileReportFromProcess` outcome `written`); otherwise it waits for the
  next reclaim.
- **Release does not reclaim.** The plan's "when a lease is released and
  finds its slot free" is the drain capture; deletion stays with
  `reclaimSlots` (end of build, daily job) so the release path imports
  nothing.
- **Leak-limit report keeps the kind name** `main-slots-exhausted`
  (payload now `{limit, waitedOn, slots: [{slot, unservedAt, holders}]}`; no
  rows of the v1 payload exist — v1 never landed).
- **The guard bootstrap's copy of the lease writes no drain note** (a hook
  call holds for its own duration; it is reported as "still holding" if it
  outlives the threshold at a reclaim).

### Review fixes (2026-11-17)

An independent review of the branch found these; each is fixed and tested
(`main-slots`' `acquire-build-slot.test.ts` "review fixes", `build/cli`'s
`fan-out.test.ts` and `hand-over.test.ts`).

- **Adoption no longer freezes `current`.** The link used to move only when
  the backend restarted onto the slot (`served: this-tree`); an adopted deploy
  (identical backend closure) left it on the old slot, so everything reading
  the link — the next convergence run, main's gateway build and drift row,
  agents' guard hooks, every `./equin` job spawned from the served root —
  kept the old code, and a gateway-, guard- or CLI-only change never
  deployed. Now a healthy deploy always moves the link (after handing the
  slot over, so its readers can take it shared); the spec keeps naming the
  slot the adopted backend runs from, which `slotStates` already counts as
  serving. Link = newest code deployed; spec = what the backend runs.
- **A grouped build's partial failure no longer skips central.** The fan-out
  used to return at the first failed target, before the deployed-phase steps
  and central's spec + restart: main deployed, a composition failed, central
  stayed on the old slot until the next push (the loop does not retry an
  attempted HEAD). Now main's own target is first (`ownTargetFirst`, also in
  run.ts whatever `--composition` order); its failure stops the fan-out (it
  carries the tree's validation); a later target's failure is recorded and
  the rest deploy; central and the deployed-phase steps follow main's own app
  whenever it deployed; the verdict is failed if anything failed. A
  composition whose stage-1 filtered registry throws is now that target's
  failure (`prepareCompositionSources` returns `compositionFailures`; the
  hermetic posture still throws), so a broken composition no longer blocks
  main's deploy.
- **One pool lock** (`withSlotPool`, `<pool>/.pool.lock`) serializes every
  read-then-act on the pool — `slotStates`, `acquireBuildSlot`'s pick/make,
  `runInBuildSlot`'s mark+release, `serveSlot` / `stampUnservedSlots`,
  `reclaimSlots`, `lease.downgrade()` — so a reclaim renaming a slot away can
  no longer fail a healthy deploy's stamping or a build's pick, and a
  hander's mark and release are atomic to a picker (which also re-reads the
  mark after its try). A lock-free `listSlots` skips a slot that vanished.
- **States come from the lock, not the records** (`probeSlotLock`): unheld ⇒
  free, exclusive ⇒ building, shared ⇒ draining (building with a live build
  record). A SIGKILLed holder's pid reused by another process no longer keeps
  a slot draining forever. Handed slots are not probed.
- **The leak-limit wait** never waits on the slot this process runs from
  (`ownRoot`, default `REPO_ROOT`: a convergence run's `build-relay` slot) and
  re-files `main-slots-exhausted` every 10 min it lasts (`waitingMs`). No
  health-report row: the stall lives in a CLI process with no live value a
  `HealthReport.Row` could read without a new server-side source; the report
  (and its notification) is the surface.
- **Fresh machine**: the early central spec of a slot build is written only
  after the build hands the slot over (`createHandOver().afterHandOver`).
- **Reclaim deletes only its slot's registration** (`<common>/worktrees/<id>`,
  checked to point back at the slot) instead of a repo-wide
  `git worktree prune`. Not `git worktree remove --force`: it enumerates every
  worktree and dies beside a concurrent add (`worktree/no-raw-worktree-git`),
  which is why `infra/worktree` itself removes by rename.

### Second review fixes (2026-11-17)

- **Validation rides on the first target ATTEMPTED, not index 0.** A
  composition-only build whose first target's stage-1 registry failed
  (`preparedFailures`) used to deploy the next target with no validation jobs
  and let its failure pass. `deployEachTarget` now tells each deploy whether it
  is the first attempted (`TargetPosition.first`); run.ts attaches the
  companions to it, and its failure stops the fan-out (`fan-out.test.ts`).
- **The pool lock is held for short steps only.** Reclaim used to sweep the
  trash, wait on the worktree-mutate gate and `rm -rf` a whole slot under
  `withSlotPool`; a build's new slot was a full `git worktree add` (gate
  included) under it. Now reclaim decides and renames to a claimed trash
  under the lock, and deletes (registration under the gate, then the tree)
  and sweeps after releasing it; a new slot is checked out in a claimed
  `.staging/` dir outside the lock, then published (its `gitdir` repointed,
  renamed into the pool) and taken under it — a listing never sees a
  half-made slot. Debris is claimed by a flock on `<debris>.lock`, so the
  sweep takes only what a killed owner left (`pool-debris.ts`).
- **A leak-limit wait re-checks the slot it was granted**, under the pool
  lock: a slot reclaimed meanwhile (or replaced at its path — compared by its
  registration), made to serve an app, or handed to a build is let go and the
  choice is made again. `waitExclusiveLease` lets its flock-wait child go when
  recording the holder fails (the slot's registration went with a reclaim).
- **A daemon bundle's content hash covers its copied scripts' bytes**, not
  just their names: an edited non-TypeScript script makes a new bundle
  (`infra/spawn/daemon/bundle`).

### Detached browser hosts run from bundles (2026-11-17)

The two detached, machine-wide browser hosts (`infra/mcp/browser`'s agent
browser, `apps/browser/engine`) were launched from the backend's checkout —
main's slot — WITHOUT holding it, and outlive the backend: a free slot could
be checked out at another commit or deleted under them (Playwright loads its
own modules lazily; a host spawns `flock-wait.ts` by path). Holding the slot
for the host's life would have kept a slot draining for hours (the agent
browser lives until 5 min after its last session). Instead a host never runs
from a slot:

- **`infra/spawn/daemon/bundle`** (`bundleDaemon`): at launch the backend
  bundles the host entry into `<host cache>/<hash>.bundle/` — one Bun.build
  JS file (repo code and pure-JS packages inlined), the scripts the closure
  runs by path (`scriptPath` literals, `infra/paths/repo-root`) bundled beside
  it at their repo-relative paths, `playwright` + `playwright-core` cloned
  into its `node_modules` (`PLAYWRIGHT_BUNDLE_EXTERNAL`: inlined, Bun bakes
  playwright-core's `__dirname` as the slot's install path), Chromium sealed
  by reference (`deps`' `linkSealedDep`). Content-addressed (emitted bytes,
  externals' store keys, seals), staged and renamed, reused when present. The
  bundler refuses a bundle that would read a module's own location or names
  the checkout's path. `repo-root` reads a `*.bundle` directory as the
  bundled code's `REPO_ROOT`.
- **Held by the host for life without host code**: the launcher takes a
  shared flock on the bundle's `in-use.lock` and hands the fd to the host
  (`launchDetached({ holdFds })`); the next launch in that host's bundle home
  deletes every bundle whose lock it can take exclusively. GC is the browser
  plugins' own, at their own launch time — `main-slots` names neither.
- **Restart policy unchanged**: the backend computes the host's `codeId`
  (its plugin's `bin/` + `shared/` + `core/`) and passes it with `--code-id`;
  the bundle hash is not the code id, so a push touching only code the host
  shares with others (flock, deps) keeps every session, as before.
- **Closure trimmed**: the agent host reached vite, esbuild, rolldown,
  `@babel/core`, `@tailwindcss/*` and the lexers through `page-ready` →
  `web-artifacts/core` (for one URL predicate). The URL grammar moved to the
  leaf `web-artifacts/served-paths`; the host's closure fell from 579 to 479
  modules and its npm externals to pure-JS ones.

So **browser hosts hold no slot**; a slot's holders are the backend,
central, `./equin` runs, the agent host while it loads, guard hooks and
builds.

### Open

- A holder SIGKILLed past the threshold leaves no drain record (no handler
  runs); only "still holding" at a reclaim catches it while alive.
- Verification on main after landing (plan § Verification, "Live on main").
