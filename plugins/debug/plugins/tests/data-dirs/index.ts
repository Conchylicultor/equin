import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Where the `tests.checkout-digests` job's child (`./equin test-digest`)
 * writes a checkout's test digests for its backend to read: one
 * `<namespace>.json` per serving backend, rewritten on each computation.
 */
export const testDigestsDir = defineDataDir({
  kind: "cache",
  name: "test-digests",
  owner: "debug/tests",
  description:
    "Each backend's latest whole-checkout test digests (`./equin test-digest` output), handed from the supervised child to the backend that stores them",
  // Read once, right after the child writes it; the tables hold the result.
  reclaim: { kind: "safe" },
});

export default [testDigestsDir];
