import {
  declaredDeps,
  pinStatus,
  reviewPin,
  type Dep,
  type DepSource,
  type PinReview,
} from "@plugins/infra/plugins/deps/deps";
import { isRelease } from "@plugins/infra/plugins/paths/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import type { PinDrift, PinnedDepRow, PinReviewView } from "../../core";

/** The pinned dependencies' declarations: none on a release (its bundle sealed the binaries). */
export async function pinnedDeps(): Promise<Dep<DepSource>[]> {
  if (isRelease()) return [];
  return (await declaredDeps()).filter((dep) => dep.pin !== null);
}

function reviewView(review: PinReview): PinReviewView | null {
  if (review.kind !== "lagging") return null;
  return {
    decision: review.decision,
    since: review.lag.since,
    dueOn: review.lag.dueOn,
    stay:
      review.stay === null
        ? null
        : { reason: review.stay.reason, reviewBy: review.stay.reviewBy },
  };
}

/**
 * Every pinned dependency against main's checkout — the git store's own
 * checkout (`getMainRepoRoot`), where the gateway runs the daemons' start
 * scripts from and so whose declaration `pinnedDep` reports drift against;
 * never a worktree's, nor main's served slot. Read only: nothing installs or
 * moves, and the lag's review record is read, not written (the weekly
 * Dependency upgrades run writes it — `decisions.ts`).
 */
export async function checkPinDrift(): Promise<PinDrift> {
  if (isRelease()) {
    return {
      kind: "not-applicable",
      reason: "A release runs the binaries its bundle sealed",
    };
  }
  const pinned = await pinnedDeps();
  if (pinned.length === 0) {
    return {
      kind: "not-applicable",
      reason: "No dependency of this checkout declares a pin",
    };
  }
  const mainRoot = await getMainRepoRoot();
  const now = new Date();
  const rows = await Promise.all(
    pinned.map(async (dep): Promise<PinnedDepRow> => {
      const [status, review] = await Promise.all([
        pinStatus(dep, { root: mainRoot }),
        reviewPin(dep, { root: mainRoot, now, record: false }),
      ]);
      return {
        id: dep.id,
        description: dep.description,
        appliesAt: dep.pin?.appliesAt ?? "",
        status,
        review: reviewView(review),
      };
    }),
  );
  return { kind: "checked", mainRoot, rows };
}

/** {@link checkPinDrift}, a failure answered as `unreadable` rather than thrown at every tab. */
export async function currentPinDrift(): Promise<PinDrift> {
  try {
    return await checkPinDrift();
  } catch (err) {
    return {
      kind: "unreadable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The ids of the pinned dependencies, whose cache dirs the push watches. */
export async function pinnedDepIds(): Promise<string[]> {
  return (await pinnedDeps()).map((dep) => dep.id);
}
