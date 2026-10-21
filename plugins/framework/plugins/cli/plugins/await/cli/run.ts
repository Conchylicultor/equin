import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  AWAIT_EXIT,
  allSettled,
  decideStates,
  exitCodeFor,
  isTerminalOutcome,
  type AwaitedOp,
  type OpState,
} from "@plugins/framework/plugins/cli/plugins/await/core";
import { resolveBuildReceipt } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import {
  readTestStatus,
  testFailureLines,
} from "@plugins/framework/plugins/cli/plugins/test/core";
import {
  OP_KIND_IDS,
  isOpKind,
  type OpKind,
} from "@plugins/infra/plugins/worktree/core";
import {
  listWorktreeOps,
  type WorktreeOpInfo,
} from "@plugins/infra/plugins/worktree/server";
import {
  OP_LOG_FILE,
  readOpRecords,
  readOpenWaitInLine,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import { watchForCommand } from "@plugins/infra/plugins/file-watcher/cli";
import {
  checkoutNamespace,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  WAIT_KINDS,
  linePositionText,
  type OpRecord,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";

/**
 * How far back a just-finished op still counts as the thing the caller meant.
 *
 * An op can end before the wait even arms — a build that fails its checks in
 * forty seconds, with the two calls a second apart. Reporting "nothing to wait
 * for" there would be true about the present and useless about the question, so
 * a terminal record this recent is answered with its verdict instead.
 */
const RECENT_VERDICT_MS = 10 * 60 * 1000;

/** Re-read on a timer as well as on events, so one missed event cannot hang a wait. */
const RECONCILE_MS = 15_000;

function opsDirOf(slug: Namespace): string {
  return `${worktreeDataDir(slug)}/ops`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function liveOpIds(ops: WorktreeOpInfo[]): Set<string> {
  return new Set(ops.flatMap((o) => (o.opId ? [o.opId] : [])));
}

function recordsById(): Map<string, OpRecord> {
  return new Map(readOpRecords().map((r) => [r.opId, r]));
}

/** Seconds, from a flag that reaches us as whatever the user typed. */
function seconds(
  raw: string | undefined,
  fallback: number,
  flag: string,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `${flag} must be a non-negative number of seconds, got: ${raw}`,
    );
    process.exit(AWAIT_EXIT.nothing);
  }
  return n;
}

/** The extra detail a kind keeps beyond the op log's one-word outcome. */
function detailFor(state: OpState, slug: Namespace): string[] {
  if (state.kind !== "ended") return [];
  if (state.op === "build") {
    const resolved = resolveBuildReceipt(slug);
    if (resolved.kind === "none") return [];
    const r = resolved.receipt;
    return [
      `  receipt: ${resolved.kind}  buildId ${r.buildId}  commit ${r.commit ?? "?"}`,
      `  ${r.url}`,
      `  log: ${r.logPath}`,
    ];
  }
  if (state.op === "test") {
    const status = readTestStatus(slug, state.opId);
    if (!status) return [];
    return testFailureLines(status);
  }
  return [];
}

function describe(state: OpState, slug: Namespace): string {
  const head =
    state.kind === "ended"
      ? `${state.op}: ${state.outcome}${state.interrupted ? " (interrupted — closed by the orphan reconciler)" : ""}`
      : state.kind === "vanished"
        ? `${state.op}: DIED WITHOUT A VERDICT — pid ${state.pid} is gone and no terminal record was written. ` +
          `Nothing knows what it did; run it again.`
        : `${state.op}: still running`;
  return [head, ...detailFor(state, slug)].join("\n");
}

/**
 * What the op is parked on right now.
 *
 * Printed only when it CHANGES. The reconcile fires every 15s, and an op parked
 * on the host grant for three minutes would otherwise print the same sentence
 * twelve times — which reads as a stuck loop, the precise impression a wait must
 * not give.
 */
function progressReporter(): (a: AwaitedOp) => void {
  const last = new Map<string, string>();
  return (a) => {
    const parked = readOpenWaitInLine(a.opId);
    const line = parked
      ? `  ${a.op}: ${WAIT_KINDS[parked.wait.kind].sentence(parked.wait.reason)}` +
        `${parked.wait.cycle > 0 ? ` · requeue #${parked.wait.cycle}` : ""}` +
        `${linePositionText(parked.ahead)} since ${parked.wait.startedAt}`
      : `  ${a.op}: working`;
    if (last.get(a.opId) === line) return;
    last.set(a.opId, line);
    console.log(line);
  };
}

const run: CliAction<[string[]], { maxWait?: string; arm?: string }> = async (
  ops,
  opts,
) => {
  for (const op of ops) {
    if (!isOpKind(op)) {
      console.error(
        `Not an op kind: ${op}. Expected one of ${OP_KIND_IDS.join(", ")}.`,
      );
      process.exit(AWAIT_EXIT.nothing);
    }
  }
  const wanted = new Set(ops.filter(isOpKind));
  const maxWaitMs = seconds(opts.maxWait, 480, "--max-wait") * 1000;
  const armMs = seconds(opts.arm, 60, "--arm") * 1000;

  const slug = await checkoutNamespace(await getWorktreeRoot());
  const opsDir = opsDirOf(slug);
  // The op writer mkdirs this too; doing it here means a checkout that has never
  // run an op can still be watched rather than throwing on subscribe.
  mkdirSync(opsDir, { recursive: true });

  const matches = (op: OpKind) => wanted.size === 0 || wanted.has(op);

  // ── arm ──────────────────────────────────────────────────────────────────
  // Capture (kind, opId, pid) now. Everything after this decides about THESE
  // runs: an op started after arming is not the one the caller meant, and
  // without the frozen ids a wait would silently start reporting on it too.
  const startedAt = Date.now();
  let awaited: AwaitedOp[] = [];
  const armOnce = async (): Promise<boolean> => {
    const live = (await listWorktreeOps(slug)).filter((o) => matches(o.op));
    awaited = live
      .filter((o): o is WorktreeOpInfo & { opId: string } => o.opId !== null)
      .map((o) => ({ op: o.op, opId: o.opId, pid: o.pid }));
    const unidentified = live.filter((o) => o.opId === null);
    for (const o of unidentified)
      console.error(
        `Ignoring a ${o.op} marker written by an older CLI (no run id) — pid ${o.pid}.`,
      );
    return awaited.length > 0;
  };

  if (!(await armOnce())) {
    // Nothing live. Either it already finished (the fast-op race) or it has not
    // started yet (the slow-start race). Answer the first from the log; wait out
    // the second.
    const now = Date.now();
    const recent = readOpRecords()
      .flatMap((r) =>
        r.opSlug === slug &&
        matches(r.kind) &&
        r.completedAt !== null &&
        isTerminalOutcome(r.outcome) &&
        now - Date.parse(r.completedAt) < RECENT_VERDICT_MS
          ? [
              {
                at: Date.parse(r.completedAt),
                state: {
                  kind: "ended",
                  op: r.kind,
                  opId: r.opId,
                  outcome: r.outcome,
                  interrupted: r.interrupted,
                } satisfies OpState,
                completedAt: r.completedAt,
              },
            ]
          : [],
      )
      .sort((a, b) => b.at - a.at);
    const done = recent[0];
    if (done) {
      console.log(
        `No ${done.state.op} is running — the last one already finished at ${done.completedAt}.`,
      );
      console.log(describe(done.state, slug));
      process.exit(exitCodeFor([done.state]));
    }
    if (armMs > 0) {
      console.log(
        `Nothing running yet — watching for up to ${armMs / 1000}s for an op to start.`,
      );
      await watchUntil(opsDir, armMs, armOnce);
    }
  }

  if (awaited.length === 0) {
    const what = wanted.size > 0 ? [...wanted].join(", ") : "op";
    console.error(
      `Nothing to await: no ${what} is running in ${slug}, and none finished recently.\n` +
        `Start one first (e.g. \`./singularity build\` with run_in_background: true), then await it.`,
    );
    process.exit(AWAIT_EXIT.nothing);
  }

  console.log(
    `Awaiting ${awaited.map((a) => a.op).join(", ")} in ${slug} ` +
      `(up to ${maxWaitMs === 0 ? "forever" : `${maxWaitMs / 1000}s`}).`,
  );

  // ── wait ─────────────────────────────────────────────────────────────────
  // Two directories, because the two readings live apart: the marker says a run
  // is alive, the op log says what it decided. Watching both means the wait
  // wakes on whichever lands first and never has to re-ask on a timer — the
  // reconcile below is a safety net, not the mechanism.
  let states: OpState[] = [];
  const settled = async (): Promise<boolean> => {
    states = decideStates(
      awaited,
      liveOpIds(await listWorktreeOps(slug)),
      recordsById(),
      isPidAlive,
    );
    return allSettled(states);
  };

  // Arming spent part of the budget. `watchUntil` reads 0 as "no limit", so a
  // budget already exhausted must skip the wait rather than be handed a 0 that
  // would mean forever — the one way this command could hang.
  const remaining = maxWaitMs === 0 ? 0 : maxWaitMs - (Date.now() - startedAt);
  const budgetLeft = maxWaitMs === 0 || remaining > 0;
  // Read once up front whatever happens next, so a wait that never gets to run
  // still reports the truth (`still running`) instead of an empty `states`,
  // which would read as "there was nothing to await".
  const progress = progressReporter();
  const alreadyDone = await settled();
  if (budgetLeft && !alreadyDone)
    await watchUntil([opsDir, dirname(OP_LOG_FILE)], remaining, settled, () => {
      for (const a of awaited)
        if (states.some((s) => s.kind === "running" && s.opId === a.opId))
          progress(a);
    });

  for (const s of states) console.log(describe(s, slug));

  const code = exitCodeFor(states);
  if (code === AWAIT_EXIT.stillRunning)
    console.log(
      `\nStill running after ${Math.round((Date.now() - startedAt) / 1000)}s. ` +
        `This is not a failure — run \`./singularity await ${awaited.map((a) => a.op).join(" ")}\` again.`,
    );
  process.exit(code);
};

/**
 * Block until `done()` says so, or until `timeoutMs` elapses (0 = no limit).
 *
 * Push-based: the promise settles on a filesystem event, not on a tick. The
 * watcher's own reconcile is the only timer, and it exists because a missed
 * event must cost a few seconds rather than the whole wait — the failure this
 * command was written to remove is precisely something waiting forever on a
 * signal that never comes.
 */
async function watchUntil(
  dirs: string | string[],
  timeoutMs: number,
  done: () => Promise<boolean>,
  onReconcile?: () => void,
): Promise<void> {
  const watcher = await watchForCommand({
    dirs: Array.isArray(dirs) ? dirs : [dirs],
    name: "await",
    debounceMs: 50,
    ceilingMs: 500,
    reconcileMs: RECONCILE_MS,
    onChange: () => check(),
    onReconcile: () => {
      onReconcile?.();
      return check();
    },
  });

  let finish!: () => void;
  const finished = new Promise<void>((r) => {
    finish = r;
  });
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    finish();
  };
  const check = async () => {
    if (over) return;
    if (await done()) end();
  };

  const timer = timeoutMs > 0 ? setTimeout(end, timeoutMs) : null;
  // Re-check once after arming: the thing being waited for may have happened
  // between the caller's own read and the subscription going live.
  void check();
  try {
    await finished;
  } finally {
    if (timer) clearTimeout(timer);
    await watcher.stop();
  }
}

export default run;
