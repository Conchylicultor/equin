import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import type {
  Check,
  CheckContext,
  CheckResult,
  CheckScope,
} from "@plugins/framework/plugins/tooling/core";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { createTurnQueue } from "@plugins/packages/plugins/macrotask-yield/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { computeTreeHash } from "./tree-hash";
import { resolveCacheSignature } from "./cache-signature";
import { recordingRepo, runRepoFiles } from "./repo-set";
import { checkFlightDir, openCheckCache } from "./cache";
import { gateSlot, runCheckFlight, type GateSlot } from "./check-flight";
import { withScanView } from "./scan-context";
import {
  loadTreeSnapshot,
  validate,
  type TreeSnapshot,
  type QueryFact,
  type ValidateResult,
} from "./read-set";
import { gitGrepList } from "./grep-code";
import { openProgressRun } from "./progress-log";
import { openCheckTranscript, provenance, renderStallLine } from "./transcript";
import { isBuildProcess } from "./run-context";
import {
  assertExemptableInvariant,
  openCheckExemptions,
} from "./check-exemptions";
import {
  loadExemptions,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import {
  thrownOutcome,
  type CheckObservation,
  type CheckOutcome,
} from "./thrown-outcome";

function isCheck(value: unknown): value is Check {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Check).id === "string" &&
    typeof (value as Check).description === "string" &&
    typeof (value as Check).run === "function"
  );
}

/**
 * A check's scope, with the default applied. THE one place `?? "tree"` is
 * written — every consumer (the scope filter below, `--list`) reads it through
 * here, so an unclassified check can never mean two different things in two
 * places.
 */
export function scopeOf(check: Check): CheckScope {
  return check.scope ?? "tree";
}

/**
 * Enforce the `Check.scope` invariant at LOAD, not at run: a non-tree check's
 * subject is outside the tree hash, so without a `cacheSignature()` the runner
 * would record its verdict under a tree-only key and replay that pass for every
 * later state of that subject — a green that can never go red again. Throwing
 * here fires for `runChecks` and `--list` alike, so the violation surfaces the
 * moment the check is written rather than as an inexplicably-passing check
 * months later.
 *
 * Written as "anything but `tree`" rather than as a list of the scopes that owe
 * a signature. The condition used to be `=== "deploy"`, which was the same set
 * while `deploy` was the only non-tree scope — and would have silently exempted
 * `host` the moment it was added, which is exactly the class of hole this
 * assertion exists to close.
 */
function assertScopeInvariant(checks: Check[]): void {
  for (const check of checks) {
    const scope = scopeOf(check);
    // `alwaysRun` means "run even under `build --skip-checks`" — it is defined
    // entirely in terms of the ops (build, push) that a `host` verdict is not
    // theirs to assert. The pair is a contradiction, so it has no spelling
    // rather than being quietly filtered out at each call site.
    if (scope === "host" && check.alwaysRun === true) {
      throw new Error(
        `Check "${check.id}" is scope: "host" and alwaysRun: true, which cannot both hold. ` +
          `alwaysRun means "run during a build even with --skip-checks", and a build cannot ` +
          `assert a host-scoped verdict: its subject is the machine, shared with every other ` +
          `checkout on this box and ahead of any one branch. Drop alwaysRun, or reclassify ` +
          `the check if its subject really is this tree or this build's deploy.`,
      );
    }
    if (scope !== "tree" && check.cacheSignature === undefined) {
      throw new Error(
        `Check "${check.id}" is scope: "${scope}" but supplies no cacheSignature(). ` +
          `A ${scope}-scoped verdict is not covered by the working-tree hash, so caching it ` +
          `under the tree hash alone would record a permanently stale pass. Add a ` +
          `cacheSignature() that covers the ${scope} state it inspects (or returns null to ` +
          `opt out of caching entirely).`,
      );
    }
  }
}

/**
 * The requested scopes as a set, or `null` for "every scope". ONE normalisation,
 * shared by the filter and by the string the progress run / transcript record —
 * so what a run reports it selected cannot drift from what it actually ran.
 */
function normalizeScopes(
  scope: CheckScope | readonly CheckScope[] | undefined,
): readonly CheckScope[] | null {
  if (scope === undefined) return null;
  return typeof scope === "string" ? [scope] : scope;
}

async function loadAllChecks(): Promise<Check[]> {
  const { checkEntries } = await import("./check.generated");
  const checks = await loadCollectedDir<Check>(checkEntries, {
    isItem: isCheck,
    dedupeKey: (c) => c.id,
    label: "check",
  });
  assertScopeInvariant(checks);
  assertExemptableInvariant(checks);
  return checks;
}

export async function listAllChecks(): Promise<Check[]> {
  return loadAllChecks();
}

export interface RunChecksOptions {
  /**
   * The host CPU grant the invoking build/check/push already holds, passed to
   * every `check.run(ctx)`. REQUIRED because the runner lives in the `core`
   * runtime and so cannot itself import the server-side `withHostGrant` to
   * acquire one — the caller (which sits at the CLI/server boundary) owns the
   * acquire and threads the grant in. `type-check` / `layout-geometry` spend it
   * per heavy child; every other check ignores it.
   */
  grant: Grant;
  onCheckDone?: (id: string, durationMs: number, wallStartMs: number) => void;
  /**
   * How many checks may run at once. Omitted, the run is UNBOUNDED — every
   * selected check starts at once, exactly as it did before this gate existed,
   * so nothing a caller did not ask for gets slower. The width is an
   * instrument a caller reaches for deliberately (`--jobs 1` to read true
   * per-check costs, a small width to debug a hang), not a policy the runner
   * imposes; the measured reason is on the `width` expression below.
   *
   * This is deliberately NOT `grant.units`. The grant is a CPU budget the
   * caller already holds and hands to every check, and a check spends it on its
   * own heavy children — `type-check` calls `ctx.grant.run()` per tsc worker
   * from inside its `run()` body, `layout-geometry` wraps a browser launch in
   * it. Reusing it as the outer gate would deadlock at `units === 1`: the outer
   * wrap holds the only slot while the check's own body waits for a slot that
   * only that check's completion can free. Two resources, two gates, no
   * nesting. See `checks/CLAUDE.md`.
   */
  jobs?: number;
  log: (line: string, stream: "stdout" | "stderr") => void;
  /** Bypass the tree-hash result cache entirely (lookup + record). */
  noCache?: boolean;
  /**
   * The working tree's content hash, already computed by the caller
   * (`computeTreeHash`, whose `null` is its fail-open "no hash": run uncached).
   * Omitted, the runner computes it itself. Ignored under `noCache`, which
   * never hashes.
   */
  treeHash?: { value: string | null };
  /**
   * Restrict the run to checks of these scopes; omitted = every scope. See
   * `Check.scope`: `push` passes "tree" because a deploy-scoped verdict is about
   * an artifact outside the push payload, and `build` passes ["tree","deploy"]
   * because it produces the dist the second kind inspects but does not own the
   * host state the third kind is about. Selection is by PROPERTY — a caller
   * never enumerates ids to include or exclude.
   *
   * A SET, not one value, because "the scopes I can assert" is genuinely plural
   * for a caller sitting between the extremes: `build` asserts two of the three.
   * Spelled as a lone `CheckScope` it could only say so by dropping the filter
   * entirely, which is not the same claim — it silently picks up every scope
   * added later, which is exactly how a build came to assert the host's state.
   */
  scope?: CheckScope | readonly CheckScope[];
  /**
   * Restrict the run to checks flagged `Check.alwaysRun`; omitted = no such
   * restriction. This is the `--skip-checks` validation set, selected BY
   * PROPERTY exactly like `scope` — a caller never enumerates the ids, because
   * a list computed in the caller's process is a registry read performed
   * wherever that process happens to be, not in the process that runs them.
   * Composes with `scope` as an AND.
   */
  alwaysRun?: boolean;
  /**
   * The run this transcript belongs to — the worktree whose data dir it sits in,
   * and the id the caller ALREADY owns (a build's `buildId`, a standalone
   * check's `opId`). Omitted, no transcript is written.
   *
   * The runner derives the path itself (`worktreeArtifacts.checkLog`) AND uses
   * `runId` as the progress-log run id, so the filename and this run's lines in
   * `check-progress.jsonl` can never name different runs. That is the whole
   * reason this is not a path: a caller handing in `check-<x>.log` while the
   * progress log minted its own uuid is precisely the drift that made a
   * transcript unattributable.
   *
   * The file holds the complete failure messages; the console (`log`) copy stays
   * summarized/truncated so it doesn't flood an agent's context (and survives
   * being piped through `tail`). When set, the console truncation note points at
   * this file instead of telling the caller to re-run.
   */
  logRun?: { worktree: Namespace; runId: string };
}

/**
 * The requested fan-out width, or null for "the runner decides". Resolved from
 * the option first and the environment second.
 *
 * The env read lives HERE, beside `SINGULARITY_CHECK_NO_CACHE` and for the same
 * structural reason: `build` and `push` do not call `runChecks` in-process, they
 * spawn the `check` command, and `runCheckSubprocess` hands the child
 * `...process.env` (op-runtime/cli/check-subprocess.ts). So an env knob reaches
 * every check pass on the box with nothing to thread through two CLI actions and
 * a subprocess argv. Read in the runner rather than in the one CLI action so
 * that stays true for any future caller.
 *
 * A malformed value THROWS rather than falling back to the default: a typo'd
 * `--jobs` or a stale `SINGULARITY_CHECK_JOBS=auto` in a shell profile would
 * otherwise silently run at a width nobody asked for, and the whole point of the
 * knob is that the width is known.
 *
 * EXPORTED so a caller can reject a bad value BEFORE paying for a host CPU
 * grant. `runChecks` runs under one, so validating only here made a typo wait
 * out the grant queue — minutes, under load — to be told it was a typo. The CLI
 * action calls this first and the runner still calls it again: one rule, two
 * call sites, rather than a second copy in the CLI that could disagree with this
 * one about the same number.
 */
export function requestedJobs(jobs: number | undefined): number | null {
  const fromEnv = process.env.SINGULARITY_CHECK_JOBS;
  const source =
    jobs !== undefined
      ? { value: jobs, from: "jobs option / --jobs" }
      : fromEnv !== undefined && fromEnv !== ""
        ? { value: Number(fromEnv), from: `SINGULARITY_CHECK_JOBS=${fromEnv}` }
        : null;
  if (source === null) return null;
  if (!Number.isInteger(source.value) || source.value < 1) {
    throw new Error(
      `Invalid check concurrency (${source.from}): expected a positive integer, got ${source.value}. ` +
        `1 runs the suite serially, which is the only way to read a true per-check cost; ` +
        `omit it entirely to let the runner size the fan-out to this host.`,
    );
  }
  return source.value;
}

export async function runChecks(
  ids: string[] | undefined,
  options: RunChecksOptions,
): Promise<boolean> {
  // FIRST STATEMENT, ahead of even the progress run: a refused call must not
  // leave a phantom open run behind for `--status` to report as a hang.
  //
  // A passing check writes a durable entry to the GLOBAL cache, keyed on the
  // tree hash and carrying no provenance — so a later `push` in a clean process
  // reads back a verdict this process recorded. That makes a recorded PASS a
  // TRANSFERABLE claim, and it is only true if the process that produced it did
  // nothing but run checks. A build's process has already imported every plugin
  // barrel and run the slot-declaration pass, so a check reading either sees a
  // world no standalone check can reproduce. That is not hypothetical: commit
  // `fa7e865e0` shipped a `docs/plugins-details.md` only a build could
  // reproduce, four pushes hit the cached pass, and the failure surfaced hours
  // later on an unrelated branch (fixed at the source in `18126884a`).
  //
  // Deliberately not folded into `assertScopeInvariant`: that validates the
  // loaded check COLLECTION at load time; this validates the PROCESS at call
  // time. Different subject, different lifetime.
  if (isBuildProcess()) {
    throw new Error(
      "runChecks() was called from the build process itself. A check pass must run " +
        "in a process that did nothing but run checks: a passing check records a " +
        "durable entry in the global check cache that a later `push` reads back from " +
        "a clean process, so the verdict has to be transferable. A build's process " +
        "has already imported every plugin barrel and run the slot-declaration pass " +
        "— that contamination is how commit fa7e865e0 shipped a generated doc only a " +
        "build could reproduce (fixed at the source in 18126884a). Spawn the check " +
        "pass instead: `runCheckSubprocess(...)` from cli/plugins/op-runtime/cli/check-subprocess.ts.",
    );
  }

  // Validated up here with the process guard, and for that guard's reason: a
  // refused call must not leave a phantom open run behind for `--status` to
  // report as a hang. The number this returns is not the width — that also
  // depends on how many checks the filters below select — but whether the
  // REQUEST is well-formed is knowable now, with no work done.
  const jobs = requestedJobs(options.jobs);

  // Durable, per-run progress records (~/.singularity/logs/check-progress/check-progress.jsonl).
  // These exist because a single hung check makes the whole run report NOTHING:
  // the print loop far below only reaches the console after `Promise.all` fully
  // resolves. Written as each unit of work starts and settles — never from that
  // loop, which is precisely what a hang prevents from ever running.
  //
  // FIRST WORK IN THE FUNCTION, deliberately — only the process guard above it,
  // which does no work and whose whole point is to refuse BEFORE a run exists.
  // Everything after this line — loading the check modules, `git rev-parse`, the
  // tree hash, the cache, the tree snapshot — can be slow or hang, and a hang
  // before the run announces itself is a hang we learn nothing about. Only the
  // caller's own request is
  // knowable here; `treeHash` and the resolved selection arrive via
  // `progress.resolved()` once bootstrap has earned them.
  const requested = ids && ids.length > 0 ? ids : null;
  const requestedScopes = normalizeScopes(options.scope)?.join(",") ?? null;
  const progress = openProgressRun({
    scope: requestedScopes,
    requested,
    runId: options.logRun?.runId,
    // Derived, not read off `transcript` below: the transcript opens after the
    // run, and the path is a pure function of the same two ids.
    transcriptPath: options.logRun
      ? worktreeArtifacts.checkLog(
          options.logRun.worktree,
          options.logRun.runId,
        )
      : null,
  });

  // The transcript opens HERE, beside the progress run and for the same reason:
  // it must exist from the first moment, not once every check has settled. Its
  // header is on disk before the checks are even loaded, so a run killed
  // mid-checks leaves a partial transcript OF ITSELF rather than its
  // predecessor's complete one.
  const transcript = options.logRun
    ? openCheckTranscript({
        ...options.logRun,
        scope: requestedScopes,
        requested,
      })
    : null;

  const all = await progress.bootstrap("load-checks", () => listAllChecks());

  const named =
    ids && ids.length > 0 ? all.filter((c) => ids.includes(c.id)) : all;

  if (ids && named.length !== ids.length) {
    const known = new Set(all.map((c) => c.id));
    const unknown = ids.filter((id) => !known.has(id));
    const message = `Unknown check(s): ${unknown.join(", ")}`;
    console.error(message);
    // Close the run: an early return is a finished run, and a run left open
    // would sit in `--status` forever as a phantom hang. Same for the
    // transcript, which otherwise ends at its header with no reason given.
    //
    // Progress FIRST, at every exit: its `finish()` stops the thread watch and
    // returns the summary the transcript renders. An early exit is not exempt —
    // `load-checks` alone keeps the thread busy ~2.5 s, and that is recorded
    // here like anywhere else.
    const thread = progress.finish(false);
    transcript?.finish([message], false, thread);
    await progress.reportsFiled();
    return false;
  }

  // Scope filter runs AFTER id resolution so an unknown id still reports as
  // unknown rather than as out-of-scope. An id the caller named EXPLICITLY but
  // this scope excludes is a caller error, not a selection to quietly narrow:
  // dropping it would run a smaller set than asked and report a pass — and with
  // a single named id, an empty selection reaches `Promise.all([])` and passes
  // vacuously. Fail loudly instead.
  const scopes = normalizeScopes(options.scope);
  const scoped =
    scopes === null ? named : named.filter((c) => scopes.includes(scopeOf(c)));
  if (scopes !== null && ids && ids.length > 0) {
    const excluded = named.filter((c) => !scopes.includes(scopeOf(c)));
    if (excluded.length > 0) {
      const message = `Excluded by --scope ${scopes.join(",")}: ${excluded
        .map((c) => `${c.id} is ${scopeOf(c)}-scoped`)
        .join(", ")}. Drop the --scope flag, or run only checks of that scope.`;
      console.error(message);
      const thread = progress.finish(false);
      transcript?.finish([message], false, thread);
      await progress.reportsFiled();
      return false;
    }
  }

  // The `alwaysRun` filter composes with `--scope` as an AND, and reuses the
  // scope filter's exact shape for the same reason: an id the caller named
  // EXPLICITLY but this filter excludes is a caller error, not a selection to
  // quietly narrow.
  const alwaysRun = options.alwaysRun === true;
  const selected = alwaysRun
    ? scoped.filter((c) => c.alwaysRun === true)
    : scoped;
  if (alwaysRun && ids && ids.length > 0) {
    const excluded = scoped.filter((c) => c.alwaysRun !== true);
    if (excluded.length > 0) {
      const message = `Excluded by --always-run: ${excluded
        .map((c) => `${c.id} is not alwaysRun`)
        .join(
          ", ",
        )}. Drop the --always-run flag, or name only alwaysRun checks.`;
      console.error(message);
      const thread = progress.finish(false);
      transcript?.finish([message], false, thread);
      await progress.reportsFiled();
      return false;
    }
  }
  // An `alwaysRun` selection that comes out EMPTY is a vacuous pass:
  // `Promise.all([])` resolves to `[]` and this function returns true having
  // proven nothing. This is the only place that can notice — the caller
  // expresses the selection as a flag and never enumerates it, precisely so the
  // registry is read in the process that runs the checks. So if the last
  // `alwaysRun: true` is ever deleted, `build --skip-checks` fails loudly here
  // instead of silently proving less than it claims.
  if (alwaysRun && selected.length === 0) {
    const message =
      "No checks are flagged `alwaysRun`, so --always-run selected nothing. " +
      "A run that asserts nothing must not report a pass: either restore the " +
      "alwaysRun flag on the checks the fast path depends on, or drop the flag " +
      "and stop claiming this pass validates anything.";
    console.error(message);
    const thread = progress.finish(false);
    transcript?.finish([message], false, thread);
    await progress.reportsFiled();
    return false;
  }

  const noCache =
    options?.noCache || process.env.SINGULARITY_CHECK_NO_CACHE === "1";
  // Root is only needed when caching (tree hash + snapshot); skipping it in
  // no-cache mode preserves today's behaviour of not touching git at all.
  // Each of the four is wrapped in its own progress phase. They all spawn git
  // or walk the cache dir, so any one of them can be where a run wedges — and
  // the diagnostic has to name WHICH, exactly as it names a hung check. Wrapping
  // costs one appended line per phase.
  const root = noCache
    ? null
    : await progress.bootstrap("root", () => getWorktreeRoot());
  // A caller that already hashed the tree (the `check` command, which keys its
  // run-level single-flight on it before the grant) hands the hash in, so the
  // tree the flight is keyed on IS the tree the cache is keyed on — one
  // computation, not two that could straddle an edit.
  const treeHash = root
    ? options.treeHash !== undefined
      ? options.treeHash.value
      : await progress.bootstrap("tree-hash", () => computeTreeHash(root))
    : null;
  const cache = treeHash
    ? await progress.bootstrap("open-cache", () => openCheckCache())
    : null;
  // The shared, content-addressed tree snapshot — loaded at most ONCE per run
  // (one `git ls-tree -r`) and reused by every input-keyed check's
  // validate/record AND by `ctx.repo()`, whose file set is this tree whenever
  // the run has one. One memoized promise serves both, so they can never read
  // different trees and the spawn is never paid twice.
  //
  // Loaded EAGERLY only when some selected check is input-keyed; otherwise the
  // first `ctx.repo()` call loads it, and a run no check asks pays nothing.
  // Fail-open: null → input-keyed checks fall back to running under a null view
  // (still keyed via the legacy `has()/record()` path), and `ctx.repo()` falls
  // back to `loadRepoFiles`. Nine checks are input-keyed today, `type-check`
  // and `plugin-boundaries` among them, so a full pass loads this snapshot — it
  // is a hot path, not a dormant one.
  let snapshotLoad: Promise<TreeSnapshot | null> | null = null;
  const loadSnapshot = (): Promise<TreeSnapshot | null> =>
    root !== null && treeHash !== null
      ? (snapshotLoad ??= loadTreeSnapshot(root, treeHash))
      : Promise.resolve(null);
  const anyInputKeyed = selected.some((c) => c.inputKeyed === true);
  const snapshot: TreeSnapshot | null =
    anyInputKeyed && root && treeHash
      ? await progress.bootstrap("tree-snapshot", loadSnapshot)
      : null;

  // `ctx.repo()`: the run's file set, loaded by the first check that asks and
  // shared by every check after it (`repo-set.ts` says where it comes from).
  // `--no-cache` resolved no root above; the set resolves its own then.
  const repo = runRepoFiles({
    loadSnapshot,
    root: () => (root !== null ? Promise.resolve(root) : getWorktreeRoot()),
  });

  // Bootstrap is over: the facts that cost work to learn are now known, so they
  // reach the log as a follow-up record under the same `runId`.
  progress.resolved(
    treeHash,
    selected.map((c) => c.id),
  );

  // The exemption manifests, loaded at most once per run and only if some
  // check asks. Each check still READS them through its own `ctx.repo()` (see
  // `openCheckExemptions`), which is what records them in its read-set.
  let exemptionsLoad: Promise<readonly ResolvedExemption[]> | null = null;
  const loadRunExemptions = (): Promise<readonly ResolvedExemption[]> =>
    (exemptionsLoad ??= repo().then(loadExemptions));

  // One check body: `run()` with the exemption context, then the verdict on
  // its exemptions that suppressed nothing. Both cache paths go through here,
  // inside their scan view, so the manifest reads land in the read-set.
  const runBody = async (
    check: Check,
    base: Omit<CheckContext, "exempt" | "inScope">,
  ): Promise<CheckResult> => {
    const session = openCheckExemptions(check, base.repo, loadRunExemptions);
    const result = await check.run({ ...base, ...session.ctx });
    return session.finish(result);
  };

  // Shadow mode (opt-in via the env var): an input-keyed check logs the
  // old-vs-new decision so a divergence (old MISS/new HIT, or the validate
  // reason) is visible before a check is trusted. Never changes the verdict or
  // the default output. Off unless asked for — the input-keyed path itself is
  // live on every run, so this is the one part that is genuinely opt-in.
  const shadow = process.env.SINGULARITY_CHECK_SHADOW === "1";

  // One check, start to settle. Extracted from the `Promise.all` callback ONLY
  // so the progress log can wrap it in a try/finally — a `finally` cannot see a
  // return value, and the callback has several return sites.
  //
  // `observations` is the caller's buffer, not one made here: if the check
  // throws, the caller builds its failed outcome from the same buffer, so the
  // lines it logged before throwing survive.
  //
  // `slot` is the check's gate slot, held on entry. Only a check that joins
  // another run's flight lets go of it (and takes it back before doing work);
  // the caller releases it when the check settles, whatever happened here.
  const runOne = async (
    check: Check,
    wallStart: number,
    observations: CheckObservation[],
    slot: GateSlot,
  ): Promise<CheckOutcome> => {
    // A check opts out of caching by returning null from cacheSignature();
    // absent → "" (keyed on tree hash alone). Awaited: a signature may be async.
    const sig = await resolveCacheSignature(check);

    // `observations` holds the non-fatal lines (measurements, capacity notes) a
    // check emits via `ctx.log`. Buffered rather than written straight through:
    // checks run under Promise.all, so a live write would interleave lines from
    // every in-flight check. They are flushed through the runner's own `emit()`
    // below, attributed under the emitting check's result line — so the
    // transcript stays deterministic and diffable across runs.

    // Scan the SAME tree the cache key (treeHash) is computed from, so a
    // recorded PASS always reflects content the check actually inspected. The
    // grant is the caller's held host CPU admission; heavy checks spend it.
    const ctx: Omit<CheckContext, "exempt" | "inScope"> = {
      grant: options.grant,
      log: (line, stream) => observations.push({ line, stream }),
      cacheEnabled: !noCache,
      repo,
    };

    const settled = (result: CheckResult, cached: boolean): CheckOutcome => ({
      check,
      result,
      durationMs: Math.round(performance.now() - wallStart),
      wallStart,
      cached,
      sharedFrom: null,
      observations,
    });

    // Which cache this check is keyed in, decided ONCE so the lookup and the
    // miss path below can never disagree about it.
    //
    // INPUT-KEYED (validate-by-replay): selected GENERICALLY on the
    // `inputKeyed` flag — the runner never names check ids. Live: nine checks
    // set the flag today, so this branch runs on every check pass. A boolean
    // `true` uses record-then-replay; the `"declared"` variant (opaque checks)
    // is not wired yet and falls through to the legacy path until its stage
    // lands. LEGACY: the whole-tree slot. NONE: no cache (`--no-cache`, no tree
    // hash, or a check whose signature opts out) — the body just runs.
    const mode =
      cache === null || treeHash === null || sig === null
        ? ({ kind: "none" } as const)
        : snapshot !== null && check.inputKeyed === true
          ? ({
              kind: "input-keyed",
              cache,
              treeHash,
              sig,
              snapshot,
            } as const)
          : ({ kind: "legacy", cache, treeHash, sig } as const);

    // The cache lookup: the hit's outcome, or null on a miss. Called first,
    // and again by a check that joined a run whose pass that run recorded.
    const lookup = async (): Promise<CheckOutcome | null> => {
      if (mode.kind === "none") return null;
      if (mode.kind === "legacy") {
        // A cache hit runs nothing, so it observes nothing.
        return mode.cache.has(check.id, mode.treeHash, mode.sig)
          ? settled({ ok: true }, true)
          : null;
      }
      const { snapshot: snap } = mode;
      const stored = mode.cache.loadReadSet(check.id, mode.sig);
      if (stored === null) return null;
      // Replay a recorded `git grep -l` query against the CURRENT snapshot
      // tree — called by `validate` ONLY when a query's pathspec fingerprint
      // changed (the cheap in-memory gate runs first). Re-runs the SAME grep
      // plumbing `readCandidates` used (via the shared `gitGrepList`), over
      // the fresh tree, so a brand-new matching file is seen (H9).
      //
      // FAIL-OPEN: any error thrown by validate (a grep-replay spawn failure,
      // a malformed snapshot) degrades to a MISS (run the body), never a
      // crash and never a false HIT — the cache can only ever cause an
      // unnecessary re-run, not a stale PASS.
      let verdict: ValidateResult;
      try {
        verdict = await validate(stored, snap, {
          replayQuery: (q: QueryFact) =>
            gitGrepList(
              snap.root,
              q.grepArg,
              q.fixed,
              q.pathspecs,
              snap.treeHash,
            ),
        });
        // fail-open contract: any validation error (grep replay spawn failure, malformed snapshot) degrades to a cache MISS (the body runs and re-verifies), which can never produce a false HIT; propagating would abort the whole check run
      } catch (err) {
        verdict = {
          hit: false,
          reason: `validate threw (fail-open → run): ${String(err)}`,
        };
      }
      if (shadow)
        observations.push({
          line: verdict.hit
            ? `shadow: ${check.id} input-keyed HIT`
            : `shadow: ${check.id} input-keyed MISS — ${verdict.reason}`,
          stream: "stdout",
        });
      return verdict.hit ? settled({ ok: true }, true) : null;
    };

    // The miss path: run the body, and record a PASS. Failures are never
    // cached — they must always re-run with full output.
    const runMiss = async (): Promise<CheckOutcome> => {
      if (mode.kind === "input-keyed") {
        // Run under a fresh recording view, capturing the read-set. The
        // check's `ctx.repo()` records into the same view, so what it lists
        // and reads through it is part of what a later HIT replays. Its set is
        // this same snapshot's (one memoized load), which `recordingRepo`
        // requires.
        const view = mode.snapshot.createRecordingView();
        const recordingCtx = { ...ctx, repo: recordingRepo(repo, view) };
        const result = await withScanView(mode.treeHash, view, () =>
          runBody(check, recordingCtx),
        );
        const outcome = settled(result, false);
        if (result.ok)
          mode.cache.recordReadSet(check.id, mode.sig, view.readSet());
        return outcome;
      }
      const result = await withScanView(treeHash, null, () =>
        runBody(check, ctx),
      );
      const outcome = settled(result, false);
      if (mode.kind === "legacy" && result.ok)
        mode.cache.record(check.id, mode.treeHash, mode.sig);
      return outcome;
    };

    const hit = await lookup();
    if (hit !== null) return hit;
    // No cache, no flight: `--no-cache` means "really run", and a check with
    // no key has nothing to coalesce on.
    if (mode.kind === "none") return await runMiss();
    // A MISS: run it at most once across every concurrent check run on the
    // host asking for the same (check, sig, tree) — see `check-flight.ts`.
    return await runCheckFlight({
      check,
      dir: checkFlightDir(),
      sig: mode.sig,
      treeHash: mode.treeHash,
      runId: progress.runId,
      wallStart,
      observations,
      slot,
      lookup,
      run: runMiss,
      onJoin: (leaderId) => progress.checkJoined(check.id, leaderId),
      onJoinEnd: (adopted) => progress.checkJoinEnded(check.id, adopted),
    });
  };

  // How many checks run at once. Resolved HERE, after the filters, because the
  // selection is half the answer: a semaphore wider than the work it gates is
  // the same semaphore, so `--jobs 32` on a two-check run is a two-wide gate.
  //
  // The default is UNBOUNDED — one slot per selected check, so an un-asked-for
  // run behaves exactly as it did before the gate existed. That is a measured
  // decision, not a timid one. The width matrix (2026-09-02, same tree,
  // --no-cache, sequential) reads:
  //
  //   width │ wall  │ Σ reported durations │ inflation
  //       1 │ 602s  │                 601s │  1.0×
  //       4 │ 284s  │                 931s │  1.5×
  //      18 │ 337s  │               4 969s │  8.3×
  //      32 │ 300s  │               9 097s │ 15×
  //     100 │ 196s  │              13 817s │ 23×
  //
  // Wall clock IMPROVES with width — bounding costs roughly 1.7× at one-per-core
  // — while the cost a run reports about itself degrades 23×. So the gate earns
  // its keep as an instrument, not as a policy: `--jobs 1` is the only way to
  // read a check's true cost (the suite is 601s, and `type-check` is 68% of it),
  // and narrowing it by default would tax every run for a fleet-level benefit
  // nothing has yet measured. If someone later shows that an unbounded pass is
  // what makes OTHER agents' builds queue — the original motivation, still open,
  // and not answerable from a single-run matrix — this default is the line to
  // change, and the numbers above are what the change has to beat.
  //
  // `Math.max(1, …)` covers the degenerate empty selection only: `createSemaphore`
  // requires a positive width, and a gate over zero checks bounds nothing either
  // way.
  const width = Math.max(
    1,
    jobs === null ? selected.length : Math.min(selected.length, jobs),
  );
  const gate = createSemaphore(width);
  // Hands each admitted check its own event-loop turn to start on — see the
  // first statement of the gate callback below.
  const startTurn = createTurnQueue();

  let results: CheckOutcome[];
  try {
    results = await Promise.all(
      selected.map(async (check) => {
        // The check's slot in the gate, held as a lease rather than through a
        // `gate.run` wrap: a check that joins another run's in-flight check
        // gives it back for the wait and re-takes it before doing work
        // (`check-flight.ts` — holding it through the wait would park a
        // `--jobs 1` run behind another run's check). Released when the check
        // settles, whatever it did with it in between.
        const slot = gateSlot(gate);
        // The wait to be admitted, ahead of the body; 0 when a slot was free.
        const queuedMs = await slot.acquire();
        try {
          // FIRST: wait for this check's own event-loop turn. Without it every
          // admitted check started on a MICROTASK (the gate grants through a
          // resolved promise), so ~100 checks ran their synchronous start-up —
          // `cacheSignature()`, then `run()` up to its first `await` — back to
          // back, before any timer or I/O callback could run: the thread
          // watch's tick, a heartbeat, another check's socket.
          //
          // A microtask yield (`await Promise.resolve()`) would change
          // nothing: microtasks drain before the loop moves on. Nor would a
          // plain `await yieldMacrotask()` here: every check would queue its
          // yield for the SAME turn and resume in one batch. The turn queue
          // chains them, so a full loop turn runs between one check's
          // start-up and the next.
          //
          // Ahead of `wallStart`, so the wait for a turn is neither queue
          // (`queuedMs`) nor work (`durationMs`); both keep their meaning.
          await startTurn();
          // INSIDE the gate, both of them, and that placement is the entire
          // point of the change rather than an incidental detail.
          //
          // `wallStart` used to be taken at `.map` time — before this callback
          // could possibly run — so under an unbounded wave every recorded
          // `durationMs` was the wave's own length rather than the check's
          // cost. That is how twelve unrelated checks came to "cost" 260s each,
          // and it would come back verbatim if this line drifted back outside:
          // the queue would simply move from the wave into every duration.
          //
          // `checkStarted` follows it for the reader's sake: `--status` names a
          // hang as `started − ended`, so "started" has to keep meaning
          // "running". A queued check is neither, and is derived instead
          // (`CheckRunProgress.queued`).
          const wallStart = performance.now();
          progress.checkStarted(check.id);
          const observations: CheckObservation[] = [];
          let outcome: CheckOutcome | undefined;
          try {
            outcome = await runOne(check, wallStart, observations, slot);
            return outcome;
          } catch (err) {
            // A check that throws FAILS ITSELF; it does not abort the run.
            // Its throw used to reject this `Promise.all`, and the outer catch
            // then ended the whole run with only `run aborted: Error: …` — the
            // check was never named, and every other check's verdict was lost.
            // On 2026-09-10, `fork-schema-drift`'s Postgres connect timeout did
            // exactly that to whole runs. Converted here, the throw is a fatal
            // FAIL that keeps the stack: it reaches the progress `end` record
            // and the transcript through the `finally` below, and the console
            // through the ordinary print loop, like any other failure. Nothing
            // is swallowed — the run still fails, just with a name on it. (This
            // also catches the per-check cache bookkeeping around the body; the
            // stack says which threw.)
            outcome = thrownOutcome(check, err, {
              wallStart,
              durationMs: Math.round(performance.now() - wallStart),
              observations,
            });
            return outcome;
          } finally {
            // In a `finally` so the end is recorded on every path, a thrown
            // check included — a check that never records its end would
            // masquerade as the hang we are hunting.
            progress.checkEnded(
              check.id,
              Math.round(performance.now() - wallStart),
              outcome?.result.ok ?? false,
              outcome?.cached ?? false,
              Math.round(queuedMs),
              outcome?.sharedFrom ?? null,
            );
            // The transcript is written as each check SETTLES, not from the print
            // loop below — the loop runs after `Promise.all`, which a hung or
            // killed run reaches never. A check that threw has an outcome too
            // (the catch above built it); `outcome` is unset only if the runner
            // itself failed, and the outer catch reports that.
            if (outcome) {
              transcript?.record({
                checkId: check.id,
                result: outcome.result,
                cached: outcome.cached,
                sharedFrom: outcome.sharedFrom,
                observations: outcome.observations,
              });
            }
          }
        } finally {
          slot.release();
        }
      }),
    );
  } catch (err) {
    // RUNNER-INTERNAL failures only (the gate, the progress log, the transcript
    // write in the `finally`): anything `runOne` throws — the check's own body
    // above all — is already that check's FAIL outcome, built inside the gate
    // callback, so it never reaches here.
    //
    // The run is over either way: stop the heartbeat and the thread watch so
    // neither can outlive the run, and close the records. Rethrown untouched —
    // this changes no semantics.
    const thread = progress.finish(false);
    transcript?.finish([`run aborted: ${String(err)}`], false, thread);
    await progress.reportsFiled();
    throw err;
  }

  // Everything below renders to the CONSOLE only. The durable copy is the
  // transcript, already written check by check as they settled — so this loop
  // is free to truncate, and losing it (a kill, a throw) costs no record.
  const log = options.log;

  const MAX_MESSAGE_LINES = 100;

  // Render a non-passing result's (possibly huge) message + optional hint,
  // truncated in the middle when it is enormous: truncation protects an agent's
  // context window, which is why it is a console concern and the transcript
  // keeps the full text. Shared by the fatal-FAIL and the non-fatal inconclusive
  // branches so the two can't drift in truncation behaviour.
  const emitDetail = (
    check: Check,
    result: { message: string; hint?: string },
  ) => {
    const lines = result.message.split("\n");
    if (lines.length > MAX_MESSAGE_LINES) {
      const head = lines.slice(0, 50).join("\n");
      const tail = lines.slice(-50).join("\n");
      const omitted = lines.length - 100;
      const moreHint = transcript
        ? `see ${transcript.path} for full output`
        : `re-run \`./singularity check ${check.id}\` for full output`;
      log(
        `  ${head}\n  ... (${omitted} lines omitted — ${moreHint})\n  ${tail}`,
        "stderr",
      );
    } else {
      log(`  ${result.message}`, "stderr");
    }
    if (result.hint) log(`  hint: ${result.hint}`, "stderr");
  };

  // Flush a check's `ctx.log` observations to the console, indented under the
  // check's result line exactly like `emitDetail` (and like the transcript's own
  // block). Purely informational: the verdict is already decided.
  const emitObservations = (
    observations: { line: string; stream: "stdout" | "stderr" }[],
  ) => {
    for (const { line, stream } of observations) {
      log(`  ${line.split("\n").join("\n  ")}`, stream);
    }
  };

  let allOk = true;
  let anyInconclusive = false;
  // Selection-ordered, deliberately unlike the transcript's completion order: a
  // terminal summary printed once is easier to read (and to diff across runs) in
  // the order the checks were named.
  for (const {
    check,
    result,
    durationMs,
    wallStart,
    cached,
    sharedFrom,
    observations,
  } of results) {
    options?.onCheckDone?.(check.id, durationMs, wallStart);
    if (result.ok) {
      log(`• ${check.id} ... ok${provenance(cached, sharedFrom)}`, "stdout");
      emitObservations(observations);
    } else if (result.inconclusive) {
      // Environmental, non-fatal outcome: NOT a pass and NOT a hard failure.
      // It stays `ok: false`, so the caching guard above never recorded it —
      // it re-runs next build and re-verifies the real invariant. We only
      // soften fatality here (allOk untouched).
      anyInconclusive = true;
      log(
        `⚠ ${check.id} ... inconclusive — ${result.message.split("\n")[0]}`,
        "stdout",
      );
      emitObservations(observations);
      emitDetail(check, result);
    } else {
      allOk = false;
      log(`• ${check.id} ... FAIL${provenance(false, sharedFrom)}`, "stdout");
      emitObservations(observations);
      emitDetail(check, result);
    }
  }

  // Stops the heartbeat and the thread watch, and closes the run's records. A
  // run that reaches here has, by definition, not hung — `started − ended` is
  // empty. Finished HERE, ahead of the transcript, because it returns the
  // thread summary both the console line below and the transcript render.
  const thread = progress.finish(allOk);

  // One line when the thread stalled, on a passing run too, and never a change
  // to the verdict. It stays loud until the code that stalls the thread is
  // fixed: every duration above carries the stall, so a reader has to know.
  const stallLine = renderStallLine(thread, transcript?.path ?? null);
  if (stallLine !== null) log(stallLine, "stdout");

  // The closing banner is the one thing the console and the transcript still
  // share verbatim: it is about the RUN, not about any one check, so neither the
  // settle loop nor the print loop can own it.
  const trailer: string[] = [];
  if (!allOk) {
    const stop =
      "\nIf you cannot fix the failing check(s): STOP, report the failure to the user, and wait for instructions. " +
      "Do NOT work around check failures — not by disabling checks, editing check code, " +
      "expanding skip lists, committing via raw git, or any other means.";
    log(stop, "stderr");
    trailer.push(stop);
  } else if (anyInconclusive) {
    // Distinct from the STOP banner above (which correctly does NOT fire for an
    // inconclusive-only run): non-fatal, so it goes to stdout, not stderr.
    const note =
      "\nNote: some check(s) were inconclusive for environmental reasons (host-load timeout, " +
      "unlaunchable browser). They are non-fatal and NOT cached — they re-run and re-verify next build.";
    log(note, "stdout");
    trailer.push(note);
  }

  // Closes the transcript (thread block, trailer) and prunes the family.
  transcript?.finish(trailer, allOk, thread);
  // Every exit awaits the run's stall reports: the command may `process.exit()`
  // as soon as this returns, and an outbox write still in flight would be lost.
  // Never rejects, so it cannot change the verdict.
  await progress.reportsFiled();

  return allOk;
}
