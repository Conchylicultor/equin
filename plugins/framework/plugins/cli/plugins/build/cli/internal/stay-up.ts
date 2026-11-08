import type { HealthResponse } from "@plugins/infra/plugins/health/core";

/**
 * What "deployed" means for a namespace backend, as pure decisions over what
 * the deploy saw — `deploy-namespace.ts` does the I/O.
 *
 * A backend is DEPLOYED when the process that took over (the first one built
 * from this tree to answer — its `startedAt` is its identity) reports
 * `boot: "settled"`: every boot phase ran in it, the post-ready ones
 * (`onReady`, `onAllReady`) and `onSettled` included. Answering once is not
 * enough: the gateway swaps to a backend at its ready barrier, and everything
 * after that point runs in a process already serving. On 2026-11-08 main's
 * backend exited ~5 s after every ready (a post-ready crash) for 16 minutes,
 * while each of the five auto-builds in that window read one `/api/health`
 * answer and said "deployed".
 *
 * Settling is an event the backend reports, not a timer the build runs out: a
 * healthy main settles 4–20 s after ready (boot journal, 2026-11-08). The
 * bound on the wait ({@link judgeSettleDeadline}) only decides what to say
 * when that event has not come; it never turns silence into success.
 */

/** One look at the namespace while waiting for the takeover process to settle. */
export type SettleObservation =
  | { kind: "answer"; startedAt: number; boot: HealthResponse["boot"] }
  | { kind: "no-answer"; detail: string };

export type SettleStep =
  | { kind: "settled" }
  | { kind: "waiting" }
  /** Another process answers: the one that took over is gone, and was respawned. */
  | { kind: "died"; successorStartedAt: number };

/** Judge one observation against the process that took over (`incarnation`). */
export function judgeSettleStep(
  incarnation: number,
  obs: SettleObservation,
): SettleStep {
  if (obs.kind === "no-answer") return { kind: "waiting" };
  if (obs.startedAt !== incarnation)
    return { kind: "died", successorStartedAt: obs.startedAt };
  return obs.boot === "settled" ? { kind: "settled" } : { kind: "waiting" };
}

/**
 * The settle wait ran out without the event. Evidence the process is gone
 * fails the deploy; anything else is stated as unproven, never as up.
 *
 * - The process itself answered last (still `ready`): alive and serving, its
 *   `onSettled` still running — unproven, not failed (a slow warm-up is a perf
 *   problem with its own budget, not a deploy that did not take).
 * - It stopped answering, and the gateway holds no live backend for the
 *   namespace (`idle`: it exited; `broken`: a respawn failed its boot;
 *   `starting`: a respawn is under way) — it died.
 * - Anything else (gateway unreachable, `running` but not answering us) — unproven.
 */
export function judgeSettleDeadline(
  last: SettleObservation | null,
  incarnation: number,
  gatewayState: string | null,
): { kind: "unproven"; why: string } | { kind: "died"; why: string } {
  if (last?.kind === "answer" && last.startedAt === incarnation) {
    return {
      kind: "unproven",
      why: `it still answers (boot: ${last.boot ?? "not reported"}) but its boot has not settled — onSettled still running`,
    };
  }
  const lastSaid =
    last === null
      ? "no answer"
      : last.kind === "no-answer"
        ? last.detail
        : `startedAt ${last.startedAt}`;
  if (
    gatewayState === "idle" ||
    gatewayState === "broken" ||
    gatewayState === "starting"
  ) {
    return {
      kind: "died",
      why: `it stopped answering (last: ${lastSaid}) and the gateway holds no live backend (state: ${gatewayState})`,
    };
  }
  return {
    kind: "unproven",
    why: `it stopped answering (last: ${lastSaid}; gateway state: ${gatewayState ?? "unreachable"})`,
  };
}
