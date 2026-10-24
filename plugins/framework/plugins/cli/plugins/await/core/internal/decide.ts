import type { OpKind } from "@plugins/infra/plugins/worktree/core";
import type {
  OpOutcome,
  OpRecord,
  TerminalOutcome,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";

/**
 * The exit codes `./equin await` answers with.
 *
 * Four states, four codes, because the caller is usually an agent deciding what
 * to do next and three of them are NOT "the op failed":
 *
 * - `ended` (0)        — every awaited op reached a terminal record, all good.
 * - `failed` (1)       — at least one ended with a non-success outcome.
 * - `stillRunning` (70)— the wait hit its own cap first. Nothing is wrong; call
 *                        again. Collapsing this into 1 would make a slow build
 *                        indistinguishable from a broken one.
 * - `nothing` (3)      — there was nothing to await. Awaiting an op that is not
 *                        running is a mistake about the world, not a verdict on
 *                        it, so it can never read as either success or failure.
 */
export const AWAIT_EXIT = {
  ended: 0,
  failed: 1,
  nothing: 3,
  stillRunning: 70,
} as const;

/** One op this wait armed on: the marker it saw, frozen at arm time. */
export interface AwaitedOp {
  op: OpKind;
  /** The op-log id the marker carries — what joins it to its outcome. */
  opId: string;
  /** The CLI process running it, the liveness handle for the death check. */
  pid: number;
}

/**
 * Where one awaited op stands.
 *
 * `vanished` is its own arm rather than an outcome value: an op whose process
 * is gone and which wrote no terminal record did not fail — nobody knows what
 * it did. A SIGKILL (OOM, a `kill -9`, the machine going down) runs no exit
 * handler, so no `completed` record is written and the marker is left behind
 * for the next reader to reap. Reporting that as `failed` would invent a
 * verdict; reporting it as success would be a lie; hanging on it forever is
 * what this whole command exists to stop.
 */
export type OpState =
  | { kind: "running"; op: OpKind; opId: string }
  | {
      kind: "ended";
      op: OpKind;
      opId: string;
      outcome: TerminalOutcome;
      /** Closed by the orphan reconciler rather than by the op itself. */
      interrupted: boolean;
    }
  | { kind: "vanished"; op: OpKind; opId: string; pid: number };

/**
 * Has this op written its verdict? `readOpRecords` synthesises `waiting` /
 * `running` for a record with no terminal phase, so "is it over" is exactly
 * "is the outcome one of the writer-stamped ones".
 */
export function isTerminalOutcome(o: OpOutcome): o is TerminalOutcome {
  return o !== "waiting" && o !== "running";
}

/**
 * Where each awaited op stands, from the three readings taken together.
 *
 * Pure, and deliberately ordered: **the op-log record wins over the marker.**
 * Every writer appends its terminal BEFORE it releases its marker, so the
 * verdict is on disk by the time the marker goes; asking the log first means a
 * marker read a moment late can never outvote it.
 *
 * `live` is the set of opIds whose marker is live right now (one flocked
 * `ops/<opId>.json` per op, so two ops of one kind are two entries).
 *
 * `pidAlive` is injected rather than called here so this stays testable without
 * spawning processes.
 */
export function decideStates(
  awaited: readonly AwaitedOp[],
  live: ReadonlySet<string>,
  records: ReadonlyMap<string, OpRecord>,
  pidAlive: (pid: number) => boolean,
): OpState[] {
  return awaited.map((a): OpState => {
    const record = records.get(a.opId);
    if (record && isTerminalOutcome(record.outcome))
      return {
        kind: "ended",
        op: a.op,
        opId: a.opId,
        outcome: record.outcome,
        interrupted: record.interrupted,
      };

    // Its marker is still locked — plainly running.
    if (live.has(a.opId)) return { kind: "running", op: a.op, opId: a.opId };

    // No live marker and no verdict. For a per-op marker that means its process
    // died; a legacy per-kind marker (an older CLI's, overwritten by the next
    // op of the same kind) says nothing, so the process settles it: alive means
    // the verdict is still coming, dead means it never will.
    return pidAlive(a.pid)
      ? { kind: "running", op: a.op, opId: a.opId }
      : { kind: "vanished", op: a.op, opId: a.opId, pid: a.pid };
  });
}

/** Every awaited op has stopped running, one way or another. */
export function allSettled(states: readonly OpState[]): boolean {
  return states.every((s) => s.kind !== "running");
}

/**
 * The code a settled set exits with. `vanished` counts as a failure: the caller
 * asked what happened and the honest answer is "nobody knows", which must not
 * be allowed to read as success.
 */
export function exitCodeFor(states: readonly OpState[]): number {
  if (states.length === 0) return AWAIT_EXIT.nothing;
  if (states.some((s) => s.kind === "running")) return AWAIT_EXIT.stillRunning;
  const bad = states.some(
    (s) =>
      s.kind === "vanished" || (s.kind === "ended" && s.outcome !== "success"),
  );
  return bad ? AWAIT_EXIT.failed : AWAIT_EXIT.ended;
}
