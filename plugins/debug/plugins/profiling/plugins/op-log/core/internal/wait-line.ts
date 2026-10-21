import type { Lane } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { OpKind } from "@plugins/infra/plugins/worktree/core";
import type { WaitKind } from "./types";

// Where an op stands in the line it waits in — "3rd in line" — derived on the
// READ side from the in-flight ops, never written to the log. The host queues
// serve each line first come, first served (`packages/ticket-line`), so the
// waiters of one line that started waiting earlier are exactly the ones ahead.
// Reading it here, rather than as a new op-log event, keeps the wire unchanged:
// every backend on the host folds the same log, older code included.

/** The slice of an in-flight op a position needs. */
export interface LineOp {
  kind: OpKind;
  lane: Lane | null;
  openWait: { kind: WaitKind; startedAt: string } | null;
}

/**
 * The line an op is waiting in, or `null` when its wait is not a first-come
 * line (the per-checkout build lock, an identical run's verdict). The host
 * grant has one line per pool and lane — e2e runs queue on their own pool.
 */
export function waitLineOf(op: LineOp): string | null {
  const wait = op.openWait;
  if (!wait) return null;
  switch (wait.kind) {
    case "push-mutex":
    case "duress-valve":
      return wait.kind;
    case "host-grant":
      return `host-grant:${op.kind === "e2e" ? "e2e" : "cpu"}:${op.lane ?? "background"}`;
    case "build-lock":
    case "in-flight":
      return null;
  }
}

/**
 * How many in-flight ops are ahead of `op` in its line — 0 at the head — or
 * `null` when it is not waiting in a first-come line. `inFlight` is every
 * in-flight op on the host (`op` among them or not).
 */
export function waitersAhead<T extends LineOp>(
  op: T,
  inFlight: readonly T[],
): number | null {
  const line = waitLineOf(op);
  if (line === null || !op.openWait) return null;
  const since = Date.parse(op.openWait.startedAt);
  return inFlight.filter(
    (other) =>
      other !== op &&
      other.openWait !== null &&
      waitLineOf(other) === line &&
      Date.parse(other.openWait.startedAt) < since,
  ).length;
}

/** ` · next in line` / ` · 3rd in line`, or `""` when there is no line. */
export function linePositionText(ahead: number | null): string {
  if (ahead === null) return "";
  if (ahead === 0) return " · next in line";
  return ` · ${ordinal(ahead + 1)} in line`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}
