import partialBarrelMock from "./partial-barrel-mock";
import noHoistedImportRead from "./no-hoisted-import-read";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "vitest-mock-safety",
  rules: {
    "partial-barrel-mock": partialBarrelMock,
    "no-hoisted-import-read": noHoistedImportRead,
  },
  // Both rules exist for test files alone — the `test` category every
  // contributed rule is off in by default.
  enforceEverywhere: ["partial-barrel-mock", "no-hoisted-import-read"],
} satisfies LintContribution;
