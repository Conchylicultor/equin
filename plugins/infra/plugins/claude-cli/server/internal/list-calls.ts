import { claudeCliCallsFor } from "../../core/resources";

/**
 * The `occurredAt` param — an ISO instant — as a `Date`; a malformed one is
 * refused `invalid-occurred-at` (a malformed question), not a loader failure.
 */
export function parseOccurredAt(
  occurredAt: string | undefined,
): Date | undefined {
  if (occurredAt === undefined) return undefined;
  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime())) {
    throw claudeCliCallsFor.refuse(
      "invalid-occurred-at",
      `occurredAt is not an instant: ${JSON.stringify(occurredAt)}`,
    );
  }
  return at;
}
