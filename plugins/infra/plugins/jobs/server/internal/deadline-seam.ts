import { defineRequestSink } from "@plugins/primitives/plugins/report-sink/core";
import type { HoldClass } from "../../core/hold";

/**
 * The seam every deadline event is announced on: one run overran its hold
 * class, and — 30 seconds later — one run still had not settled after being
 * given up on.
 *
 * WHY A SEAM AND NOT A DIRECT `@plugins/reports` IMPORT. Two reasons, and the
 * second is a hard constraint.
 *
 * It is the wrong layering. `jobs` is load-bearing infrastructure and must not
 * name the observability stack; `reports` owns interpretation — kinds,
 * fingerprints, duress shedding, the bell, task filing. This is the same rule
 * `queue-health/CLAUDE.md` gives as the reason for its own placement. It also
 * has a concrete cost: naming `reports` here would force every composition
 * containing `jobs` to also contain `reports`, `shell/notifications` and
 * `tasks`.
 *
 * And it would be a cycle. `reports` (its engine) already reaches `jobs` by two independent
 * routes today — `reports/plugins/engine/server/internal/record-report.ts` →
 * `shell/notifications/server` → `ttl-cleanup.ts:4` → `jobs`, and
 * `reports/plugins/engine/server/internal/retention.ts` → `infra/retention/server` → `jobs`.
 * Both are there because `reports` is a *user* of durable background work, which
 * is exactly the relationship a primitive cannot invert. Severing the two routes
 * would leave a standing rule that "reports must never use a background job" —
 * a far worse constraint than a sink.
 *
 * `jobs` has already faced this identical shape once: it needs `registerTrigger`
 * from `events` for `ctx.waitFor`, and `events` already imports `jobs`. The
 * answer was `UNSAFE_installDurableHooks` (`step-ctx.ts`). This is that answer
 * again, using the factored-out primitive rather than a hand-rolled setter.
 *
 * The consumer is the `deadline-audit` sub-plugin, which registers a handler in
 * its `onReady`. A child importing its parent is not a cycle: the parent never
 * imports the child.
 *
 * `emit()` never throws (the report-sink contract), which matters because these
 * calls happen on the abort path — the one path that must not acquire a second
 * failure mode. `emit()` returning `undefined` means nobody registered, and
 * every caller treats that as a branch (fall back to `reportServerError`), never
 * as an assumption.
 */

/** One announcement about a run that passed its class deadline. `phase`
 * discriminates the arms. */
export interface JobDeadlineEvent {
  /**
   * - `exceeded` — the deadline fired: `ctx.signal` has just been aborted and
   *   the handler has not yet been given the chance to unwind.
   * - `zombie` — the 30 s grace after that elapsed and the handler still has not
   *   settled. It is still holding its slot and its advisory lock, and that slot
   *   has now been written off (see `forfeit.ts`).
   * - `unforfeited` — a run we had already written off as a zombie finally
   *   settled, and its slot is back. Emitted ONLY when there was a forfeit to
   *   clear, never on the normal path where a handler simply finished in time —
   *   so this arm always means "a wedge we reported has resolved itself", which
   *   is a fact worth having and not merely the absence of one.
   */
  phase: "exceeded" | "zombie" | "unforfeited";
  jobName: string;
  jobId: string;
  /** 1-indexed graphile attempt number. */
  attempt: number;
  hold: HoldClass;
  /** The class's deadline, carried rather than re-derived so a consumer never
   * restates a number from the class table. */
  deadlineMs: number;
  /** Wall-clock hold at the moment this arm fired. */
  elapsedMs: number;
  /** Which runner in the ladder dispatched this run (`floor` / `mid` / `wide`). */
  runnerId: string;
}

/**
 * `true` from the handler means *this event has a durable home and is on its way
 * there* — not that a row has been written, which a synchronous handler could
 * not promise (the consumer's write is a DB round-trip and this is called from
 * a timer on the abort path).
 *
 * That is the question the caller actually needs answered: it separates "nobody
 * is listening" (`undefined`) and "a consumer looked at this and declined it"
 * (`false`) from "a consumer owns it". The first two both fall back to
 * `reportServerError`, so the abort can never be silent.
 */
export const jobDeadlineSink = defineRequestSink<JobDeadlineEvent, boolean>();
