import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  holdProblems,
  utcDay,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  UV_HOLDS,
  UV_HOLDS_FILE,
} from "@plugins/infra/plugins/deps/plugins/python/plugins/uv-updater/core";

/** Every uv hold ends within 90 days of today — set or renewed, never set for good. */
const holds: Check = {
  id: "deps-uv:holds",
  description:
    "every uv updater hold (UV_HOLDS) lasts no longer than 90 days from today",
  async run() {
    const problems = holdProblems(UV_HOLDS, utcDay(new Date()), UV_HOLDS_FILE);
    return problems.length === 0
      ? { ok: true }
      : {
          ok: false,
          message: problems.join("\n"),
          hint: "Renew a hold that still matters with a new `until` and reason; delete one that no longer does.",
        };
  },
};

export default [holds];
