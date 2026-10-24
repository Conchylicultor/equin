import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  holdProblems,
  utcDay,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  CARGO_HOLDS,
  CARGO_HOLDS_FILE,
} from "@plugins/infra/plugins/deps/plugins/rust/plugins/cargo-updater/core";

/** No cargo hold goes more than 90 days unreviewed — set or renewed, never set for good. */
const holds: Check = {
  id: "deps-cargo:holds",
  description:
    "every cargo updater hold (CARGO_HOLDS) is next reviewed within 90 days of today",
  async run() {
    const problems = holdProblems(
      CARGO_HOLDS,
      utcDay(new Date()),
      CARGO_HOLDS_FILE,
    );
    return problems.length === 0
      ? { ok: true }
      : {
          ok: false,
          message: problems.join("\n"),
          hint: "Renew a hold that still matters with a new `reviewBy` and reason; delete one that no longer does.",
        };
  },
};

export default [holds];
