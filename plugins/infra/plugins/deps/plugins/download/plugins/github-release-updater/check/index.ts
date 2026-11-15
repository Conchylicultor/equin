import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  holdProblems,
  utcDay,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  GITHUB_RELEASE_HOLDS,
  GITHUB_RELEASE_HOLDS_FILE,
} from "@plugins/infra/plugins/deps/plugins/download/plugins/github-release-updater/core";

/** No github-release hold goes more than 90 days unreviewed. */
const holds: Check = {
  id: "deps-github-release:holds",
  description:
    "every github-release updater hold (GITHUB_RELEASE_HOLDS) is next reviewed within 90 days of today",
  async run() {
    const problems = holdProblems(
      GITHUB_RELEASE_HOLDS,
      utcDay(new Date()),
      GITHUB_RELEASE_HOLDS_FILE,
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
