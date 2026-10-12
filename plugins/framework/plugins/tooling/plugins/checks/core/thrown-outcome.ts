import { inspect } from "node:util";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

/** One `ctx.log` line a check emitted, buffered until the check settles. */
export interface CheckObservation {
  line: string;
  stream: "stdout" | "stderr";
}

/** One check, settled: what the runner records, prints and (maybe) caches. */
export interface CheckOutcome {
  check: Check;
  result: CheckResult;
  durationMs: number;
  wallStart: number;
  cached: boolean;
  /**
   * The run whose verdict this is, when this run JOINED another run's
   * in-flight check instead of running it (`check-flight.ts`): its run id.
   * `null` when this run decided the check itself (ran it, or hit the cache).
   */
  sharedFrom: string | null;
  observations: CheckObservation[];
}

/**
 * A thrown value as text, stack first. An `Error` renders as its stack (which
 * already leads with `name: message`), followed by its `cause` chain — a
 * driver error is often a wrapper whose useful half is the cause. Anything
 * else thrown (a string, a plain object) is rendered by `inspect`, which never
 * throws itself, even on a circular value.
 */
function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    const head = err.stack || `${err.name}: ${err.message}`;
    return err.cause === undefined
      ? head
      : `${head}\ncause: ${describeThrown(err.cause)}`;
  }
  return typeof err === "string" ? err : inspect(err, { depth: 4 });
}

/**
 * The failed outcome of a check whose `run()` THREW instead of returning a
 * result — so the throw fails that one check rather than the whole run.
 *
 * Fatal (never `inconclusive`): an uncaught throw is a bug in the check, and
 * softening it would let a broken check pass a build. Never cached: the
 * runner records passes only, and `cached: false` says this outcome came from
 * running the body. The observations are the ones the check logged before it
 * threw, kept because they are often the only clue to how far it got.
 *
 * Pure, and kept out of `runner.ts` so it can be tested without loading the
 * generated check registry.
 */
export function thrownOutcome(
  check: Check,
  err: unknown,
  run: {
    wallStart: number;
    durationMs: number;
    observations: CheckObservation[];
  },
): CheckOutcome {
  return {
    check,
    result: {
      ok: false,
      message: `threw instead of returning a result:\n${describeThrown(err)}`,
      hint:
        "An uncaught throw is a bug in the check: it should return `{ ok: false }` " +
        "(or `inconclusive` for an environmental cause) for any failure it can name. " +
        "The other checks in this run still ran.",
    },
    durationMs: run.durationMs,
    wallStart: run.wallStart,
    cached: false,
    sharedFrom: null,
    observations: run.observations,
  };
}
