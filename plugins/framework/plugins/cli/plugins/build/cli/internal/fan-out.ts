// The build's fan-out over its targets (run.ts): in what order they deploy,
// and what one failing does to the rest. Pure orchestration over a `deploy`
// callback, so it is testable without a build.

/**
 * `targets` with the checkout's OWN app first (the rest in their given
 * order): main's own target carries the build's validation (the first target
 * does), and central and the deployed-phase steps follow it — so a
 * composition that fails can never stand between main and its deploy.
 */
export function ownTargetFirst<T extends { isMainComposition: boolean }>(
  targets: readonly T[],
): T[] {
  return [
    ...targets.filter((t) => t.isMainComposition),
    ...targets.filter((t) => !t.isMainComposition),
  ];
}

/** One target's deploy, as the fan-out sees it. */
export type TargetDeploy =
  | { ok: true }
  | {
      ok: false;
      reason: string[];
      failedLabels: string[];
      /** No verdict: the failure is only processes killed by this signal. */
      killedBy: string | null;
    };

/** A target that did not deploy, and why. */
export interface TargetFailure<T> {
  target: T;
  reason: string[];
  failedLabels: string[];
  /** No verdict: the failure is only processes killed by this signal. */
  killedBy: string | null;
}

/** How the fan-out went. */
export interface FanOut<T> {
  deployed: T[];
  failed: TargetFailure<T>[];
  /** Never attempted: the first attempted target failed (the tree's validation rides on it). */
  notAttempted: T[];
}

/** Where a target sits in the fan-out, as its deploy sees it. */
export interface TargetPosition {
  /** Its index in `targets` (for the transcript's `(i/N)` header). */
  index: number;
  /**
   * It is the first target the fan-out ATTEMPTS — not index 0: a target whose
   * preparation already failed is skipped, and the next one attempted must
   * carry the build's validation in its place.
   */
  first: boolean;
}

/**
 * Deploy every target in order. A failure of the first ATTEMPTED target stops
 * the fan-out — the build's validation (checks, tsc) rides on it (its deploy
 * is told `first`), so its failure may be the tree's, and nothing else is
 * deployed from a tree that failed it. A later target's failure is that
 * target's: it is recorded and the rest still deploy (its siblings share a
 * slot and a ledger row, and a target left behind would wait for the next
 * push — the convergence loop does not retry an attempted commit). `prepared`
 * names targets that already failed before the fan-out (their stage-1
 * preparation): recorded as failed, not deployed, and never the one the
 * validation rides on — so a composition-only build whose first target's
 * registry failed still validates the tree on the next one.
 */
export async function deployEachTarget<T>(
  targets: readonly T[],
  deploy: (target: T, position: TargetPosition) => Promise<TargetDeploy>,
  prepared: ReadonlyMap<T, TargetFailure<T>> = new Map(),
): Promise<FanOut<T>> {
  const out: FanOut<T> = { deployed: [], failed: [], notAttempted: [] };
  let attemptedAny = false;
  for (const [i, target] of targets.entries()) {
    const early = prepared.get(target);
    if (early !== undefined) {
      out.failed.push(early);
      continue;
    }
    const first = !attemptedAny;
    attemptedAny = true;
    const result = await deploy(target, { index: i, first });
    if (result.ok) {
      out.deployed.push(target);
      continue;
    }
    out.failed.push({
      target,
      reason: result.reason,
      failedLabels: result.failedLabels,
      killedBy: result.killedBy,
    });
    if (first) {
      const rest = targets.slice(i + 1);
      out.notAttempted = rest.filter((t) => !prepared.has(t));
      out.failed.push(
        ...rest.flatMap((t) => {
          const f = prepared.get(t);
          return f === undefined ? [] : [f];
        }),
      );
      break;
    }
  }
  return out;
}
