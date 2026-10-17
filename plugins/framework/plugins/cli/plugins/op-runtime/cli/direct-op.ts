import {
  withHostGrant,
  withE2eGrant,
  inheritedGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import type {
  Grant,
  GrantHooks,
  Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { z } from "zod";
import {
  actAsCheckoutNamespace,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/server";
import {
  singleFlight,
  tryLead,
  type FlightLeader,
} from "@plugins/packages/plugins/single-flight/core";
import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import type { OpKind } from "@plugins/infra/plugins/worktree/core";
import { markWorktreeOpStart } from "@plugins/infra/plugins/worktree/server";
import {
  createOpProfiler,
  readOpStates,
  type OpProfiler,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import type { OutcomeByKind } from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import { checkBroadcasts } from "./broadcasts";
import { reportInterruptedPredecessor } from "./build-receipt";
import { installFatalSignalExit } from "./fatal-signals";
import { signalOriginTap } from "./signal-origin-tap";
import { publishLane } from "./lane";

// The lifecycle of a DIRECT op — one whose only entry ticket is the host CPU
// grant: `check`, `test`, and an `e2e` script run. Before this file the whole
// sequence lived inline in the check command, and `test` / `e2e` needed the
// identical sequence: identity, the broadcast banner, the interrupted
// predecessor, the lane, the per-op liveness marker,
// the op-log profiler (requested → granted → completed), a graceful exit on a
// catchable fatal signal with signal-origin attribution, and the grant itself —
// or the parent's INHERITED grant when this process is nested inside another op.
// Three hand-rolled copies of that sequence is how the three copies of
// `PushContentionRecord` drifted; so it is one function, and the commands own
// only what is genuinely theirs: what to run under the grant, and what the
// outcome means.
//
// `build` and `push` are NOT direct ops. A build's entry ticket is the
// per-worktree build lock and it later queues on the duress valve and the host
// grant; a push's is the global push mutex. They keep their own lifecycles.

/** What the body learns about the op it runs inside. */
export interface DirectOpContext<K extends OpKind> {
  /** The op-marker slug: this checkout's namespace. */
  slug: Namespace;
  branch: string;
  lane: Lane;
  /** This run's id — names its op-log record, its kill line, its transcript. */
  opId: string;
  /**
   * True iff this process inherited its grant from a parent op (a check spawned
   * by `build` / `push`). A nested op writes no marker, no op-log record, and
   * installs no signal handlers — the parent already owns all three, and a
   * second set would double-count the time and churn the status.
   */
  nested: boolean;
  /** `undefined` exactly when `nested`: a nested op records nothing of its own. */
  profiler: OpProfiler<K> | undefined;
}

/**
 * The outcomes one run may hand to an identical concurrent request: a verdict
 * about the work. `error` (the body threw) is not one — it says nothing about
 * the work, so a joiner runs the work itself instead.
 */
export type SharedOutcome = "success" | "failed";

const SharedVerdictSchema = z.object({
  outcome: z.enum(["success", "failed"]),
});
type SharedVerdict = z.infer<typeof SharedVerdictSchema>;

function isSharedOutcome(outcome: string): outcome is SharedOutcome {
  return outcome === "success" || outcome === "failed";
}

/** What a joiner learns about the in-flight run whose verdict it adopted. */
export interface JoinedRun {
  outcome: SharedOutcome;
  /** The run that produced the verdict: its op id (`opId`), pid and start. */
  leader: FlightLeader;
}

/**
 * Opt-in run-level coalescing: N identical requests in this worktree at once
 * cost one run. See `DirectOpOptions.flight`.
 */
export interface DirectOpFlight<K extends OpKind> {
  /**
   * What makes two requests the same run — everything that changes the
   * answer, INCLUDING the content hash of the tree it runs on (the correctness
   * bar: a verdict is only ever adopted from a run that started on the tree the
   * joiner's own request saw). The op kind is prepended here, so two kinds can
   * never share a key.
   */
  key: string;
  /**
   * The joiner's side: render the adopted verdict (the leader's transcript, its
   * failure list) and return the outcome to stamp on this op. Called instead of
   * `body`; no grant is taken.
   */
  adopt: (joined: JoinedRun, ctx: DirectOpContext<K>) => OutcomeByKind[K];
}

export interface DirectOpOptions<K extends OpKind = OpKind> {
  /**
   * How many host CPU units to ask for when acquiring a grant of our own. The
   * acquire is elastic — it hands back the slots it could get, `>= 1` — so this
   * is a ceiling, not a demand: `cpuBudget().B` for work that fans out (a check
   * pass, a vitest worker pool), `1` for a single process driving a browser.
   */
  max: number;
  /**
   * Adopt a parent-supplied id rather than minting one. Nested-only by
   * contract (the check command's `--run-id`): a top-level op must mint its
   * own, because that id also names its op-log row, and adopting a parent's
   * would collide with the parent's records. The caller validates that rule —
   * this primitive only honours the id it is handed.
   */
  opId?: string;
  /**
   * Coalesce with an identical run already in flight in this worktree, BEFORE
   * the host grant. Omitted, every request runs.
   *
   * A request whose key is in flight JOINS: it still writes its marker and its
   * `requested` record, opens an `in-flight` wait naming the leader, never
   * calls `withHostGrant`, and completes with the leader's outcome via
   * `flight.adopt`. A run that could not be adopted (the leader died, threw, or
   * published nothing) is run by the joiner itself, which then leads.
   *
   * Joining happens before the grant because a `Grant` cannot be released
   * early: a duplicate that queued for a grant first would hold host CPU for a
   * run it never does.
   *
   * A NESTED op (a parent's grant inherited) leads when the key is free — so a
   * top-level duplicate can still join it — but never waits: a leader still
   * queued for a host grant may be waiting on exactly the units the nested
   * op's parent holds, and waiting on it would close a cycle. It runs unshared
   * instead.
   */
  flight?: DirectOpFlight<K>;
}

type GrantAcquire = <T>(
  opts: { lane: Lane; max: number; hooks?: GrantHooks },
  fn: (grant: Grant) => Promise<T>,
) => Promise<T>;

/**
 * The host pool a direct op's grant comes from. An `e2e` run — one browser,
 * p50 21 s — has a pool of its own: in `cpu` it shared the 6-slot background
 * window with builds holding theirs for 30–60 min, and 23 % of e2e runs waited
 * ≥ 100 s for a 20 s screenshot (`HOST_POOLS.e2e`).
 */
type GrantPool = "cpu" | "e2e";

function poolFor(kind: OpKind): GrantPool {
  return kind === "e2e" ? "e2e" : "cpu";
}

/**
 * `in flight: build att-… (12m), test att-… (3m); 2 more queued` — the ops on
 * `pool` other than this one, from the folded op log. A HOLDER is an open op
 * past `granted` that is not itself parked on a host grant; that is an
 * approximation (a build's `granted` is its build lock, and it takes `cpu`
 * units per stage), which is why the line says "in flight", not "held by".
 */
function describeQueueFromOpLog(pool: GrantPool, selfOpId: string): string {
  const now = Date.now();
  const holders: string[] = [];
  let queued = 0;
  for (const st of readOpStates().values()) {
    const id = st.identity;
    if (st.opId === selfOpId || st.closedBy !== null || !id) continue;
    if (poolFor(id.kind) !== pool) continue;
    const who = `${id.kind} ${id.opSlug ?? "?"}`;
    if (st.openWait?.kind === "host-grant") queued++;
    else if (st.grantedAt !== null) {
      const mins = Math.round((now - Date.parse(st.grantedAt)) / 60_000);
      holders.push(`${who} (${mins}m)`);
    }
  }
  const shown = holders.slice(0, 6).join(", ");
  const more = holders.length > 6 ? ` and ${holders.length - 6} more` : "";
  const ahead = queued > 0 ? `; ${queued} other(s) queued` : "";
  return holders.length > 0 || queued > 0
    ? `in flight: ${shown || "none recorded"}${more}${ahead}`
    : "no holder recorded in the op log";
}

/**
 * The seams a test injects. Every one defaults to the real thing; nothing here
 * is a mock in production. The shape follows `ValveDeps` in admission-valve.ts.
 */
export interface DirectOpDeps {
  inheritedGrant: () => Grant | undefined;
  withHostGrant: GrantAcquire;
  /** The `e2e` pool's grant — what an `e2e` op acquires instead of `cpu`. */
  withE2eGrant: GrantAcquire;
  /**
   * What this op is queued behind, for the line printed when its grant wait
   * starts: the other ops in flight on the same pool. Read from the op log.
   */
  describeQueue: (pool: GrantPool, selfOpId: string) => string;
  identity: () => Promise<{ slug: Namespace; branch: string }>;
  checkBroadcasts: (kind: OpKind) => Promise<void>;
  reportInterruptedPredecessor: (slug: Namespace) => void;
  publishLane: (isInteractiveOrigin: boolean) => void;
  createOpProfiler: typeof createOpProfiler;
  markWorktreeOpStart: typeof markWorktreeOpStart;
  /** Register an exit-time cleanup (`process.on("exit", …)`). */
  onExit: (fn: () => void) => void;
  installFatalSignalExit: (opId: string, slug: Namespace) => Promise<void>;
  singleFlight: typeof singleFlight;
  tryLead: typeof tryLead;
  /** The progress line a joiner prints. */
  log: (line: string) => void;
}

// This worktree's identity: the op-marker slug (this checkout's namespace,
// matching what `build` / `push` write — see worktree-op.ts) and the branch the
// op record carries. `getWorktreeRoot()` is the shared, process-memoized
// git-root helper (one spawn regardless of caller count); the branch is one
// more `git rev-parse`. Moved here verbatim from the check command, which was
// the one direct op until test and e2e joined it.
async function getWorktreeIdentity(): Promise<{
  slug: Namespace;
  branch: string;
}> {
  const root = await getWorktreeRoot();
  const branchResult = await spawnCaptured(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    // Wedge-breaker for a metadata-only git read; the op body this precedes is
    // the genuinely long-running part, and it is the one marked `unbounded`.
    { timeoutMs: 60_000 },
  );
  const branch = branchResult.stdout.trim();
  if (branchResult.exitCode !== 0 || !branch) {
    console.error(
      `Could not determine the current branch (git rev-parse said: ${branchResult.stdout.trim()})`,
    );
    process.exit(1);
  }
  // A direct op runs against the main composition only — same reading as
  // `build`, where the checkout is the variable half of the pair, which is what
  // `checkoutNamespace` names (acted as, so the namespace records this checkout).
  return { slug: await actAsCheckoutNamespace(root), branch };
}

const realDeps: DirectOpDeps = {
  inheritedGrant,
  withHostGrant,
  withE2eGrant,
  describeQueue: describeQueueFromOpLog,
  identity: getWorktreeIdentity,
  checkBroadcasts,
  reportInterruptedPredecessor,
  publishLane,
  createOpProfiler,
  markWorktreeOpStart,
  onExit: (fn) => process.on("exit", fn),
  // The tap arms here, and its sink is a direct op's ONLY record of a death: a
  // direct op owns no deploy receipt, so without the line an externally-killed
  // check/test leaves nothing behind but a cleared marker. The signal→exit-code
  // map is shared with `build` and `push`; see ./fatal-signals.ts.
  installFatalSignalExit: async (opId, slug) =>
    installFatalSignalExit(await signalOriginTap({ opId, worktree: slug })),
  singleFlight,
  tryLead,
  log: (line) => console.log(line),
};

/**
 * Run `body` as a direct op of `kind`.
 *
 * Sequence, on the top-level path: broadcasts → identity → interrupted
 * predecessor → lane → locked liveness marker → profiler `requested` + exit
 * handler + fatal-signal exit → host grant (its queue recorded as a
 * `host-grant` wait) → profiler `granted` → `body` → profiler `completed` →
 * marker released. The marker is published BEFORE `requested` and released
 * AFTER `completed` is appended, on every graceful exit — the `finally` below,
 * and the exit handler for a `process.exit` inside `body` — so a reader never
 * sees an op in the log with no marker unless its process really died. A
 * SIGKILL drops the marker's flock with the process, and the op-store
 * reconciler closes the op as interrupted.
 *
 * On the NESTED path (a parent's grant in the environment) only the lane is
 * published — not-clobbered, so the parent's classification wins — and `body`
 * runs on the inherited grant with `ctx.nested === true` and no profiler.
 *
 * With `opts.flight`, the grant step is wrapped in a single-flight on the
 * key: an identical request already in flight is JOINED (an `in-flight` wait,
 * no grant, the leader's outcome via `flight.adopt`) — see `DirectOpFlight`.
 *
 * `body` returns the outcome to stamp on the terminal record, and it owns the
 * process exit code: this primitive never calls `process.exit`. A `body` that
 * throws stamps no outcome; the exit handler's `write()` lands it as `error`,
 * which is the truth about it.
 */
export async function withDirectOp<K extends OpKind>(
  kind: K,
  opts: DirectOpOptions<K>,
  body: (grant: Grant, ctx: DirectOpContext<K>) => Promise<OutcomeByKind[K]>,
  deps: DirectOpDeps = realDeps,
): Promise<OutcomeByKind[K]> {
  // NESTING, resolved before anything acts on it. A parent op hands this child
  // its host CPU grant in the environment; we spend those units WITHOUT
  // acquiring host-wide again — no double-acquire, no deadlock. Its presence is
  // also the single answer to "did a parent already do this?", which every
  // gate below reads. "This op has a marker of its own" and "this op contends
  // for a grant of its own" are one fact, not two.
  const inherited = deps.inheritedGrant();
  const nested = inherited !== undefined;

  // The parent printed the same banner before it spawned us, and a nested op
  // re-printing it is pure noise.
  if (!nested) await deps.checkBroadcasts(kind);

  const { slug, branch } = await deps.identity();

  // An interrupted build prints no verdict and sets no exit code its caller
  // can see, so the next op is where it surfaces. Direct ops are very often
  // run to validate what a build just deployed. Gated for the same reason as
  // the banner: the parent already announced its predecessor.
  if (!nested) deps.reportInterruptedPredecessor(slug);

  // A direct op on the main worktree is human-blocking (interactive), any other
  // is background. `publishLane` not-clobbers: a parent op's `grant.env()`
  // always sets SINGULARITY_LANE, so a nested op reads the parent's
  // classification here rather than reclassifying off its own branch — that
  // is how a push-nested check keeps `interactive` even on an agent branch.
  // Left UNCONDITIONAL; a `!nested` gate would be a second rule saying the
  // same thing. See ./lane.ts.
  const isInteractiveOrigin = slug === MAIN_WORKTREE_NAME;
  const lane: Lane = isInteractiveOrigin ? "interactive" : "background";
  deps.publishLane(isInteractiveOrigin);

  const opId = opts.opId ?? crypto.randomUUID();

  const profiler = nested
    ? undefined
    : deps.createOpProfiler(kind, { opId, branch, opSlug: slug, lane });

  // The marker first, THEN `requested`: an op in the log with no locked marker
  // is one the reconciler closes as interrupted. The terminal is appended
  // before the release for the same reason (see `finish`).
  const marker = nested
    ? undefined
    : deps.markWorktreeOpStart(slug, kind, opId);
  // The terminal record then the release, on every graceful exit — including a
  // `process.exit(1)` inside `body`, which skips the `finally`. Idempotent (both
  // halves are), and an outcome already stamped by `complete()` wins; a path
  // that exits without one lands as "error", which is the truth about it.
  const finish = (): void => {
    profiler?.write();
    marker?.release();
  };
  if (!nested) {
    profiler?.markRequested();
    deps.onExit(finish);
    // Catchable fatal signals → graceful exit so the exit handler above runs
    // (the wrapper's orphan SIGTERM tears this worker down cleanly). SIGKILL is
    // uncatchable; the kernel drops the marker's flock with the process.
    await deps.installFatalSignalExit(opId, slug);
  }

  const ctx: DirectOpContext<K> = {
    slug,
    branch,
    lane,
    opId,
    nested,
    profiler,
  };

  try {
    const runUnder = async (grant: Grant): Promise<OutcomeByKind[K]> => {
      // The grant is now held. The host grant IS a direct op's entry ticket: it
      // does no further waiting after this point.
      profiler?.markGranted();
      const outcome = await body(grant, ctx);
      profiler?.complete(outcome);
      return outcome;
    };
    const pool = poolFor(kind);
    const acquire = pool === "e2e" ? deps.withE2eGrant : deps.withHostGrant;
    // `grantHooks()` is what makes this queue visible as a `host-grant` wait
    // in the op log — the wait that made a direct check an invisible
    // contender. The two lines are the same wait made visible to whoever ran
    // the command: before them a run queued for 30 min printed nothing, so an
    // agent could not tell a queue from a hang.
    const grantHooks = (): GrantHooks => {
      const recorded = profiler?.grantHooks();
      let waited = false;
      return {
        ...recorded,
        onWaitStart: () => {
          recorded?.onWaitStart?.();
          waited = true;
          deps.log(
            `Waiting for a host ${pool} slot (every slot is taken — ${deps.describeQueue(pool, opId)}). This is a queue, not a hang; the ${kind} starts as soon as a slot frees.`,
          );
        },
        onAcquired: (waitMs) => {
          recorded?.onAcquired?.(waitMs);
          if (waited)
            deps.log(
              `Got a host ${pool} slot after ${Math.round(waitMs / 1000)}s — starting the ${kind}.`,
            );
        },
      };
    };
    const run = async (): Promise<OutcomeByKind[K]> =>
      inherited
        ? await runUnder(inherited)
        : await acquire({ lane, max: opts.max, hooks: grantHooks() }, runUnder);
    const { flight } = opts;
    if (!flight) return await run();

    const flightOpts = {
      dir: worktreeArtifacts.opFlights(slug),
      key: `${kind}\n${flight.key}`,
      id: opId,
    };
    // The leader's side: run, then hand the verdict to whoever joined. Only a
    // verdict about the work is shared; `error` is not one.
    const lead = async (
      publish: (v: SharedVerdict) => void,
    ): Promise<OutcomeByKind[K]> => {
      const outcome = await run();
      if (isSharedOutcome(outcome)) publish({ outcome });
      return outcome;
    };

    if (inherited) {
      const led = await deps.tryLead(flightOpts, lead);
      if (led.role === "led") return led.result;
      deps.log(
        `An identical ${kind} is already running in this worktree — running anyway: a nested ${kind} never waits on another run (it may be queued behind this op's own parent's grant).`,
      );
      return await run();
    }

    const result = await deps.singleFlight(
      {
        ...flightOpts,
        schema: SharedVerdictSchema,
        // Only `success` / `failed` are ever published, and both are verdicts.
        adoptable: () => true,
        onJoin: (leader) => {
          const who = leader ? `${kind} ${leader.id}` : `${kind} (starting)`;
          deps.log(
            `An identical ${kind} is already running in this worktree (${leader ? `${leader.id}, started ${ago(leader.startedAt)}` : "starting"}) — waiting for its verdict instead of running again.`,
          );
          profiler?.waitStart("in-flight", who);
        },
      },
      async (publish) => {
        // A join that ends here could not adopt (its leader died, threw, or
        // published nothing): close that wait and run the work ourselves.
        profiler?.waitEnd("aborted");
        return await lead(publish);
      },
    );
    if (result.role === "led") return result.result;

    profiler?.waitEnd("acquired");
    const outcome = flight.adopt(
      { outcome: result.verdict.outcome, leader: result.leader },
      ctx,
    );
    profiler?.complete(outcome);
    return outcome;
  } finally {
    finish();
  }
}

/** `12s ago` — how long ago an epoch-ms instant was. */
function ago(epochMs: number): string {
  return `${Math.max(0, Math.round((Date.now() - epochMs) / 1000))}s ago`;
}
