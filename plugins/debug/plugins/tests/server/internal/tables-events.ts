import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface TestDigestsSettledPayload {
  /** How the computation ended: new digests, the tree unchanged, or a failure. */
  outcome: "computed" | "unchanged" | "failed";
  [key: string]: unknown;
}

// The checkout's test digests finished a computation (`tests.checkout-digests`
// ended): the file statuses now describe the current code, or will not until
// the next try. For work that must pick files by status on CURRENT code (the
// idle runner) — it asks for a computation, then acts on this. No filter
// columns.
export const { event: testDigestsSettled, table: _testDigestsSettledTriggers } =
  defineTriggerEvent<TestDigestsSettledPayload>({
    name: "tests.digestsSettled",
    filters: {},
  });
