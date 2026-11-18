# main-slots

> **A slot is a checkout of one commit. Every running app lives in the slot it
> was built from. Keep exactly one free slot ready.**

Main and the compositions it serves (`sonata`, `website`, …) run from per-commit
**slots**, not from the checkout `./equin push` rewrites. Main is not special:
it is just the app that rebuilds most often, so it alternates between its slot
and the free one. Plans and measurements:
[`research/2026-11-16-global-main-slots.md`](../../../../../../research/2026-11-16-global-main-slots.md) (v1),
[`research/2026-11-17-global-main-slots-v2.md`](../../../../../../research/2026-11-17-global-main-slots-v2.md) (v2: one pool for every served app).

- **A build** takes the free slot and moves it to its commit (≈0.4 s). **One
  build covering several apps** puts them all in one slot. **When an app
  switches** to the new slot, its old slot **drains**: what it left running
  there finishes, and the slot is then free unless another app still lives in
  it. **Free slots beyond one are deleted**; a build that finds none free (the
  last one is still draining) makes one. Steady state: the slots apps live in,
  plus one.

## The slot

- A linked worktree of the repo, detached at one commit, with its own
  `node_modules`: `<data root>/services/main-slots/slot-<n>/` (`mainSlotsDir()`,
  the `main-slots` data dir). `getMainRepoRoot()` (`infra/spawn`) stays the git
  STORE — refs, worktrees, the human's checkout — not the code anything runs.
- **One `current` link per app**: `current/<namespace>` (`currentLinkFor`),
  the slot that app is served from. `serveSlot(slot, namespace)` flips one
  app's link (made beside it, renamed over it). Main's is the one the gateway
  resolves (`-main-slots-current`, passed by the launcher). `servedSlotOf(ns)`
  / `servedMainRoot()` resolve them (the latter: the repo's main checkout
  before any slot exists). The pre-v2 single `current` link (main's) is read
  as main's and migrated once into `current/<main namespace>`
  (`migrateLegacyCurrentLink`, run by `slotStates` / `serveSlot`).
- **A slot counts as main.** It is made with a stamp in its git dir
  (`stampMainSlot`, `infra/paths`); `checkoutRef` answers `main` for a stamped
  slot of the repo main's spec names (`mainNamespaceOwner` derives the repo
  from whichever checkout the spec names), `worktree` for another clone's. A
  stamp, not a location test: `infra/paths` cannot read this plugin's data dir.
- **Everything about a slot lives in its git ADMIN dir** (`<git dir>/<lock
  dir>/`, per linked worktree — git never lists it, no check's tree hash sees
  it; the layout is `plugins/boot-lease`'s): the lock, the holder records, the
  unserved stamp, the handoff mark, the drain records, main's served marker.

## Slot states — derived, never stored (`slotStates()`)

| State | Defined by |
|---|---|
| **serving** | an app's `current` link names it, or a namespace's spec does (a deploy whose new backend took over and then failed: the gateway respawns from the spec), or a holder that **pins** its slot runs from it (central — see below) |
| **building** | handed to a build (its hander lock held), or its lock held exclusively, or held shared with a live build among its holders (a build after its handover, until it exits) |
| **draining** | serves no app, but its lock is held shared (old backends, their children) |
| **free** | none of these: its lock is unheld, whatever records say |

**Each holder kind has a role** (`slotHolderRole`, boot-lease — a table total
over the kinds, so a new kind does not compile until it picks one): `pins` (the
holder is an app living in the slot: the slot serves while it holds it),
`drains` (must let go soon after the slot's last app left; past the threshold
it is a slow drain) or `outlives` (holds past the switch it causes by design:
`build-relay`). **Central pins.** One per machine, it keeps the slot it booted
from until a deploy restarts it — an adopted deploy keeps it there for as many
builds as its code is unchanged — and its spec is no proof of where it runs: a
build on a branch from before slots rewrites central's spec to the repo root on
every build. Read off links and specs alone, central's slot was "draining" for
as long as central lived, counted toward `DRAINING_SLOT_LIMIT` with the short
drains around it, and stalled main's deploy (2026-11-18). Pinned, it is never a
drain: not counted against the limit, never reported slow, and never stamped
unserved while central holds it (`stampUnservedSlots` clears a stamp a serving
slot still carries; the slot central leaves is stamped by the reclaim that
ends the deploy restarting it). An old central slow to exit keeps its slot
serving only until the gateway's stop grace kills it. A pinning record counts only while the slot's
lock is held (an unheld slot lists no holders).

Held or not is the LOCK's answer, never the records': `probeSlotLock` (a
non-blocking exclusive try, let go at once; refused, a shared try tells shared
from exclusive). Records only NAME holders — a SIGKILLed holder's pid can be
reused by an unrelated process, and a record alone would keep its slot
draining forever. A slot handed to a build is not probed (its claim's
exclusive try must not meet a probe). The handoff mark is judged the same way:
the hander holds `main-slot-handed.lock` exclusively from before it writes the
mark until it lets the handoff go, and a mark whose lock is unheld is stale —
never the hander's pid, which a SIGKILL frees for reuse.

The mark's format crosses versions: the hander is the convergence run, started
in the slot main SERVES, so it runs the commit before the one it builds — the
child must read every format an older hander writes. Each mark names its
`hold` (`lock`; none = the pre-lock `{handoff, pid}`, judged by its pid, as
its writer meant), and an unknown one is refused loudly. Change the format by
adding a `hold`, never by reinterpreting one: a child that refused the served
hander's mark failed every build, so main could not deploy the change
(2026-11-17, 958f655c93).

## The pool lock

Every step that reads slot states and acts on them runs under ONE exclusive
flock over the pool (`withSlotPool`, `<pool>/.pool.lock`; re-entrant within
one async flow): `slotStates` itself, `acquireBuildSlot`'s pick or publish,
`runInBuildSlot`'s mark-and-release, `serveSlot` and `stampUnservedSlots`,
`reclaimSlots`' choice and renames, and `lease.downgrade()` — so a reclaim
never renames a slot away between another process listing and reading it, a
hander's mark and release are one step to a picker, and a state probe never
lands in a downgrade's gap. **Short holds only**: nothing under it waits for
another process or does a slot-sized job. Outside it: a leak-limit wait, a new
slot's checkout (made in `.staging/`, then published — `gitdir` repointed and
renamed into the pool — and taken under the lock), and a removed slot's
delete (its registration under the worktree-mutate gate, then its tree). A
lock-free reader (`listSlots`) skips a slot that vanished between its listing
and its read.

**Pool debris** (`cli/internal/pool-debris.ts`): a slot being made
(`.staging/<name>`) or removed (`.trash-<id>-<ms>`) is a dot name no listing
reads, CLAIMED by its owner (an exclusive flock on `<debris>.lock`, taken
before the dir exists). Every reclaim sweeps the unclaimed ones — what an owner
killed mid-way left — with their own registration; a live owner's claim keeps
the sweep off its work, and the kernel drops a dead owner's.

## Leases

Each slot is a reader/writer lease on its own `<admin dir>/tree.lock`:
`acquireSharedLease(slot, kind, label)` while code runs from it,
`holdSlotForLife(root, kind, label)` for a process running from it until it
exits (`not-a-slot` elsewhere; its root hands `releaseAtExitSync` to its exit
handler), `tryExclusiveLease` (non-blocking) / `waitExclusiveLease` for a build,
and `lease.downgrade()` (exclusive → shared in place). Each lease writes a holder
record `<admin dir>/leases/<pid>.<n>.json` (`{pid, kind, mode, acquiredAt,
label}`); `readSlotHolders` touches a live pid's (last seen alive) and REAPS
a dead pid's (claimed by a rename, noted as a drain found dead, deleted). `reapDeadHolders` (under the
pool lock: every reclaim, and each slot just before it is stamped unserved)
reaps by the lock — unheld, every record is a dead holder's, a reused pid
included. Records name;
the lock decides (`probeSlotLock`). `label` names the holder for a report: a supervised child's job name (`worktree.prepare`), a
CLI process's verb (`run <script>` for a `./equin run` — an argv supervised
job such as `desktop.fullscreen-budget` — so each script is its own row), a
backend's namespace, a build's id.

Who holds a slot:

- **Backend and central** — `holdSlotForLife(REPO_ROOT, "backend" | "central",
  …)` at boot (`server-core/bin/serve.ts`, `central-core/bin/index.ts`).
- **Every `./equin` run from a slot** — the CLI bootstrap's
  `holdSlotLeaseSync(REPO_ROOT, kind, label)`, for life: `exec-child` (the
  backend's supervised children, `argv` jobs alike), or `build-relay` for a
  `./equin build` (main's convergence run, a relayed build: it hands the build
  to another slot and waits, so it holds its own slot past the switch it
  causes — by design, never a slow drain). Not in the slot handed to a build.
- **The agent host** — `agent-boot`, only while it loads. Its CLI's later
  needs live in the agent's own dir (the claude clone, a copy of
  `bin/background-shell`).
- **Agent hooks** — an agent outlives the slot its backend ran from, so every
  path an agent launch bakes in (its `GUARDS_ROOT`, the stop-gate and
  compaction hook commands) names main's `current` link instead of a slot
  (`durableCheckoutRoot`); the guard
  bootstrap holds it (a blocking shared flock, kind `guard`) while the hook runs, and its
  main fallback runs main's served slot (the most recent `main-slot-served`
  marker, written for main's own app only).
- **A build** — exclusive from its claim, shared from its handover, until it
  exits.
- **Main's gateway build** — `withServedMainRoot` holds main's served slot
  while `gateway-drift` compiles the gateway from it.
- **Not the browser hosts.** The agent browser and the Browser app's engine
  outlive their backend by hours, so they never run from a slot: each launch
  bundles the host into a self-contained dir of its own and the host holds
  that (`infra/spawn/daemon/bundle`). Any other detached daemon that outlives
  its backend must do the same.

## The build's half (`cli/`)

- **`acquireBuildSlot(sha)`**: a free slot, least recently served first (by
  its unserved stamp), taken without waiting; else — while fewer slots drain
  than the leak limit (`DRAINING_SLOT_LIMIT` = 3) — a new one
  (`infra/worktree`'s `addCheckout` under the worktree-mutate gate, + stamp:
  ~6 s plus the install); else it waits on the oldest draining slot and files
  `main-slots-exhausted` naming its holders (a leak, not a busy pool) — and
  files it again every `EXHAUSTED_REFILE_MS` (10 min) the wait lasts
  (`waitingMs` in the payload), never giving up: failing main's deploy over a
  leak would make it an outage. Never waited on: the slot this process runs
  from (`ownRoot`, default `REPO_ROOT` — a convergence run's `build-relay`
  slot drains only when it exits); with only that one draining past the
  limit, a slot is made. Never a slot an app lives in, nor one building or
  draining — even at the same commit. The pick is one step under the pool
  lock, and a slot found marked handed after its try is let go. A new slot is
  staged outside the lock and published and taken under it, so no listing
  ever sees one half-made. The slot a leak-limit wait was granted is re-read
  under the pool lock — let go, and the choice made again, when it was
  reclaimed (or replaced at its path: its registration differs), serves an app
  or was handed to a build meanwhile. Then the unserved stamp is cleared,
  `git checkout --force --detach <sha>` and `ensureDeps`.
- **`runInBuildSlot(sha, opts, build)`**: `acquireBuildSlot`, MARK the slot
  handed to a fresh handoff id (`markSlotHanded`: `{handoff, pid, hold: "lock"}` and the
  hander lock, held until the build is over — it reads as `building` while
  that lock is held) and release the lease (one step under the
  pool lock), and hand the slot to
  `build` — the CHILD build, started with `EQUIN_BUILD_SLOT` and
  `EQUIN_BUILD_SLOT_HANDOFF`. The child claims the slot only if its mark names
  that id (`claimHandedBuildSlot`, core; a mark for another handoff, or a
  holder found, is refused loudly) and holds it until it exits, turning it
  shared when it hands the slot to a backend it restarts there. Then — whatever
  the verdict — `reclaimSlots`. Used by main's convergence run
  (`converge.ts`) and by a main build that was not handed one (run.ts's slot
  relay).
- **`reclaimSlots()`**: stamp the slots that serve no app unserved; file the
  slow drains; remove free slots beyond `FREE_SLOTS_KEPT` (1), oldest first —
  under the pool lock, each taken exclusively and renamed out of the pool
  (claimed trash); then, after the lock is released, its own registration —
  `<common git dir>/worktrees/<id>/`, deleted only when no live checkout
  claims it back — goes under the worktree-mutate gate, then its tree, and the
  unclaimed debris is swept. Never a repo-wide `git worktree prune`, which
  would drop every other prunable checkout's entry too, and never
  `git worktree remove`, which enumerates every worktree and dies beside a
  concurrent add — `worktree/no-raw-worktree-git`. At the end of every main build and
  by the daily `main-slots.reclaim` job (`server/`, main only, running
  `./equin main-slots-reclaim` — the `reclaim` sub-plugin): a process killed
  with SIGKILL never releases its lease and nothing can announce its death, so
  a scheduled job is the documented exception to "no polling".

## Slow drains are reported

A process that keeps an old slot busy more than `main-slots.drainReportAfterSec`
(config, default 10 s) after its last app switched away is a problem to fix, not
a normal wait:

- **When serving stopped** is stamped on the slot (`main-slot-unserved`:
  `{at, reportAfterMs}`) by whoever sees its last app leave — `serveSlot`, a
  build moving central's spec, `reclaimSlots` (`stampUnservedSlots`). The
  threshold travels in the stamp, so the release paths read no config.
- **Captured at release**, so nothing is missed between builds: a lease let go
  past the threshold leaves `<admin dir>/drain-log/<pid>.<n>.json`
  (`{kind, label, pid, heldPastSwitchMs, thresholdMs, slot, commit}`) — plain
  `fs` in boot-lease (`noteLeaseReleaseSync`, and its async twin in `lease.ts`),
  on every release path: an explicit release, the CLI bootstrap's exit handler,
  a lifetime lease's `releaseAtExitSync`, the guard bootstrap's release
  (`noteGuardDrain`, its builtins-only copy).
- **Found dead**, for a holder SIGKILLed while holding (no release runs): the
  reader that reaps its record (`reapDeadHolders` at every reclaim,
  `readSlotHolders`) writes its drain record, `foundDead: true`, when the
  holder was last SEEN ALIVE past the threshold — the record's mtime, set at
  acquire and touched by every `readSlotHolders` (every slot-state read) that
  finds its pid live. A lower bound: one killed inside the threshold (a
  backend SIGKILLed after the gateway's grace) is never reported; one killed
  past it between two looks is missed. A holder already dead when the slot
  stopped serving is reaped before the stamp is written, unreported.
- **Filed by `reclaimSlots`**: one `main-slot-drain-slow` report per record
  (deleted once written to the outbox, kept otherwise), and one per holder of a
  draining slot still holding past the threshold ("still holding").
  Fingerprint `(kind, label)`: one row per job, its occurrences counted. The
  report names the job — what to make faster, or stop from outliving its app.
- Only `drains` holders are reported: never `build-relay` (it causes the
  switch), never central (it pins its slot). Reclaim checks the role again
  when it files a drain record and deletes a record of any other kind: the
  record is written by the releasing process with the code it booted with,
  and a central started before central pinned its slot still noted one at
  its exit (2026-11-18).

## The deploy across slots

- **Converge** builds every app due at one HEAD in ONE build: main's own and
  the compositions together, one slot, one `build_runs` row with every target
  (`build/converge`'s `convergenceBuild`). Apps due at different commits are
  successive passes.
- **The build** writes each target's spec (`server` = the slot), and flips
  each target's `current/<namespace>` link once THAT target deployed healthy
  (`build/cli/run.ts`, after handing the slot over) — never on a failed one.
  **The link is the newest code deployed; the spec is what the backend runs
  from.** They differ when the running backend ADOPTED the deploy from its
  previous slot (restart-skip judges the backend's closure by content): the
  link still moves — everything that reads it wants the new code (the next
  convergence run, main's gateway build, agents' guard hooks; a gateway-,
  guard- or CLI-only change deploys through exactly this) — while the spec
  keeps naming the slot the backend runs from, which `slotStates` therefore
  still counts as serving until a later deploy restarts it elsewhere. A failed
  restart that leaves the previous backend serving puts its previous spec back
  (`spec-switch.ts`); the link was never moved, so spec and link agree again.
- **Partial failure of a grouped build**: main's own target goes first; the
  first target ATTEMPTED carries the validation (one whose stage-1 registry
  failed is skipped, and the next carries it), and its failure stops the
  fan-out. A later target's
  failure (or its composition registry failing in stage 1) is that target's:
  the others still deploy, central and the deployed-phase steps still follow
  main's own app, and the verdict is failed (`build/cli`'s `fan-out.ts`).
- **Central's spec names where central runs**, read from central's adopt
  answer (restart-skip's `root`), never from the previous spec: a worktree
  build from before the slots rewrites central's spec to the repo root on
  every build, and trusting it kept slot-3 reading as draining (2026-11-17).
  A main build that finds the spec naming another tree rewrites it and clears
  that slot's unserved stamp (`clearUnservedAt`); the gateway refuses such a
  spec meanwhile (`gateway/central_spec_guard.go`).
- **Central's spec** moves only with a build that deployed main's own app. On
  a fresh machine (no central spec yet) a slot build writes it only once it
  has handed the slot over (`hand-over.ts`): a central spawned from a slot
  the build still holds exclusively would block behind it.
- **The gateway** starts each convergence run in the slot main's link
  resolves to (`gateway/main_deploy.go` `convergeDir`; the repo root while
  there is none), and is itself built from main's served slot
  (`gateway-drift`'s `prepareMainGateway`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Main's per-commit slots: every app main serves (its own and its compositions) runs from a checkout of the commit it was built from, apps built together share one, and one free slot is kept ready (see the plugin's core and cli). Web half: registers the main-slots config (drainReportAfterSec — how long a process may keep an old slot busy after its app switched away before it is reported) for Settings → Config. Main's per-commit slots (the checkouts main and its compositions are built and served from; see the plugin's core and cli), server half: the main-slots config (drainReportAfterSec), the main-slot-drain-slow report kind (a process that kept an old slot busy past the threshold after its app switched away, one row per job), the main-slots-exhausted report kind (a build found no free slot and the draining ones at the leak limit, and waited), and the daily main-slots.reclaim job (main only) — the backstop reclaim for slots freed by a killed process.
- Web:
  - Contributes: `ConfigV2.WebRegister` "main-slots"
  - Uses: `config_v2.ConfigV2`
- Server:
  - Contributes:
    - `ConfigV2.Register` "main-slots"
    - `report-kind` "main-slot-drain-slow"
    - `report-kind` "main-slots-exhausted"
  - Uses:
    - `config_v2.ConfigV2`
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `primitives/log-channels.defineLogSink`
    - `reports.ReportKind`
    - `reports.ReportRow`
  - Register: `defineSupervisedJob('main-slots.reclaim')`
- Core:
  - Uses: 47 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/git/main-slots/boot-lease` ×20
    - `packages/timed-fs` ×6
    - `infra/paths` ×5
    - `infra/namespace` ×4
    - `packages/flock` ×4
    - `infra/host-fs/user-path` ×3
    - `packages/owned-fd` ×2
    - `infra/launcher/env-names.readEnv`
    - `infra/paths/repo-root.REPO_ROOT`
    - `infra/spawn.getMainRepoRoot`
  - Exports (types):
    - `DrainSlowPayload`
    - `HandedBuildSlot`
    - `MainSlot`
    - `SlotHanded`
    - `SlotHandoffHold`
    - `SlotHold`
    - `SlotLease`
    - `SlotLockProbe`
    - `SlotsExhaustedPayload`
    - `SlotState`
    - `SlotStateKind`
    - `TryExclusiveLease`
  - Exports (values):
    - `acquireSharedLease`
    - `claimHandedBuildSlot`
    - `clearSlotHanded`
    - `clearUnserved`
    - `clearUnservedAt`
    - `currentLinkFor`
    - `currentLinksDir`
    - `DRAIN_SLOW_REPORT_KIND`
    - `drainSlowFingerprint`
    - `drainSlowMessage`
    - `DrainSlowPayloadSchema`
    - `durableCheckoutRoot`
    - `holdSlotForLife`
    - `isInSlotPool`
    - `listSlots`
    - `mainSlotsDir`
    - `markSlotHanded`
    - `readSlotHanded`
    - `readSlotHolders`
    - `reapDeadHolders`
    - `servedMainRoot`
    - `servedSlotOf`
    - `serveSlot`
    - `SLOTS_EXHAUSTED_REPORT_KIND`
    - `SlotsExhaustedPayloadSchema`
    - `slotStates`
    - `stampUnservedSlots`
    - `tryExclusiveLease`
    - `waitExclusiveLease`
    - `withServedMainRoot`
    - `withSlotPool`
- Cli:
  - Uses: `framework/cli/bootstrap.ensureDeps`
  - Exports (types):
    - `AcquireBuildSlotOptions`
    - `BuildSlot`
    - `HandedSlot`
    - `HeldSlot`
    - `ReclaimOptions`
    - `ReclaimOutcome`
    - `RunInBuildSlotOptions`
  - Exports (values):
    - `acquireBuildSlot`
    - `DRAINING_SLOT_LIMIT`
    - `FREE_SLOTS_KEPT`
    - `readDrainReportAfterMs`
    - `reclaimSlots`
    - `runInBuildSlot`
- Cross-plugin:
  - Imported by:
    - `conversations/compaction-context`
    - `conversations/runtime-sdk`
    - `conversations/stop-gate`
    - `framework/cli/build`
    - `infra/git/main-slots/reclaim`
    - `infra/launcher`
    - `infra/launcher/gateway-drift`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/handoff.ts`, `core/internal/lease.ts`, `core/internal/pool-lock.ts`, `core/internal/slots.ts` (debt)
- Sub-plugins:
  - **`boot-lease`** — A main slot's lease file layout (the tree.lock flock, the holder records beside it, the main-slot stamp) and holdSlotLeaseSync — the shared lease a process takes on the slot it runs from BEFORE it…
  - **`reclaim`** — `./equin main-slots-reclaim` — reclaim main's slot pool (stamp the slots no app lives in any more, file a main-slot-drain-slow report per process that kept one busy past the threshold, remove free…

<!-- AUTOGENERATED:END -->
