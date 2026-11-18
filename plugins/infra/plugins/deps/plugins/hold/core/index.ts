// The one hold model — a release not to land yet, with a reason and a review
// day at most HOLD_MAX_DAYS out — shared by every updater (`deps/updates`) and
// by a pinned dependency's decision to stay behind main (`infra/deps`). A leaf:
// nothing but zod behind it.
export type { Hold, HoldState } from "./internal/hold";
export {
  describeHold,
  heldBy,
  HOLD_MAX_DAYS,
  holdProblems,
  HoldSchema,
  holdState,
  lapsedHolds,
  latestReviewBy,
  utcDay,
} from "./internal/hold";
