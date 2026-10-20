# op-runtime

The machinery an **op command** runs on — the shared half of `build`, `check`,
`test`, `push`, and the e2e branch of `run`.

Broadcasts, the deploy receipt, fatal-signal exits, signal-origin attribution,
lane classification, the op profiler and its durable progress log, the duress
admission valve, the nested-check subprocess, build-output rendering, crash
recording — and the whole lifecycle of a **direct op**.

## `withDirectOp` — one lifecycle for the ops whose only ticket is the host grant

`check`, `test` and an `e2e` script run (`./singularity run plugins/…/e2e/x.ts`)
are the same op shape: nothing to lock but the host CPU grant. Before
`direct-op.ts` the check command hand-rolled the sequence — identity, the
broadcast banner, the interrupted-predecessor warning, the lane, the per-op
liveness marker (a flocked `ops/<opId>.json`, published before `requested` and
released only after `completed` is appended), the op-log profiler (`requested` →
`granted` → `completed`), a graceful exit on a catchable fatal signal with
signal-origin attribution, and the grant — and `test` / `e2e` would have been
the second and third copies. It is one function:

```ts
const outcome = await withDirectOp("test", { max: cpuBudget().B }, async (grant, ctx) => {
  // run the work under `grant`; `ctx` carries slug / branch / lane / opId /
  // nested / profiler
  return ok ? "success" : "failed";
});
if (outcome !== "success") process.exit(1);
```

The command owns only what is genuinely its own: what to run under the grant,
what the outcome means, and its own exit code (the primitive never calls
`process.exit`). Nesting is handled once, inside: a parent's grant in the
environment (`inheritedGrant()`) means no marker, no record, no handlers — the
parent owns all three — and the body spends the inherited units.

### Run-level single-flight (`opts.flight`)

`check` and `test` opt in: N identical requests in one worktree at once cost
one run (2026-10-09: ~14 subagents each ran `check type-check`, 11 concurrent
15–20 GB workers). The command computes a key — its selection plus the
**tree hash** (the correctness bar: a verdict is only adopted from a run that
started on the tree the joiner saw) — and `withDirectOp` wraps the grant step in
`packages/single-flight` under `worktreeArtifacts.opFlights(slug)`:

- **Joined BEFORE the grant**, because a `Grant` cannot be released early: a
  duplicate that queued first would hold host CPU for a run it never does. A
  joiner still writes its marker and `requested`, opens an `in-flight` wait
  (reason `<kind> <leaderOpId>`), never calls `withHostGrant`, and completes
  with the leader's outcome via `flight.adopt` (the command prints the leader's
  transcript / failure list).
- **Only `success` / `failed` are shared.** `error` says nothing about the work;
  a joiner whose leader died, threw or published nothing leads itself.
- **A nested op leads but never waits** (`tryLead`). A top-level leader can be
  queued for a host grant whose units the nested op's parent holds; joining it
  would deadlock. Busy → the nested op runs unshared.
- `--no-cache` / `SINGULARITY_CHECK_NO_CACHE=1` and a fail-open (null) tree
  hash mean no flight. `e2e` is not opted in (live browser, arbitrary args).

`build` and `push` are **not** direct ops (build lock + duress valve + host grant;
the push mutex) and keep their own lifecycles. Every seam is injectable
(`DirectOpDeps`), which is how `direct-op.test.ts` asserts the order and the
nested gating without a flock or a marker file.

## Admission priority (`priority.ts`)

`opPriority(root, kind, isMainCheckout)` decides the host-admission `Priority`
an op acquires at: `low` when the checkout is the worktree of a task on the
**sidequest** track (`tasks/task-track`'s `checkoutTrack`, read from the main
database at acquire time), `normal` otherwise. A `low` op takes a host slot only
while no `normal` op of the same pool is waiting (`packages/host-semaphore`), so
the sidequest track never delays the main track. Applied where an op acquires:
`withDirectOp` (check / test / e2e — asked only when it really acquires, never
when nested or joining a flight), `build`'s heavy-section grant, and `push`'s
mutex. Push's grant inside the mutex stays `normal`: every queued push waits out
the holder. A main database that cannot answer is printed and admits at
`normal` — priority orders a queue, it bounds nothing.

## Direction of the dependency

Commands import this; **nothing here may import a command.** The `cli` runtime's
import graph has to stay a DAG, and this is the node everything else hangs off.

It does not import `bootstrap` either, and `bootstrap` does not import it.
Keeping the two apart is what lets the bootstrap closure stay npm-free while this
one is unconstrained. The one place they nearly met is the build lock's
wait policy, which wants this plugin's build-progress log:
`acquireCheckoutLock` takes an `observeHolder` hook instead, and
`app-artifacts` — which already has the log loaded — supplies it. There is no
edge between the two plugins in either direction.

## The receipt has a `core` barrel

Everything else here is CLI machinery, but the deploy receipt
(`build-status.json`) is a **record**, and reading a record is not a CLI act.
The e2e harness has to prove that the deploy answering its target is the build
the checkout it runs from actually published, and the `e2e` runtime may reach a
plugin's `core` barrel but never its `cli` one. So `build-receipt.ts` sits in
`core/internal/` and `cli/build-receipt.ts` is a one-line shim onto it. Writing
the receipt is still the op commands' job; only the reading grew a second door.

`core/` here means runtime-neutral **Node**, not web-safe: the module reaches
`node:fs` and `paths/core`, whose module scope calls `homedir()`. Nothing in
`web/` may import it.

## No path re-exports

There used to be a `paths.ts` here whose entire content was re-exporting
`worktreeArtifacts` / `PG_LOG_FILE` / `MAIN_WORKTREE_NAME` / … from the plugins
that own them. That was only ever legal because `bin/` sits outside the boundary
rules: a `cli/` barrel surfacing another plugin's names is a
`cross-plugin-reexport` violation, and the detector follows indirect chains, so
hiding the proxy behind an internal file would not have helped.

Consumers now import from the owning barrel —
`@plugins/infra/plugins/paths/server` for the worktree paths,
`@plugins/database/plugins/embedded/server` for `PG_LOG_FILE`. Most of the tree
already did (`db`, `start`, `app-artifacts`, `legacy-dist-reap`); only three
files used the proxy. Two of its re-exports (`worktreesDir`,
`DATABASE_CONFIG_PATH`) had no consumer at all.

This also honours the deleted file's own stated rule better than it did: a path
is named once, by the plugin that owns the directory, and never re-derived.

## Why a plugin, not files in `bin/`

Once every command is its own sub-plugin, a sibling cannot reach the host's
`bin/`, and `shared/` is plugin-private. A `cli/` barrel is the sanctioned way
for one CLI plugin to share code with another — the same shape `e2e/` uses for
the shared Playwright harness.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Shared machinery of the op commands (build / check / test / push / run <e2e>): broadcasts, deploy receipt, fatal-signal exits, lane, op profiler, progress log, admission valve, nested check, build output, and the direct-op lifecycle (withDirectOp).
- Core:
  - Uses:
    - `infra/paths.worktreeArtifacts`
    - `infra/paths.worktreeDataDir`
  - Exports (types):
    - `BuildReceipt`
    - `BuildReceiptStatus`
    - `ResolvedReceipt`
  - Exports (values):
    - `interruptedPredecessorWarning`
    - `readBuildReceipt`
    - `reportInterruptedPredecessor`
    - `resolveBuildReceipt`
    - `writeBuildReceipt`
- Cli:
  - Uses:
    - `infra/jobs/supervised-job.cliExecContext`
    - `tasks/task-track.checkoutTrack`
  - Exports (types):
    - `BuildLogs`
    - `BuildProfile`
    - `BuildProgressRecord`
    - `BuildReceipt`
    - `BuildReceiptStatus`
    - `BuildRunProgress`
    - `BuildSpan`
    - `BuildStepLog`
    - `CheckSubprocessOptions`
    - `CheckSubprocessResult`
    - `DirectOpContext`
    - `DirectOpDeps`
    - `DirectOpFlight`
    - `DirectOpOptions`
    - `FatalSignal`
    - `FatalSignalExitOptions`
    - `HoldOutcome`
    - `JoinedRun`
    - `ResolvedReceipt`
    - `SignalOriginTapOptions`
    - `SignalTermination`
    - `ValveDeps`
    - `Verdict`
  - Exports (values):
    - `buildProfilerStart`
    - `checkBroadcasts`
    - `checkValveGuard`
    - `createValveDeps`
    - `emitVerdict`
    - `FATAL_SIGNAL_EXITS`
    - `finishBuildProgress`
    - `holdThroughValve`
    - `installFatalSignalExit`
    - `installVerdictGuard`
    - `LANE_ENV`
    - `laneFor`
    - `MAX_VALVE_HOLD_MS`
    - `openBuildProgress`
    - `opPriority`
    - `printStepBlocks`
    - `PROGRESS_FILE`
    - `publishLane`
    - `pushBuildSpan`
    - `pushBuildStepLog`
    - `readBuildProgress`
    - `readBuildReceipt`
    - `readCliCrash`
    - `recordCliCrash`
    - `renderVerdict`
    - `reportInterruptedPredecessor`
    - `resolveBuildReceipt`
    - `runCheckSubprocess`
    - `shouldRequeue`
    - `signalOriginTap`
    - `valveGates`
    - `withDirectOp`
    - `writeBuildLogs`
    - `writeBuildProfile`
    - `writeBuildReceipt`
- Cross-plugin:
  - Imported by:
    - `framework/cli/build`
    - `framework/cli/check`
    - `framework/cli/push`
    - `framework/cli/release`
    - `framework/cli/run`
    - `framework/cli/test`
- Exemptions:
  - Exempts itself from:
    - `watcher-safety/no-raw-fs-watch` — `cli/admission-valve.ts` (sanctioned)
    - `boundaries/no-platform-api` — `core/internal/build-receipt.ts` (debt)

<!-- AUTOGENERATED:END -->
