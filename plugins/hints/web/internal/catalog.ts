import type { Hint, HintOutcome, HintSeen } from "../../core";
import type { AnyTour } from "./tour-machine";

/**
 * One declared hint or tour joined with its seen row. `not-encountered` means
 * the user has not met it yet (or reset it); a running tour is `seen` with no
 * outcome.
 */
export type HintCatalogEntry =
  | {
      readonly kind: "hint";
      readonly hint: Hint;
      readonly status: "not-encountered";
    }
  | {
      readonly kind: "hint";
      readonly hint: Hint;
      readonly status: "seen";
      readonly outcome: HintOutcome | null;
      readonly seenAt: Date;
    }
  | {
      readonly kind: "tour";
      readonly tour: AnyTour;
      readonly status: "not-encountered";
    }
  | {
      readonly kind: "tour";
      readonly tour: AnyTour;
      readonly status: "seen";
      readonly outcome: HintOutcome | null;
      readonly seenAt: Date;
    };

/** Every declared hint, then every tour, each joined with its seen row by id. */
export function joinCatalog(
  hints: readonly Hint[],
  tours: readonly AnyTour[],
  seen: ReadonlyMap<string, HintSeen>,
): HintCatalogEntry[] {
  const seenOf = (id: string) => {
    const row = seen.get(id);
    return row
      ? { status: "seen" as const, outcome: row.outcome, seenAt: row.seenAt }
      : { status: "not-encountered" as const };
  };
  return [
    ...hints.map((hint) => ({
      kind: "hint" as const,
      hint,
      ...seenOf(hint.id),
    })),
    ...tours.map((tour) => ({
      kind: "tour" as const,
      tour,
      ...seenOf(tour.id),
    })),
  ];
}
