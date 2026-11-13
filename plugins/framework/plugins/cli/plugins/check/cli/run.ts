import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  withDirectOp,
  type DirectOpFlight,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { openGrepIndexStore } from "@plugins/framework/plugins/tooling/plugins/checks/cli";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  describeVerification,
  openRecordStore,
  verificationPassed,
  verifyRecordsAgainst,
} from "@plugins/plugin-meta/plugins/plugin-records/cli";
import { inheritedGrant } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { cpuBudget } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import {
  computeTreeHash,
  readCheckProgress,
  readTranscriptVerdict,
  runChecks,
  requestedJobs,
  scopeOf,
  type CheckRunProgress,
  type RunChecksOptions,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  listAllChecks,
  loadChecks,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/registry/core";
import {
  CHECK_SCOPES,
  CHECKOUT_SCOPES,
  type CheckResult,
  type CheckScope,
} from "@plugins/framework/plugins/tooling/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import {
  HOST_CHECK_KIND,
  hostCheckMessage,
  type HostCheckPayload,
} from "@plugins/reports/plugins/host-check/core";

/**
 * Deliver each failing check's verdict as a `host-check` report through the
 * report outbox — `--file-reports`, what main's hourly host audit runs. True
 * when every failure reached the outbox: the reports, not the exit code, are
 * the verdict then, so a run that delivered them all has done its job.
 */
async function fileHostCheckReports(
  failures: readonly { id: string; result: CheckResult }[],
): Promise<boolean> {
  let allFiled = true;
  for (const { id, result } of failures) {
    if (result.ok) continue;
    const data: HostCheckPayload = {
      checkId: id,
      message: result.message,
      hint: result.hint ?? null,
    };
    // No `code`: the report is about the machine's state, not a source file,
    // so the outbox's staleness rule has nothing to compare.
    const filed = await fileReportFromProcess({
      kind: HOST_CHECK_KIND,
      message: hostCheckMessage(data),
      data,
    });
    if (filed.outcome === "written") {
      console.log(`Filed a ${HOST_CHECK_KIND} report for ${id}.`);
    } else {
      // `fileReportFromProcess` already printed why.
      console.error(`Could not file the ${HOST_CHECK_KIND} report for ${id}.`);
      allFiled = false;
    }
  }
  return allFiled;
}

/**
 * The open run's thread stalls so far, as one line — or null when it has had
 * none. Read off the `stall` records, which land the moment each late tick
 * runs, so a run still in flight already names what has been holding its
 * thread. The shares merge each record's top owners, so they are over the
 * owners the records kept, not over every sample.
 */
function stallLine(run: CheckRunProgress): string | null {
  if (run.stalls.length === 0) return null;
  const longest = run.stalls.reduce((a, b) => (b.lateMs > a.lateMs ? b : a));
  const byOwner = new Map<string, number>();
  let total = 0;
  for (const stall of run.stalls) {
    total += stall.samples;
    for (const o of stall.owners) {
      byOwner.set(o.owner, (byOwner.get(o.owner) ?? 0) + o.samples);
    }
  }
  const top = [...byOwner]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([owner, n]) => `${owner} ${Math.round((n / total) * 100)}%`)
    .join(", ");
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  // Held, not late, is what code did (a starved thread is the OS's doing) —
  // summed over the stalls that measured it.
  const measured = run.stalls.flatMap((s) =>
    s.held?.measured === true ? [s.held.heldMs] : [],
  );
  const held =
    measured.length > 0
      ? `, ${secs(measured.reduce((sum, ms) => sum + ms, 0))} held`
      : "";
  return (
    `  thread stalled ${run.stalls.length}× so far ` +
    `(longest ${secs(longest.lateMs)} at +${secs(longest.offsetMs)}${held})` +
    (top ? ` — top: ${top}` : "")
  );
}

/**
 * Render the durable check-progress log: every run that never wrote its `done`
 * record, newest first, with the checks that started and never settled.
 *
 * This is the whole point of the progress log — a hung run prints NOTHING to
 * its own console (the runner's print loop only reaches stdout after
 * `Promise.all` resolves), so the only way to name the culprit is to read the
 * records from outside the wedged process.
 */
function printProgress(): void {
  const runs = readCheckProgress();
  const open = runs.filter((r) => r.done === null);
  if (open.length === 0) {
    const newest = runs[0];
    console.log(
      newest
        ? `No check run in flight. Last run finished ${newest.done?.at} (${newest.worktree}, ${newest.endedCount} checks, ${newest.done?.allOk ? "all ok" : "FAILED"}).`
        : "No check runs recorded yet.",
    );
    return;
  }
  for (const run of open) {
    console.log(
      `run ${run.runId} — ${run.worktree} (pid ${run.pid}, scope ${run.scope ?? "all"})\n` +
        `  started ${run.startedAt}, last activity ${run.lastActivityAt}`,
    );
    // Before the bootstrap branch, because bootstrap stalls too (`load-checks`
    // alone holds the thread ~2.5 s) — and a stalled run's durations and
    // "running for" times are the process's, not the checks'.
    const stalls = stallLine(run);
    if (stalls !== null) console.log(stalls);
    // A run with no `selected` record yet never got past bootstrap — it has zero
    // outstanding CHECKS, which without this branch would print as a healthy
    // "0/0 settled" and say nothing about the git spawn it is actually stuck in.
    // Report the phase instead; that is the whole reason bootstrap is
    // instrumented at all.
    if (run.selected === null) {
      const phases = [...run.outstandingBootstrap].sort(
        (a, b) => b.elapsedMs - a.elapsedMs,
      );
      console.log(
        phases.length > 0
          ? `  in bootstrap: ${phases.map((p) => `${p.checkId} (${Math.round(p.elapsedMs / 1000)}s)`).join(", ")}`
          : "  in bootstrap: between phases (no phase outstanding)",
      );
      continue;
    }
    // Three numbers, not two, because the runner gates its fan-out: a check
    // that has not started is now a normal state (waiting for a slot) rather
    // than an impossible one. Reporting only "settled / outstanding" under a
    // bound would make a healthy run look like it had lost most of its work —
    // 18 running out of 100 selected, with nothing said about the other 82.
    // The queued set is derived from the same records (`selected` minus
    // everything that ever started), so it cannot disagree with them. It is
    // non-null exactly when `selected` is — both come off the one `selected`
    // record — and the branch above has already returned for that case; they
    // are separate fields, so the `??` is the pairing TS cannot state.
    const queued = run.queued ?? [];
    console.log(
      `  ${run.outstanding.length} running, ${queued.length} queued, ` +
        `${run.endedCount}/${run.selected.length} settled`,
    );
    // Longest-running first: under a hang that is the suspect, by construction.
    for (const o of [...run.outstanding].sort(
      (a, b) => b.elapsedMs - a.elapsedMs,
    )) {
      // A check waiting on another run's in-flight copy of itself is not
      // hung: name the run it is blocked on (`check --status` there shows
      // what THAT run is doing).
      const what =
        o.joined === null
          ? "running"
          : `joined run ${o.joined.leaderId ?? "(starting)"}, running`;
      console.log(
        `    • ${o.checkId} — ${what} ${Math.round(o.elapsedMs / 1000)}s (since ${o.startedAt})`,
      );
    }
  }
}

/** How much of an adopted verdict a joiner prints before pointing at the file. */
const ADOPTED_TRANSCRIPT_LINES = 200;

/**
 * The run-level single-flight for a check: an identical `./equin check`
 * already in flight in this worktree — same selection, same scope, same
 * `--always-run`, same TREE — is joined instead of run again. Its key carries
 * the tree hash, so a verdict is only ever adopted from a run that started on
 * the tree this request saw. `--jobs` is left out: it changes how the checks
 * are scheduled, never what they decide.
 *
 * `undefined` (no flight) when the tree hash is unavailable — `computeTreeHash`
 * fails open, and with no hash there is no correctness bar to key on.
 */
function checkFlight(
  ids: string[],
  scope: CheckScope[] | undefined,
  alwaysRun: boolean,
  treeHash: string | null,
): DirectOpFlight<"check"> | undefined {
  if (treeHash === null) return undefined;
  return {
    key: JSON.stringify({
      ids: [...ids].sort(),
      scope: scope ? [...scope].sort() : null,
      alwaysRun,
      treeHash,
    }),
    adopt: ({ outcome, leader }, ctx) => {
      // The leader's transcript is complete: its `done —` trailer is written
      // before the run returns, and the verdict is published after that.
      const transcript = worktreeArtifacts.checkLog(ctx.slug, leader.id);
      const ago = Math.max(
        0,
        Math.round((Date.now() - leader.startedAt) / 1000),
      );
      console.log(
        `Joined in-flight check ${leader.id} (same tree, started ${ago}s ago) — its verdict: ${outcome}.\n`,
      );
      // Only the verdict section — the per-check blocks, the trailer and the
      // `done` line, which is what the leader's own console showed. The header
      // and the thread profile stay in the file.
      const verdict = readTranscriptVerdict(transcript);
      if (verdict.kind === "ok") {
        const { lines } = verdict;
        console.log(lines.slice(0, ADOPTED_TRANSCRIPT_LINES).join("\n"));
        if (lines.length > ADOPTED_TRANSCRIPT_LINES)
          console.log(
            `… ${lines.length - ADOPTED_TRANSCRIPT_LINES} more lines in ${transcript}`,
          );
      } else {
        console.error(`(the leader's transcript is gone: ${transcript})`);
      }
      // Last line, so it survives `./equin check | tail`.
      if (outcome !== "success")
        console.error(`\nFull check output: ${transcript}`);
      return outcome;
    },
  };
}

/**
 * The check run itself. Reached only once commander has routed to `check`, so
 * everything above — the checks registry, the host-admission grant, the op
 * profiler and the worktree-op marker — stays off every other command's path.
 *
 * `checks` is the variadic positional: an empty array when no id was typed,
 * which is how "run every check" is spelled below (`checks.length > 0 ? … :
 * undefined`). `opts.cache` is commander's negatable `--no-cache`, so the test
 * is `=== false` — `undefined`/`true` both mean the cache is live.
 */
const run: CliAction<
  [string[]],
  {
    list?: boolean;
    status?: boolean;
    cache?: boolean;
    scope?: string;
    alwaysRun?: boolean;
    runId?: string;
    jobs?: string;
    fileReports?: boolean;
    verifyRecords?: boolean;
  }
> = async (checks, opts) => {
  // Validate before anything else: an unrecognized scope must NOT fall
  // through to `scope: undefined`, which means "every scope" — a typo would
  // then silently run MORE than asked and report a pass. EVERY part of a
  // comma-separated list is validated for the same reason: one good part must
  // not carry a typo'd sibling through.
  let scope: CheckScope[] | undefined;
  if (opts.scope !== undefined) {
    const parts = opts.scope.split(",").map((s) => s.trim());
    const unknown = parts.filter(
      (s) => !(CHECK_SCOPES as readonly string[]).includes(s),
    );
    if (unknown.length > 0) {
      console.error(
        `Unknown --scope ${unknown.map((s) => `"${s}"`).join(", ")}. ` +
          `Expected one of: ${CHECK_SCOPES.join(", ")} (comma-separated for several).`,
      );
      process.exit(1);
    }
    scope = parts as CheckScope[];
  } else if (checks.length === 0) {
    // A bare `./equin check` asserts what THIS checkout owns: its tree and its
    // deploy. Host checks judge state every checkout shares (the data root),
    // so selecting them here let one agent's leftover file fail every other
    // agent's check. They run on main's hourly host audit, which files a
    // report, and when asked for by id or `--scope host`.
    scope = [...CHECKOUT_SCOPES];
    console.log(
      `Running the ${CHECKOUT_SCOPES.join(" + ")} checks. Host checks (shared machine ` +
        "state) are not this checkout's to assert: main's hourly checks.host-audit runs " +
        "them and files a host-check report; `./equin check --scope host` runs them now.",
    );
  }

  // `--file-reports` delivers verdicts to the alert funnel, which is only right
  // for a verdict nobody's checkout owns. A tree or deploy failure belongs to
  // the checkout that ran it — filed as a report it would page whoever triages
  // Reports about one agent's work in progress.
  const fileReports = opts.fileReports === true;
  if (fileReports && (scope === undefined || scope.some((s) => s !== "host"))) {
    console.error(
      "--file-reports is only valid with --scope host: a tree or deploy verdict belongs to the " +
        "checkout that ran it, not to the alert funnel.",
    );
    process.exit(1);
  }

  // NESTING is resolved by `withDirectOp` below (a parent op hands this child
  // its host CPU grant in the environment). It is read once more here, ahead of
  // the lifecycle, for the one rule that is this command's own: `--run-id`.
  const nested = inheritedGrant() !== undefined;

  // `--run-id` is meaningful ONLY for a nested check. A top-level check
  // must mint its own id, because that id also names its op-log row and its
  // kill line — reusing a parent's would collide with the parent's own
  // records. `withDirectOp` honours whatever id it is handed; this is the
  // validation that keeps a top-level check from handing it one.
  if (opts.runId !== undefined && !nested) {
    console.error(
      "--run-id is only valid for a nested check (one that inherited a parent op's " +
        `host grant via ${envName("HOST_GRANT")}). A top-level check mints its own id, ` +
        "which also names its op-log row and its kill line — adopting a parent's would " +
        "collide with the parent's own records. Drop the flag.",
    );
    process.exit(1);
  }

  if (opts.list) {
    const all = await listAllChecks();
    // Print the scope: it decides whether `push` asserts a check at all, so
    // the classification has to be auditable without reading every barrel.
    for (const c of all)
      console.log(`  [${scopeOf(c)}] ${c.id} — ${c.description}`);
    return;
  }
  if (opts.status) {
    printProgress();
    return;
  }

  // Validated once the two PURE READS above have returned, and not before.
  // Refusing early is right for a run — `runChecks` validates this too, but it
  // does so inside `withHostGrant`, so a typo'd `--jobs` would queue for a host
  // CPU slot (minutes, under load) just to be told it was a typo. But `--list`
  // and `--status` acquire no grant and run no check, and `--status` is the tool
  // you reach for from a second shell WHILE a run is wedged. A stale
  // `EQUIN_CHECK_JOBS=auto` in a shell profile must not be what stops you
  // reading the progress log during an incident.
  //
  // Deliberately the runner's own `requestedJobs`, not a second check that
  // happens to agree today: one rule about one number, called from both ends.
  // The return value is discarded — this call is for its throw. It covers the
  // env var too, which the runner reads itself.
  requestedJobs(opts.jobs !== undefined ? Number(opts.jobs) : undefined);

  // The tree hash, BEFORE the grant: it is IO (a temp-index `git add -A`), not
  // CPU work, and the run-level single-flight below is keyed on it — a
  // duplicate must find the in-flight run without first queueing for a host
  // slot. Handed to `runChecks` so the cache is keyed on the same reading.
  // `--no-cache` / EQUIN_CHECK_NO_CACHE mean "really run": no hash, no
  // flight — exactly what the runner does with them.
  // `--verify-records` recomputes every record, so its checks must really run.
  const verifyRecords = opts.verifyRecords === true;
  const noCache =
    verifyRecords || opts.cache === false || readEnv("CHECK_NO_CACHE") === "1";
  const treeHash = noCache
    ? undefined
    : { value: await computeTreeHash(await getWorktreeRoot()) };
  const alwaysRun = opts.alwaysRun === true;

  // Everything from here on — the broadcast banner, this worktree's identity,
  // the interrupted-predecessor warning, the lane, the op marker, the op-log
  // record, the signal handlers and the host grant (or the parent's inherited
  // one) — is the direct-op lifecycle, shared with `test` and `run`. See op-runtime/cli/direct-op.ts. What is left here is what only a
  // check knows: how to run the checks, and what their verdict means.
  //
  // A nested check adopts its parent's id (`--run-id`, validated above), so
  // the child's transcript and progress records name the op a human is
  // actually looking at; a top-level check mints its own inside the primitive.
  const outcome = await withDirectOp(
    "check",
    {
      max: cpuBudget().B,
      opId: opts.runId,
      // A joiner adopts the leader's verdict without its per-check results,
      // so a reporting run never joins one.
      flight:
        treeHash && !fileReports
          ? checkFlight(checks, scope, alwaysRun, treeHash.value)
          : undefined,
    },
    async (grant, ctx) => {
      // This run's transcript: `check-<opId>.log` sits in the worktree's data
      // dir beside a build's artifacts, so the three records of one run (op
      // row, kill line, transcript) all answer to the same id. Derived here
      // rather than passed in, so the path this prints and the path the runner
      // writes are the same expression.
      const checkLogPath = worktreeArtifacts.checkLog(ctx.slug, ctx.opId);
      // The shared plugin records, as the build reads them: a pass computes
      // only the facets, evaluated barrels and file scans no checkout has made
      // yet. Safe because a record's key is the hash of every input its value
      // is a function of, the producer's code included — and checked, daily on
      // main, by `--verify-records`: every record computed again and compared
      // with the store's under the same key.
      const sharedRecords = openRecordStore();
      const verification = verifyRecords
        ? verifyRecordsAgainst(sharedRecords)
        : undefined;
      installRecordStore(verification?.store ?? sharedRecords);
      const { profiler } = ctx;
      const failures: { id: string; result: CheckResult }[] = [];
      const inconclusive: string[] = [];
      const runOpts: RunChecksOptions = {
        grant,
        loadChecks,
        // One step per individual check, so a `check` bar drills in to
        // `type-check` / `eslint` / … — the affordance `build` already has
        // via the same hook (build.ts → `pushBuildSpan`). Gated on the
        // profiler, i.e. on not being nested: a push-nested check must write
        // no record of its own, and therefore no steps either.
        //
        // `onCheckDone` reports a check that has ALREADY finished, so this
        // must be `recordStep` (duration + start supplied) and never
        // `stepStart`/`stepEnd` (which read the clock themselves and would
        // stamp the check's end as its start).
        //
        // CLOCK. `wallStartMs` is a `performance.now()` reading (runner.ts)
        // despite the name — monotonic, NOT a `Date.now()` epoch — while
        // `recordStep` takes a WALL instant (the op's one axis; the monotonic
        // clock pauses while the machine sleeps). It is converted here, paired
        // at THIS instant: wall now minus the monotonic time since the start.
        // Not `performance.timeOrigin + wallStartMs`, which would bake in
        // `timeOrigin`'s process-start capture error (~6ms under load) and
        // every nap since the process started.
        onCheckDone: (id, durationMs, wallStartMs, result) => {
          if (!result.ok) {
            if (result.inconclusive) inconclusive.push(id);
            else failures.push({ id, result });
          }
          profiler?.recordStep(
            id,
            durationMs,
            Date.now() - (performance.now() - wallStartMs),
          );
        },
        noCache,
        treeHash,
        // `--no-cache` means "really run": every grep runs whole as well.
        grepIndex: opts.cache === false ? undefined : openGrepIndexStore(),
        // Commander hands every `<n>` option through as a string, so the
        // conversion happens here and the VALIDATION does not: `runChecks`
        // rejects anything that is not a positive integer, with one message
        // covering both this flag and EQUIN_CHECK_JOBS (which it reads
        // itself — that is the knob `build` and `push` reach, since they spawn
        // this command and inherit the environment). Splitting the check across
        // both sites would be two rules that could disagree about the same
        // number, so `Number("x")` is passed on as `NaN` for the runner to
        // reject by name.
        jobs: opts.jobs !== undefined ? Number(opts.jobs) : undefined,
        scope,
        alwaysRun,
        logRun: { worktree: ctx.slug, runId: ctx.opId },
        log: (line, stream) =>
          stream === "stderr" ? console.error(line) : console.log(line),
      };
      const ok = await runChecks(
        checks.length > 0 ? checks : undefined,
        runOpts,
      );
      // The records this pass made, written now — not by an exit listener
      // after the verdict. A write the store could not make is its own
      // outcome (logged and reported by the store): the records are computed
      // again, and the verdict stays the checks' (2026-11-12, a green pass
      // turned failed by a busy store at exit).
      await sharedRecords.flush();
      // Last line, so it survives `./equin check | tail`.
      if (!ok) console.error(`\nFull check output: ${checkLogPath}`);
      if (verification) {
        await verification.settled();
        const agree = verificationPassed(verification);
        for (const line of describeVerification(verification))
          (agree ? console.log : console.error)(line);
        if (!ok)
          console.error(
            "Check failures above are context: a --verify-records run's verdict is the records'.",
          );
        return agree ? "success" : "failed";
      }
      // Only a run whose every non-passing check became a report has
      // delivered its verdict. An inconclusive check files nothing, so it
      // keeps the run failed — the job's own failure report then names it.
      if (fileReports && !ok && failures.length > 0) {
        const filed = await fileHostCheckReports(failures);
        return filed && inconclusive.length === 0 ? "success" : "failed";
      }
      return ok ? "success" : "failed";
    },
  );
  if (outcome !== "success") process.exit(1);
};

export default run;
