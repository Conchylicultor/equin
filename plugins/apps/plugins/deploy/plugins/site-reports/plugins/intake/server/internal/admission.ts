import { SITE_REPORT_LIMITS } from "../../core";

/** The admission bounds — `SITE_REPORT_LIMITS` in production, smaller in tests. */
export interface AdmissionLimits {
  windowMs: number;
  perVisitorBatches: number;
  globalBatches: number;
  maxTrackedVisitors: number;
}

export type Admission =
  | { admitted: true }
  | {
      admitted: false;
      reason: "visitor-budget" | "global-budget" | "visitor-roster";
      retryAfterS: number;
    };

export interface AdmissionGate {
  /** Spend one batch of `visitor`'s and the global budget, or say why not. */
  admit(visitor: string, now: number): Admission;
  /** Visitors tracked this window — never above `maxTrackedVisitors`. */
  trackedVisitors(): number;
}

/**
 * The public intake's first gate: fixed windows, a per-visitor batch budget
 * and a global one, in memory. Nothing past the gate is read for a refused
 * batch, and the gate's own memory is bounded — at most `maxTrackedVisitors`
 * keys, all dropped when the window rolls. A visitor arriving once the roster
 * is full is refused (`visitor-roster`): unbounded keys would be the one
 * thing here that grows with traffic.
 *
 * Pure over an explicit clock, so its bounds are asserted directly.
 */
export function createAdmissionGate(
  limits: AdmissionLimits = SITE_REPORT_LIMITS,
): AdmissionGate {
  let windowStartedAt = -Infinity;
  let globalSpent = 0;
  const perVisitor = new Map<string, number>();

  return {
    admit(visitor, now) {
      if (now - windowStartedAt >= limits.windowMs) {
        windowStartedAt = now;
        globalSpent = 0;
        perVisitor.clear();
      }
      const retryAfterS = Math.max(
        1,
        Math.ceil((windowStartedAt + limits.windowMs - now) / 1000),
      );
      if (globalSpent >= limits.globalBatches) {
        return { admitted: false, reason: "global-budget", retryAfterS };
      }
      const spent = perVisitor.get(visitor);
      if (spent === undefined && perVisitor.size >= limits.maxTrackedVisitors) {
        return { admitted: false, reason: "visitor-roster", retryAfterS };
      }
      if ((spent ?? 0) >= limits.perVisitorBatches) {
        return { admitted: false, reason: "visitor-budget", retryAfterS };
      }
      perVisitor.set(visitor, (spent ?? 0) + 1);
      globalSpent += 1;
      return { admitted: true };
    },
    trackedVisitors: () => perVisitor.size,
  };
}
