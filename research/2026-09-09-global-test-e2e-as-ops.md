# `./equin test` and e2e runs as first-class ops

## Context

The build/check/push page (`block-f0d24b10-…`, "Monitoring") wants every op a
worktree runs to report through ONE system: live in the conversation's
op-status banner and sidebar chip, in the op history (the Debug → Profiling →
Ops Gantt), with its lock/grant wait visible, and admitted to the host through
the same scheduler. Its checklist names `singularity test` as not covered.

Today `./equin test` and an e2e script run (`./equin run
plugins/<…>/e2e/<name>.ts`) are plain `spawnPassthrough` wrappers. They write
no worktree op marker (so the conversation reads `waiting` while tests run and
the banner shows nothing), no op-log record (invisible in the Gantt), and take
no host CPU grant (an unbounded, uncounted consumer beside the tracked
build/push/check ops — the same blind spot `check` was before op-log existed).

Decisions taken with the user:

- `test` and `e2e` **take a host CPU grant** like a direct `check`, with the
  queue time recorded as a `host-grant` wait.
- **Not every `./equin run` is an op.** Only a script under an `e2e/`
  directory (the documented convention `plugins/<path>/e2e/<name>.ts`) is an
  `e2e` op. The `run` command decides from the path; every other script runs
  exactly as today, with no grant and no marker.

Two structural problems make a per-command patch the wrong shape, so the plan
fixes them first:

1. **The op-kind list is a closed union spelled in seven places** (marker,
   op-log types, op-log fold, op-status zod schema, banner, chip, broadcasts ×2).
   Adding a kind today is a scavenger hunt. It becomes one `core/` data
   declaration; every `Record<OpKind, …>` downstream then fails to type-check
   until the new kinds have an entry (rung 2 of the fix ladder).
2. **The direct-op lifecycle is hand-rolled** (~100 lines in
   `check/cli/run.ts`: identity, broadcasts, lane, marker waiting→running,
   profiler requested→granted→completed, fatal-signal exit, host grant,
   exit-handler cleanup). `test` and `e2e` need exactly that lifecycle. It
   becomes one primitive, and `check` moves onto it so there is one copy, not
   three.

Out of scope (follow-ups, noted at the end): a DB-backed `runs` arm for
test/e2e, a durable test transcript file, forcing e2e runs into background
tasks via the `background-ops` guard.

## The three layers, as they exist (for orientation)

| layer | where | written by | read by |
|---|---|---|---|
| live marker `~/.singularity/worktrees/<slug>/ops/<kind>.json` | `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` (`markWorktreeOpStart` / `setWorktreeOpPhase` / `clearWorktreeOp`) | CLI process directly | op-status watcher → `worktree-ops` live resource → banner + chip; `isWorktreeOpActive` → conversation `working` status (runtime-tmux) |
| durable op-log `~/.singularity/logs/op-log/op-log.jsonl` | `plugins/debug/plugins/profiling/plugins/op-log` (`createOpProfiler`) | CLI process directly | Ops Gantt (`debug/profiling/ops`), `stats/pushes` |
| host CPU grant | `plugins/infra/plugins/host/plugins/host-admission` (`withHostGrant`, `inheritedGrant`, `Grant.env()`) | CLI process | — (wait recorded into op-log via `profiler.grantHooks()`) |

Nothing changes in how these layers work. The plan only (a) widens the kind
vocabulary at its source and (b) shares the lifecycle that drives them.

## Step 1 — One op-kind declaration: `plugins/infra/plugins/worktree/core`

The worktree plugin already owns the vocabulary (op-log's docs say its `OpKind`
is "borrowed" from `WorktreeOp`). Its `core/` barrel is web-safe and already
imported by web code (the Gantt reads `stripAttemptBranchPrefix` from it), and
it is a pure leaf — zero outgoing cross-plugin edges.

New `core/internal/op-kind.ts`, exported from `core/index.ts`:

```ts
export interface OpKindMeta {
  label: string;        // "Build" → "Build in progress", "Build queued — waiting for lock"
  progressive: string;  // "Building" — the busy-row verb
}
export const OP_KINDS = {
  build: { label: "Build", progressive: "Building" },
  push:  { label: "Push",  progressive: "Pushing" },
  check: { label: "Check", progressive: "Checking" },
  test:  { label: "Test",  progressive: "Testing" },
  e2e:   { label: "E2E",   progressive: "Running e2e" },
} as const satisfies Record<string, OpKindMeta>;
export type OpKind = keyof typeof OP_KINDS;
export const OP_KIND_IDS = Object.keys(OP_KINDS) as [OpKind, ...OpKind[]]; // feeds z.enum
export function isOpKind(value: string): value is OpKind;
```

Icons stay on the web side as a `Record<OpKind, IconType>` (tsc-complete), not
in core — core must not import react-icons.

Derive every existing spelling from it:

- `worktree/server/internal/worktree-op.ts`: `export type WorktreeOp = OpKind;`
  `const KNOWN_OPS = OP_KIND_IDS;` (keep the `"build"` fallback for a garbage
  marker). Update the module comment.
- `op-log/core/internal/types.ts`: delete its own `OpKind`, import it from
  `@plugins/infra/plugins/worktree/core`. **Remove `OpKind` from
  `op-log/core/index.ts`'s export list** — re-exporting another plugin's symbol
  is banned (transitively). Consumers that imported `OpKind` from op-log/core
  switch to worktree/core: `debug/profiling/ops/shared/endpoints.ts`
  (`exhaustiveEnum<OpKind>` gains `test`, `e2e`),
  `debug/profiling/ops/plugins/op-gantt/web/components/op-gantt.tsx`.
- `op-log/core/internal/types.ts` `OutcomeByKind` gains
  `test: "success" | "failed" | "error"` and the same for `e2e`. This is where
  the type checker bites: `TerminalOutcome = OutcomeByKind[OpKind]` fails to
  compile the moment a kind exists without an outcome entry.
- `op-log/core/internal/fold.ts`: `KNOWN_KINDS = OP_KIND_IDS`.
- `op-status/shared/schemas.ts`: `op: z.enum(OP_KIND_IDS)` (`shared/` may
  import a `core` barrel).
- `debug/broadcasts/shared/endpoints.ts`: `z.array(z.enum(OP_KIND_IDS))`;
  `debug/broadcasts/web/components/broadcasts-panel.tsx`:
  `type BroadcastCommand = OpKind; const ALL_COMMANDS = OP_KIND_IDS;`;
  `op-runtime/cli/broadcasts.ts`: `type BroadcastCommand = OpKind`.
- `guards/core/guards/background-ops.ts`: no change (`LONG_OPS` already has
  `test`; `run` deliberately stays foreground-capable, see follow-ups).

`createOpProfiler<K extends OpKind>` needs no change — nothing in the profiler
enumerates kinds.

## Step 2 — One lifecycle primitive: `op-runtime/cli/direct-op.ts`

New file in `plugins/framework/plugins/cli/plugins/op-runtime/cli/`, exported
from its `cli/index.ts` as `withDirectOp` (+ `DirectOpContext`,
`DirectOpOptions`). It is the body of `check/cli/run.ts` lines ~200–420 made
generic; `getWorktreeIdentity()` moves there verbatim as a private helper.

```ts
export interface DirectOpContext<K extends OpKind> {
  slug: Namespace; branch: string; lane: Lane; opId: string;
  nested: boolean;                    // inherited a parent's grant ⇒ no marker, no record, no handlers
  profiler: OpProfiler<K> | undefined; // undefined when nested
}
export interface DirectOpOptions { max: number; opId?: string /* nested-only adoption (check --run-id) */ }

export async function withDirectOp<K extends OpKind>(
  kind: K,
  opts: DirectOpOptions,
  body: (grant: Grant, ctx: DirectOpContext<K>) => Promise<OutcomeByKind[K]>,
): Promise<OutcomeByKind[K]>
```

Sequence, identical to check's today: `inheritedGrant()` → nested?;
`checkBroadcasts(kind)` and `reportInterruptedPredecessor(slug)` when not
nested; lane = interactive iff `slug === MAIN_WORKTREE_NAME`, `publishLane`;
`opId = opts.opId ?? randomUUID()`; when not nested: `createOpProfiler(kind,
{opId, branch, opSlug: slug, lane})`, `markRequested()`,
`markWorktreeOpStart(slug, kind, "waiting-for-lock")`, `process.on("exit")` →
`clearWorktreeOp` + `profiler.write()`,
`installFatalSignalExit(signalOriginTap({opId, worktree: slug}))`. Then
`withHostGrant({lane, max, hooks: profiler?.grantHooks()}, runUnder)` (or
`runUnder(inherited)` when nested), where `runUnder` flips the marker to
`running`, `markGranted()`, runs `body`, `profiler.complete(outcome)`. `finally`
clears the marker. The primitive never calls `process.exit`; the command owns
its exit code. A `body` that throws lands as `error` via the exit-handler write,
as today.

New import edges from `op-runtime/cli`: `infra/worktree/server`,
`debug/profiling/op-log/server`, `infra/host/host-admission/server`,
`infra/paths/server`. All acyclic: none of those plugins reaches
`framework/cli/*` in any runtime (checked their barrels' import lists), and
`check/cli/run.ts` already imports every one of them, so eval-weight for a CLI
process is unchanged. The op-runtime rule "nothing here imports a command"
still holds.

Build and push keep their own lifecycles untouched (build lock, duress valve,
push mutex, nested-check subprocess have no analogue here).

## Step 3 — Migrate `check` onto it

`plugins/framework/plugins/cli/plugins/check/cli/run.ts`: everything from
`const inherited = inheritedGrant();` through the closing `finally` becomes one
call:

```ts
const outcome = await withDirectOp("check", { max: cpuBudget().B, opId: opts.runId },
  async (grant, ctx) => {
    const checkLogPath = worktreeArtifacts.checkLog(ctx.slug, ctx.opId);
    const ok = await runChecks(checks.length > 0 ? checks : undefined, {
      grant,
      onCheckDone: ctx.profiler ? (id, d, s) => ctx.profiler.recordStep(id, d, s) : undefined,
      noCache: opts.cache === false,
      jobs: opts.jobs !== undefined ? Number(opts.jobs) : undefined,
      scope, alwaysRun: opts.alwaysRun === true,
      logRun: { worktree: ctx.slug, runId: ctx.opId },
      log: (line, stream) => (stream === "stderr" ? console.error : console.log)(line),
    });
    if (!ok) console.error(`\nFull check output: ${checkLogPath}`);
    return ok ? "success" : "failed";
  });
if (outcome !== "success") process.exit(1);
```

Everything above that block (`--list`, `--status`, `--run-id` nested-only
validation, `requestedJobs` throw) stays. Drop the now-unused imports. Behaviour
must be byte-identical for a nested check (no marker, no record, no handlers,
parent's grant, adopted `--run-id`).

## Step 4 — `test`

`plugins/framework/plugins/cli/plugins/test/cli/run.ts`: enumeration and
classification stay BEFORE the op (a typo'd path must fail without ever
queueing for a grant, the rule check documents for `--list`). Only the two
runner invocations move inside:

```ts
const outcome = await withDirectOp("test", { max: cpuBudget().B }, async (grant) => {
  const env = { ...process.env, ...grant.env() };
  bunExit = bun.length > 0 ? await runRunner("bun:test", [bunBin, "test", ...runnerArgs], root, env) : null;
  domExit = dom.length > 0 ? await runRunner("vitest",
      [bunBin, "x", "vitest", "run", `--maxWorkers=${grant.units}`, ...runnerArgs], root, env) : null;
  …existing summary / orphan / no-files reporting…
  return failed.length > 0 ? "failed" : "success";
});
if (outcome !== "success") process.exit(1);
```

`runRunner` gains an `env` parameter forwarded to `spawnPassthrough`. Only
vitest is capped: `bun test` runs files in one process by default
(`--parallel` is opt-in), vitest's `forks` pool defaults to the core count, so
`--maxWorkers=<grant.units>` (vitest ^4.1.4 flag) is what makes the grant real.
Comment the asymmetry so nobody "fixes" it into symmetry. The command still
takes paths and nothing else — no `--jobs`; the grant is always the elastic
share.

## Step 5 — `e2e` via `run`

Predicate: new `core/` runtime for the e2e-harness plugin,
`plugins/framework/plugins/tooling/plugins/e2e-harness/core/index.ts` exporting
`isE2eScriptPath(repoRelPath)` from `core/internal/e2e-path.ts`: under
`plugins/`, a runnable module extension (`MODULE_EXTENSION` from
`tooling/guards/core`), with an `e2e` path segment. The harness plugin owns the
`plugins/<path>/e2e/<name>.ts` convention, so the predicate lives with it (not
in test-layout, which owns a different split). Leaf module, no `node:*`.

`plugins/framework/plugins/cli/plugins/run/cli/run.ts`: after the existing path
validation and before the spawn:

```ts
if (isE2eScriptPath(rel)) {
  const outcome = await withDirectOp("e2e", { max: 1 }, async (grant) => {
    const { exitCode, signalCode } = await spawnPassthrough([bunBin, abs, ...args],
      { cwd: root, stdin: "inherit", env: { ...process.env, ...grant.env() } });
    if (signalCode !== null) { console.error(`\n${rel} was killed by ${signalCode}.`); return "failed"; }
    if (exitCode !== 0) { process.exitCode = exitCode; return "failed"; }
    return "success";
  });
  if (outcome !== "success") process.exit(process.exitCode ?? 1);
  return;
}
// existing non-e2e spawn, byte-identical
```

`max: 1`: one script driving one Chromium, no fan-out. The harness scripts
themselves do not change (the `e2e` runtime may only import `core`/`e2e`
barrels, so the lifecycle cannot live there — that is why it sits in the
command).

## Step 6 — Surfaces that key on kind

- `op-status/server/internal/resource.ts`: `OP_RANK: Record<OpKind, number> =
  { push: 4, check: 3, build: 2, test: 1, e2e: 1 }` — test/e2e never contend
  on a worktree-shared lock, so they lose the single display slot to the ops
  that do (only matters in the documented "safety tiebreak" case).
- `op-status/web/components/op-status-banner.tsx`: `summaryLabel` →
  `` `${OP_KINDS[op.op].label} in progress` `` / `` `… queued — waiting for lock` ``;
  the no-queue group filter becomes `o.op !== "push"` (push is the only kind on
  a global lock); `phaseText` → `OP_KINDS[op.op].progressive`.
- `op-status/web/components/op-status-chip.tsx`: `OP_ICON: Record<OpKind,
  IconType>` = build MdBuild, push MdUpload, check MdScience, test MdChecklist,
  e2e MdOpenInBrowser (verify names exist in `react-icons/md`); hourglass for any
  waiting op; titles from `OP_KINDS` (check's tooltip becomes "Check in
  progress", matching the banner).
- `op-gantt.tsx` `TYPE_FILL: Record<OpKind, string>` gains
  `test: "bg-categorical-6", e2e: "bg-categorical-7"` (unused categorical
  tokens; waits use 3/4/8/9, check uses 5). `op-detail.tsx`, `use-op-click.ts`,
  `handle-op-profiling.ts` are already kind-agnostic.
- runtime-tmux `working` status and the op watcher: automatic (marker-agnostic).

## Step 7 — Docs

- `op-status/CLAUDE.md`, `op-log/CLAUDE.md` ("Vocabulary is borrowed" →
  "defined once in `infra/worktree/core`, both import it"), `op-runtime/CLAUDE.md`
  (document `withDirectOp`; shared half of build/check/test/push/`run`'s e2e
  branch), `worktree-op.ts` module comment, ops/op-gantt CLAUDE.md fill table.
- Root `CLAUDE.md`: one line under "Testing" and one under "Driving the app":
  a test run / an `e2e/` script run is an op — it takes a host CPU grant and
  shows in the op-status banner like `./equin check`.
- Autogen reference blocks regenerate on `./equin build`.

## Step 8 — Tests (`./equin test <plugin>`)

- `worktree/core/internal/op-kind.test.ts`: `isOpKind`, `OP_KIND_IDS` ==
  `Object.keys(OP_KINDS)`.
- `worktree/server/internal/worktree-op.test.ts`: a `test`/`e2e` marker is read
  back as itself; an unknown kind still falls back to `build`.
- `op-log/core/fold.test.ts`: `kind: "test"` and `"e2e"` fixtures through the
  in-flight and terminal paths.
- `op-log/server/internal/profiler.test.ts`: full cycle for `test` and `e2e`;
  `// @ts-expect-error` that `"failed_rebase"` is rejected on `test`.
- `op-runtime/cli/direct-op.test.ts`: inject deps (as `admission-valve.test.ts`
  does) — nested skips marker/profiler/handlers; a throwing body still clears
  the marker; not-nested flips waiting→running on grant.
- `e2e-harness/core/internal/e2e-path.test.ts`: table of real paths.

## Verification

1. `./equin build` in the background; confirm `status: ok` in
   `~/.singularity/worktrees/<slug>/build-status.json`.
2. Background: `./equin test plugins/primitives/plugins/optimistic-mutation`.
   While it runs, screenshot this worktree's own conversation via the e2e
   screenshot tool: banner reads "Test in progress" with a ticking timer, the
   sidebar chip shows the test icon, and the conversation status is `working`
   (`query_db`: `select status from conversations where id = …`).
3. Background: `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --out <scratch>/e2e-op`.
   Banner reads "E2E in progress"; expanding it lists both ops in the no-queue
   group.
4. `grep -E '"kind":"(test|e2e)"' ~/.singularity/logs/op-log/op-log.jsonl`:
   `requested`, `granted`, `completed` records per op, `outcome: "success"`,
   `waits` empty on an idle host (expected) or one `host-grant` entry under load.
5. Screenshot Debug → Profiling → Ops: two new bars with their fills, legend
   lists `test` and `e2e`.
6. Regression: `./equin check --list` / `--status` still take no grant;
   a direct `./equin check <cheap-id>` still shows "Check in progress";
   `./equin build` still runs its nested check with no `check` marker
   and no second op-log record; `./equin run <non-e2e script>` produces
   no marker and no record.
7. `./equin check` passes (plugin-boundaries: the dropped op-log
   re-export, the new edges; plugins-doc-in-sync; type-check).

## Follow-ups (not in this change)

- A DB-backed `runs` arm so test/e2e/check/push appear in the merged Runs
  DataView beside builds — the op-log JSONL is the unified history today and
  the Gantt reads it; projecting it into the SQL union is a separate design.
- A durable `test-<opId>.log` transcript: `spawnPassthrough` cannot tee, and
  switching to buffered capture would lose live output.
- Whether `./equin run <e2e>` should be forced into a background task by
  the `background-ops` guard — decide from measured e2e durations in
  op-log.jsonl once they exist, the way `LONG_OPS` cites p50/p90.
- A second `test` in one worktree overwrites the single `test.json` marker
  (same accepted behaviour as build-behind-build; the op-log keeps both).

## As built (2026-09-10)

Built as planned, with these notes:

- **Verified end to end on the deployed worktree.** A `./equin test` over
  the four touched plugins and a `./equin run …/e2e/screenshot.ts` were
  launched together on a host at load 21. Both wrote their marker in the
  `waiting-for-lock` phase within a second, both landed a `requested` op-log
  record attributed to this conversation with an open `host-grant` wait, both
  queued about 38 minutes for the grant, and both closed as `success` with the
  wait recorded (test: 140 tests green in 14 files, held 1 s; e2e: held 12 s).
  Both markers were cleared on exit.
- **The banner capture itself was not obtained.** This conversation's own page
  is the only one that shows this worktree's banner, and it currently throws
  on a `remote_session_change` attachment in the transcript (a known crash
  report, 92 hits, unrelated to this change) and times out under the host
  load. The banner and chip logic is template-driven off `OP_KINDS` and
  type-complete, and the resource feeding them was verified through the
  markers; the visual check is still worth doing once that page renders.
- **Two builds were lost to the orphan guard.** A build started as a Claude
  background task exits 140 (`ORPHAN_EXIT_CODE`) the moment the session's
  shell dies, which a session restart does. Each lost build had queued about
  45 minutes for the host grant first. Filed as a separate concern; not
  changed here.
- **The op-status edits were missed on the first build.** The shell command
  carrying them was blocked by a guard on an unrelated `rg` flag and not
  re-run; the type checker caught it (`Record<OpKind, …>` incomplete), which is
  the enforcement this change was built for.
- `plugins-refs-resolve` validates every `plugins/<id>/…` string literal, test
  fixtures included, so the e2e-path test names real plugins in its negative
  cases.
